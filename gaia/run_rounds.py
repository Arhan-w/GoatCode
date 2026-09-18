# GAIA completion runner: parallel GoatCode workers, fail-fast rounds, requeue 502s.
import json, os, subprocess, sys, time
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed

HERE = Path(__file__).parent
GOAT = str((HERE.parent / "dist" / "goat.exe").resolve())
HOME = HERE / ".goathome"
OUT = HERE / "results_full.json"
DATA = HERE / "data"
K = int(sys.argv[1]) if len(sys.argv) > 1 else 3     # parallel workers
ROUNDS = int(sys.argv[2]) if len(sys.argv) > 2 else 12
SKIP_EXT = {".mp3", ".wav", ".m4a"}

rows = json.loads((HERE / "all.json").read_text())
tasks = {}
for r in rows:
    fn = r.get("file_name")
    if fn and (Path(fn).suffix.lower() in SKIP_EXT or not (DATA / fn).exists()):
        continue
    tasks[r["task_id"]] = {"level": int(r["Level"]), "gold": r["Final answer"],
                           "file": str(DATA / fn) if fn else None,
                           "question": r["Question"]}

results = json.loads(OUT.read_text()) if OUT.exists() else []
clean = {x["task_id"]: x for x in results if "HTTP 502" not in x["got"]}

PROMPT_TMPL = (
    "You are answering one GAIA benchmark question.\n"
    "{file_note}"
    "Use your websearch and webfetch tools to research facts, and bash/read tools for files.\n"
    "Think step by step and verify before concluding.\n"
    "IMPORTANT: your reply MUST end with a final line exactly of the form:\n"
    "ANSWER: <final answer only, as short as possible — no punctuation added, no unit unless asked>\n"
    "Never finish without that line.\n\n"
    "Question: {q}\n"
)

def extract(out):
    lines = [l.strip() for l in out.splitlines() if l.strip()]
    for line in reversed(lines):
        if line.upper().startswith("ANSWER:"):
            return line[7:].strip().strip("*_`").strip()
    for line in reversed(lines):
        low = line.lower()
        if line and not low.startswith(("╭", "│", "╰", "ask before edits", "ctrl+t", "esc to")):
            return line[:200]
    return ""

def run_one(tid):
    t = tasks[tid]
    env = dict(os.environ)
    env["GOATCODE_HOME"] = str(HOME.resolve())
    env["GOAT_MAX_STEPS"] = "25"
    file_note = f"A data file for this question is at: {t['file']}\n" if t["file"] else ""
    prompt = PROMPT_TMPL.format(file_note=file_note, q=t["question"])
    t0 = time.time()
    try:
        r = subprocess.run([GOAT, "-p", prompt], capture_output=True, text=True,
                           timeout=500, env=env, cwd=str(HERE), encoding="utf-8", errors="replace")
        out = (r.stdout or "") + "\n" + (r.stderr or "")
    except subprocess.TimeoutExpired as e:
        out = ((e.stdout or b"").decode("utf-8", "replace") if isinstance(e.stdout, bytes) else (e.stdout or "")) + "\nTIMEOUT"
    return {"task_id": tid, "level": t["level"], "file": bool(t["file"]),
            "question": t["question"][:200], "gold": t["gold"],
            "got": extract(out), "secs": round(time.time() - t0, 1),
            "raw_tail": out[-300:]}

# warm up the shared flash server once
run_one(next(iter(tasks)))  # throwaway? no — actually keep it:
def main():
    # seed clean from existing non-502 results
    global clean
    clean = {x["task_id"]: x for x in json.loads(OUT.read_text()) if "HTTP 502" not in x["got"]}
    print(f"seeded clean: {len(clean)} / {len(tasks)}", flush=True)
    for rnd in range(1, ROUNDS + 1):
        todo = [tid for tid in tasks if tid not in clean]
        if not todo:
            break
        print(f"=== ROUND {rnd}: {len(todo)} to go (K={K}) ===", flush=True)
        fails502 = 0
        with ThreadPoolExecutor(max_workers=K) as ex:
            futs = {ex.submit(run_one, tid): tid for tid in todo}
            n = 0
            for fut in as_completed(futs):
                res = fut.result()
                n += 1
                if "HTTP 502" in res["got"] or "HTTP 502" in res["raw_tail"][-150:]:
                    fails502 += 1
                    tag = "502"
                else:
                    clean[res["task_id"]] = res
                    tag = "OK "
                OUT.write_text(json.dumps(list(clean.values()), indent=1))
                if tag == "OK ":
                    print(f"  [{n}/{len(todo)}] {tag} L{res['level']} {res['task_id'][:8]} {res['secs']}s got={res['got'][:40]!r}", flush=True)
                elif n % 10 == 0:
                    print(f"  [{n}/{len(todo)}] ... {fails502} rate-limited so far", flush=True)
        left = len(tasks) - len(clean)
        print(f"round {rnd} done: {len(clean)}/{len(tasks)} answered, {left} rate-limited", flush=True)
        if left == 0:
            break
        wait = 60 if fails502 < len(todo) * 0.5 else 300
        print(f"  sleeping {wait}s before next round", flush=True)
        time.sleep(wait)
    print("ALL_DONE", len(clean), "/", len(tasks))

if __name__ == "__main__":
    main()
