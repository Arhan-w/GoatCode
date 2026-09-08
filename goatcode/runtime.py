"""Runtime glue: resolve provider+credential into a live chat client.

Handles lazy OAuth refresh and the special headers the subscription-backed
endpoints (Copilot, Codex) expect.
"""
from __future__ import annotations

from dataclasses import dataclass

from .config import Config
from .llm import make_client
from .providers import Credential, OAUTH_PROVIDERS, Provider, ProviderRegistry, normalize_base_url
from . import oauth


class ResolveError(RuntimeError):
    """Base for provider-resolution failures callers must surface."""


class AuthRequired(ResolveError):
    def __init__(self, provider_id: str) -> None:
        super().__init__(
            f"provider '{provider_id}' needs credentials.\n"
            f"  API key:  set the env var or run:  goat auth {provider_id} --key <KEY>\n"
            f"  OAuth:    goat auth {provider_id} --oauth   (if listed by: goat auth --list-oauth)"
        )
        self.provider_id = provider_id


class UnknownProvider(ResolveError):
    def __init__(self, provider_id: str) -> None:
        super().__init__(f"unknown provider '{provider_id}' — see: goat providers")
        self.provider_id = provider_id


@dataclass
class Resolved:
    provider: Provider
    credential: Credential
    client: object


def _refresh_if_needed(registry: ProviderRegistry, provider_id: str,
                       cred: Credential) -> Credential:
    if cred.kind != "oauth" or cred.valid():
        return cred
    try:
        fresh = oauth.refresh(provider_id, cred)
    except RuntimeError:
        raise AuthRequired(provider_id) from None
    registry.store.put(provider_id, fresh)
    return fresh


def _headers_for(provider_id: str, cred: Credential) -> dict[str, str]:
    if provider_id == "github-copilot":
        return {"editor-version": "vscode/1.99.0", "user-agent": "GoatCode",
                "copilot-integration-id": "vscode-chat"}
    if provider_id == "codex":
        return {"originator": "goatcode", "accept": "text/event-stream"}
    return {}


def resolve(cfg: Config, registry: ProviderRegistry) -> Resolved:
    provider = registry.get(cfg.provider)
    if provider is None:
        raise UnknownProvider(cfg.provider)
    cred = registry.resolve_credential(provider.id)
    if cred is None:
        raise AuthRequired(provider.id)
    cred = _refresh_if_needed(registry, provider.id, cred)

    fmt = provider.format
    base = provider.base_url
    # OAuth credential -> the subscription endpoint from OAUTH_PROVIDERS
    # (different host/format than the API-key route, e.g. gemini's
    # cloudcode-pa vs generativelanguage).
    if cred.kind == "oauth" and provider.id in OAUTH_PROVIDERS:
        meta = OAUTH_PROVIDERS[provider.id]
        fmt = meta["api_format"]
        base = normalize_base_url(meta["base_url"])
    api_key = cred.api_key
    auth_token = cred.access_token if cred.kind == "oauth" else None
    # Anthropic OAuth uses bearer; API key uses x-api-key — AnthropicClient
    # handles both. OpenAI-compatible endpoints with OAuth (kimi/grok/copilot)
    # send the bearer via auth_token -> api_key slot for OpenAIChatClient.
    if fmt == "openai" and auth_token and not api_key:
        api_key = auth_token
        auth_token = None
    client = make_client(
        fmt, base,
        api_key=api_key, auth_token=auth_token,
        extra_headers=_headers_for(provider.id, cred) or None,
    )
    return Resolved(provider=provider, credential=cred, client=client)
