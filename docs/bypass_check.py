"""Prove bypass mode really works: boot with auto_approve=true (bypass), send a
write prompt, assert NO permission dialog ever appears and the write completes.
Then boot in default mode and assert the dialog DOES appear (control group).

  python docs/bypass_check.py
"""
from __future__ import annotations
import json, os, queue, shutil, subprocess, sys, threading, time
from pathlib import Path
import pyte, winpty

ROOT = Path(__file__).resolve().parent.parent
BUN = str(Path.home() / ".bun" / "bin" / "bun.exe")
ROWS, COLS = 30, 96


def run(auto_approve: bool) -> list[str]:
    home = ROOT / "docs" / ".bypass-home"
    proj = ROOT / "docs" / ".bypass-proj"
    for d in (home, proj):
        shutil.rmtree(d, ignore_errors=True)
    (home / "sessions").mkdir(parents=True)
    proj.mkdir(parents=True)
    cfg = {"model": "anthropic/claude-sonnet-4-5", "max_tokens": 512,
           "auto_approve": auto_approve,
           "endpoints": {"anthropic": {"base_url": "http://127.0.0.1:31998/v1", "format": "openai",
                                        "api_key": "k", "models": ["claude-sonnet-4-5"]}}}
    (home / "config.json").write_text(json.dumps(cfg), encoding="utf-8")
    mock = subprocess.Popen([sys.executable, str(ROOT / "docs" / "mock_server.py"), "--port", "31998"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                            env=dict(os.environ, GOAT_DEMO="write"))
    env = dict(os.environ, GOATCODE_HOME=str(home), GOAT_LOG="0",
               TERM="xterm-256color", FORCE_COLOR="3")
    p = winpty.PtyProcess.spawn([BUN, "run", str(ROOT / "src" / "index.ts")], cwd=str(proj),
                                dimensions=(ROWS, COLS), env=env)
    screen = pyte.Screen(COLS, ROWS)
    stream = pyte.ByteStream(); stream.attach(screen)
    q: queue.Queue = queue.Queue()
    def reader():
        while True:
            try: d = p.read(4096)
            except Exception: return
            if not d: return
            q.put(d if isinstance(d, bytes) else d.encode())
    threading.Thread(target=reader, daemon=True).start()
    def drain(sec):
        end = time.time() + sec
        while time.time() < end:
            try: stream.feed(q.get(timeout=0.05))
            except queue.Empty: pass
    drain(6)
    for ch in "create notes.txt with the line: hello from the goat pen":
        p.write(ch); drain(0.03)
    p.write("\r")
    drain(14)
    # snapshot every visible row
    rows = []
    for y in range(ROWS):
        rows.append("".join(screen.buffer[y][x].data for x in range(COLS)).rstrip())
    try: p.terminate(force=True)
    except Exception: pass
    mock.terminate()
    written = (proj / "notes.txt").exists()
    shutil.rmtree(home, ignore_errors=True); shutil.rmtree(proj, ignore_errors=True)
    return rows, written


def dialog_seen(rows): return any("allow?" in r for r in rows)

print("== bypass (auto_approve=true) ==")
rows_b, written_b = run(True)
print("  dialog appeared:", dialog_seen(rows_b), "(want False)")
print("  notes.txt written:", written_b, "(want True)")
print("  footer:", next((r.strip()[:80] for r in rows_b if "GOAT MODE" in r or "ask before" in r), "?"))

print("== control (default mode) ==")
rows_d, written_d = run(False)
print("  dialog appeared:", dialog_seen(rows_d), "(want True)")

ok = (not dialog_seen(rows_b)) and written_b and dialog_seen(rows_d)
print("\nRESULT:", "PASS — bypass really bypasses" if ok else "FAIL")
sys.exit(0 if ok else 1)
