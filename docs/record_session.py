"""Record a real GoatCode v2 TUI session through a pty and replay it as
terminal frames — no screen capture, no focus stealing.

The TUI runs live (real Ink rendering, real agent loop) against the
deterministic mock provider; its raw ANSI stream is fed through pyte, a
spec-compliant terminal emulator, so each sampled snapshot is exactly what a
user's terminal showed at that instant — truecolor included.

  python docs/record_session.py            # writes docs/assets/frames/*.png
"""
from __future__ import annotations

import json
import os
import queue
import re
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

import pyte  # type: ignore
import winpty  # type: ignore

ROOT = Path(__file__).resolve().parent.parent
OUTDIR = ROOT / "docs" / "assets" / "frames"
PORT = int(os.environ.get("GOAT_MOCK_PORT", "31999"))

BUN = os.environ.get("GOAT_BUN", str(Path.home() / ".bun" / "bin" / "bun.exe"))

ROWS, COLS = 34, 96

DEMO = os.environ.get("GOAT_DEMO", "read")
DEMO_QUESTION = "what does @t.txt say?"


def truecolor_fg(c) -> tuple[int, int, int] | None:
    """pyte stores 24-bit colors as hex triplets ('ff8800') in graphic.fg when
    using SGR 38;2; — normalize to an RGB tuple or None (default)."""
    v = getattr(c, "fg", "default")
    if v in ("default", "", None):
        return None
    if re.fullmatch(r"[0-9a-fA-F]{6}", str(v)):
        s = str(v)
        return (int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16))
    return None


def truecolor_bg(c) -> tuple[int, int, int] | None:
    v = getattr(c, "bg", "default")
    if v in ("default", "", None):
        return None
    if re.fullmatch(r"[0-9a-fA-F]{6}", str(v)):
        s = str(v)
        return (int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16))
    return None


def main() -> None:
    # --- scratch config home ---
    goat_home = ROOT / "docs" / ".goatdemo-home"
    if goat_home.exists():
        shutil.rmtree(goat_home, ignore_errors=True)
    (goat_home / "sessions").mkdir(parents=True)
    # The banner shows a real model id; the "anthropic" endpoint is secretly
    # the local deterministic mock so every capture run is identical.
    cfg_obj = {
        "model": "anthropic/claude-sonnet-4-5",
        "max_tokens": 512,
        "endpoints": {
            "anthropic": {
                "base_url": f"http://127.0.0.1:{PORT}/v1",
                "format": "openai",
                "api_key": "demo-key",
                "models": ["claude-sonnet-4-5"],
            },
        },
    }
    if DEMO == "failover":
        # primary always 429s; the fallback answers on PORT+1
        cfg_obj["endpoints"]["fallback"] = {
            "base_url": f"http://127.0.0.1:{PORT + 1}/v1",
            "format": "openai",
            "api_key": "demo-key",
            "models": ["claude-sonnet-4-5"],
        }
        cfg_obj["fallback_models"] = ["fallback/claude-sonnet-4-5"]
    (goat_home / "config.json").write_text(json.dumps(cfg_obj, indent=2), encoding="utf-8")

    # --- demo project ---
    proj = ROOT / "docs" / ".goatdemo-proj"
    shutil.rmtree(proj, ignore_errors=True)
    proj.mkdir(parents=True, exist_ok=True)  # an orphaned winpty-agent may hold it as CWD
    (proj / "t.txt").write_text("hello from the goat pen\n", encoding="utf-8")

    # --- mock server(s) ---
    # failover scenario: primary "anthropic" is a dead provider (always 429),
    # fallback "fallback" is the normal scripted mock on PORT+1.
    failover = DEMO == "failover"
    extra_mock = None
    mock = None
    try:
        import urllib.request
        urllib.request.urlopen(f"http://127.0.0.1:{PORT}/v1/models", timeout=1)
    except Exception:
        mock = subprocess.Popen(
            [sys.executable, str(ROOT / "docs" / "mock_server.py"), "--port", str(PORT)],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            env={**os.environ, "GOAT_DEMO": "dead" if failover else DEMO})
        time.sleep(1.2)
    if failover:
        extra_mock = subprocess.Popen(
            [sys.executable, str(ROOT / "docs" / "mock_server.py"), "--port", str(PORT + 1)],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            env={**os.environ, "GOAT_DEMO": "read"})
        time.sleep(1.2)

    OUTDIR.mkdir(parents=True, exist_ok=True)
    for f in OUTDIR.glob("*.png"):
        f.unlink()
    (OUTDIR / "frames.json").unlink(missing_ok=True)

    env = dict(os.environ)
    env["GOATCODE_HOME"] = str(goat_home)
    env["GOAT_LOG"] = "0"
    env["TERM"] = "xterm-256color"
    env["FORCE_COLOR"] = "3"
    env["GOAT_MODEL"] = "anthropic/claude-sonnet-4-5"

    p = winpty.PtyProcess.spawn([BUN, "run", str(ROOT / "src" / "index.ts")],
                                cwd=str(proj), dimensions=(ROWS, COLS), env=env)
    stream = pyte.ByteStream()
    screen = pyte.Screen(COLS, ROWS)
    screen.set_mode(pyte.modes.LNM)
    stream.attach(screen)
    q: queue.Queue[bytes] = queue.Queue()

    def reader():
        while True:
            try:
                data = p.read(4096)
            except Exception:
                return
            if not data:
                return
            q.put(data)

    threading.Thread(target=reader, daemon=True).start()

    frames: list[dict] = []
    last_snap: list[float] = [0.0]

    def snap() -> bool:
        """Snapshot the current screen if content changed since last frame."""
        grid = []
        for y in range(ROWS):
            row = []
            for x in range(COLS):
                c = screen.buffer[y][x]
                ch = c.data if c.data != " " else " "
                row.append([ch, truecolor_fg(c), truecolor_bg(c), bool(c.bold)])
            grid.append(row)
        sig = json.dumps([r for r in grid]).__hash__()
        if frames and frames[-1]["_sig"] == sig:
            return False
        frames.append({"_sig": sig, "grid": grid})
        return True

    def drain(seconds: float) -> None:
        end = time.time() + seconds
        while time.time() < end:
            try:
                data = q.get(timeout=0.05)
                stream.feed(data if isinstance(data, bytes) else data.encode("utf-8", "replace"))
            except queue.Empty:
                pass
            if time.time() - last_snap[0] >= 0.10:
                snap()
                last_snap[0] = time.time()

    def send(text: str) -> None:
        p.write(text)
        time.sleep(0.45)
        p.write("\r")
        time.sleep(0.4)

    # boot + welcome
    drain(7.0)
    # type the question slowly so the GIF shows typing
    for ch in DEMO_QUESTION:
        p.write(ch)
        drain(0.055)
        snap()
        last_snap[0] = 0
    p.write("\r")
    # let the agent turn stream: tool call, result, streamed answer
    drain(24.0)
    snap()  # guarantee the final frame is the settled state

    try:
        p.terminate(force=True)
    except Exception:
        pass
    if mock:
        mock.terminate()

    for fr in frames:
        fr.pop("_sig", None)
    (OUTDIR / "frames.json").write_text(json.dumps(frames), encoding="utf-8")
    print(f"captured {len(frames)} frames -> {OUTDIR}/frames.json")


if __name__ == "__main__":
    main()
