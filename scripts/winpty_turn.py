"""Full TUI turn e2e: boot, /model freellmapi/auto, ask a question, expect an answer.
Text and Enter are sent as SEPARATE chunks — a real keyboard always delivers the
CR on its own; embedding it in a larger write makes ink treat it as text."""
import sys, time, threading, re
import winpty

p = winpty.PtyProcess.spawn(["D:/bin/goat.exe"], cwd="C:\\Users\\Arhan", dimensions=(40, 150))
buf = []

def reader():
    while True:
        try:
            data = p.read(4096)
        except Exception:
            return
        if not data:
            return
        buf.append(data)

threading.Thread(target=reader, daemon=True).start()

def clean_text():
    out = "".join(buf)
    return re.sub(r"\x1b\[[0-9;?]*[A-Za-z]|\x1b[()][A-Za-z0-9]|\x1b[>=]|\x1b\][^\x07]*\x07", "", out)

def dump(label):
    time.sleep(0.7)
    with open("D:/GoatCode-ts/scripts/pty-turn.txt", "w", encoding="utf-8") as f:
        f.write(f"===== {label}: alive={p.isalive()} exit={p.exitstatus} =====\n" + clean_text()[-12000:])
    print(label, "alive=", p.isalive(), "exit=", p.exitstatus)

def type_line(s):
    p.write(s)
    time.sleep(0.6)
    p.write("\r")          # Enter as its own chunk, like a real keypress
    time.sleep(0.6)

time.sleep(9)
if sum(len(b) for b in buf) < 500:
    dump("no output after 9s boot"); sys.exit(1)
type_line("/model freellmapi/auto")
time.sleep(2)
if not p.isalive(): dump("died after /model"); sys.exit(1)
if "model → freellmapi/auto" not in clean_text():
    dump("/model did not submit"); sys.exit(1)
type_line("What is 2+2? Answer with just the number.")
for i in range(12):
    time.sleep(3)
    if not p.isalive():
        dump(f"died during turn @{3*i}s"); sys.exit(1)
    after = clean_text().split("What is 2+2?")[-1]
    if re.search(r"\b4\b", after) and "freellmapi" not in after.split("4")[0][-30:]:
        dump(f"answer visible after ~{3*(i+1)}s"); sys.exit(0)
dump("timeout waiting for answer")
