# Wait for upstream recovery, then finish GAIA with slow, gentle rounds; score + Telegram.
import json, os, re, subprocess, sys, time
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed

HERE = Path(__file__).parent
GOAT = str((HERE.parent / "dist" / "goat.exe").resolve())
HOME = HERE / ".goathome"
OUT = HERE / "results_full.json"
DATA = HERE / "data"
SKIP_EXT = {".mp3", ".wav", ".m4a"}
JUNK = re.compile(r"error: LLMError|HTTP 5\d\d|Unable to connect|socket conne|TIMEOUT|did not start|stopped after \d+ steps|^\[tool ", re.I)

rows = json.loads((HERE / "all.json").read_text())
tasks = {}
for r in rows:
    fn = r.get("file_name")
    if fn and (Path(fn).suffix.lower() in SKIP_EXT or not (DATA / fn).exists()):
        continue
    tasks[r["task_id"]] = {"level": int(r["Level"]), "gold": r["Final answer"],
                           "file": str(DATA / fn) if fn else None, "question": r["Question"]}

res = json.loads(OUT.read_text()) if OUT.exists() else []
clean = {x["task_id"]: x for x in res if not JUNK.search(x["got"])}
print(f"resume: {len(clean)}/{len(tasks)} clean", flush=True)

PROMPT_TMPL = (
    "You are answering one GAIA benchmark question.\n{file_note}"
    "Use your websearch and webfetch tools to research facts, and bash/read tools for files.\n"
    "Think step by step and verify before concluding.\n"
    "IMPORTANT: your reply MUST end with a final line exactly of the form:\n"
    "ANSWER: <final answer only, as short as possible>\nNever finish without that line.\n\n"
    "Question: {q}\n"
)

def extract(out):
    lines = [l.strip() for l in out.splitlines() if l.strip()]
    for line in reversed(lines):
        if line.upper().startswith("ANSWER:"):
            return line[7:].strip().strip("*_`").strip()
    for line in reversed(lines):
        if line and not line.lower().startswith(("╭", "│", "╰", "ask before edits", "ctrl+t", "esc to")):
            return line[:200]
    return ""

def invoke(prompt):
    env = dict(os.environ)
    env["GOATCODE_HOME"] = str(HOME.resolve())
    env["GOAT_MAX_STEPS"] = "60"
    t0 = time.time()
    to = 1200 if os.environ.get("GAIA_BIG") else 500
    try:
        r = subprocess.run([GOAT, "-p", prompt], capture_output=True, text=True,
                           timeout=to, env=env, cwd=str(HERE), encoding="utf-8", errors="replace")
        out = (r.stdout or "") + "\n" + (r.stderr or "")
    except subprocess.TimeoutExpired as e:
        out = ((e.stdout or b"").decode("utf-8", "replace") if isinstance(e.stdout, bytes) else (e.stdout or "")) + "\nTIMEOUT"
    return extract(out), round(time.time() - t0, 1), out[-300:]

def healthy():
    ans, secs, tail = invoke("Reply with exactly the word: UP")
    return ans.upper().startswith("UP") and "LLMError" not in ans and "502" not in ans

FAILS = HERE / "fails.json"
def failcount():
    try: return json.load(open(FAILS))
    except Exception: return {}

def run_task(tid):
    t = tasks[tid]
    file_note = f"A data file for this question is at: {t['file']}\n" if t["file"] else ""
    ans, secs, tail = invoke(PROMPT_TMPL.format(file_note=file_note, q=t["question"]))
    return {"task_id": tid, "level": t["level"], "file": bool(t["file"]),
            "question": t["question"][:200], "gold": t["gold"], "got": ans, "secs": secs, "raw_tail": tail}

K = 4
while True:
    fc = failcount()
    # quarantine: 2+ failures -> stop retrying (record as EXCLUDED so count can finish)
    for tid, n in list(fc.items()):
        if n >= 2 and tid not in clean:
            clean[tid] = {"task_id": tid, "level": tasks[tid]["level"], "file": bool(tasks[tid]["file"]),
                          "question": tasks[tid]["question"][:200], "gold": tasks[tid]["gold"],
                          "got": "EXCLUDED: timed out after repeated attempts", "secs": 0,
                          "raw_tail": "excluded"}
            OUT.write_text(json.dumps(list(clean.values()), indent=1))
            print("EXCLUDED (2 fails):", tid[:8], flush=True)
    todo = [tid for tid in tasks if tid not in clean]
    if not todo:
        break
    # health gate: wait until upstream serves us again
    waits = 0
    while not healthy():
        waits += 1
        print(f"upstream unhealthy, wait 10min ({waits})", flush=True)
        time.sleep(600)
    # big-timeout mode after first failures for the whole tail
    import os as _os
    fc = failcount()
    if any(fc.get(t, 0) >= 1 for t in todo):
        _os.environ["GAIA_BIG"] = "1"
        print("escalated timeouts: 1200s", flush=True)
    else:
        _os.environ.pop("GAIA_BIG", None)
    print(f"healthy. {len(todo)} to go, K={K}", flush=True)
    batch = todo[:8]
    with ThreadPoolExecutor(max_workers=K) as ex:
        futs = [ex.submit(run_task, tid) for tid in batch]
        for fut in as_completed(futs):
            r = fut.result()
            if JUNK.search(r["got"]):
                fc = failcount(); fc[r["task_id"]] = fc.get(r["task_id"], 0) + 1
                FAILS.write_text(json.dumps(fc))
                print("  junk:", r["task_id"][:8], r["got"][:40], flush=True)
            else:
                clean[r["task_id"]] = r
                OUT.write_text(json.dumps(list(clean.values()), indent=1))
                print(f"  OK L{r['level']} {r['task_id'][:8]} {r['secs']}s {r['got'][:40]!r}", flush=True)
            time.sleep(4)
    print(f"progress: {len(clean)}/{len(tasks)}", flush=True)

print("ALL_CLEAN", len(clean), "/", len(tasks), flush=True)
subprocess.run([sys.executable, str(HERE / "send_results.py")])
