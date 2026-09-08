import time, threading, winpty
LOG = open("D:/GoatCode-ts/scripts/input-log.txt", "a", encoding="utf-8")
p = winpty.PtyProcess.spawn(["C:\\Users\\Arhan\\.bun\\bin\\bun.exe", "run", "D:/GoatCode-ts/scripts/input-harness.tsx"], cwd="D:\\GoatCode-ts", dimensions=(20, 80))
def r():
    while True:
        try: d = p.read(1024)
        except Exception: return
        if not d: return
threading.Thread(target=r, daemon=True).start()

def send(s, label):
    LOG.write(f"--- send {label} @ {time.strftime('%H:%M:%S')}\n"); LOG.flush()
    p.write(s)
    time.sleep(1.5)

time.sleep(8)   # generous boot
send("hi", "'hi'")
send("\r", "CR (real Enter)")
send("\n", "LF")
send("\x1b", "ESC")
time.sleep(2)
p.terminate(force=True)
