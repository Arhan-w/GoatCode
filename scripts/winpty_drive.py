"""Drive goat.exe under a real ConPTY (winpty), capture everything it prints.

Usage: python winpty_drive.py <command> [args...]
Boots the TUI, waits, types 'hello there' + Enter, Esc, Ctrl+C x2, dumps
ANSI-stripped output plus the child's exit status.
"""
import sys, time, threading, re

import winpty

cmd = sys.argv[1:]
p = winpty.PtyProcess.spawn(cmd, cwd="C:\\Users\\Arhan", dimensions=(50, 160))

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

def finish(process, outbuf):
    time.sleep(0.7)
    out = "".join(outbuf)
    clean = re.sub(r"\x1b\[[0-9;?]*[A-Za-z]|\x1b[()][A-Za-z0-9]|\x1b[>=]|\x1b\][^\x07]*\x07", "", out)
    with open("D:/GoatCode-ts/scripts/pty-capture.txt", "w", encoding="utf-8") as f:
        f.write("===== goat output (ANSI stripped) =====\n" + clean)
        f.write("\n===== final exit status: " + str(process.exitstatus) + "\n")
    sys.stdout.write("captured " + str(len(clean)) + " chars; exit=" + str(process.exitstatus) + "\n")
    sys.exit(0)

def snap(label):
    time.sleep(0.5)
    alive = p.isalive()
    buf.append(f"\n\n[[{label}: alive={alive} exit={p.exitstatus}]]\n\n")
    return alive

time.sleep(6.0)
if not snap("after 6s idle"):
    finish(p, buf)
p.write("hello there\r")
time.sleep(8.0)
if not snap("after prompt+8s"):
    finish(p, buf)
p.write("\x1b")
time.sleep(1.0)
try:
    p.write("\x03")          # first Ctrl+C -> warning, must stay alive
except Exception:
    pass
time.sleep(1.0)
if not snap("after first ctrl+c"):
    finish(p, buf)           # died on ONE ctrl+c = regression
try:
    p.write("\x03")          # second Ctrl+C -> should exit cleanly
except Exception:
    pass
time.sleep(2.0)
snap("after second ctrl+c")
finish(p, buf)
