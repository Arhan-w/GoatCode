"""Repro harness: boot the TUI in a pty, capture frames, hunt render artifacts.

Artifact checks per frame:
  - input box drawn more than once (duplicate top-border rows)
  - stray unclosed box (top border without bottom border)
  - frame with the status line above the input box (wrong order)

  python docs/render_repro.py [mcp]   # 'mcp' adds a dummy MCP server to trigger async banner
Set GOAT_DEMO=long for the viewport stress (streams 30+ lines mid-turn).
"""
from __future__ import annotations
import json, os, queue, shutil, subprocess, sys, threading, time
from pathlib import Path
import pyte, winpty

ROOT = Path(__file__).resolve().parent.parent
BUN = str(Path.home() / ".bun" / "bin" / "bun.exe")
ROWS, COLS = 20, 96   # short terminal: viewport smaller than content (the user's case)
WITH_MCP = len(sys.argv) > 1 and sys.argv[1] == "mcp"

home = ROOT / "docs" / ".renderrepro-home"
proj = ROOT / "docs" / ".renderrepro-proj"
for d in (home, proj):
    shutil.rmtree(d, ignore_errors=True)
(home / "sessions").mkdir(parents=True)
proj.mkdir(parents=True)
cfg = {"model": "anthropic/claude-sonnet-4-5", "max_tokens": 512,
       "endpoints": {"anthropic": {"base_url": "http://127.0.0.1:31999/v1", "format": "openai",
                                    "api_key": "demo-key", "models": ["claude-sonnet-4-5"]}}}
if WITH_MCP:
    cfg["mcpServers"] = {"sleepy": {"type": "stdio", "command": "node",
                                    "args": ["-e", "setTimeout(()=>process.exit(0),4000)"]}}
(home / "config.json").write_text(json.dumps(cfg), encoding="utf-8")

mock = subprocess.Popen([sys.executable, str(ROOT / "docs" / "mock_server.py"), "--port", "31999"],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                        env=dict(os.environ, GOAT_DEMO=os.environ.get("GOAT_DEMO", "read")))
env = dict(os.environ, GOATCODE_HOME=str(home), GOAT_LOG="0", TERM="xterm-256color",
           FORCE_COLOR="3", GOAT_MODEL="anthropic/claude-sonnet-4-5")
DEMO = os.environ.get("GOAT_DEMO", "read")
p = winpty.PtyProcess.spawn([BUN, "run", str(ROOT / "src" / "index.ts")], cwd=str(proj),
                            dimensions=(ROWS, COLS), env=env)
screen = pyte.Screen(COLS, ROWS)
stream = pyte.ByteStream(); stream.attach(screen)
q: queue.Queue = queue.Queue()
def reader():
    while True:
        try: data = p.read(4096)
        except Exception: return
        if not data: return
        q.put(data)
threading.Thread(target=reader, daemon=True).start()

frames = []
def snap():
    grid = []
    for y in range(ROWS):
        grid.append([screen.buffer[y][x].data for x in range(COLS)])
    frames.append(grid)

end = time.time() + 8
last = 0.0
while time.time() < end:
    try:
        d = q.get(timeout=0.05)
        stream.feed(d if isinstance(d, bytes) else d.encode("utf-8", "replace"))
    except queue.Empty:
        pass
    if time.time() - last > 0.15:
        snap(); last = time.time()
for ch in "analyze the whole thing":
    p.write(ch)
    time.sleep(0.02)
p.write("\r")
end = time.time() + 22
while time.time() < end:
    try:
        d = q.get(timeout=0.05)
        stream.feed(d if isinstance(d, bytes) else d.encode("utf-8", "replace"))
    except queue.Empty:
        pass
    if time.time() - last > 0.15:
        snap(); last = time.time()
snap()

bad = []
for i, g in enumerate(frames):
    txt = [" ".join(r).rstrip() for r in g]
    tops = sum(1 for l in txt if l.strip().startswith("╭") and "─" in l)
    bots = sum(1 for l in txt if l.strip().startswith("╰") and "─" in l)
    boxes = [l for l in txt if "help me build" in l]
    if tops > 1 or (tops > 0 and bots == 0 and i > 3):
        bad.append((i, tops, bots, len(boxes)))
        if len(bad) <= 2:
            print(f"--- frame {i} (tops={tops} bots={bots}) ---")
            for l in txt:
                if l.strip(): print(repr(l[:100]))
print(f"\nframes={len(frames)}  artifact-frames={len(bad)}")
for i, t, b, bx in bad[:12]:
    print(f"  frame {i}: {t} box-top(s), {b} box-bottom(s), {bx} input line(s)")
try: p.terminate(force=True)
except Exception: pass
mock.terminate()
