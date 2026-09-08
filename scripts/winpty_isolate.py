"""Isolate: does goat die on the message, or on the Esc?"""
import sys, time, threading, re
import winpty

MODE = sys.argv[1]  # "idle" | "msg" | "msg-esc"

p = winpty.PtyProcess.spawn(["D:/bin/goat.exe"], cwd="C:\\Users\\Arhan", dimensions=(50, 160))
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

def dump(label):
    time.sleep(0.7)
    out = "".join(buf)
    clean = re.sub(r"\x1b\[[0-9;?]*[A-Za-z]|\x1b[()][A-Za-z0-9]|\x1b[>=]|\x1b\][^\x07]*\x07", "", out)
    with open("D:/GoatCode-ts/scripts/pty-capture.txt", "w", encoding="utf-8") as f:
        f.write(f"===== {label}: alive={p.isalive()} exit={p.exitstatus} =====\n" + clean[-8000:])
    print(label, "alive=", p.isalive(), "exit=", p.exitstatus)
    sys.exit(0)

time.sleep(5)
if MODE == "idle":
    dump("idle 20s")
    time.sleep(15)
    dump("idle 20s")

p.write("hello there\r")
time.sleep(5)
if MODE == "msg":
    dump("msg +5s")
p.write("\x1b")
time.sleep(5)
dump("msg-esc +5s")
