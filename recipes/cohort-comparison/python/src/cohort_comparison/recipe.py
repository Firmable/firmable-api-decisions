"""Cohort comparison: asks the same Decisions company questions of two cohorts and compares them.

Workflow:
1. Read the input rows. Each row names a company by `company_id` or `domain` and a `cohort`. Rows
   whose cohort is not one of the two configured cohorts are ignored and counted.
2. Read the decision tool list (GET /decisions, free) and check every question's tool and inputs.
3. For each question, ask every unique valid company once, in batches of up to `batch_size`
   records. A company in both cohorts is asked once and counted in both.
4. Build a measure block per question per cohort, and the difference in yes share in percentage
   points when both cohorts have at least `min_answered` yes or no answers.

Measure rules match cohort-question-radar: a yes share is yes over (yes + no) with that
denominator; the unknown share is unknown over the companies asked; unknown is never no.
The difference is cohort A's yes share minus cohort B's, from the exact shares, rounded half away
from zero to one decimal. No significance test is made.
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from firmable_client import pricing
from firmable_client.decisions import SUBJECT_KEYS, answer_from, check_tools, uses_model
from firmable_client.errors import ConfigError, FirmableError, InputError, InvalidResponseError
from firmable_client.io import normalise_domain, read_rows
from firmable_client.recipe import PlannedCall, Recipe, RunContext
from firmable_client.report import Raw, badge, details_json, esc, note, table

NAME = "cohort-comparison"
TITLE = "Cohort comparison"
DESCRIPTION = ("Asks the same Firmable Decisions company questions of two cohorts you supply, and shows both "
               "cohorts' answers side by side with the difference in yes share where both have enough answers.")

ANSWERS = ["yes", "no", "unknown", "error", "not_found", "not_asked"]
STATUS_TONE = {"answered": "good", "incomplete": "review", "not_found": "review", "invalid_input": "error",
               "not_processed": "unknown", "ignored": "neutral"}
BASE_COLUMNS = ["row_id", "domain", "company_id", "company_name", "cohort", "in_both_cohorts", "status",
                "status_reason", "duplicate_of", "firmable_id"]
FIXED_NOTE = ("Differences describe these two cohorts only. They are not tested for statistical significance and "
              "do not describe a market, sector or population.")
_ID = re.compile(r"^[a-z0-9_]{1,40}$")
_COMPANY_ID = re.compile(r"^f\d{12}$")
_TOP_KEYS = {"cohorts", "questions", "with_reasoning", "batch_size", "min_answered"}
_QUESTION_KEYS = {"id", "label", "tool", "inputs"}
_MD_SPECIAL = re.compile(r"([\\`*_\[\]<>|])")


def md_escape(value: Any) -> str:
    """Escapes Markdown special characters in text from the API, the input or the configuration."""
    s = "" if value is None else str(value)
    s = re.sub(r"[\r\n]+", " ", s)
    s = _MD_SPECIAL.sub(r"\\\1", s)
    return "\\" + s if s.startswith("#") else s


def _whole(x: Any) -> bool:
    return isinstance(x, int) and not isinstance(x, bool)


def load_config(raw: dict[str, Any]) -> dict[str, Any]:
    unknown = sorted(set(raw) - _TOP_KEYS)
    if unknown:
        raise ConfigError(f"Unknown configuration key(s): {', '.join(unknown)}")
    cohorts = raw.get("cohorts")
    if (not isinstance(cohorts, list) or len(cohorts) != 2
            or not all(isinstance(c, str) and c.strip() for c in cohorts)):
        raise ConfigError("cohorts must list exactly two cohort values, as text.")
    cohorts = [c.strip() for c in cohorts]
    if cohorts[0] == cohorts[1]:
        raise ConfigError("cohorts must name two different values.")
    qs = raw.get("questions")
    if not isinstance(qs, list) or not 1 <= len(qs) <= 10:
        raise ConfigError("questions must be a list of 1 to 10 questions.")
    questions: list[dict[str, Any]] = []
    seen: set[str] = set()
    for i, q in enumerate(qs, start=1):
        if not isinstance(q, dict):
            raise ConfigError(f"questions[{i}] must be an object.")
        extra = sorted(set(q) - _QUESTION_KEYS)
        if extra:
            raise ConfigError(f"questions[{i}] has unknown key(s): {', '.join(extra)}")
        qid = q.get("id")
        if not isinstance(qid, str) or not _ID.match(qid):
            raise ConfigError(f"questions[{i}].id must be 1 to 40 lower-case letters, digits or underscores.")
        if qid in seen:
            raise ConfigError(f"questions[{i}].id {qid!r} is used twice.")
        if qid in BASE_COLUMNS:
            raise ConfigError(f"questions[{i}].id {qid!r} is reserved for an output column.")
        seen.add(qid)
        tool = q.get("tool")
        if not isinstance(tool, str) or not tool:
            raise ConfigError(f"questions[{i}].tool must name a decision tool.")
        inputs = q.get("inputs", {})
        if not isinstance(inputs, dict):
            raise ConfigError(f"questions[{i}].inputs must be an object.")
        subject = sorted(k for k in inputs if k in SUBJECT_KEYS)
        if subject:
            raise ConfigError(f"questions[{i}].inputs must not include {', '.join(subject)}; "
                              "the recipe adds each company.")
        label = q.get("label", qid)
        if not isinstance(label, str) or not label:
            raise ConfigError(f"questions[{i}].label must be text.")
        questions.append({"id": qid, "label": label, "tool": tool, "inputs": inputs})
    wr = raw.get("with_reasoning", False)
    if not isinstance(wr, bool):
        raise ConfigError("with_reasoning must be true or false.")
    bs = raw.get("batch_size", 100)
    if not _whole(bs) or not 1 <= bs <= 100:
        raise ConfigError("batch_size must be a whole number from 1 to 100.")
    ma = raw.get("min_answered", 5)
    if not _whole(ma) or ma < 1:
        raise ConfigError("min_answered must be a whole number, 1 or more.")
    return {"cohorts": cohorts, "questions": questions, "with_reasoning": wr, "batch_size": bs, "min_answered": ma}


def read_input(path: Path) -> list[dict[str, str]]:
    rows = read_rows(path, any_of=["domain", "company_id"])
    if not any("cohort" in r for r in rows):
        raise InputError(f"{Path(path).name} is missing column(s): cohort")
    return rows


def _subject(row: dict[str, str]) -> tuple[dict[str, str] | None, str | None]:
    """The company a row names, or the reason it names none. company_id wins over domain."""
    cid = row.get("company_id") or ""
    if cid:
        if not _COMPANY_ID.match(cid):
            return None, f"{cid!r} is not a Firmable company ID (f followed by 12 digits)."
        return {"company_id": cid}, None
    raw = row.get("domain") or ""
    d = normalise_domain(raw)
    if not d:
        return None, f"{raw!r} is not a valid domain."
    return {"domain": d}, None


def _key(subject: dict[str, str]) -> str:
    k = next(iter(subject))
    return f"{k}:{subject[k]}"


def _companies(rows: list[dict[str, str]], cohorts: list[str]) -> list[dict[str, Any]]:
    """Unique valid companies in either compared cohort, in order of first appearance."""
    out: list[dict[str, Any]] = []
    index: dict[str, dict[str, Any]] = {}
    for r in rows:
        if (r.get("cohort") or "") not in cohorts:
            continue
        subject, _ = _subject(r)
        if subject is None:
            continue
        k = _key(subject)
        if k not in index:
            index[k] = {"key": k, "subject": subject, "ext": f"c-{len(out) + 1}", "row_ids": [], "cohorts": []}
            out.append(index[k])
        index[k]["row_ids"].append(r["row_id"])
        if r["cohort"] not in index[k]["cohorts"]:
            index[k]["cohorts"].append(r["cohort"])
    return out


def plan(rows: list[dict[str, str]], config: dict[str, Any]) -> list[PlannedCall]:
    n = len(_companies(rows, config["cohorts"]))
    q = len(config["questions"])
    b = config["batch_size"]
    batches = -(-n // b)
    return [
        PlannedCall("GET /decisions", "Read the decision tool list and check each question's tool and inputs", 1, []),
        PlannedCall("POST /decisions", f"{q} question(s) for {n} unique valid company(ies) in the two cohorts, in "
                                       f"batches of up to {b}",
                    q * batches, pricing.estimate_decision(n * q, config["with_reasoning"])),
    ]


def _tenths(num: int, den: int) -> int:
    """num / den x 1000, rounded half away from zero to a whole number, computed with whole numbers."""
    t = (2000 * abs(num) + den) // (2 * den)
    return -t if num < 0 else t


def _pct(part: int, whole: int) -> tuple[float, str]:
    t = _tenths(part, whole)
    return t / 10, f"{t // 10}.{t % 10}"


def measure(keys: list[str], answers: dict[str, dict[str, dict[str, Any]]], qid: str, min_answered: int) -> dict[str, Any]:
    counts = {a: 0 for a in ANSWERS}
    for k in keys:
        counts[answers[k][qid]["answer"]] += 1
    n = len(keys)
    asked = n - counts["not_asked"]
    answered = counts["yes"] + counts["no"]
    enough = answered >= min_answered
    block: dict[str, Any] = {"companies_in_cohort": n, "companies_asked": asked, **counts, "answered": answered,
                             "enough_answers": enough}
    if enough:
        value, text = _pct(counts["yes"], answered)
        block["yes_share_pct"] = value
        block["yes_share"] = f"{counts['yes']} of {answered} answered ({text}%)"
    else:
        block["yes_share_pct"] = None
        block["yes_share"] = f"too few answers to compare ({answered} answered, minimum {min_answered})"
    if asked:
        value, text = _pct(counts["unknown"], asked)
        block["unknown_share_pct"] = value
        block["unknown_share"] = f"{counts['unknown']} of {asked} asked ({text}%)"
    else:
        block["unknown_share_pct"] = None
        block["unknown_share"] = "no companies asked"
    return block


def difference(a: dict[str, Any], b: dict[str, Any], names: list[str], min_answered: int) -> dict[str, Any]:
    if not (a["enough_answers"] and b["enough_answers"]):
        return {"comparable": False, "yes_share_difference_pp": None,
                "text": (f"too few answers to compare ({names[0]}: {a['answered']} answered, {names[1]}: "
                         f"{b['answered']} answered, minimum {min_answered})")}
    t = _tenths(a["yes"] * b["answered"] - b["yes"] * a["answered"], a["answered"] * b["answered"])
    sign = "+" if t > 0 else "-" if t < 0 else ""
    return {"comparable": True, "yes_share_difference_pp": t / 10,
            "text": f"{sign}{abs(t) // 10}.{abs(t) % 10} percentage points ({names[0]} minus {names[1]})"}


def _record(qid: str, resp: dict[str, Any]) -> dict[str, Any]:
    ans = answer_from(resp)
    err = resp.get("error")
    if ans["answer"] in ("yes", "no", "unknown"):
        outcome = ans["answer"]
    else:
        code = err.get("code") if isinstance(err, dict) else None
        outcome = "not_found" if isinstance(code, str) and code.endswith("not_found") else "error"
    return {"question_id": qid, "answer": outcome, "decision": ans["answer"], "confidence": ans["confidence"],
            "details": ans["details"], "reasoning": ans["reasoning"], "answered_at": ans["answered_at"],
            "credits": ans["credits"], "error": err if err else None, "entity_id": ans["entity_id"],
            "request_id": ans["request_id"]}


def _empty(qid: str, outcome: str, error: Any = None) -> dict[str, Any]:
    return {"question_id": qid, "answer": outcome, "decision": None, "confidence": None, "details": None,
            "reasoning": None, "answered_at": None, "credits": None, "error": error, "entity_id": None,
            "request_id": None}


def _error_text(err: Any) -> str:
    if isinstance(err, dict):
        return str(err.get("message") or err.get("code") or "error")
    return str(err)


def ask_all(ctx: RunContext, questions: list[dict[str, Any]], companies: list[dict[str, Any]],
            batch_size: int, with_reasoning: bool) -> dict[str, dict[str, dict[str, Any]]]:
    """Asks every question for every company in batches. Returns answers[company_key][question_id]."""
    answers: dict[str, dict[str, dict[str, Any]]] = {c["key"]: {} for c in companies}
    for q in questions:
        qid = q["id"]
        for start in range(0, len(companies), batch_size):
            chunk = companies[start:start + batch_size]
            batch_no = start // batch_size + 1
            if ctx.stopped is not None:
                for c in chunk:
                    answers[c["key"]][qid] = _empty(qid, "not_asked")
                continue
            records = [{**c["subject"], "external_id": c["ext"]} for c in chunk]
            try:
                resp = ctx.client.make_decision(q["tool"], {**q["inputs"], "records": records},
                                                with_reasoning=with_reasoning)
                results = resp.get("results")
                if not isinstance(results, list):
                    raise InvalidResponseError("The batch response has no results list.", endpoint="POST /decisions")
            except FirmableError as e:
                entry = ctx.record_error(chunk[0]["row_ids"][0], e)
                entry["question_id"] = qid
                entry["batch"] = batch_no
                # A request stopped by the credit limit was never sent, so its companies were not asked.
                outcome = "not_asked" if e.kind == "budget_exceeded" else "error"
                for c in chunk:
                    answers[c["key"]][qid] = _empty(qid, outcome, entry)
                continue
            by_ext = {r.get("external_id"): r for r in results if isinstance(r, dict) and r.get("external_id")}
            for idx, c in enumerate(chunk):
                r = by_ext.get(c["ext"])
                if r is None and len(results) == len(chunk) and isinstance(results[idx], dict) \
                        and not results[idx].get("external_id"):
                    r = results[idx]
                if r is None:
                    entry = ctx.record_error(c["row_ids"][0], InvalidResponseError(
                        f"The batch response has no answer for external_id {c['ext']!r}.", endpoint="POST /decisions"))
                    entry["question_id"] = qid
                    entry["batch"] = batch_no
                    answers[c["key"]][qid] = _empty(qid, "error", entry)
                    continue
                rec = _record(qid, r)
                answers[c["key"]][qid] = rec
                if rec["answer"] == "error":
                    ctx.errors.append({"row_id": c["row_ids"][0], "kind": "answer_error", "status": None,
                                       "code": rec["error"].get("code") if isinstance(rec["error"], dict) else None,
                                       "endpoint": "POST /decisions", "message": _error_text(rec["error"]),
                                       "charge_uncertain": False, "retry_after": None, "question_id": qid,
                                       "batch": batch_no})
    return answers


def _row_status(recs: list[dict[str, Any]], labels: dict[str, str]) -> tuple[str, str]:
    outcomes = [r["answer"] for r in recs]
    total = len(outcomes)
    if all(o == "not_asked" for o in outcomes):
        return "not_processed", "The run stopped before any question was asked for this company."
    if all(o == "not_found" for o in outcomes):
        return "not_found", "Firmable did not find this company for any question."
    missing = [r for r in recs if r["answer"] in ("error", "not_found", "not_asked")]
    if missing:
        parts = ", ".join(f"{labels[r['question_id']]} ({r['answer']})" for r in missing)
        return "incomplete", f"{len(missing)} of {total} question(s) have no yes, no or unknown answer: {parts}."
    y = outcomes.count("yes")
    n = outcomes.count("no")
    u = outcomes.count("unknown")
    return "answered", f"All {total} question(s) answered: {y} yes, {n} no, {u} unknown."


def run(ctx: RunContext) -> dict[str, Any]:
    cfg = ctx.config
    questions = cfg["questions"]
    m = cfg["min_answered"]
    coverage = [
        "The two cohorts are the input file you supplied. The REST API has no general company search and no reverse "
        "lookup by decision, so this recipe cannot add companies to either cohort.",
        FIXED_NOTE,
        "An unknown answer means Firmable does not hold the fact. It is never counted as a no.",
        "A yes share is yes over yes plus no among the companies checked, shown with that denominator. The unknown "
        "share is unknown over the companies asked.",
        f"A difference is shown only when both cohorts have at least {m} yes or no answers to the question.",
        "Duplicate rows are matched on the identifier as given. The same company entered once by domain and once by "
        "company ID is asked twice and counted twice.",
    ]
    companies = _companies(ctx.rows, cfg["cohorts"])
    labels = {q["id"]: q["label"] for q in questions}

    def finish(answers: dict[str, dict[str, dict[str, Any]]] | None, stop_reason: str | None) -> dict[str, Any]:
        return _assemble(ctx, cfg, companies, answers, stop_reason, coverage, labels)

    try:
        catalogue = ctx.client.list_decision_tools()
    except FirmableError as e:
        ctx.record_error(None, e)
        return finish(None, "The decision tool list could not be read, so no questions were asked.")
    problems = check_tools(catalogue, questions, "company")
    if problems:
        for p in problems:
            ctx.errors.append({"row_id": None, "kind": "config", "status": None, "code": None,
                               "endpoint": "GET /decisions", "message": p, "charge_uncertain": False,
                               "retry_after": None})
        coverage.extend(problems)
        return finish(None, "The configuration names decision tools or inputs the API does not accept.")
    model_tools = sorted({q["tool"] for q in questions if uses_model(catalogue, q["tool"])})
    if model_tools:
        coverage.append(f"These decision tools use a decision model inside Firmable's service: "
                        f"{', '.join(model_tools)}. This code adds no model of its own and only counts the answers.")
    answers = ask_all(ctx, questions, companies, cfg["batch_size"], cfg["with_reasoning"])
    return finish(answers, None)


def _assemble(ctx: RunContext, cfg: dict[str, Any], companies: list[dict[str, Any]],
              answers: dict[str, dict[str, dict[str, Any]]] | None, stop_reason: str | None,
              coverage: list[str], labels: dict[str, str]) -> dict[str, Any]:
    questions = cfg["questions"]
    names = cfg["cohorts"]
    m = cfg["min_answered"]
    if answers is None:
        answers = {c["key"]: {q["id"]: _empty(q["id"], "not_asked") for q in questions} for c in companies}
    both = {c["key"] for c in companies if len(c["cohorts"]) > 1}
    first_row: dict[str, str] = {}
    members: dict[str, list[str]] = {n: [] for n in names}
    rows_out: list[dict[str, Any]] = []
    ignored: dict[str, int] = {}
    for r in ctx.rows:
        cohort = r.get("cohort") or ""
        base = {"row_id": r["row_id"], "input": r, "cohort": cohort, "company_key": None, "in_both_cohorts": False,
                "duplicate_of": None, "firmable_id": None, "answers": []}
        if cohort not in names:
            ignored[cohort] = ignored.get(cohort, 0) + 1
            rows_out.append({**base, "status": "ignored",
                             "status_reason": f"Cohort {cohort!r} is not one of the two compared cohorts."})
            continue
        subject, reason = _subject(r)
        if subject is None:
            rows_out.append({**base, "status": "invalid_input", "status_reason": reason})
            continue
        k = _key(subject)
        if k not in members[cohort]:
            members[cohort].append(k)
        dup = first_row.get(k)
        first_row.setdefault(k, r["row_id"])
        recs = [answers[k][q["id"]] for q in questions]
        if stop_reason is not None:
            status, reason = "not_processed", stop_reason
        else:
            status, reason = _row_status(recs, labels)
        ids = [x["entity_id"] for x in recs if x["entity_id"]]
        rows_out.append({**base, "company_key": k, "in_both_cohorts": k in both, "duplicate_of": dup,
                         "firmable_id": ids[0] if ids else None, "status": status, "status_reason": reason,
                         "answers": recs})

    summaries = []
    for q in questions:
        blocks = [{"cohort": n, "measure": measure(members[n], answers, q["id"], m)} for n in names]
        summaries.append({"id": q["id"], "label": q["label"], "tool": q["tool"], "cohorts": blocks,
                          "difference": difference(blocks[0]["measure"], blocks[1]["measure"], names, m)})
    counts: dict[str, int] = {}
    for r in rows_out:
        counts[r["status"]] = counts.get(r["status"], 0) + 1
    dupes = sum(1 for r in rows_out if r["duplicate_of"])
    if both:
        coverage.append(f"{len(both)} company(ies) are in both cohorts. Each was asked once and is counted in both.")
    if dupes:
        coverage.append(f"{dupes} row(s) repeat an earlier company; that company's answers were reused.")
    n_ignored = sum(ignored.values())
    if n_ignored:
        coverage.append(f"{n_ignored} row(s) had another cohort value and were ignored.")
    summary = {"cohorts": names, "input_rows": len(ctx.rows), "ignored_rows": n_ignored,
               "ignored_cohort_values": [{"cohort": k, "rows": v} for k, v in ignored.items()],
               "invalid_rows": counts.get("invalid_input", 0), "duplicate_rows": dupes,
               "companies_in_both": len(both), "companies_asked_once": len(companies),
               "cohort_sizes": {n: len(members[n]) for n in names}, "min_answered": m,
               "status_counts": counts, "questions": summaries}
    return {"rows": rows_out, "summary": summary, "coverage": coverage}


def csv_columns(result: dict[str, Any]) -> list[str]:
    return BASE_COLUMNS + [q["id"] for q in result["input"]["config"]["questions"]]


def csv_rows(result: dict[str, Any]) -> list[dict[str, Any]]:
    out = []
    for r in result["rows"]:
        inp = r["input"]
        row = {"row_id": r["row_id"], "domain": inp.get("domain"), "company_id": inp.get("company_id"),
               "company_name": inp.get("company_name"), "cohort": r.get("cohort", inp.get("cohort")),
               "in_both_cohorts": r.get("in_both_cohorts"), "status": r["status"],
               "status_reason": r.get("status_reason") or r.get("reason"), "duplicate_of": r.get("duplicate_of"),
               "firmable_id": r.get("firmable_id")}
        for a in r.get("answers") or []:
            row[a["question_id"]] = a["answer"]
        out.append(row)
    return out


_MEASURE_ROWS = [("Companies", "companies_in_cohort"), ("Asked", "companies_asked"), ("Yes", "yes"), ("No", "no"),
                 ("Unknown", "unknown"), ("Error", "error"), ("Not found", "not_found"), ("Not asked", "not_asked"),
                 ("Yes share of answered", "yes_share"), ("Unknown share of asked", "unknown_share")]
INTERPRETATION = [
    "Yes and no are Firmable's answers as returned. Unknown means Firmable does not hold the fact; it is not a no.",
    "A yes share counts only yes and no answers. Its denominator is shown beside it.",
    "Error, not found and not asked are not answers and are left out of every share.",
    FIXED_NOTE,
]


def markdown(result: dict[str, Any]) -> dict[str, str]:
    s = result["summary"]
    a, b = s["cohorts"]
    sizes = s["cohort_sizes"]
    lines = [f"# Cohort comparison: {md_escape(a)} and {md_escape(b)}", "",
             f"Cohort {md_escape(a)}: {sizes[a]} company(ies). Cohort {md_escape(b)}: {sizes[b]} company(ies).",
             f"{s['companies_in_both']} company(ies) are in both cohorts and are counted in both.",
             f"{s['ignored_rows']} input row(s) had another cohort value and were ignored. "
             f"{s['invalid_rows']} row(s) were not valid.", "",
             f"> {md_escape(FIXED_NOTE)}", ""]
    for q in s["questions"]:
        ma, mb = q["cohorts"][0]["measure"], q["cohorts"][1]["measure"]
        lines += [f"## {md_escape(q['label'])}", "", f"Tool: {md_escape(q['tool'])}", "",
                  f"| Measure | {md_escape(a)} | {md_escape(b)} |", "| - | - | - |"]
        for label, key in _MEASURE_ROWS:
            lines.append(f"| {label} | {md_escape(ma[key])} | {md_escape(mb[key])} |")
        lines += ["", f"Difference in yes share: {md_escape(q['difference']['text'])}.", ""]
    lines += ["## How to read this", ""] + [f"- {md_escape(t)}" for t in INTERPRETATION]
    if result.get("coverage"):
        lines += ["", "## Coverage and limitations", ""] + [f"- {md_escape(c)}" for c in result["coverage"]]
    return {"comparison.md": "\n".join(lines) + "\n"}


def _company_label(r: dict[str, Any]) -> str:
    inp = r["input"]
    return inp.get("company_name") or inp.get("domain") or inp.get("company_id") or r["row_id"]


def render(report: Any, result: dict[str, Any]) -> None:
    s = result["summary"]
    a, b = s["cohorts"]
    counts = s.get("status_counts", {})
    body = ("<p>" + " ".join(badge(f"{k.replace('_', ' ')}: {v}", STATUS_TONE.get(k, "neutral"))
                             for k, v in counts.items()) + "</p>"
            + f"<p>Cohort {esc(a)}: {esc(s['cohort_sizes'][a])} company(ies). Cohort {esc(b)}: "
              f"{esc(s['cohort_sizes'][b])} company(ies). {esc(s['companies_in_both'])} company(ies) are in both "
              f"and are counted in both. {esc(s['ignored_rows'])} row(s) had another cohort value and were "
              "ignored.</p>"
            + note(esc(FIXED_NOTE), "unknown"))
    for q in s["questions"]:
        ma, mb = q["cohorts"][0]["measure"], q["cohorts"][1]["measure"]
        diff = q["difference"]
        body += (f"<h3>{esc(q['label'])}</h3><p class=\"muted\">Tool: {esc(q['tool'])}</p>"
                 + table(["Measure", a, b], [[label, ma[key], mb[key]] for label, key in _MEASURE_ROWS])
                 + note(f"Difference in yes share: {esc(diff['text'])}.", "info" if diff["comparable"] else "unknown"))
    report.add("Result", "The two cohorts side by side", body)

    rows = []
    for r in result["rows"]:
        answers = " ".join(f"{x['question_id']}={x['answer']}" for x in r.get("answers") or [])
        rows.append([r["row_id"], _company_label(r), r.get("cohort"), "yes" if r.get("in_both_cohorts") else "no",
                     Raw(badge(r["status"].replace("_", " "), STATUS_TONE.get(r["status"], "neutral"))),
                     r.get("status_reason") or r.get("reason") or "", answers])
    report.add("Companies", "Each input row",
               table(["Row", "Company", "Cohort", "In both", "Status", "Reason", "Answers"], rows)
               + details_json("Answers as JSON", [{"row_id": r["row_id"], "answers": r.get("answers")}
                                                  for r in result["rows"]]))


RECIPE = Recipe(NAME, TITLE, DESCRIPTION, load_config, read_input, plan, run, csv_columns, csv_rows, render,
                markdown=markdown)
