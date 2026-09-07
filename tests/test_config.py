"""Config layering + custom endpoint persistence."""
from __future__ import annotations

import json
from pathlib import Path

from goatcode.config import (
    CustomEndpoint,
    config_path,
    load_config,
    save_config,
)


def test_defaults_when_no_files():
    cfg = load_config()
    assert cfg.model == "anthropic/claude-sonnet-4-5"
    assert cfg.provider == "anthropic"
    assert cfg.model_id == "claude-sonnet-4-5"
    assert cfg.max_tokens > 0


def test_env_overrides_win(monkeypatch):
    monkeypatch.setenv("GOAT_MODEL", "groq/llama-3.3-70b")
    monkeypatch.setenv("GOAT_AUTO_APPROVE", "1")
    cfg = load_config()
    assert cfg.provider == "groq"
    assert cfg.model_id == "llama-3.3-70b"
    assert cfg.auto_approve is True


def test_project_config_overrides_user_config(tmp_path, monkeypatch):
    user = {"model": "openai/gpt-4o", "max_tokens": 1000}
    config_path().write_text(json.dumps(user), encoding="utf-8")
    (tmp_path / "goatcode.json").write_text(
        json.dumps({"model": "deepseek/deepseek-chat"}), encoding="utf-8")
    monkeypatch.chdir(tmp_path)
    cfg = load_config(project_dir=tmp_path)
    assert cfg.model == "deepseek/deepseek-chat"
    assert cfg.max_tokens == 1000  # user-level value survives


def test_save_roundtrip_endpoints():
    cfg = load_config()
    cfg.endpoints["ollama"] = CustomEndpoint(
        id="ollama", base_url="http://localhost:11434/v1", format="openai",
        models=["llama3.2"], label="Local Ollama",
    )
    save_config(cfg)
    reloaded = load_config()
    ep = reloaded.endpoints["ollama"]
    assert ep.base_url == "http://localhost:11434/v1"
    assert ep.models == ["llama3.2"]


def test_invalid_json_exits_cleanly():
    config_path().write_text("{not json", encoding="utf-8")
    try:
        load_config()
    except SystemExit as exc:
        assert "invalid JSON" in str(exc)
    else:
        raise AssertionError("expected SystemExit")
