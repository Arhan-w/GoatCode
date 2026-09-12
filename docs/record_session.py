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
DEMO_QUESTION = {
    "write": "create notes.txt with the line: hello from the goat pen",
    "todo": "track a 3-step plan: scan, group, triage",
    "codegraph": "/index",          # custom driver below sends both commands
    "goatmode": "run: echo goat mode works",
}.get(DEMO, "what does @t.txt say?")


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
        "repos": [str((ROOT / "docs" / ".goatdemo-proj" / "src").resolve())],
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

    # Stage tree-sitter wasm into appDir()/vendor so /index uses the real
    # parser (TS/JS/Go) instead of the regex heuristic — resolver candidate #3.
    vendor = goat_home / "vendor"
    vendor.mkdir(parents=True, exist_ok=True)
    nm = ROOT / "node_modules"
    shutil.copy(nm / "web-tree-sitter" / "tree-sitter.wasm", vendor / "tree-sitter.wasm")
    wasms_out = nm / "tree-sitter-wasms" / "out"
    for g in ("tsx", "javascript", "python", "go"):
        src = wasms_out / f"tree-sitter-{g}.wasm"
        if src.exists():
            shutil.copy(src, vendor / src.name)

    # --- demo project ---
    proj = ROOT / "docs" / ".goatdemo-proj"
    shutil.rmtree(proj, ignore_errors=True)
    proj.mkdir(parents=True, exist_ok=True)  # an orphaned winpty-agent may hold it as CWD
    (proj / "t.txt").write_text("hello from the goat pen\n", encoding="utf-8")

    # TS sources for the codegraph capture (repos → .../.goatdemo-proj/src)
    srcdir = proj / "src"
    srcdir.mkdir(parents=True, exist_ok=True)
    (srcdir / "users.ts").write_text(
        "import { db } from './db.ts';\n\n"
        "export interface User { id: string; email: string; quota: number }\n\n"
        "export async function createUser(email: string): Promise<User> {\n"
        "  const user = { id: crypto.randomUUID(), email, quota: 100 };\n"
        "  await db.insert('users', user);\n"
        "  return user;\n}\n\n"
        "export async function findUser(id: string): Promise<User | null> {\n"
        "  return db.selectOne('users', { id });\n}\n", encoding="utf-8")
    (srcdir / "db.ts").write_text(
        "export const db = {\n"
        "  async insert(table: string, row: object) { /* … */ },\n"
        "  async selectOne(table: string, where: object) { return null; },\n};\n", encoding="utf-8")
    (srcdir / "api.ts").write_text(
        "import { createUser } from './users.ts';\n\n"
        "export async function handleSignup(email: string) {\n"
        "  const user = await createUser(email);\n"
        "  return Response.json(user);\n}\n", encoding="utf-8")

    # The wasm resolver's first candidate is <cwd>/node_modules/…; the TUI runs
    # in proj, so link the repo's node_modules in for a real (non-heuristic) parse.
    # Junction (no elevation on Windows) → symlink → copy fallback.
    link = proj / "node_modules"
    try:
        link.symlink_to(nm, target_is_directory=True)
    except OSError:
        try:
            subprocess.run(f'mklink /J "{link}" "{nm}"', shell=True, check=True,
                           capture_output=True)
        except Exception:
            shutil.copytree(nm, link)

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

    # boot + welcome — v3 needs longer for async MCP/skills init + auth probe
    drain(15.0)

    def send(text: str) -> None:
        """Type text char-by-char (triggers autocomplete), accept suggestion, submit."""
        for ch in text:
            p.write(ch); drain(0.10)
        drain(0.6)
        p.write("\r"); drain(0.5)   # accept completion (or submit if no completion)
        p.write("\r"); drain(1.0)   # submit the command

    if DEMO == "codegraph":
        # /index → wait for completion → /find <symbol>
        send("/index")
        drain(7.0)
        snap()
        send("/find createUser")
        drain(4.0)
    elif DEMO == "goatmode":
        # write request → permission dialog appears → shift+tab x3 into GOAT
        # MODE, which resolves the open prompt YES (mid-turn, no clicks)
        for ch in "create notes.txt with the line: hello from the goat pen":
            p.write(ch); drain(0.055)
        p.write("\r"); drain(6.0)           # dialog is up now
        for _ in range(3):
            p.write("\x1b[Z"); drain(1.0)   # ask → accept-edits → plan → bypass
        drain(20.0)                          # write + diff stream with no prompts
    elif DEMO == "read":
        # type the question slowly so the GIF shows typing
        for ch in DEMO_QUESTION:
            p.write(ch); drain(0.055)
            snap()
            last_snap[0] = 0
        p.write("\r")
        # let the agent turn stream: tool call, result, streamed answer
        drain(6.0)
    else:
        # write / todo: normal question + permission dialog
        for ch in DEMO_QUESTION:
            p.write(ch); drain(0.055)
            snap()
            last_snap[0] = 0
        p.write("\r")
        # let the agent turn stream: tool call, result, streamed answer
        # auto-approve the permission dialog when the demo writes a file
        if DEMO == "write":
            drain(6.0)
            p.write("\r")  # Enter = Yes on the dialog
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
