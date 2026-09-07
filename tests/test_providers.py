"""Provider catalog, credential resolution order, custom endpoints."""
from __future__ import annotations

import os
import time

from goatcode.config import CustomEndpoint
from goatcode.providers import (
    Credential,
    CredentialStore,
    ENV_KEY_FALLBACK,
    OAUTH_PROVIDERS,
    ProviderRegistry,
    load_catalog,
)


def test_catalog_loads_and_has_big_names():
    catalog = load_catalog()
    assert len(catalog) > 100
    for pid in ("openai", "anthropic", "groq", "deepseek", "openrouter"):
        assert pid in catalog, pid
    assert catalog["anthropic"].format == "claude"
    assert catalog["openai"].format == "openai"


def test_oauth_pseudo_providers_registered():
    catalog = load_catalog()
    for pid in OAUTH_PROVIDERS:
        assert pid in catalog
        assert catalog[pid].auth == "oauth"


def test_env_key_fallback_resolution(monkeypatch):
    registry = ProviderRegistry()
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-123")
    cred = registry.resolve_credential("openai")
    assert cred and cred.api_key == "sk-test-123"


def test_stored_key_beats_env(monkeypatch):
    store = CredentialStore()
    store.put("groq", Credential(kind="api_key", api_key="gsk-stored"))
    monkeypatch.setenv("GROQ_API_KEY", "gsk-env")
    registry = ProviderRegistry(store=store)
    cred = registry.resolve_credential("groq")
    assert cred.api_key == "gsk-stored"


def test_custom_endpoint_inline_and_env(monkeypatch):
    ep_key = CustomEndpoint(id="mine", base_url="https://x.example/v1", api_key="inline-k")
    ep_env = CustomEndpoint(id="theirs", base_url="https://y.example/v1", api_key_env="THEIRS_KEY")
    registry = ProviderRegistry({"mine": ep_key, "theirs": ep_env})
    monkeypatch.setenv("THEIRS_KEY", "env-k")
    assert registry.resolve_credential("mine").api_key == "inline-k"
    assert registry.resolve_credential("theirs").api_key == "env-k"
    assert registry.get("mine").custom is True


def test_oauth_credential_validity_and_refresh_state():
    live = Credential(kind="oauth", access_token="a", refresh_token="r",
                      expires_at=time.time() + 3600)
    stale = Credential(kind="oauth", access_token="a", refresh_token="r",
                       expires_at=time.time() - 10)
    assert live.valid()
    assert not stale.valid()  # expired, but refresh_token present -> resolvable for refresh
    store = CredentialStore()
    store.put("claude", stale)
    registry = ProviderRegistry(store=store)
    got = registry.resolve_credential("claude")
    assert got is not None and got.refresh_token == "r"


def test_credentials_file_permissions(tmp_path):
    store = CredentialStore(tmp_path / "creds.json")
    store.put("openai", Credential(kind="api_key", api_key="sk-x"))
    assert (tmp_path / "creds.json").exists()
    assert store.get("openai").api_key == "sk-x"
    assert store.remove("openai") is True
    assert store.get("openai") is None


def test_unknown_provider_returns_none():
    assert ProviderRegistry().get("definitely-not-real") is None


def test_env_fallback_keys_exist_in_catalog_or_oauth():
    """A fallback keyed to a non-existent provider id is dead code — the exact
    bug where 'google'/'cloudflare-workersai' never matched the catalog."""
    catalog = load_catalog()
    for pid in ENV_KEY_FALLBACK:
        assert pid in catalog, f"ENV_KEY_FALLBACK key '{pid}' is not a catalog/oauth id"


def test_gemini_env_key_resolves(monkeypatch):
    """Regression: GEMINI_API_KEY must resolve for the 'gemini' catalog id."""
    monkeypatch.setenv("GEMINI_API_KEY", "AIza-test")
    registry = ProviderRegistry()
    cred = registry.resolve_credential("gemini")
    assert cred and cred.api_key == "AIza-test"
