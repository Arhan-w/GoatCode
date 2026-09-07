"""Provider catalog: built-in providers (from the OmniRoute registry),
custom endpoints, and credential resolution (env vars + OAuth tokens).
"""
from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass, field
from pathlib import Path

from .config import CustomEndpoint, app_dir

_CATALOG_PATH = Path(__file__).parent / "data" / "providers.json"

# OmniRoute's registry stores full endpoint URLs; our clients append the path
# themselves. Strip the endpoint suffix down to the API base.
_ENDPOINT_SUFFIXES = ("/chat/completions", "/messages", "/responses",
                      "/streamGenerateContent", "/generateContent")


def normalize_base_url(url: str) -> str:
    url = (url or "").rstrip("/")
    for suffix in _ENDPOINT_SUFFIXES:
        if url.endswith(suffix):
            url = url[: -len(suffix)].rstrip("/")
            break
    return url

# Providers whose OAuth flows GoatCode implements natively (web OAuth -> API token).
OAUTH_PROVIDERS = {
    "claude": {
        "label": "Claude Pro/Max (OAuth)",
        "authorize_url": "https://claude.ai/oauth/authorize",
        "token_url": "https://api.anthropic.com/v1/oauth/token",
        "client_id": "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
        "redirect_uri": "https://console.anthropic.com/oauth/code/callback",
        "scope": "org:create_api_key user:profile user:inference",
        "pkce": True,
        "api_format": "claude",
        "base_url": "https://api.anthropic.com/v1",
        "model_prefix": "claude",
    },
    "codex": {
        "label": "ChatGPT Plus/Pro (OAuth)",
        "authorize_url": "https://auth.openai.com/oauth/authorize",
        "token_url": "https://auth.openai.com/oauth/token",
        "client_id": "app_EMoamEEZ73f0CkXaXp7hrann",
        "redirect_uri": "http://localhost:1455/auth/callback",
        "scope": "openid email profile offline_access",
        "pkce": True,
        "api_format": "openai-responses",
        "base_url": "https://chatgpt.com/backend-api/codex",
        "model_prefix": "gpt",
    },
    "gemini": {
        "label": "Gemini Code Assist (OAuth)",
        "authorize_url": "https://accounts.google.com/o/oauth2/auth",
        "token_url": "https://oauth2.googleapis.com/token",
        "client_id": "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com",
        "redirect_uri": "http://localhost:8085/oauth2callback",
        "scope": "https://www.googleapis.com/auth/cloud-platform",
        "pkce": False,
        "api_format": "gemini-oauth",
        "base_url": "https://cloudcode-pa.googleapis.com/v1internal",
        "model_prefix": "gemini",
    },
    "github-copilot": {
        "label": "GitHub Copilot (device OAuth)",
        "flow": "device",
        "device_url": "https://github.com/login/device/code",
        "token_url": "https://github.com/login/oauth/access_token",
        "copilot_token_url": "https://api.github.com/copilot_internal/v2/token",
        "client_id": "Iv1.b507a08c87ecfe98",
        "api_format": "openai",
        "base_url": "https://api.githubcopilot.com",
        "model_prefix": "gpt",
    },
    "kimi": {
        "label": "Kimi For Coding (device OAuth)",
        "flow": "device",
        "device_url": "https://auth.kimi.com/api/oauth/device_authorization",
        "token_url": "https://auth.kimi.com/api/oauth/token",
        "client_id": "17e5f671-d194-4dfb-9706-5516cb48c098",
        "api_format": "openai",
        "base_url": "https://api.kimi.com/coding/v1",
        "model_prefix": "kimi",
    },
    "grok": {
        "label": "Grok (import token)",
        "flow": "import",
        "api_format": "openai",
        "base_url": "https://cli-chat-proxy.grok.com/v1",
        "model_prefix": "grok",
    },
}

# Env var fallbacks for API keys on popular built-ins. Keys must match catalog
# provider ids (data/providers.json) or resolve_credential never consults them.
ENV_KEY_FALLBACK = {
    "openai": "OPENAI_API_KEY",
    "anthropic": "ANTHROPIC_API_KEY",
    "claude": "ANTHROPIC_API_KEY",
    "gemini": "GEMINI_API_KEY",
    "groq": "GROQ_API_KEY",
    "mistral": "MISTRAL_API_KEY",
    "deepseek": "DEEPSEEK_API_KEY",
    "openrouter": "OPENROUTER_API_KEY",
    "xai": "XAI_API_KEY",
    "grok-cli": "XAI_API_KEY",
    "fireworks": "FIREWORKS_API_KEY",
    "cerebras": "CEREBRAS_API_KEY",
    "cohere": "COHERE_API_KEY",
    "perplexity": "PERPLEXITY_API_KEY",
    "nvidia": "NVIDIA_API_KEY",
    "zai": "ZAI_API_KEY",
    "moonshot": "MOONSHOT_API_KEY",
    "kimi": "MOONSHOT_API_KEY",
    "minimax": "MINIMAX_API_KEY",
    "cloudflare-ai": "CLOUDFLARE_API_KEY",
    "huggingface": "HF_TOKEN",
}


@dataclass
class Provider:
    id: str
    name: str
    format: str            # openai | claude | openai-responses | gemini
    base_url: str
    auth: str = "apikey"   # apikey | oauth | none
    env_key: str | None = None
    models: list[str] = field(default_factory=list)
    custom: bool = False


