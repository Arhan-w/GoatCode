"""Debug probe: run the TUI with no creds, send /index then a question, dump frames."""
import os, sys, time, subprocess
sys.path.insert(0, str(os.path.dirname(__file__)))
import pyte, winpty
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
HOME = ROOT / "docs" / ".flashprobe-home"
import shutil, json
if HOME.exists(): shutil.rmtree(HOME, ignore_errors=True)
(HOME / "sessions").mkdir(parents=True)
cfg = {"max_tokens": 512, "repos": [str(ROOT / "docs" / ".goatdemo-proj")]}
(HOME / "config.json").write_text(json.dumps(cfg), encoding="utf-8")
env = dict(os.environ)
env["GOATCODE_HOME"] = str(HOME)
env["GOAT_LOG"] = "1"
env["TERM"] = "xterm-256color"
env["FORCE_COLOR"] = "3"
for k in ("GOAT_MODEL","GOAT_DEMO"): env.pop(k, None)
p = winpty.PtyProcess.spawn([str(ROOT / "dist" / "goat.exe")], cwd=str(ROOT / "docs" / ".goatdemo-proj"), dimensions=(34, 96), env=env)
stream = pyte.ByteStream(); screen = pyte.Screen(96, 34); stream.attach(screen)
import queue, threading
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
        line = screen.display[y].rstrip()
        if line.strip(): print(f"  [{y}] {line[:90]}")
drain(12)
dump("after boot")
send("/index"); drain(8); dump("after /index")
send("what is 12*8?"); drain(30); dump("after question")
p.terminate(force=True)
