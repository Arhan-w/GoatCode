"""Capture deterministic demo GIFs for GoatCode v3 features.

  python docs/capture_v3.py [scenario]   # code, collab, share, ultra
"""
from __future__ import annotations
import json, os, queue, shutil, subprocess, sys, threading, time
from pathlib import Path
import pyte, winpty

ROOT = Path(__file__).resolve().parent.parent
OUTDIR = ROOT / "docs" / "assets" / "frames"
PORT = int(os.environ.get("GOAT_MOCK_PORT", "31999"))
BUN = os.environ.get("GOAT_BUN", str(Path.home() / ".bun" / "bin" / "bun.exe"))
ROWS, COLS = 34, 96
SCENARIO = sys.argv[1] if len(sys.argv) > 1 else "code"


def _tc(c):
    v = getattr(c, "fg", "default")
    if v in ("default", "", None): return None
    import re
    if re.fullmatch(r"[0-9a-fA-F]{6}", str(v)):
        s = str(v); return (int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16))
    return None


def run_scenario():
    goat_home = ROOT / "docs" / ".goatdemo-home"
    if goat_home.exists(): shutil.rmtree(goat_home, ignore_errors=True)
    (goat_home / "sessions").mkdir(parents=True)
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
    if SCENARIO == "code":
        (goat_home / "config.json").write_text(json.dumps(cfg_obj, indent=2), encoding="utf-8")
    proj = ROOT / "docs" / ".goatdemo-proj"
    shutil.rmtree(proj, ignore_errors=True)
    proj.mkdir(parents=True, exist_ok=True)
    (proj / "t.txt").write_text("hello from the goat pen\n", encoding="utf-8")
    if SCENARIO == "code":
        (proj / "src").mkdir(parents=True)
        (proj / "src" / "main.ts").write_text('const x: number = 1;\nconsole.log(x);\n', encoding="utf-8")
    if SCENARIO == "collab":
        os.environ["GOAT_COLLAB_INVITE"] = "v1.urn:goat:collaborate:00000000000000000000000000000000:00000000"
    mock = None
    try:
        import urllib.request
        urllib.request.urlopen(f"http://127.0.0.1:{PORT}/v1/models", timeout=1)
    except Exception:
        mock = subprocess.Popen(
            [sys.executable, str(ROOT / "docs" / "mock_server.py"), "--port", str(PORT)],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            env={**os.environ, "GOAT_DEMO": SCENARIO})
        time.sleep(1.2)
    OUTDIR.mkdir(parents=True, exist_ok=True)
    for f in OUTDIR.glob("*.png"): f.unlink()
    (OUTDIR / "frames.json").unlink(missing_ok=True)
    env = dict(os.environ)
    env["GOATCODE_HOME"] = str(goat_home)
    env["GOAT_LOG"] = "0"
    env["TERM"] = "xterm-256color"
    env["FORCE_COLOR"] = "3"
    env["GOAT_MODEL"] = "anthropic/claude-sonnet-4-5"
    env["GOAT_DEMO"] = SCENARIO
    p = winpty.PtyProcess.spawn([BUN, "run", str(ROOT / "src" / "index.ts")],
                                    cwd=str(proj), dimensions=(ROWS, COLS), env=env)
    stream = pyte.ByteStream()
    screen = pyte.Screen(COLS, ROWS)
    screen.set_mode(pyte.modes.LNM)
    stream.attach(screen)
    q: queue.Queue[bytes] = queue.Queue()
    def reader():
        while True:
            try: data = p.read(4096)
            except Exception: return
            if not data: return
            q.put(data)
    threading.Thread(target=reader, daemon=True).start()
    frames: list[dict] = []
    last_snap = [0.0]
    def snap() -> bool:
        grid = []
        for y in range(ROWS):
            row = []
            for x in range(COLS):
                c = screen.buffer[y][x]
                ch = c.data if c.data != " " else " "
                row.append([ch, _tc(c), None, bool(c.bold)])
            grid.append(row)
        sig = json.dumps([r for r in grid]).__hash__()
        if frames and frames[-1]["_sig"] == sig: return False
        frames.append({"_sig": sig, "grid": grid})
        return True
    def drain(seconds: float) -> None:
        end = time.time() + seconds
        while time.time() < end:
            try:
                data = q.get(timeout=0.05)
                stream.feed(data if isinstance(data, bytes) else data.encode("utf-8", "replace"))
            except queue.Empty: pass
            if time.time() - last_snap[0] >= 0.10:
                snap(); last_snap[0] = time.time()
    def send(text: str) -> None:
        p.write(text); time.sleep(0.45); p.write("\r"); time.sleep(0.4)
    # boot
    drain(7.0)
    if SCENARIO == "code":
        send("/index"); drain(3.0)
        send("/find x"); drain(3.0)
    elif SCENARIO == "collab":
        send("hello from goat"); drain(4.0)
    elif SCENARIO == "share":
        send("/share"); drain(5.0)
    elif SCENARIO == "ultra":
        send("/ultracode build a tiny CLI tool"); drain(5.0)
        drain(12.0)
    try: p.terminate(force=True)
    except Exception: pass
    if mock: mock.terminate()
    for fr in frames: fr.pop("_sig", None)
    (OUTDIR / "frames.json").write_text(json.dumps(frames), encoding="utf-8")
    print(f"captured {len(frames)} frames -> {OUTDIR}/frames.json [{SCENARIO}]")


if __name__ == "__main__":
    run_scenario()
