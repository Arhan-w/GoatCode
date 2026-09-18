# Score full GAIA results and send leaderboard to Telegram (Goated, 6201806207).
import json, subprocess, sys
from pathlib import Path
from score_full import score_one

HERE = Path(__file__).parent
ENV = Path.home() / "AppData/Local/hermes/.env"
CHAT = "6201806207"

token = ""
for line in ENV.read_text(encoding="utf-8", errors="replace").splitlines():
    if line.startswith("TELEGRAM_BOT_TOKEN="):
        token = line.split("=", 1)[1].strip()

res = json.load(open(HERE / "results_full.json", encoding="utf-8"))
by = {1: [0, 0], 2: [0, 0], 3: [0, 0]}
for x in res:
    ok = score_one(x["got"], x["gold"])
    x["correct"] = ok
    if x["level"] in by:
        by[x["level"]][1] += 1
        by[x["level"]][0] += ok
json.dump(res, open(HERE / "results_full.json", "w"), indent=1)

tok = sum(v[1] for v in by.values()); ok_t = sum(v[0] for v in by.values())
lines = [
    "GOATCODE × GAIA — FINAL RESULTS",
    "Model: free-tier auto-router via FreeLLMAPI proxy ($0) + Goated-Flash-Free fallback · tools: websearch/webfetch/bash/files",
    "",
    f"L1: {by[1][0]}/{by[1][1]} = {100*by[1][0]/max(1,by[1][1]):.1f}%",
    f"L2: {by[2][0]}/{by[2][1]} = {100*by[2][0]/max(1,by[2][1]):.1f}%",
    f"L3: {by[3][0]}/{by[3][1]} = {100*by[3][0]/max(1,by[3][1]):.1f}%",
    f"OVERALL: {ok_t}/{tok} = {100*ok_t/max(1,tok):.1f}%",
    "",
    "LEADERBOARD (GAIA val, published numbers)",
    "HAL Claude Sonnet 4.5 .... 74.6% ($178)",
    "HAL Sonnet 4.5 High ...... 70.9% ($180)",
    "HF OpenDR GPT-5 .......... 62.8% ($360)",
    "HAL o4-mini .............. 58.2% ($73)",
    "HAL Gemini 2.0 Flash ..... 32.7% ($7.8)",
    "Bare frontier models ..... 45-52%",
    "GPT-4+plugins (2023) ..... 15%",
    "Human baseline ........... 92%",
    "",
    f"*GoatCode free tier ...... {100*ok_t/max(1,tok):.1f}% ($0.00)*",
]
msg = "\n".join(lines)
print(msg)
if token:
    r = subprocess.run(["curl", "-s", "-X", "POST", f"https://api.telegram.org/bot{token}/sendMessage",
                        "-d", f"chat_id={CHAT}", "--data-urlencode", f"text={msg}",
                        "-o", "/dev/null", "-w", "%{http_code}"], capture_output=True, text=True)
    print("TELEGRAM:", r.stdout.strip() or r.stderr[:120])
else:
    print("NO TOKEN")
