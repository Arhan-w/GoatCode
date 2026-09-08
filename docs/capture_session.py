"""Capture a real GoatCode session (actual TUI code paths, forced-color console)
to an ANSI file for rendering into README assets. Run with the mock server up.

The Live region is transient and would smear across frames on a file-backed
console, so this drives the same widgets the live TUI uses — _welcome(), the
●/⎿ tool lines, and the final Markdown render — in scrollback order.
"""
from __future__ import annotations

import asyncio
import io
import os
import sys
from pathlib import Path

from rich.console import Console
from rich.markdown import Markdown

sys.path.insert(0, str(Path(__file__).parent.parent))
from goatcode.config import load_config
from goatcode.providers import ProviderRegistry
from goatcode.tui import TUI

# Seed a few so /providers shows real check marks in the demo.
os.environ.setdefault("OPENAI_API_KEY", "sk-demo")
os.environ.setdefault("GROQ_API_KEY", "gsk-demo")
os.environ.setdefault("DEEPSEEK_API_KEY", "sk-demo")

OUT = Path(sys.argv[1] if len(sys.argv) > 1 else "session.ansi")

buf = io.StringIO()
cfg = load_config(Path.cwd())
cfg.model = "mock/test-model"
cfg.split_model()
cfg.auto_approve = True
tui = TUI(cfg, ProviderRegistry(cfg.endpoints), plain=False)
tui.console = Console(file=buf, force_terminal=True, width=88, color_system="truecolor")


async def main() -> None:
    tui._welcome()
    tui.console.print("[bold]❯[/bold] what does t.txt say?")
    tui.agent = tui.build_agent()
    # Drive the real event rendering from _streamed_turn's tool/text paths.
    answer = ""
    async for ev in tui.agent.run_turn("what does t.txt say?"):
        if ev.kind == "tool_start":
            args = ev.args or {}
            brief = args.get("path") or args.get("command") or args.get("pattern")
            tui.console.print(f"[bright_yellow]●[/] {ev.tool} [dim]{str(brief)[:120]}[/dim]")
        elif ev.kind == "tool_end":
            first = ev.result.splitlines()[0][:160] if ev.result else ""
            style = "green" if ev.ok else "red"
            tui.console.print(f"  [{style}]⎿[/] {'completed' if ev.ok else 'failed'}  [dim]{first}[/dim]")
        elif ev.kind == "text":
            answer += ev.text
        elif ev.kind == "error":
            tui.console.print(f"[red]✗ {ev.text}[/red]")
    if answer:
        tui.console.print(Markdown(answer))
    tui.console.print()
    tui.console.print("[bold]❯[/bold] /model openrouter/deepseek-ai/deepseek-v3.2")
    tui.handle_slash("/model openrouter/deepseek-ai/deepseek-v3.2")
    tui.console.print("[bold]❯[/bold] /providers")
    before = len(buf.getvalue())
    tui.handle_slash("/providers")
    # keep only the first few provider rows — 181 lines flood the frame
    tail = buf.getvalue()[before:].split("\n")
    buf.truncate(before)
    buf.seek(before)  # truncate() leaves the position at the old end -> NUL padding
    buf.write("\n".join(tail[:6]) + "\n   … 183 providers total\n")
    OUT.write_text(buf.getvalue(), encoding="utf-8")
    print(f"wrote {OUT} ({len(buf.getvalue())} bytes)")


asyncio.run(main())
