"""GoatCode TUI: streaming chat REPL built on prompt_toolkit + rich.

Deliberately scrollback-native (no alt-screen redraw loop) so it stays smooth
on 4 GB machines and dumb terminals. `--plain` drops prompt_toolkit entirely.
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

from prompt_toolkit import PromptSession
from prompt_toolkit.completion import WordCompleter
from prompt_toolkit.history import FileHistory
from rich.console import Console
from rich.panel import Panel
from rich.text import Text

from .agent import Agent
from .config import Config, app_dir, save_config
from .providers import Credential, OAUTH_PROVIDERS, ProviderRegistry
from .runtime import AuthRequired, resolve
from .session import Session, list_sessions
from .tools import ToolKit
from . import oauth

BANNER = r"""
  ▄▄▄   ▄▄▄  ▄▄▄  ▄▄▄  ▄▄▄
  █  █  █    █  █ █  █ █
  █  █  █▄▄  █▄▄  █▄▄  ▀▀▀█
        GoatCode — every provider, one terminal
"""

SLASH_COMMANDS = [
    "/help", "/model", "/models", "/provider", "/providers", "/auth", "/logout",
    "/new", "/resume", "/sessions", "/approve", "/auto", "/compact", "/quit",
]


class TUI:
    def __init__(self, cfg: Config, registry: ProviderRegistry, plain: bool = False) -> None:
        self.cfg = cfg
        self.registry = registry
        self.plain = plain
        self.console = Console(highlight=False, no_color=plain)
        self.session = Session.new(str(Path.cwd()), cfg.model)
        self.agent: Agent | None = None
        self._prompt_session: PromptSession[str] | None = None

    # ---------- setup ----------

    def build_agent(self) -> Agent:
        try:
            resolved = resolve(self.cfg, self.registry)
        except AuthRequired as exc:
            self.console.print(f"[red]{exc}[/red]")
            raise SystemExit(2) from None
        self.session.model = resolved.provider.id + "/" + self.cfg.model_id
        tools = ToolKit(Path(self.session.cwd), permission=self._confirm,
                        auto_approve=self.cfg.auto_approve)
        self.agent = Agent(
            client=resolved.client, session=self.session, tools=tools,
            max_tokens=self.cfg.max_tokens, temperature=self.cfg.temperature,
            max_steps=self.cfg.max_steps,
        )
        return self.agent

    def _confirm(self, tool: str, args: dict[str, Any]) -> bool:
        """Interactive permission prompt for mutating tools."""
        if tool == "bash":
            preview = args.get("command", "")
        else:
            preview = args.get("path", "")
            if tool == "edit":
                preview += f"  ({len(args.get('old_string', ''))} -> {len(args.get('new_string', ''))} chars)"
        self.console.print(Panel(Text(preview[:400]), title=f"allow {tool}?", border_style="yellow"))
        answer = self._input("[y]es / [n]o > ").strip().lower()
        return answer in ("y", "yes")

    def _input(self, prompt: str) -> str:
        if self.plain or self._prompt_session is None:
            try:
                return input(prompt)
            except EOFError:
                return "/quit"
        return self.prompt_session().prompt(prompt)

    def prompt_session(self) -> PromptSession[str]:
        if self._prompt_session is None:
            self._prompt_session = PromptSession(
                history=FileHistory(app_dir() / "history.txt"),
                completer=WordCompleter(SLASH_COMMANDS, sentence_start=True),
                multiline=False,
            )
        return self._prompt_session

    # ---------- slash commands ----------

    def handle_slash(self, line: str) -> bool:
        """Returns True if handled (skip agent)."""
        parts = line.split()
        cmd, rest = parts[0], parts[1:]
        arg = rest[0] if rest else ""
        if cmd == "/quit":
            raise KeyboardInterrupt
        if cmd == "/help":
            self._show_help()
        elif cmd == "/model":
            if arg:
                self.cfg.model = arg
                self.cfg.split_model()
                self.session.model = arg
                save_config(self.cfg)
                self.console.print(f"[green]model -> {arg}[/green]")
                self.agent = None  # rebuild on next message
            else:
                self.console.print(f"current: {self.cfg.model}")
        elif cmd in ("/provider", "/providers"):
            self._show_providers()
        elif cmd == "/models":
            self._show_models()
        elif cmd == "/auth":
            self._auth_command(rest)
        elif cmd == "/logout":
            if arg and self.registry.store.remove(arg):
                self.console.print(f"[green]credentials cleared for {arg}[/green]")
            else:
                self.console.print("usage: /logout <provider>")
        elif cmd == "/new":
            self.session.save()
            self.session = Session.new(str(Path.cwd()), self.cfg.model)
            self.agent = None
            self.console.print("[green]new session[/green]")
        elif cmd == "/sessions":
            for row in list_sessions():
                self.console.print(f"  {row['id']}  {row.get('model', '')}  {row.get('title', '')[:60]}")
        elif cmd == "/resume":
            if not arg:
                self.console.print("usage: /resume <id>  (see /sessions)")
            else:
                try:
                    self.session = Session.load(arg)
                    self.agent = None
                    self.console.print(f"[green]resumed {arg}[/green]")
                except FileNotFoundError:
                    self.console.print("[red]no such session[/red]")
        elif cmd == "/approve":
            self.cfg.auto_approve = False
            self.agent = None
            self.console.print("manual approval ON")
        elif cmd == "/auto":
            self.cfg.auto_approve = True
            self.agent = None
            self.console.print("[yellow]auto-approve ON — tools run without asking[/yellow]")
        elif cmd == "/compact":
            self.agent = None
            self.console.print("context will rebuild from session tail on next message")
        else:
            self.console.print(f"[red]unknown command {cmd}[/red] — /help")
        return True

    def _show_help(self) -> None:
        rows = [
            "/model <provider/id>", "switch model (e.g. /model openrouter/deepseek-ai/deepseek-v3.2)",
            "/providers", "list all 180+ providers",
            "/models", "models for the current provider",
            "/auth <provider> --key <K>", "store an API key",
            "/auth <provider> --oauth", "browser OAuth (claude, codex, gemini, github-copilot, kimi, grok)",
            "/new /resume <id> /sessions", "session management",
            "/approve /auto", "tool permission mode",
            "/quit", "exit",
        ]
        for i in range(0, len(rows), 2):
            self.console.print(f"[cyan]{rows[i]:<34}[/cyan] {rows[i + 1]}")

    def _show_providers(self) -> None:
        for p in self.registry.list_all():
            mark = "[green]✓[/green]" if self.registry.resolve_credential(p.id) else " "
            fmt = {"openai": "oai", "claude": "ant", "openai-responses": "rsp", "gemini": "gem"}.get(p.format, p.format)
            self.console.print(f" {mark} {p.id:<28} [{fmt}] {p.base_url[:52]}")

    def _show_models(self) -> None:
        p = self.registry.get(self.cfg.provider)
        if not p:
            self.console.print("[red]unknown provider[/red]")
            return
        for m in p.models or ["(no catalog models — type any model id)"]:
            self.console.print(f"  {p.id}/{m}")

    def _auth_command(self, rest: list[str]) -> None:
        if not rest:
            self.console.print("usage: /auth <provider> --key <K> | --oauth")
            self.console.print("oauth: " + ", ".join(OAUTH_PROVIDERS))
            return
        pid = rest[0]
        if "--key" in rest:
            key = rest[rest.index("--key") + 1]
            self.registry.store.put(pid, Credential(kind="api_key", api_key=key))
            self.console.print(f"[green]stored key for {pid}[/green]")
            self.agent = None
        elif "--oauth" in rest:
            self._oauth_login(pid)
        else:
            self.console.print("usage: /auth <provider> --key <K> | --oauth")

    def _oauth_login(self, pid: str) -> None:
        if pid not in OAUTH_PROVIDERS:
            self.console.print(f"[red]{pid} has no OAuth flow[/red] — try: " + ", ".join(OAUTH_PROVIDERS))
            return
        try:
            flow = OAUTH_PROVIDERS[pid].get("flow", "browser")
            if flow == "device":
                cred = oauth.login_device(pid)
            elif flow == "import":
                cred = oauth.login_import(pid)
            else:
                cred = oauth.login_oauth(pid, manual_paste=self.plain)
        except Exception as exc:  # noqa: BLE001
            self.console.print(f"[red]login failed:[/red] {exc}")
            return
        self.registry.store.put(pid, cred)
        self.console.print(f"[green]logged in to {pid}[/green]")
        meta = OAUTH_PROVIDERS[pid]
        sample = meta.get("model_prefix", "")
        self.console.print(f"try: /model {pid}/{sample}-...  (see /models)")
        self.agent = None

    # ---------- main loop ----------

    async def run(self) -> None:
        self.console.print(Text(BANNER, style="bold green"))
        self.console.print(f"model: [cyan]{self.cfg.model}[/cyan]   cwd: {self.session.cwd}"
                           f"   (Ctrl+C cancels generation, /help for commands)\n")
        loop = asyncio.get_event_loop()
        while True:
            try:
                if self.plain:
                    line = input("goat > ")
                else:
                    line = await loop.run_in_executor(None, self.prompt_session().prompt, "goat > ")
            except (KeyboardInterrupt, EOFError):
                self.console.print("\n[dim]bye[/dim]")
                return
            line = line.strip()
            if not line:
                continue
            if line.startswith("/"):
                try:
                    self.handle_slash(line)
                except KeyboardInterrupt:
                    self.console.print("[dim]bye[/dim]")
                    return
                continue
            if self.agent is None:
                try:
                    self.agent = self.build_agent()
                except SystemExit:
                    continue
            await self._run_turn(line)

    async def _run_turn(self, text: str) -> None:
        assert self.agent is not None
        streaming_header = False
        try:
            async for ev in self.agent.run_turn(text):
                if ev.kind == "text":
                    if not streaming_header:
                        self.console.print("[bold cyan]goat[/bold cyan] ", end="")
                        streaming_header = True
                    self.console.print(ev.text, end="", markup=False, highlight=False)
                elif ev.kind == "usage":
                    self.console.print(f"\n[dim]{ev.text}[/dim]")
                elif ev.kind == "tool_start":
                    streaming_header = False
                    args = ev.args or {}
                    brief = args.get("path") or args.get("command") or args.get("pattern") or json.dumps(args)[:80]
                    self.console.print(f"[magenta]● {ev.tool}[/magenta] [dim]{str(brief)[:120]}[/dim]")
                elif ev.kind == "tool_end":
                    style = "green" if ev.ok else "red"
                    first = ev.result.splitlines()[0][:160] if ev.result else ""
                    self.console.print(f"  [{style}]{'ok' if ev.ok else 'failed'}[/] [dim]{first}[/dim]")
                elif ev.kind == "error":
                    streaming_header = False
                    self.console.print(f"\n[red]error:[/red] {ev.text}")
                elif ev.kind == "done":
                    if streaming_header:
                        self.console.print()
                    streaming_header = False
        except KeyboardInterrupt:
            self.console.print("\n[yellow]interrupted[/yellow]")
        except Exception as exc:  # noqa: BLE001
            self.console.print(f"\n[red]fatal:[/red] {type(exc).__name__}: {exc}")
        finally:
            if self.agent:
                self.agent.session.save()


def run_tui(cfg: Config, registry: ProviderRegistry, plain: bool = False,
            resume: str | None = None) -> None:
    app = TUI(cfg, registry, plain=plain)
    if resume:
        try:
            app.session = Session.load(resume)
            cfg.model = app.session.model
            cfg.split_model()
        except FileNotFoundError:
            app.console.print(f"[red]no session {resume}[/red]")
            return
    try:
        asyncio.run(app.run())
    except KeyboardInterrupt:
        print("\nbye")
