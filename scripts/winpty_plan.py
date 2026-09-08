"""Live e2e: ask the model to plan with the todo tool; expect the pinned Plan panel."""
import sys, time, threading, re
import winpty

p = winpty.PtyProcess.spawn(["D:/bin/goat.exe"], cwd="C:\\Users\\Arhan", dimensions=(45, 150))
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
    with open("D:/GoatCode-ts/scripts/pty-plan.txt", "w", encoding="utf-8") as f:
        f.write(f"===== {label}: alive={p.isalive()} exit={p.exitstatus} =====\n" + clean_text()[-14000:])
    print(label, "alive=", p.isalive())

def type_line(s):
    p.write(s)
    time.sleep(0.7)
    p.write("\r")          # Enter as its own chunk
    time.sleep(0.7)

time.sleep(9)
type_line("/model freellmapi/auto")
time.sleep(1.5)
type_line("Use the todo tool to lay out a 3-step plan for adding a --verbose flag to a CLI, then just start step 1 with the todo tool marked in_progress. Keep it short.")
for i in range(16):
    time.sleep(3)
    if not p.isalive():
        dump(f"died @{3*i}s"); sys.exit(1)
    t = clean_text()
    if "Plan " in t and ("▸" in t or "✔" in t or "○" in t):
        dump(f"plan panel visible after ~{3*(i+1)}s"); sys.exit(0)
dump("no plan panel in 48s")
sys.exit(1)
