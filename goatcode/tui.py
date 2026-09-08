"""GoatCode TUI — Claude Code-style streaming interface.

Design targets (mirroring claude code / opencode UX):
  • live streaming markdown with a working spinner + elapsed/tok status line
  • tool calls rendered as `● tool(args)` with `⎿` result lines underneath
  • ❯ prompt with a bottom status bar (mode · model · path)
  • slash-command completion menu with descriptions
  • Shift+Tab cycles accept-edits / plan-free modes
  • welcome panel with logo + tips on startup

`--plain` keeps a dumb-terminal fallback (no Live, no prompt_toolkit).
Scrollback-native: nothing is ever redrawn outside a transient Live region,
so it stays cheap on 4 GB machines.
"""
from __future__ import annotations

import asyncio
import json
import threading
import time
from pathlib import Path
from typing import Any

from prompt_toolkit import PromptSession
from prompt_toolkit.completion import Completer, Completion
from prompt_toolkit.formatted_text import HTML
from prompt_toolkit.history import FileHistory
from prompt_toolkit.key_binding import KeyBindings
from rich import box
from rich.console import Console, Group
from rich.live import Live
from rich.markdown import Markdown
from rich.panel import Panel
from rich.rule import Rule
from rich.spinner import Spinner
from rich.text import Text

from .agent import Agent
from .config import Config, app_dir, save_config
from .providers import Credential, OAUTH_PROVIDERS, ProviderRegistry
from .runtime import ResolveError, resolve
from .session import Session, list_sessions
from .tools import ToolKit
from . import oauth

LOGO = (
    " ██████╗  ██████╗  █████╗ ████████╗\n"
    "██╔════╝ ██╔═══██╗██╔══██╗╚══██╔══╝\n"
    "██║      ██║   ██║███████║   ██║\n"
    "██║      ██║   ██║██╔══██║   ██║\n"
    "╚██████╗ ╚██████╔╝██║  ██║   ██║\n"
    " ╚═════╝  ╚═════╝ ╚═╝  ╚═╝   ╚═╝"
)

ACCENT = "bright_yellow"       # claude orange
DIM = "dim"

SLASH_HELP: dict[str, str] = {
    "/help": "show all commands",
    "/model <provider/id>": "switch model",
    "/models": "models for the current provider",
    "/providers": "list all providers",
    "/auth <provider> --key <K>": "store an API key",
    "/auth <provider> --oauth": "subscription login (claude/codex/gemini/copilot/kimi/grok)",
    "/logout <provider>": "clear stored credentials",
    "/new": "start a fresh session",
    "/sessions": "list saved sessions",
    "/resume <id>": "continue a saved session",
    "/clear": "wipe this session's context",
    "/auto": "toggle auto-approve for tools",
    "/quit": "exit (or Ctrl+D)",
}
SLASH_COMMANDS = list(SLASH_HELP)


class SlashCompleter(Completer):
    """prompt_toolkit completer with descriptions in the menu."""

    def get_completions(self, document, complete_event):
        text = document.text_before_cursor
        if not text.startswith("/"):
            return
        word = text.split(" ")[0]
        for cmd, desc in SLASH_HELP.items():
            if cmd.startswith(word):
                yield Completion(cmd, start_position=-len(text), display_meta=desc)


def _key_bindings(toggle: callable) -> KeyBindings:
    kb = KeyBindings()

    # s-tab is prompt_toolkit's CSI-Z binding (Shift+Tab on Windows/VT terms);
    # Ctrl+O is the fallback for terminals that swallow Shift+Tab.
    @kb.add("c-o")
    @kb.add("s-tab")
    def _cycle(event):  # noqa: ANN001
        toggle()

    return kb


