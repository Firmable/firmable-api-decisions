"""Cohort question radar: asks the same Decisions company questions across a cohort you supply.

Workflow:
1. Read the input rows. Each row names a company by `company_id` or `domain`. Rows that name the
   same company reuse its answers and are flagged as duplicates.
2. Read the decision tool list (GET /decisions, free) and check every question's tool and inputs.
   A wrong tool or input stops the run before any paid call.
3. For each question, ask every unique valid company in batches of up to `batch_size` records
   (POST /decisions with question.records).
4. Classify each answer as yes, no, unknown, error, not_found or not_asked, and count them per
   question, and per group when `group_by` names an input column.

Measure rules:
- A yes share is yes over (yes + no) and is always shown with that denominator.
- The unknown share is unknown over the companies asked.
- A question with fewer than `min_answered` yes or no answers is "too few answers to compare" and
  shows no yes share.
- Unknown is never counted as no. A batch row with an error is that company's error, or its
  not_found outcome when the error code ends in "not_found"; the other rows still count.
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from firmable_client import pricing
from firmable_client.decisions import SUBJECT_KEYS, answer_from, check_tools, uses_model
from firmable_client.errors import ConfigError, FirmableError, InvalidResponseError
from firmable_client.io import normalise_domain, read_rows
from firmable_client.recipe import PlannedCall, Recipe, RunContext
from firmable_client.report import Raw, badge, details_json, esc, note, table

NAME = "cohort-question-radar"
TITLE = "Cohort question radar"
DESCRIPTION = ("Asks the same Firmable Decisions company questions across a cohort of companies you supply, "
               "and shows how the answers come out, with every count beside its denominator.")

ASSET = Path(__file__).resolve().parents[3] / "assets" / "explorer.js"
ANSWERS = ["yes", "no", "unknown", "error", "not_found", "not_asked"]
ANSWER_TONE = {"yes": "info", "no": "neutral", "unknown": "unknown", "error": "error", "not_found": "review",
               "not_asked": "unknown"}
STATUS_TONE = {"answered": "good", "incomplete": "review", "not_found": "review", "invalid_input": "error",
               "not_processed": "unknown"}
BASE_COLUMNS = ["row_id", "domain", "company_id", "company_name", "group", "status", "status_reason",
                "duplicate_of", "firmable_id"]
NO_GROUP = "(no value)"
_ID = re.compile(r"^[a-z0-9_]{1,40}$")
_COMPANY_ID = re.compile(r"^f\d{12}$")
_TOP_KEYS = {"questions", "with_reasoning", "batch_size", "min_answered", "group_by"}
_QUESTION_KEYS = {"id", "label", "tool", "inputs"}


def _whole(x: Any) -> bool:
    return isinstance(x, int) and not isinstance(x, bool)


def load_config(raw: dict[str, Any]) -> dict[str, Any]:
    unknown = sorted(set(raw) - _TOP_KEYS)
    if unknown:
        raise ConfigError(f"Unknown configuration key(s): {', '.join(unknown)}")
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
    gb = raw.get("group_by")
    if gb is not None and (not isinstance(gb, str) or not gb or gb == "row_id"):
        raise ConfigError("group_by must be the name of an input column other than row_id.")
    return {"questions": questions, "with_reasoning": wr, "batch_size": bs, "min_answered": ma, "group_by": gb}


def read_input(path: Path) -> list[dict[str, str]]:
    return read_rows(path, any_of=["domain", "company_id"])


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


def _companies(rows: list[dict[str, str]]) -> list[dict[str, Any]]:
    """Unique valid companies in order of first appearance."""
    out: list[dict[str, Any]] = []
    index: dict[str, dict[str, Any]] = {}
    for r in rows:
        subject, _ = _subject(r)
        if subject is None:
            continue
        k = _key(subject)
        if k not in index:
            index[k] = {"key": k, "subject": subject, "ext": f"c-{len(out) + 1}", "row_ids": []}
            out.append(index[k])
        index[k]["row_ids"].append(r["row_id"])
    return out


def plan(rows: list[dict[str, str]], config: dict[str, Any]) -> list[PlannedCall]:
    n = len(_companies(rows))
    q = len(config["questions"])
    b = config["batch_size"]
    batches = -(-n // b)
    return [
        PlannedCall("GET /decisions", "Read the decision tool list and check each question's tool and inputs", 1, []),
        PlannedCall("POST /decisions", f"{q} question(s) for {n} unique valid company(ies), in batches of up to {b}",
                    q * batches, pricing.estimate_decision(n * q, config["with_reasoning"])),
    ]


def _pct(part: int, whole: int) -> tuple[float, str]:
    """part / whole as a percentage rounded half up to one decimal, computed with whole numbers."""
    tenths = (2000 * part + whole) // (2 * whole)
    return tenths / 10, f"{tenths // 10}.{tenths % 10}"


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


def _record(qid: str, resp: dict[str, Any]) -> dict[str, Any]:
    ans = answer_from(resp)
    err = resp.get("error")
    if ans["answer"] in ("yes", "no", "unknown"):
        outcome = ans["answer"]
    else:
        code = err.get("code") if isinstance(err, dict) else None
        outcome = "not_found" if isinstance(code, str) and code.endswith("not_found") else "error"
    entity = resp.get("entity") if isinstance(resp.get("entity"), dict) else {}
    return {"question_id": qid, "answer": outcome, "decision": ans["answer"], "confidence": ans["confidence"],
            "details": ans["details"], "reasoning": ans["reasoning"], "answered_at": ans["answered_at"],
            "credits": ans["credits"], "error": err if err else None, "entity_id": ans["entity_id"],
            "profile_url": entity.get("profile_url"), "request_id": ans["request_id"]}


def _empty(qid: str, outcome: str, error: Any = None) -> dict[str, Any]:
    return {"question_id": qid, "answer": outcome, "decision": None, "confidence": None, "details": None,
            "reasoning": None, "answered_at": None, "credits": None, "error": error, "entity_id": None,
            "profile_url": None, "request_id": None}


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
    gb = cfg["group_by"]
    coverage = [
        "The cohort is the input file you supplied. The REST API has no general company search and no reverse "
        "lookup by decision, so this recipe cannot add companies to the cohort.",
        "Answers describe the companies in this cohort only. They do not describe a market, sector or population.",
        "An unknown answer means Firmable does not hold the fact. It is never counted as a no.",
        "A yes share is yes over yes plus no among the companies checked, shown with that denominator. The unknown "
        "share is unknown over the companies asked.",
        f"A question with fewer than {m} yes or no answers is marked too few answers to compare and shows no yes share.",
        "Duplicate rows are matched on the identifier as given. The same company entered once by domain and once by "
        "company ID is asked twice and counted twice.",
    ]
    companies = _companies(ctx.rows)
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
    if gb is not None and not any(gb in r for r in ctx.rows):
        coverage.append(f"The group_by column {gb!r} is not in the input, so every company is in the group "
                        f"{NO_GROUP}.")
    answers = ask_all(ctx, questions, companies, cfg["batch_size"], cfg["with_reasoning"])
    return finish(answers, None)


def _assemble(ctx: RunContext, cfg: dict[str, Any], companies: list[dict[str, Any]],
              answers: dict[str, dict[str, dict[str, Any]]] | None, stop_reason: str | None,
              coverage: list[str], labels: dict[str, str]) -> dict[str, Any]:
    questions = cfg["questions"]
    gb = cfg["group_by"]
    m = cfg["min_answered"]
    if answers is None:
        answers = {c["key"]: {q["id"]: _empty(q["id"], "not_asked") for q in questions} for c in companies}
    first_row: dict[str, str] = {}
    rows_out: list[dict[str, Any]] = []
    group_members: dict[str, list[str]] = {}
    company_groups: dict[str, list[str]] = {}
    for r in ctx.rows:
        group = (r.get(gb) or NO_GROUP) if gb else None
        subject, reason = _subject(r)
        base = {"row_id": r["row_id"], "input": r, "group": group, "company_key": None, "duplicate_of": None,
                "firmable_id": None, "answers": []}
        if subject is None:
            rows_out.append({**base, "status": "invalid_input", "status_reason": reason})
            continue
        k = _key(subject)
        if group is not None:
            members = group_members.setdefault(group, [])
            if k not in members:
                members.append(k)
            groups = company_groups.setdefault(k, [])
            if group not in groups:
                groups.append(group)
        dup = first_row.get(k)
        first_row.setdefault(k, r["row_id"])
        recs = [answers[k][q["id"]] for q in questions]
        if stop_reason is not None:
            status, reason = "not_processed", stop_reason
        else:
            status, reason = _row_status(recs, labels)
        ids = [x["entity_id"] for x in recs if x["entity_id"]]
        rows_out.append({**base, "company_key": k, "duplicate_of": dup, "firmable_id": ids[0] if ids else None,
                         "firmable_ids_differ": len(set(ids)) > 1, "status": status, "status_reason": reason,
                         "answers": recs})

    keys = [c["key"] for c in companies]
    summaries = []
    for q in questions:
        entry: dict[str, Any] = {"id": q["id"], "label": q["label"], "tool": q["tool"],
                                 "measure": measure(keys, answers, q["id"], m), "groups": []}
        if gb is not None:
            entry["groups"] = [{"group": g, "measure": measure(ks, answers, q["id"], m)}
                               for g, ks in group_members.items()]
        summaries.append(entry)
    counts: dict[str, int] = {}
    for r in rows_out:
        counts[r["status"]] = counts.get(r["status"], 0) + 1
    dupes = sum(1 for r in rows_out if r["duplicate_of"])
    if dupes:
        coverage.append(f"{dupes} row(s) repeat an earlier company; that company's answers were reused and it is "
                        "counted once.")
    multi = sum(1 for g in company_groups.values() if len(g) > 1)
    if multi:
        coverage.append(f"{multi} company(ies) appear in more than one group and are counted once in each group.")
    differ = sorted({r["company_key"] for r in rows_out if r.get("firmable_ids_differ")})
    if differ:
        coverage.append(f"{len(differ)} company(ies) were matched to different Firmable IDs by different questions: "
                        f"{', '.join(differ)}. The answers are shown as returned.")
    summary = {"input_rows": len(ctx.rows), "invalid_rows": counts.get("invalid_input", 0), "duplicate_rows": dupes,
               "companies_in_cohort": len(companies), "min_answered": m, "group_by": gb,
               "status_counts": counts, "questions": summaries}
    return {"rows": rows_out, "summary": summary, "coverage": coverage}


def csv_columns(result: dict[str, Any]) -> list[str]:
    return BASE_COLUMNS + [q["id"] for q in result["input"]["config"]["questions"]]


def csv_rows(result: dict[str, Any]) -> list[dict[str, Any]]:
    out = []
    for r in result["rows"]:
        inp = r["input"]
        row = {"row_id": r["row_id"], "domain": inp.get("domain"), "company_id": inp.get("company_id"),
               "company_name": inp.get("company_name"), "group": r.get("group"), "status": r["status"],
               "status_reason": r.get("status_reason") or r.get("reason"), "duplicate_of": r.get("duplicate_of"),
               "firmable_id": r.get("firmable_id")}
        for a in r.get("answers") or []:
            row[a["question_id"]] = a["answer"]
        out.append(row)
    return out


def _company_label(r: dict[str, Any]) -> str:
    inp = r["input"]
    return inp.get("company_name") or inp.get("domain") or inp.get("company_id") or r["row_id"]


def explorer_data(result: dict[str, Any]) -> dict[str, Any]:
    cfg = result["input"]["config"]
    companies: list[dict[str, Any]] = []
    index: dict[str, dict[str, Any]] = {}
    for r in result["rows"]:
        k = r.get("company_key")
        if not k:
            continue
        if k in index:
            c = index[k]
            c["row_ids"].append(r["row_id"])
            if r.get("group") is not None and r["group"] not in c["groups"]:
                c["groups"].append(r["group"])
            continue
        profile = next((a["profile_url"] for a in r["answers"] if a.get("profile_url")), None)
        c = {"key": k, "label": _company_label(r), "identifier": k.split(":", 1)[1], "row_ids": [r["row_id"]],
             "groups": [r["group"]] if r.get("group") is not None else [], "firmable_id": r.get("firmable_id"),
             "profile_url": profile, "status": r["status"], "status_reason": r.get("status_reason"),
             "answers": {}}
        for a in r["answers"]:
            rs = a.get("reasoning") or {}
            c["answers"][a["question_id"]] = {
                "answer": a["answer"], "confidence": a.get("confidence"), "details": a.get("details"),
                "reason": rs.get("reason"), "source": rs.get("source"), "fact_date": rs.get("fact_date"),
                "last_refreshed": rs.get("last_refreshed"), "would_change_if": rs.get("would_change_if"),
                "error": _error_text(a["error"]) if a.get("error") else None}
        index[k] = c
        companies.append(c)
    return {"questions": [{"id": q["id"], "label": q["label"], "tool": q["tool"]} for q in cfg["questions"]],
            "group_by": cfg.get("group_by"), "min_answered": cfg["min_answered"],
            "answer_values": ANSWERS, "measures": result["summary"].get("questions", []), "companies": companies}


_MEASURE_HEADERS = ["Question", "Companies", "Asked", "Yes", "No", "Unknown", "Error", "Not found", "Not asked",
                    "Yes share of answered", "Unknown share of asked"]


def _measure_cells(label: str, b: dict[str, Any]) -> list[Any]:
    return [label, b["companies_in_cohort"], b["companies_asked"], b["yes"], b["no"], b["unknown"], b["error"],
            b["not_found"], b["not_asked"], b["yes_share"], b["unknown_share"]]


EXPLORER_CSS = (
    "<style>.rx-filters{display:flex;flex-wrap:wrap;gap:8px 16px;margin:0 0 12px}"
    ".rx-filters label{display:flex;flex-direction:column;font-size:12px;color:var(--muted);font-weight:700}"
    ".rx-filters select{font:inherit;font-size:14px;padding:4px 6px;max-width:100%}"
    ".rx-bar{display:flex;height:12px;border-radius:6px;overflow:hidden;background:var(--shale);margin:4px 0}"
    ".rx-bar span{display:block;height:100%}.rx-yes{background:#F15B06}.rx-no{background:#5B6170}"
    ".rx-unknown{background:#C9CCD3}.rx-error{background:#C0392B}.rx-not_found{background:#E5A04B}"
    ".rx-not_asked{background:#E9EAEB}.rx-q{margin:0 0 12px}.rx-company{font:inherit;background:none;border:0;"
    "padding:0;color:var(--ember);text-decoration:underline;cursor:pointer;text-align:left}"
    "#rx-drill{margin-top:14px}</style>"
)


def render(report: Any, result: dict[str, Any]) -> None:
    s = result["summary"]
    counts = s.get("status_counts", {})
    head = ("<p>" + " ".join(badge(f"{k.replace('_', ' ')}: {v}", STATUS_TONE.get(k, "neutral"))
                             for k, v in counts.items()) + "</p>"
            + f"<p>{esc(s.get('companies_in_cohort'))} unique company(ies) from {esc(s.get('input_rows'))} input "
              f"row(s). {esc(s.get('invalid_rows'))} row(s) were not valid and {esc(s.get('duplicate_rows'))} "
              "repeated an earlier company.</p>"
            + note("These counts describe the companies in this cohort only. Unknown means Firmable does not hold "
                   "the fact; it is never counted as a no. A yes share is yes over yes plus no.", "unknown"))
    rows = [_measure_cells(q["label"], q["measure"]) for q in s.get("questions", [])]
    body = head + table(_MEASURE_HEADERS, rows)
    for q in s.get("questions", []):
        if q.get("groups"):
            body += (f"<h3>{esc(q['label'])} by {esc(s.get('group_by'))}</h3>"
                     + table(["Group"] + _MEASURE_HEADERS[1:],
                             [_measure_cells(g["group"], g["measure"]) for g in q["groups"]]))
    report.add("Result", "Answers across the cohort", body)

    report.add("Explorer", "Question-by-company explorer",
               EXPLORER_CSS + '<div id="radar-explorer"><p class="muted" id="rx-fallback">The explorer needs '
               "JavaScript. The tables on this page and results.csv hold the same answers.</p></div>")
    report.add_data("radar-data", explorer_data(result))
    report.add_script(ASSET.read_text(encoding="utf-8"))

    company_rows = []
    for r in result["rows"]:
        reason = r.get("status_reason") or r.get("reason") or ""
        answers = " ".join(f"{a['question_id']}={a['answer']}" for a in r.get("answers") or [])
        company_rows.append([r["row_id"], _company_label(r), r.get("group"),
                             Raw(badge(r["status"].replace("_", " "), STATUS_TONE.get(r["status"], "neutral"))),
                             reason, answers])
    report.add("Companies", "Each input row",
               table(["Row", "Company", "Group", "Status", "Reason", "Answers"], company_rows)
               + details_json("Answers as JSON", [{"row_id": r["row_id"], "answers": r.get("answers")}
                                                  for r in result["rows"]]))


RECIPE = Recipe(NAME, TITLE, DESCRIPTION, load_config, read_input, plan, run, csv_columns, csv_rows, render)
