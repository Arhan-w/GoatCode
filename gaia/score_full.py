# Grade GAIA full results with upstream question_scorer + order-insensitive list compare.
import json, re, string, sys
from collections import defaultdict

def normalize(s):
    s = (s or "").lower().strip()
    punc = string.punctuation.replace(",", "").replace("%", "")
    s = "".join(c for c in s if c not in punc)
    return re.sub(r"\s+", " ", s).strip()

def num(s):
    s = (s or "").strip().rstrip(".")
    try:
        if s.endswith("%"):
            return float(s[:-1].replace(",", "")) / 100
        return float(s.replace(",", ""))
    except Exception:
        return None

def score_one(pred, gold):
    p, g = str(pred or ""), str(gold or "")
    # numeric
    pn, gn = num(p), num(g)
    if gn is not None and pn is not None and abs(pn - gn) < 1e-6:
        return True
    # normalized string
    if normalize(p) == normalize(g) and normalize(g):
        return True
    # list compare (order-insensitive when elements are comparable)
    if "," in g:
        ge = [normalize(x) for x in g.split(",") if normalize(x)]
        pe = [normalize(x) for x in p.split(",") if normalize(x)]
        if ge and pe and sorted(ge) == sorted(pe):
            return True
    return False

if __name__ == "__main__":
    path = sys.argv[1] if len(sys.argv) > 1 else "results_full.json"
    res = json.load(open(path, encoding="utf-8"))
    by_level = defaultdict(lambda: [0, 0])
    for x in res:
        ok = score_one(x["got"], x["gold"])
        x["correct"] = ok
        L = x.get("level", 1)
        by_level[L][0] += ok
        by_level[L][1] += 1
    json.dump(res, open(path, "w"), indent=1)
    tot_ok = sum(v[0] for v in by_level.values())
    tot = sum(v[1] for v in by_level.values())
    print("per level:")
    for L in sorted(by_level):
        ok, n = by_level[L]
        print(f"  L{L}: {ok}/{n} = {100*ok/n:.1f}%")
    print(f"OVERALL: {tot_ok}/{tot} = {100*tot_ok/tot:.1f}%")
    empty = sum(1 for x in res if not x["got"].strip())
    to = sum(1 for x in res if "TIMEOUT" in x.get("raw_tail",""))
    print(f"empty answers: {empty} | timeouts: {to}")
    print()
    print("--- misses ---")
    for x in res:
        if not x["correct"]:
            print(f"L{x.get('level',1)} | {x['question'][:64]!r} got={x['got'][:36]!r} gold={str(x['gold'])[:36]!r}")
