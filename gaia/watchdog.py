# Watchdog: ensures the GAIA finisher keeps running until all 162 are answered,
# and that results get sent to Telegram at the end. Run every ~10 min via cron.
import json, os, re, subprocess, sys, time
from pathlib import Path

HERE = Path("D:/GoatCode-ts/gaia")
JUNK = re.compile(r"error: LLMError|HTTP 5\d\d|Unable to connect|socket conne|TIMEOUT|did not start|stopped after \d+ steps|^\[tool ", re.I)

def clean_count():
    try:
        r = json.load(open(HERE / "results_full.json"))
        return sum(1 for x in r if not JUNK.search(x["got"]))
    except Exception:
        return 0

n = clean_count()
print("clean:", n, "/162")
if n >= 162:
    # ensure the send happened (idempotent marker)
    if not (HERE / ".sent").exists():
        p = subprocess.run([sys.executable, str(HERE / "send_results.py")], capture_output=True, text=True, cwd=str(HERE))
        print(p.stdout[-400:])
        (HERE / ".sent").write_text("ok")
    sys.exit(0)

# is a finisher alive?
r = subprocess.run(["powershell", "-NoProfile", "-Command",
                    "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*finisher.py*' } | Select-Object -ExpandProperty ProcessId"],
                   capture_output=True, text=True)
pids = [p for p in r.stdout.split() if p.strip().isdigit()]
if pids:
    print("finisher alive:", pids)
else:
    print("restart finisher")
    log = open(HERE / "finisher.log", "a")
    subprocess.Popen([sys.executable, str(HERE / "finisher.py")], cwd=str(HERE),
                     stdout=log, stderr=subprocess.STDOUT)
