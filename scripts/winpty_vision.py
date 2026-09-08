"""Live vision e2e: goat TUI + @scripts/red.png -> model should say 'red'."""
import sys, time, threading, re
import winpty

p = winpty.PtyProcess.spawn(["D:/bin/goat.exe"], cwd="D:\\GoatCode-ts", dimensions=(45, 150))
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
    with open("D:/GoatCode-ts/scripts/pty-vision.txt", "w", encoding="utf-8") as f:
        f.write(f"===== {label}: alive={p.isalive()} exit={p.exitstatus} =====\n" + clean_text()[-14000:])
    print(label, "alive=", p.isalive())

def type_line(s):
    p.write(s)
    time.sleep(0.7)
    p.write("\r")
    time.sleep(0.7)

time.sleep(9)
if sum(len(b) for b in buf) < 500:
    dump("no output after boot"); sys.exit(1)
type_line("/model freellmapi/auto")
time.sleep(1.5)
type_line("What color is @scripts/red.png? Answer with exactly one word.")
for i in range(16):
    time.sleep(3)
    if not p.isalive():
        dump(f"died @{3*i}s"); sys.exit(1)
    t = clean_text()
    tail = t.split("one word.")[-1]
    if re.search(r"\bred\b", tail, re.I):
        dump(f"VISION OK: model said red after ~{3*(i+1)}s"); sys.exit(0)
    if "✗" in tail or "error" in tail.lower():
        dump(f"model/agent error: {tail[:300]}"); sys.exit(1)
dump("no answer in 48s")
sys.exit(1)
