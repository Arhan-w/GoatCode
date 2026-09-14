"""Exactly the capture sequence (bun run src/index.ts, GOAT_DEMO=flash, /index then question)."""
import os, sys, time, json, shutil
from pathlib import Path
import pyte, winpty, threading, queue
ROOT = Path(__file__).resolve().parent.parent
HOME = ROOT / "docs" / ".goatdemo-home"
if HOME.exists(): shutil.rmtree(HOME, ignore_errors=True)
(HOME / "sessions").mkdir(parents=True)
proj = ROOT / "docs" / ".goatdemo-proj"
(HOME / "config.json").write_text(json.dumps({"max_tokens": 512, "repos": [str(proj)]}), encoding="utf-8")
env = dict(os.environ)
env["GOATCODE_HOME"] = str(HOME)
env["GOAT_LOG"] = "1"
env["TERM"] = "xterm-256color"
env["FORCE_COLOR"] = "3"
env["GOAT_DEMO"] = "flash"
env.pop("GOAT_MODEL", None)
BIN = str(Path.home() / ".bun" / "bin" / "bun.exe")
p = winpty.PtyProcess.spawn([BIN, "run", str(ROOT / "src" / "index.ts")], cwd=str(proj), dimensions=(34, 96), env=env)
stream = pyte.ByteStream(); screen = pyte.Screen(96, 34); stream.attach(screen)
q = queue.Queue()
def reader():
    while True:
        try: d = p.read(4096)
        except Exception: return
        if not d: return
        q.put(d)
threading.Thread(target=reader, daemon=True).start()
def drain(sec):
    end = time.time() + sec
    while time.time() < end:
        try:
            d = q.get(timeout=0.05)
            stream.feed(d if isinstance(d, bytes) else d.encode("utf-8", "replace"))
        except queue.Empty: pass
def send(t):
    for ch in t: p.write(ch); time.sleep(0.04)
    p.write("\r"); time.sleep(0.4)
def dump(label):
    print(f"===== {label} =====")
    for y in range(13, 34):
        line = ''.join(c[0] for c in [screen.buffer[y][x] for x in range(96)]).rstrip()
        if line.strip(): print(f"  [{y}] {line[:88]}")
drain(12); dump("boot")
send("/index"); drain(6); dump("index")
send("what is 12*8? answer with just the number"); drain(35); dump("question")
p.terminate(force=True)
