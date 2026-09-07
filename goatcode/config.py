"""Configuration: discovery, defaults, custom endpoints.

Layered: defaults < ~/.goatcode/config.json < ./goatcode.json (project) < env vars.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

APP_DIR_NAME = ".goatcode"
CONFIG_FILE_NAME = "config.json"
PROJECT_CONFIG_NAME = "goatcode.json"


def app_dir() -> Path:
    override = os.environ.get("GOATCODE_HOME")
    base = Path(override) if override else Path.home() / APP_DIR_NAME
    base.mkdir(parents=True, exist_ok=True)
    return base


def config_path() -> Path:
    return app_dir() / CONFIG_FILE_NAME


@dataclass
class CustomEndpoint:
    """A user-declared provider pointing at any OpenAI/Anthropic-compatible URL."""

    id: str
    base_url: str
    format: str = "openai"  # openai | claude | openai-responses | gemini
    api_key_env: str | None = None
    api_key: str | None = None
    models: list[str] = field(default_factory=list)
    label: str = ""


@dataclass
class Config:
    model: str = "anthropic/claude-sonnet-4-5"
    provider: str = ""          # derived from model when empty
    model_id: str = ""          # derived from model when empty
    max_tokens: int = 8192
    temperature: float | None = None
    auto_approve: bool = False  # skip tool confirmations
    max_steps: int = 40         # agent loop iteration cap
    stream: bool = True
    theme_dim: bool = False     # disable colors for very old terminals
    endpoints: dict[str, CustomEndpoint] = field(default_factory=dict)
    raw: dict[str, Any] = field(default_factory=dict)

    def split_model(self) -> None:
        if "/" in self.model:
            self.provider, self.model_id = self.model.split("/", 1)
        else:
            self.provider, self.model_id = "openai", self.model


def _read_json(path: Path) -> dict[str, Any]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except json.JSONDecodeError as exc:
        raise SystemExit(f"goat: invalid JSON in {path}: {exc}") from exc


def _endpoint_from(pid: str, data: dict[str, Any]) -> CustomEndpoint:
    return CustomEndpoint(
        id=pid,
        base_url=data.get("base_url", data.get("baseUrl", "")).rstrip("/"),
        format=data.get("format", "openai"),
        api_key_env=data.get("api_key_env") or data.get("apiKeyEnv"),
        api_key=data.get("api_key") or data.get("apiKey"),
        models=list(data.get("models") or []),
        label=data.get("label", pid),
    )


def load_config(project_dir: Path | None = None) -> Config:
    data: dict[str, Any] = {}
    data.update(_read_json(config_path()))
    if project_dir:
        data.update(_read_json(project_dir / PROJECT_CONFIG_NAME))

    cfg = Config(
        model=str(data.get("model", Config.model)),
        max_tokens=int(data.get("max_tokens", Config.max_tokens)),
        temperature=data.get("temperature"),
        auto_approve=bool(data.get("auto_approve", False)),
        max_steps=int(data.get("max_steps", Config.max_steps)),
        stream=bool(data.get("stream", True)),
        theme_dim=bool(data.get("theme_dim", False)),
        raw=data,
    )
    for pid, edata in (data.get("endpoints") or {}).items():
        if isinstance(edata, dict):
            cfg.endpoints[pid] = _endpoint_from(pid, edata)

    # Env overrides win: GOAT_MODEL, GOAT_AUTO_APPROVE, GOAT_MAX_TOKENS
    if os.environ.get("GOAT_MODEL"):
        cfg.model = os.environ["GOAT_MODEL"]
    if os.environ.get("GOAT_AUTO_APPROVE"):
        cfg.auto_approve = os.environ["GOAT_AUTO_APPROVE"].lower() in ("1", "true", "yes")
    if os.environ.get("GOAT_MAX_TOKENS"):
        try:
            cfg.max_tokens = int(os.environ["GOAT_MAX_TOKENS"])
        except ValueError:
            pass
    cfg.split_model()
    return cfg


def save_config(cfg: Config) -> None:
    """Persist user-level config (model + endpoints only)."""
    payload: dict[str, Any] = {"model": cfg.model, "max_tokens": cfg.max_tokens}
    if cfg.endpoints:
        payload["endpoints"] = {
            pid: {
                "base_url": ep.base_url,
                "format": ep.format,
                **({"api_key_env": ep.api_key_env} if ep.api_key_env else {}),
                **({"api_key": ep.api_key} if ep.api_key else {}),
                **({"models": ep.models} if ep.models else {}),
            }
            for pid, ep in cfg.endpoints.items()
        }
    config_path().write_text(json.dumps(payload, indent=2), encoding="utf-8")
