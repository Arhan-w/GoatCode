# GAIA validation — FULL run (all levels, text + file questions).
# Fixes vs run.py: forced ANSWER tail, fallback extraction, file paths handed to agent,
# larger step budget, order-tolerant scoring done separately.
import json, os, subprocess, sys, time
from pathlib import Path

HERE = Path(__file__).parent
LIMIT = int(sys.argv[1]) if len(sys.argv) > 1 else 999
GOAT = str((HERE.parent / "dist" / "goat.exe").resolve())
HOME = HERE / ".goathome"
OUT = HERE / "results_full.json"
DATA = HERE / "data"

SKIP_EXT = {".mp3", ".wav", ".m4a"}  # no audio pipeline in free tier

rows = json.loads((HERE / "all.json").read_text())
qs = []
for r in rows:
    fn = r.get("file_name")
    if fn and Path(fn).suffix.lower() in SKIP_EXT:
        continue
    if fn and not (DATA / fn).exists():
        continue
    qs.append(r)
qs.sort(key=lambda r: (int(r["Level"]), r["task_id"]))
qs = qs[:LIMIT]
print(f"running {len(qs)} questions (all levels)", flush=True)

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

def extract(out: str) -> str:
    lines = [l.strip() for l in out.splitlines() if l.strip()]
    for line in reversed(lines):
        u = line.upper()
        if u.startswith("ANSWER:"):
            return line[7:].strip().strip('*_`').strip()
    # fallbacks: last content line that isn't a spinner/footer
    for line in reversed(lines):
        low = line.lower()
        if line and not low.startswith(("╭", "│", "╰", "ask before edits", "ctrl+t", "esc to", "⠋", "⠙")):
            return line[:200]
    return ""

results = json.loads(OUT.read_text()) if OUT.exists() else []
results = [x for x in results if "HTTP 502" not in x["got"]]  # requeue rate-limited
done = {r["task_id"] for r in results}

env = dict(os.environ)
env["GOATCODE_HOME"] = str(HOME.resolve())
env["GOAT_MAX_STEPS"] = "25"

for i, q in enumerate(qs):
    if q["task_id"] in done:
        continue
    fn = q.get("file_name")
    file_note = f"A data file for this question is at: {DATA / fn}\n" if fn else ""
    prompt = PROMPT_TMPL.format(file_note=file_note, q=q["Question"])
    t0 = time.time()
    for attempt in range(4):
        try:
            r = subprocess.run([GOAT, "-p", prompt], capture_output=True, text=True,
                               timeout=600, env=env, cwd=str(HERE), encoding="utf-8", errors="replace")
            out = (r.stdout or "") + "\n" + (r.stderr or "")
        except subprocess.TimeoutExpired as e:
            out = ((e.stdout or b"").decode("utf-8", "replace") if isinstance(e.stdout, bytes) else (e.stdout or "")) + "\nTIMEOUT"
        if "HTTP 502" not in out:
            break
        wait = 90 * (attempt + 1)
        print(f"  502 on {q['task_id'][:8]}, cooldown {wait}s", flush=True)
        time.sleep(wait)
    elapsed = round(time.time() - t0, 1)
    ans = extract(out)
    results.append({"task_id": q["task_id"], "level": int(q["Level"]), "file": bool(fn),
                    "question": q["Question"][:200], "gold": q["Final answer"],
                    "got": ans, "secs": elapsed, "raw_tail": out[-300:]})
    OUT.write_text(json.dumps(results, indent=1))
    time.sleep(6)  # be gentle on the free endpoint
    print(f"[{i+1}/{len(qs)}] L{q['Level']} {q['task_id'][:8]} {elapsed}s got={ans[:44]!r} gold={str(q['Final answer'])[:44]!r}", flush=True)

print("DONE", len(results))