class TUI:
    def __init__(self, cfg: Config, registry: ProviderRegistry, plain: bool = False) -> None:
        self.cfg = cfg
        self.registry = registry
        self.plain = plain
        self.console = Console(highlight=False, no_color=plain)
        self.session = Session.new(str(Path.cwd()), cfg.model)
        self.agent: Agent | None = None
        self._prompt_session: PromptSession[str] | None = None
        # streaming state (shared between the agent task and the Live refresh)
        self._lock = threading.Lock()
        self._text_buf = ""
        self._status = ""
        self._tok_out = 0
        self._t0 = time.time()

    # ---------- setup ----------

    def build_agent(self) -> Agent | None:
        """Resolve provider/credentials. Returns None (after printing the
        error) when the model can't be used — the loop keeps running so the
        user can /model to something valid."""
        try:
            resolved = resolve(self.cfg, self.registry)
        except ResolveError as exc:
            self.console.print(f"[red]{exc}[/red]")
            return None
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
        preview = args.get("command") or args.get("path") or json.dumps(args)[:200]
        if tool == "edit":
            preview += f"  ({len(args.get('old_string', ''))} → {len(args.get('new_string', ''))} chars)"
        self.console.print()
        self.console.print(Panel(Text(str(preview)[:400], style="yellow"),
                                 title=f"● {tool} — allow?", border_style="yellow",
                                 box=box.ROUNDED, expand=False))
        answer = self._input("  [y]es · [n]o > ").strip().lower()
        return answer in ("y", "yes")

    def _input(self, prompt: str) -> str:
        # Plain input() on purpose: _confirm runs inside the asyncio loop
        # during tool dispatch, and a second prompt_toolkit event loop cannot
        # nest there. The Live region is stopped while this asks, so the
        # terminal is free.
        try:
            return input(prompt)
        except EOFError:
            return "n"

    def prompt_session(self) -> PromptSession[str]:
        if self._prompt_session is None:
            self._prompt_session = PromptSession(
                history=FileHistory(app_dir() / "history.txt"),
                completer=SlashCompleter(),
                complete_while_typing=True,
                multiline=False,
                key_bindings=_key_bindings(self._toggle_auto),
                bottom_toolbar=self._status_bar,
            )
        return self._prompt_session

    def _toggle_auto(self) -> None:
        self.cfg.auto_approve = not self.cfg.auto_approve
        self.agent = None
        msg = ("auto-approve ON — tools run without asking" if self.cfg.auto_approve
               else "manual approval — mutating tools will prompt")
        self.console.print(f"[{ACCENT}]⇄ {msg}[/{ACCENT}]")

    def _status_bar(self):
        mode = "auto-approve ON" if self.cfg.auto_approve else "ask before edits"
        path = str(Path(self.session.cwd)).replace(str(Path.home()), "~", 1)
        # prompt_toolkit's HTML parser has no &nbsp; entity — plain spaces only.
        return HTML(
            f"<b style='color:#d97706'>{mode}</b> <span style='color:#666'>(ctrl+o to cycle)</span>"
            f"  ·  <i>{self.cfg.model}</i>"
            f"  ·  <span style='color:#888'>{path}</span>"
            f"  ·  <span style='color:#888'>/help</span>"
        )

    # ---------- slash commands ----------

    def handle_slash(self, line: str) -> bool:
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
                self.console.print(f"[green]✓ model → {arg}[/green]")
                self.agent = None
            else:
                self.console.print(f"current model: [cyan]{self.cfg.model}[/cyan]")
        elif cmd in ("/provider", "/providers"):
            self._show_providers()
        elif cmd == "/models":
            self._show_models()
        elif cmd == "/auth":
            self._auth_command(rest)
        elif cmd == "/logout":
            if arg and self.registry.store.remove(arg):
                self.console.print(f"[green]✓ credentials cleared for {arg}[/green]")
            else:
                self.console.print("usage: /logout <provider>")
        elif cmd == "/new":
            self.session.save()
            self.session = Session.new(str(Path.cwd()), self.cfg.model)
            self.agent = None
            self.console.print("[green]✓ new session[/green]")
        elif cmd == "/clear":
            self.session.messages.clear()
            self.session.compacted_from = 0
            self.agent = None
            self.console.print("[green]✓ context cleared[/green]")
        elif cmd == "/sessions":
            for row in list_sessions():
                self.console.print(f"  [cyan]{row['id']}[/cyan]  {row.get('model', ''):<34} {row.get('title', '')[:52]}")
        elif cmd == "/resume":
            if not arg:
                self.console.print("usage: /resume <id>  (see /sessions)")
            else:
                try:
                    self.session = Session.load(arg)
                    self.agent = None
                    self.console.print(f"[green]✓ resumed {arg}[/green]")
                except FileNotFoundError:
                    self.console.print("[red]✗ no such session[/red]")
        elif cmd == "/approve":
            self.cfg.auto_approve = False
            self.agent = None
            self.console.print("manual approval ON")
        elif cmd == "/auto":
            self.cfg.auto_approve = True
            self.agent = None
            self.console.print(f"[{ACCENT}]auto-approve ON — tools run without asking[/]")
        elif cmd == "/compact":
            self.agent = None
            self.console.print("context will rebuild from the session tail on the next message")
        else:
            self.console.print(f"[red]✗ unknown command {cmd}[/red] — /help")
        return True

    def _show_help(self) -> None:
        for cmd, desc in SLASH_HELP.items():
            self.console.print(f"  [{ACCENT}]{cmd:<32}[/] {desc}")

    def _show_providers(self) -> None:
        rows = self.registry.list_all()
        ready = 0
        for p in rows:
            has = self.registry.resolve_credential(p.id)
            ready += bool(has)
            mark = "[green]✓[/]" if has else " "
            fmt = {"openai": "oai", "claude": "ant",
                   "openai-responses": "rsp", "gemini": "gem"}.get(p.format, p.format)
            self.console.print(f"  {mark} {p.id:<28} [{fmt}] {p.base_url[:52]}")
        self.console.print(f"  [dim]{ready}/{len(rows)} configured[/dim]")

    def _show_models(self) -> None:
        p = self.registry.get(self.cfg.provider)
        if not p:
            self.console.print("[red]✗ unknown provider[/red]")
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
            idx = rest.index("--key") + 1
            if idx >= len(rest):
                self.console.print("[red]usage: /auth <provider> --key <KEY>[/red]")
                return
            self.registry.store.put(pid, Credential(kind="api_key", api_key=rest[idx]))
            self.console.print(f"[green]✓ stored key for {pid}[/green]")
            self.agent = None
        elif "--oauth" in rest:
            self._oauth_login(pid)
        else:
            self.console.print("usage: /auth <provider> --key <K> | --oauth")

    def _oauth_login(self, pid: str) -> None:
        if pid not in OAUTH_PROVIDERS:
            self.console.print(f"[red]✗ {pid} has no OAuth flow[/red] — try: " + ", ".join(OAUTH_PROVIDERS))
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
            self.console.print(f"[red]✗ login failed:[/red] {exc}")
            return
        self.registry.store.put(pid, cred)
        meta = OAUTH_PROVIDERS[pid]
        self.console.print(f"[green]✓ logged in to {pid}[/green]  "
                           f"try: [cyan]/model {pid}/{meta.get('model_prefix', '')}…[/cyan]")
        self.agent = None

    # ---------- welcome ----------

    def _welcome(self) -> None:
        logo = Text(LOGO, style=ACCENT)
        info = Text.assemble(
            ("GoatCode", f"bold {ACCENT}"), ("  v0.1  ·  ", DIM),
            ("every provider, one terminal", DIM),
        )
        path = str(Path(self.session.cwd)).replace(str(Path.home()), "~", 1)
        body = Group(
            logo,
            info,
            Rule(style=DIM),
            Text(f"  model  {self.cfg.model}", style="white"),
            Text(f"  path   {path}", style="white"),
            Text.assemble(("  tips   ", DIM),
                          ("/", ACCENT), ("help · ", DIM),
                          ("/", ACCENT), ("providers · ", DIM),
                          ("shift+tab", ACCENT), (" or ", DIM),
                          ("ctrl+o", ACCENT), (" toggle auto-approve", DIM)),
        )
        self.console.print(Panel(body, box=box.ROUNDED, border_style=ACCENT,
                                 padding=(1, 2), expand=False))
        self.console.print()

    # ---------- main loop ----------

    async def run(self) -> None:
        if self.plain:
            await self._run_plain_loop()
            return
        self._welcome()
        loop = asyncio.get_event_loop()
        while True:
            try:
                line = await loop.run_in_executor(
                    None, lambda: self.prompt_session().prompt(
                        HTML(f"<b style='color:#d97706'>❯ </b>")))
            except (KeyboardInterrupt, EOFError):
                self.console.print("\n[dim]bye[/dim]")
                return
            line = (line or "").strip()
            if not line:
                continue
            if line.startswith("/"):
                try:
                    self.handle_slash(line)
                except KeyboardInterrupt:
                    self.console.print("[dim]bye[/dim]")
                    return
                continue
            if self.agent is None and self.build_agent() is None:
                continue
            await self._streamed_turn(line)

    async def _run_plain_loop(self) -> None:
        self.console.print(Text(LOGO, style="bold green"))
        self.console.print(f"model: {self.cfg.model}   cwd: {self.session.cwd}\n")
        while True:
            try:
                line = input("goat > ")
            except (KeyboardInterrupt, EOFError):
                self.console.print("\nbye")
                return
            line = line.strip()
            if not line:
                continue
            if line.startswith("/"):
                try:
                    self.handle_slash(line)
                except KeyboardInterrupt:
                    self.console.print("bye")
                    return
                continue
            if self.agent is None and self.build_agent() is None:
                continue
            await self._plain_turn(line)

    # ---------- rendering ----------

    def _frame(self) -> Group:
        """One Live frame: spinner + status line, then streamed markdown."""
        with self._lock:
            status, tok = self._status, self._tok_out
            md = self._text_buf
        elapsed = time.time() - self._t0
        tok_txt = f" · {tok} tok" if tok else ""
        spinner = Spinner(
            "dots",
            text=Text(f"  {status}  ({elapsed:.0f}s{tok_txt})  ctrl+c to interrupt", style=DIM),
            style=ACCENT,
        )
        parts: list = [spinner]
        if md:
            parts.append(Markdown(md))
        return Group(*parts)

    def _restart_live(self, live: Live | None) -> Live:
        if live is not None:
            live.stop()
        live = Live(self._frame(), console=self.console, refresh_per_second=12,
                    transient=True, vertical_overflow="visible")
        live.start()
        return live

    async def _streamed_turn(self, text: str) -> None:
        """Live region is only up while the event loop can actually refresh it
        (LLM streaming). Tool dispatch is synchronous — permission prompts and
        ●/⎿ lines print to scrollback with Live stopped, so nothing fights
        over the terminal."""
        assert self.agent is not None
        with self._lock:
            self._text_buf = ""
            self._status = "thinking…"
            self._tok_out = 0
        self._t0 = time.time()
        live: Live | None = None
        interrupted = False

        def stop_live() -> None:
            nonlocal live
            if live is not None:
                live.stop()
                live = None

        try:
            live = self._restart_live(None)
            async for ev in self.agent.run_turn(text):
                if ev.kind == "text":
                    with self._lock:
                        self._text_buf += ev.text
                elif ev.kind == "usage":
                    try:
                        with self._lock:
                            self._tok_out = int(ev.text.split("+")[1].split()[0])
                    except (IndexError, ValueError):
                        pass
                elif ev.kind == "tool_start":
                    # transient Live erases itself on stop — flush the streamed
                    # preamble to scrollback first, like Claude Code does.
                    stop_live()
                    with self._lock:
                        preamble, self._text_buf = self._text_buf, ""
                    if preamble.strip():
                        self.console.print(Markdown(preamble))
                    args = ev.args or {}
                    brief = (args.get("path") or args.get("command")
                             or args.get("pattern") or json.dumps(args))
                    self.console.print(f"[{ACCENT}]●[/] {ev.tool} [dim]{str(brief)[:120]}[/dim]")
                elif ev.kind == "tool_end":
                    first = ev.result.splitlines()[0][:160] if ev.result else ""
                    style = "green" if ev.ok else "red"
                    self.console.print(f"  [{style}]⎿[/] {'completed' if ev.ok else 'failed'}  [dim]{first}[/dim]")
                    with self._lock:
                        self._status = "thinking…"
                    self._t0 = time.time()
                    live = self._restart_live(None)  # next model turn is streaming
                elif ev.kind == "error":
                    stop_live()
                    self.console.print(f"[red]✗ {ev.text}[/red]")
                    return
        except KeyboardInterrupt:
            interrupted = True
        finally:
            stop_live()
            with self._lock:
                final = self._text_buf
            if final:
                self.console.print(Markdown(final))
            if interrupted:
                self.console.print("[yellow]⚠ interrupted — send a new message to continue[/yellow]")
        self.console.print()

    async def _plain_turn(self, text: str) -> None:
        """No Live, no markdown widgets — plain writes only."""
        assert self.agent is not None
        header = False
        try:
            async for ev in self.agent.run_turn(text):
                if ev.kind == "text":
                    if not header:
                        self.console.print("goat ", end="")
                        header = True
                    self.console.print(ev.text, end="", markup=False, highlight=False)
                elif ev.kind == "tool_start":
                    header = False
                    args = ev.args or {}
                    brief = args.get("path") or args.get("command") or args.get("pattern") or json.dumps(args)[:80]
                    self.console.print(f"[tool {ev.tool}] {str(brief)[:120]}")
                elif ev.kind == "tool_end":
                    first = ev.result.splitlines()[0][:160] if ev.result else ""
                    self.console.print(f"  {'ok' if ev.ok else 'failed'}  {first}")
                elif ev.kind == "error":
                    self.console.print(f"error: {ev.text}")
                elif ev.kind == "done" and header:
                    self.console.print()
        except KeyboardInterrupt:
            self.console.print("\n⚠ interrupted")
        finally:
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
            app.console.print(f"[red]✗ no session {resume}[/red]")
            return
    try:
        asyncio.run(app.run())
    except KeyboardInterrupt:
        print("\nbye")
