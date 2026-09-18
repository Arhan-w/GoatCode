# GAIA validation run for GoatCode (Goated-Flash-Free, zero-config).
# Sample: N text-only Level-1 questions. Sequential with shared flash server.
import json, subprocess, sys, time
from pathlib import Path

HERE = Path(__file__).parent
N = int(sys.argv[1]) if len(sys.argv) > 1 else 10
GOAT = str((HERE.parent / "dist" / "goat.exe").resolve())
HOME = HERE / ".goathome"
OUT = HERE / "results.json"

rows = json.loads((HERE / "all.json").read_text())
# text-only level 1, deterministic sample: first N by task_id sort
qs = [r for r in rows if str(r["Level"]) == "1" and not r.get("file_name")]
qs.sort(key=lambda r: r["task_id"])
qs = qs[:N]
print(f"running {len(qs)} level-1 text-only questions")

PROMPT = ("You are answering one GAIA benchmark question. Use your websearch and webfetch tools "
          "to research. Think step by step. When certain, end your reply with a line exactly of the form:\n"
          "ANSWER: <final answer only, as short as possible>\n\nQuestion: {q}\n")

results = json.loads(OUT.read_text()) if OUT.exists() else []
done = {r["task_id"] for r in results}

for i, q in enumerate(qs):
    if q["task_id"] in done:
        continue
    import os
    env = dict(os.environ)
    env["GOATCODE_HOME"] = str(HOME.resolve())
    (HERE / "tmp").mkdir(exist_ok=True)
    HOME.mkdir(exist_ok=True)
    t0 = time.time()
    try:
        r = subprocess.run([GOAT, "-p", PROMPT.format(q=q["Question"])],
                           capture_output=True, text=True, timeout=420, env=env,
                           cwd=str(HERE), encoding="utf-8", errors="replace")
        out = (r.stdout or "") + "\n" + (r.stderr or "")
    except subprocess.TimeoutExpired as e:
        out = ((e.stdout or b"").decode("utf-8", "replace") if isinstance(e.stdout, bytes) else (e.stdout or "")) + "\nTIMEOUT"
    elapsed = round(time.time() - t0, 1)
    ans = ""
    for line in reversed(out.splitlines()):
        line = line.strip()
        if line.upper().startswith("ANSWER:"):
            ans = line[7:].strip()
            break
    results.append({"task_id": q["task_id"], "question": q["Question"][:160],
                    "gold": q["Final answer"], "got": ans, "secs": elapsed,
                    "raw_tail": out[-400:]})
    OUT.write_text(json.dumps(results, indent=1))
    print(f"[{i+1}/{len(qs)}] {q['task_id'][:8]} {elapsed}s got={ans[:40]!r} gold={str(q['Final answer'])[:40]!r}", flush=True)

print("DONE", len(results))