@dataclass
class Credential:
    kind: str              # "api_key" | "oauth"
    api_key: str | None = None
    access_token: str | None = None
    refresh_token: str | None = None
    expires_at: float = 0.0  # unix ts; 0 = never/unknown

    def valid(self) -> bool:
        if self.kind == "oauth":
            return bool(self.access_token) and (self.expires_at == 0 or time.time() < self.expires_at - 60)
        return bool(self.api_key)


def load_catalog() -> dict[str, Provider]:
    providers: dict[str, Provider] = {}
    try:
        raw = json.loads(_CATALOG_PATH.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raw = {}
    for pid, data in raw.items():
        providers[pid] = Provider(
            id=pid,
            name=data.get("name", pid),
            format=data.get("format", "openai"),
            base_url=normalize_base_url(data.get("base_url")),
            auth=data.get("auth", "apikey"),
            env_key=data.get("env_key"),
            models=list(data.get("models") or []),
        )
    # OAuth pseudo-providers: mark catalog entries (or add missing ones).
    # The catalog base_url stays the API-key route; runtime.resolve() swaps
    # to the OAuth endpoint when the stored credential is an OAuth token.
    for oid, meta in OAUTH_PROVIDERS.items():
        existing = providers.get(oid)
        if existing:
            existing.auth = "oauth"
        else:
            providers[oid] = Provider(
                id=oid, name=meta["label"], format=meta["api_format"],
                base_url=normalize_base_url(meta["base_url"]), auth="oauth",
            )
    return providers


class CredentialStore:
    """~/.goatcode/credentials.json — keyed by provider id.

    Parses once and caches; put/remove invalidate. (goat providers --check
    resolves ~180 credentials per run — re-reading per lookup was O(n²) IO.)
    """

    def __init__(self, path: Path | None = None) -> None:
        self.path = path or app_dir() / "credentials.json"
        self._cache: dict | None = None

    def _read(self) -> dict:
        if self._cache is None:
            try:
                self._cache = json.loads(self.path.read_text(encoding="utf-8"))
            except (FileNotFoundError, json.JSONDecodeError):
                self._cache = {}
        return self._cache

    def get(self, provider_id: str) -> Credential | None:
        data = self._read().get(provider_id)
        if not data:
            return None
        return Credential(
            kind=data.get("kind", "api_key"),
            api_key=data.get("api_key"),
            access_token=data.get("access_token"),
            refresh_token=data.get("refresh_token"),
            expires_at=float(data.get("expires_at") or 0),
        )

    def put(self, provider_id: str, cred: Credential) -> None:
        data = self._read()
        data[provider_id] = {
            "kind": cred.kind,
            **({"api_key": cred.api_key} if cred.api_key else {}),
            **({"access_token": cred.access_token} if cred.access_token else {}),
            **({"refresh_token": cred.refresh_token} if cred.refresh_token else {}),
            "expires_at": cred.expires_at,
        }
        self.path.write_text(json.dumps(data, indent=2), encoding="utf-8")
        self._cache = None
        try:
            os.chmod(self.path, 0o600)
        except OSError:
            pass

    def remove(self, provider_id: str) -> bool:
        data = self._read()
        if provider_id in data:
            del data[provider_id]
            self.path.write_text(json.dumps(data, indent=2), encoding="utf-8")
            self._cache = None
            return True
        return False


class ProviderRegistry:
    """Resolves provider id -> Provider + Credential, merging catalog, custom
    endpoints, env keys and stored credentials."""

    def __init__(self, custom_endpoints: dict[str, CustomEndpoint] | None = None,
                 store: CredentialStore | None = None) -> None:
        self.catalog = load_catalog()
        self.custom = dict(custom_endpoints or {})
        self.store = store or CredentialStore()
        for pid, ep in self.custom.items():
            self.catalog[pid] = Provider(
                id=pid, name=ep.label or pid, format=ep.format,
                base_url=normalize_base_url(ep.base_url), auth="apikey",
                models=ep.models, custom=True,
            )

    def get(self, provider_id: str) -> Provider | None:
        return self.catalog.get(provider_id)

    def list_all(self) -> list[Provider]:
        return sorted(self.catalog.values(), key=lambda p: p.id)

    def resolve_credential(self, provider_id: str) -> Credential | None:
        # 1. stored credential (oauth or goat-set key)
        cred = self.store.get(provider_id)
        if cred and cred.valid():
            return cred
        # 2. custom endpoint inline key / env var
        ep = self.custom.get(provider_id)
        if ep:
            if ep.api_key:
                return Credential(kind="api_key", api_key=ep.api_key)
            if ep.api_key_env and os.environ.get(ep.api_key_env):
                return Credential(kind="api_key", api_key=os.environ[ep.api_key_env])
        # 3. catalog env key, then well-known fallback
        prov = self.catalog.get(provider_id)
        env_names: list[str] = []
        if prov and prov.env_key:
            env_names.append(prov.env_key)
        env_names.append(ENV_KEY_FALLBACK.get(provider_id, ""))
        for name in env_names:
            if name and os.environ.get(name):
                return Credential(kind="api_key", api_key=os.environ[name])
        # 4. expired oauth with refresh token — caller refreshes lazily
        if cred and cred.kind == "oauth" and cred.refresh_token:
            return cred
        return None

    def add_custom(self, ep: CustomEndpoint) -> None:
        self.custom[ep.id] = ep
        self.catalog[ep.id] = Provider(
            id=ep.id, name=ep.label or ep.id, format=ep.format,
            base_url=ep.base_url, auth="apikey", models=ep.models, custom=True,
        )
