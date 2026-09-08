"""goat — command line entrypoint.

  goat                          interactive TUI
  goat -p "fix the tests"       one-shot prompt, prints result and exits
  goat auth <provider> --key K  store API key
  goat auth <provider> --oauth  browser/device OAuth login
  goat providers [--check]      list providers (optionally probe credentials)
  goat endpoint add <id> ...    register a custom OpenAI/Anthropic-compatible URL
  goat models <provider>        list catalog models for a provider
  goat resume <id>              continue a saved session
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# Heavy modules (httpx via oauth, prompt_toolkit/rich via tui) are imported
# lazily inside the commands that need them — keeps `goat providers` and
# `goat --version` snappy on low-end machines.
from . import __version__
from .config import Config, CustomEndpoint, load_config, save_config
from .providers import OAUTH_PROVIDERS, Credential, ProviderRegistry
from .session import list_sessions


def _registry(cfg: Config) -> ProviderRegistry:
    return ProviderRegistry(cfg.endpoints)


def cmd_auth(args: argparse.Namespace) -> int:
    cfg = load_config()
    registry = _registry(cfg)
    pid = args.provider
    if args.list_oauth:
        for k, meta in OAUTH_PROVIDERS.items():
            print(f"  {k:<16} {meta['label']}")
        return 0
    if args.key:
        registry.store.put(pid, Credential(kind="api_key", api_key=args.key))
        print(f"stored API key for {pid}")
        return 0
    if args.oauth:
        from . import oauth
        if pid not in OAUTH_PROVIDERS:
            print(f"no OAuth flow for '{pid}'. Available: {', '.join(OAUTH_PROVIDERS)}", file=sys.stderr)
            return 1
        meta = OAUTH_PROVIDERS[pid]
        flow = meta.get("flow", "browser")
        if flow == "device":
            cred = oauth.login_device(pid)
        elif flow == "import":
            cred = oauth.login_import(pid)
        else:
            cred = oauth.login_oauth(pid, manual_paste=args.manual)
        registry.store.put(pid, cred)
        print(f"logged in to {pid} — try: goat -m {pid}/... \"hello\"")
        return 0
    print("usage: goat auth <provider> --key <K> | --oauth", file=sys.stderr)
    return 1


def cmd_providers(args: argparse.Namespace) -> int:
    cfg = load_config()
    registry = _registry(cfg)
    for p in registry.list_all():
        mark = "✓" if registry.resolve_credential(p.id) else " "
        print(f" {mark} {p.id:<30} [{p.format}] {p.base_url}")
    if args.check:
        missing = [p.id for p in registry.list_all() if not registry.resolve_credential(p.id)]
        print(f"\n{len(missing)} providers without credentials.")
    return 0


def cmd_models(args: argparse.Namespace) -> int:
    cfg = load_config()
    registry = _registry(cfg)
    p = registry.get(args.provider)
    if not p:
        print(f"unknown provider '{args.provider}'", file=sys.stderr)
        return 1
    for m in p.models or ["(no catalog models — pass any model id)"]:
        print(f"  {p.id}/{m}")
    return 0


def cmd_endpoint(args: argparse.Namespace) -> int:
    cfg = load_config()
    if args.action in ("add", "remove") and not args.id:
        print(f"usage: goat endpoint {args.action} <id>", file=sys.stderr)
        return 1
    if args.action == "add":
        if not args.base_url:
            print("add requires --base-url", file=sys.stderr)
            return 1
        cfg.endpoints[args.id] = CustomEndpoint(
            id=args.id, base_url=args.base_url.rstrip("/"), format=args.format,
            api_key_env=args.api_key_env, api_key=args.api_key,
            models=(args.models or "").split(",") if args.models else [],
            label=args.label or args.id,
        )
        save_config(cfg)
        print(f"added endpoint '{args.id}' ({args.format}) -> {args.base_url}")
        print(f"usage: goat -m {args.id}/<model> \"...\"")
        return 0
    if args.action == "remove":
        if args.id in cfg.endpoints:
            del cfg.endpoints[args.id]
            save_config(cfg)
            print(f"removed endpoint '{args.id}'")
            return 0
        print("no such endpoint", file=sys.stderr)
        return 1
    if args.action == "list":
        for pid, ep in cfg.endpoints.items():
            print(f"  {pid:<20} [{ep.format}] {ep.base_url}")
        return 0
    return 1


def cmd_sessions(args: argparse.Namespace) -> int:
    for row in list_sessions():
        print(f"  {row['id']}  {row.get('model', ''):<34} {row.get('title', '')[:60]}")
    return 0


def cmd_print(args: argparse.Namespace, cfg: Config) -> int:
    """One-shot: run a single prompt non-interactively."""
    import asyncio

    from .agent import Agent
    from .runtime import AuthRequired, resolve
    from .session import Session
    from .tools import ToolKit

    registry = _registry(cfg)
    try:
        resolved = resolve(cfg, registry)
    except AuthRequired as exc:
        print(exc, file=sys.stderr)
        return 2
    session = Session.new(str(Path.cwd()), cfg.model)
    tools = ToolKit(Path.cwd(), auto_approve=cfg.auto_approve)
    agent = Agent(client=resolved.client, session=session, tools=tools,
                  max_tokens=cfg.max_tokens, temperature=cfg.temperature,
                  max_steps=cfg.max_steps)

    async def _run() -> int:
        text_out: list[str] = []
        async for ev in agent.run_turn(args.prompt):
            if ev.kind == "text":
                text_out.append(ev.text)
                if not args.quiet:
                    print(ev.text, end="", flush=True)
            elif ev.kind == "tool_start" and not args.quiet:
                print(f"\n[tool {ev.tool} {json.dumps(ev.args)[:100]}]", file=sys.stderr)
            elif ev.kind == "error":
                print(f"\nerror: {ev.text}", file=sys.stderr)
                return 1
        if text_out and not args.quiet:
            print()
        return 0

    return asyncio.run(_run())


def main(argv: list[str] | None = None) -> int:
    # Windows consoles default to cp1252 — unicode output (✓, box drawing)
    # would crash. Replace-encode keeps the tool alive on any codepage.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, OSError):
            pass

    parser = argparse.ArgumentParser(prog="goat", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--version", action="version", version=f"goatcode {__version__}")
    parser.add_argument("-m", "--model", help="provider/model, e.g. openrouter/deepseek-ai/deepseek-v3.2")
    parser.add_argument("-p", "--print", dest="prompt", help="one-shot prompt, then exit")
    parser.add_argument("-q", "--quiet", action="store_true", help="with -p: no tool chatter")
    parser.add_argument("--plain", action="store_true", help="no colors/no prompt_toolkit (very old terminals)")
    parser.add_argument("--auto", action="store_true", help="auto-approve all tools")
    parser.add_argument("--resume", metavar="SESSION_ID", help="resume a saved session in the TUI")
    sub = parser.add_subparsers(dest="command")

    p_auth = sub.add_parser("auth", help="configure credentials")
    p_auth.add_argument("provider", nargs="?")
    p_auth.add_argument("--key")
    p_auth.add_argument("--oauth", action="store_true")
    p_auth.add_argument("--manual", action="store_true", help="paste code instead of local callback")
    p_auth.add_argument("--list-oauth", action="store_true")

    p_prov = sub.add_parser("providers", help="list providers")
    p_prov.add_argument("--check", action="store_true")

    p_models = sub.add_parser("models", help="list models for a provider")
    p_models.add_argument("provider")

    p_ep = sub.add_parser("endpoint", help="manage custom endpoints")
    p_ep.add_argument("action", choices=["add", "remove", "list"])
    p_ep.add_argument("id", nargs="?", default="")
    p_ep.add_argument("--base-url", default="")
    p_ep.add_argument("--format", default="openai",
                      choices=["openai", "claude", "openai-responses", "gemini"])
    p_ep.add_argument("--api-key", default=None)
    p_ep.add_argument("--api-key-env", default=None)
    p_ep.add_argument("--models", default="", help="comma-separated model ids")
    p_ep.add_argument("--label", default="")

    sub.add_parser("sessions", help="list saved sessions")

    args = parser.parse_args(argv)
    cfg = load_config(Path.cwd())
    if args.model:
        cfg.model = args.model
        cfg.split_model()
    if args.auto:
        cfg.auto_approve = True

    if args.command == "auth":
        return cmd_auth(args)
    if args.command == "providers":
        return cmd_providers(args)
    if args.command == "models":
        return cmd_models(args)
    if args.command == "endpoint":
        return cmd_endpoint(args)
    if args.command == "sessions":
        return cmd_sessions(args)
    if args.prompt:
        return cmd_print(args, cfg)

    registry = _registry(cfg)
    from .tui import run_tui
    run_tui(cfg, registry, plain=args.plain, resume=args.resume)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
