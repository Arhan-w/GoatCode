#!/usr/bin/env python3
"""Drive the GoatCode launch thread on X via cua-driver background input.

Each tweet is typed as text runs separated by explicit shift+enter (in-tweet
newline); plain enter starts the next tweet box in the thread. Stops before
the final Post click for verification.
"""
import json, os, subprocess, sys, time

CUA = os.path.join(os.environ["LOCALAPPDATA"], "Programs", "Cua", "cua-driver", "bin", "cua-driver.exe")
PID = int(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1].isdigit() else None

TWEETS = [
    [
        "Most terminal coding agents lock you into one model and one more monthly bill.",
        "",
        "GoatCode: open-source, 183 providers, and the subs you already pay for (Claude, ChatGPT, Gemini, Copilot) become real API credentials.",
        "",
        "npm i -g goatcode-cli",
    ],
    [
        "Also the only coding agent with desktop control built in:",
        "",
        "- screenshot: the model literally sees your screen",
        "- computer: drives real apps - click, type, launch, clipboard",
        "- background input: your cursor never moves",
        "",
        'fix the bug AND check the app, one prompt.',
    ],
    [
        "The core is Claude-Code-shaped, so migrating is boring:",
        "",
        "- your .claude/skills, .mcp.json, hooks and permission rules just load",
        "- plan mode, sub-agents, parallel tool calls",
        "- undo checkpoints on every file write",
        "- /cost = real spend, no vibes",
    ],
    [
        "Install:",
        "",
        "npm i -g goatcode-cli",
        "",
        "5 prebuilt binaries (win/mac/linux, x64+arm64), zero runtime deps. No npm? One-line PowerShell/curl installers in the README.",
        "",
        "No keys yet? goat tells you exactly what to do on first run.",
    ],
    [
        "It is days old and fully open - the agent loop is ~700 lines of TypeScript. Read it, patch it.",
        "",
        "github.com/Arhan-w/GoatCode",
        "",
        'Star it if "your subscriptions, not our margin" resonates',
    ],
]

# X counts: URLs fixed 23, emoji ~2, everything else = code points. Cap 260.
import unicodedata, re as _re
def xlen(s):
    s = _re.sub(r"(https?://)?\S*\.(com|dev|io|sh|org)\S*", "X" * 23, s)
    return sum(2 if unicodedata.category(ch) == "So" else 1 for ch in s)

for i, t in enumerate(TWEETS):
    n = xlen("\n".join(t))
    if n > 260:
        print(f"TWEET {i+1} TOO LONG: {n}")
        sys.exit(1)
    print(f"tweet {i+1}: {n} chars")
print("all tweets within budget")

def cua(tool, args, timeout=30):
    r = subprocess.run([CUA, "call", tool, json.dumps(args), "--json"],
                       capture_output=True, text=True, timeout=timeout)
    try:
        return json.loads(r.stdout)
    except Exception:
        return {"raw": r.stdout[:400], "err": r.stderr[:200]}

def type_text(text):
    r = cua("type_text", {"pid": PID, "text": text, "delivery_mode": "foreground", "bring_to_front": True})
    eff = r.get("effect", "?")
    return eff

if PID is None:
    wins = cua("list_windows")
    rows = wins.get("windows") or wins.get("_legacy_windows") or []
    x = [v for v in rows if "Personal" in str(v.get("title", "")) and "msedge" in str(v.get("app_name", "")).lower()]
    if not x:
        print("edge window with X not found"); sys.exit(1)
    PID = x[0]["pid"]
print("target pid:", PID)

# focus the compose field (foreground click, since Chromium drops posted input)
cua("click", {"pid": PID, "x": 703, "y": 209, "scope": "desktop", "delivery_mode": "foreground"})
time.sleep(0.8)
# clear any leftovers from previous attempts
cua("press_key", {"pid": PID, "key": "a", "ctrl": True, "delivery_mode": "foreground"})
time.sleep(0.3)
cua("press_key", {"pid": PID, "key": "delete", "delivery_mode": "foreground"})
time.sleep(0.5)

for i, tweet in enumerate(TWEETS):
    for j, line in enumerate(tweet):
        if line:
            eff = type_text(line)
            if eff == "refused":
                print(f"t{i+1} line refused: {line[:40]}")
                sys.exit(1)
            time.sleep(0.25)
        if j < len(tweet) - 1:
            cua("press_key", {"pid": PID, "key": "enter", "shift": True, "delivery_mode": "foreground"})
            time.sleep(0.2)
    print(f"tweet {i+1} typed")
    if i < len(TWEETS) - 1:
        cua("press_key", {"pid": PID, "key": "enter", "delivery_mode": "foreground"})  # next tweet box
        time.sleep(0.6)

print("DONE typing 5-tweet thread; NOT posting. Verify in the window, then run with --post.")
