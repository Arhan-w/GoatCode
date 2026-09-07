"""Shared fixtures: isolated GOATCODE_HOME so tests never touch real config."""
from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def isolated_home(tmp_path, monkeypatch):
    monkeypatch.setenv("GOATCODE_HOME", str(tmp_path / "goathome"))
    monkeypatch.delenv("GOAT_MODEL", raising=False)
    monkeypatch.delenv("GOAT_AUTO_APPROVE", raising=False)
    monkeypatch.delenv("GOAT_MAX_TOKENS", raising=False)
    return tmp_path / "goathome"
