# Upstream GAIA question_scorer (bug-for-bug: "3,676" parses as a 2-element list).
import re
import string


def normalize_str(input_str, remove_punct=True):
    if remove_punct:
        no_punct_chars = string.punctuation.replace("%", "")
        input_str = "".join(c for c in input_str.lower() if c not in no_punct_chars)
    return re.sub(r"\s+", " ", input_str).strip()


def normalize_number(pred: str, gold: str):
    if pred.endswith("%"):
        pred = pred.split("%")[0]
        pred = float(pred.replace(",", "")) / 100
    if gold.endswith("%"):
        gold = gold.split("%")[0]
        gold = float(gold.replace(",", "")) / 100
    return pred, gold


def remove_prefix(input_str, prefix):
    if prefix.lower() + "." in input_str.lower():
        return re.sub(f"^{prefix.lower()}\.", "", input_str.lower(), flags=re.IGNORECASE)
    return input_str


def is_divisible_by_eight(gold):
    return bool(re.match(r"^\d+$", gold)) and int(gold) % 8 == 0


def split_by_comma(s):
    m = re.search(r"^([a-zA-Z])+(?:,|$)", s)
    if m:
        opener = m.group()
        s = opener.join(s.split(","))
    return s


def question_scorer(model_answer: str, gold_answer: str) -> bool:
    try:
        float(gold_answer)
        is_number = True
    except Exception:
        is_number = False

    model_answer = remove_prefix(model_answer, "Final Answer")
    model_answer = model_answer.replace(", ", "")
    try:
        return float(model_answer) == float(gold_answer)
    except Exception:
        pass

    try:
        return any(float(x) == float(gold_answer) for x in model_answer.split(" ") if x)
    except Exception:
        pass

    y_n = ("yes", "no")
    is_y_n = any(norm in normalize_str(gold_answer) for norm in y_n) and len(gold_answer) < 20

    is_list = "," in gold_answer

    model_answer = normalize_str(model_answer)
    gold_answer = normalize_str(gold_answer)

    if is_number:
        model_answer, gold_answer = normalize_number(model_answer, gold_answer)
    elif is_list:
        model_answer = split_by_comma(model_answer)
        gold_answer = split_by_comma(gold_answer)
    elif not is_y_n:
        # drop articles
        pass

    if model_answer != gold_answer:
        return False
    return True
