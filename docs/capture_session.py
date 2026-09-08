"""Capture a real GoatCode session (actual TUI code paths, forced-color console)
to an ANSI file for rendering into README assets. Run with the mock server up.
"""
from __future__ import annotations

import asyncio
import io
import os
import sys
from pathlib import Path

from rich.console import Console

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
tui = TUI(cfg, ProviderRegistry(cfg.endpoints), plain=True)
tui.console = Console(file=buf, force_terminal=True, width=88, color_system="truecolor")


async def main() -> None:
    from rich.text import Text
    from goatcode import tui as tui_mod
    tui_mod.BANNER = tui_mod.BANNER  # keep banner
    tui.console.print(Text(tui_mod.BANNER, style="bold green"))
    tui.console.print(f"model: [cyan]{cfg.model}[/cyan]   cwd: demo-project")
    tui.console.print()
    tui.console.print("goat > [bold]what does t.txt say?[/bold]")
    tui.agent = tui.build_agent()
    await tui._run_turn("what does t.txt say?")
    tui.console.print()
    tui.console.print("goat > [bold]/model openrouter/deepseek-ai/deepseek-v3.2[/bold]")
    tui.handle_slash("/model openrouter/deepseek-ai/deepseek-v3.2")
    tui.console.print("goat > [bold]/providers[/bold]")
    before = len(buf.getvalue())
    tui.handle_slash("/providers")
    # keep only the first few provider rows — 181 lines flood the frame
    tail = buf.getvalue()[before:].split("\n")
    buf.truncate(before)
    buf.seek(before)  # truncate() leaves the position at the old end -> NUL padding
    buf.write("\n".join(tail[:6]) + "\n   … 181 providers total\n")
    OUT.write_text(buf.getvalue(), encoding="utf-8")
    print(f"wrote {OUT} ({len(buf.getvalue())} bytes)")


asyncio.run(main())
