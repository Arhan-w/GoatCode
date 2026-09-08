"""TUI construction smoke tests — the class of bug where a widget is built
with a kwarg the installed library version doesn't accept (WordCompleter
'sentence_start' vs 'sentence') never reached an agent turn, so the agent-loop
mocks couldn't catch it. These construct the real objects."""
from __future__ import annotations

import inspect

from prompt_toolkit.completion import WordCompleter

from goatcode.tui import SLASH_COMMANDS, TUI
from goatcode.config import load_config
from goatcode.providers import ProviderRegistry


def test_word_completer_accepts_our_kwargs():
    """Regression: sentence_start is not a real parameter in prompt_toolkit 3.x."""
    params = inspect.signature(WordCompleter.__init__).parameters
    completer = WordCompleter(SLASH_COMMANDS, sentence=True)
    assert list(completer.words) == SLASH_COMMANDS
    assert "sentence_start" not in params  # would have crashed the TUI


def test_tui_constructs_and_slash_commands_parse(isolated_home):
    cfg = load_config()
    tui = TUI(cfg, ProviderRegistry(cfg.endpoints), plain=True)
    # every advertised slash command must be handled without raising
    for cmd in ["/help", "/model", "/providers", "/models", "/sessions",
                "/approve", "/auto", "/compact", "/bogus"]:
        assert tui.handle_slash(cmd) is True


def test_model_switch_updates_config(isolated_home):
    cfg = load_config()
    tui = TUI(cfg, ProviderRegistry(cfg.endpoints), plain=True)
    tui.handle_slash("/model groq/llama-3.3-70b")
    assert tui.cfg.provider == "groq"
    assert tui.cfg.model_id == "llama-3.3-70b"


def test_logout_unknown_provider_no_crash(isolated_home):
    tui = TUI(load_config(), ProviderRegistry(), plain=True)
    assert tui.handle_slash("/logout nonexistent") is True


def test_build_agent_unknown_provider_returns_none_not_exit(isolated_home):
    """Regression: unknown provider used to raise SystemExit that the run loop
    swallowed silently — the user saw no error at all."""
    cfg = load_config()
    cfg.model = "notreal/model-x"
    cfg.split_model()
    tui = TUI(cfg, ProviderRegistry(cfg.endpoints), plain=True)
    assert tui.build_agent() is None  # no SystemExit


def test_build_agent_missing_credentials_returns_none(isolated_home):
    cfg = load_config()
    cfg.model = "deepseek/deepseek-chat"  # in catalog, no key stored
    cfg.split_model()
    tui = TUI(cfg, ProviderRegistry(cfg.endpoints), plain=True)
    assert tui.build_agent() is None
