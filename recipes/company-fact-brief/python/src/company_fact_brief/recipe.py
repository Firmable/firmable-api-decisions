"""Company fact brief: what Firmable holds about one company, stated as checkable facts.

Workflow:
1. Read the decision tool list (GET /decisions, free) and check every configured question.
2. For each unique valid company, fetch the profile (GET /company), unless fetch_company is false.
3. Ask every question in batches of up to batch_size companies (POST /decisions with records).
4. Write one Markdown brief per company: profile facts with their field names, each answer with its
   reason, source and dates as returned, what is unknown, what could not be answered, and a fixed
   interpretation. Nothing is generated beyond fixed text and returned values.

Each answer outcome is one of yes, no, unknown, not_found (the batch row's error code ends in
"not_found"), error, or not_asked (the run stopped first). Unknown is never no.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from firmable_client import pricing
from firmable_client.decisions import answer_from, check_tools, uses_model
from firmable_client.errors import ConfigError, FirmableError, InputError, NotFoundError
from firmable_client.io import find_duplicates, normalise_domain, read_rows
from firmable_client.recipe import PlannedCall, Recipe, RunContext
from firmable_client.report import Raw, badge, bullet_list, card, details_json, esc, kv, link, note, table

NAME = "company-fact-brief"
TITLE = "Company fact brief"
DESCRIPTION = ("Writes a Markdown brief for each company: profile facts from Firmable, then each configured "
               "Decisions question with its answer, reason, source and dates as returned.")

MAX_ROWS = 25
_ID = re.compile(r"^[a-z0-9_]{1,40}$")
_COMPANY_ID = re.compile(r"^f\d{12}$")
_TOP_KEYS = {"questions", "with_reasoning", "fetch_company", "batch_size"}
_QUESTION_KEYS = {"id", "label", "tool", "inputs"}
OUTCOMES = ["yes", "no", "unknown", "not_found", "error", "not_asked"]
STATUS_TONE = {"brief_ready": "good", "partial": "review", "company_not_found": "unknown",
               "invalid_input": "error", "error": "error", "not_processed": "unknown"}
OUTCOME_TONE = {"yes": "good", "no": "bad", "unknown": "unknown", "not_found": "unknown", "error": "error",
                "not_asked": "neutral"}
PROFILE_FIELDS = ["id", "name", "website", "fqdn", "hq_country", "company_size", "industries", "year_founded",
                  "company_type"]
INTERPRETATION = [
    "Yes and no are Firmable's answers to the question as asked, from Firmable data as of the last refreshed "
    "date shown.",
    "Unknown means Firmable does not hold the fact needed to answer. It is not a no.",
    "Not found means Firmable could not match the company for that question.",
    "Error and not asked mean no answer came back. They say nothing about the company.",
    "Some decision tools use a decision model inside Firmable's service. This brief adds no model of its own and "
    "no narrative: every sentence above the Interpretation section is a returned value or fixed text.",
]


# ----- configuration and input ------------------------------------------------------------------

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
        seen.add(qid)
        tool = q.get("tool")
        if not isinstance(tool, str) or not tool:
            raise ConfigError(f"questions[{i}].tool must name a decision tool.")
        inputs = q.get("inputs", {})
        if not isinstance(inputs, dict):
            raise ConfigError(f"questions[{i}].inputs must be an object.")
        label = q.get("label", qid)
        if not isinstance(label, str) or not label.strip():
            raise ConfigError(f"questions[{i}].label must be text.")
        questions.append({"id": qid, "label": label, "tool": tool, "inputs": inputs})
    for key in ("with_reasoning", "fetch_company"):
        if not isinstance(raw.get(key, True), bool):
            raise ConfigError(f"{key} must be true or false.")
    bs = raw.get("batch_size", 100)
    if not isinstance(bs, int) or isinstance(bs, bool) or not 1 <= bs <= 100:
        raise ConfigError("batch_size must be a whole number from 1 to 100.")
    return {"questions": questions, "with_reasoning": raw.get("with_reasoning", True),
            "fetch_company": raw.get("fetch_company", True), "batch_size": bs}


def read_input(path: Path) -> list[dict[str, str]]:
    rows = read_rows(path, any_of=["domain", "company_id"])
    if len(rows) > MAX_ROWS:
        raise InputError(f"{Path(path).name} has {len(rows)} rows; this recipe takes up to {MAX_ROWS} companies.")
    return rows


def _subject(row: dict[str, str]) -> tuple[str | None, dict[str, str] | None, str | None]:
    """Returns (key, identifier, problem). A company_id, when given, is used before the domain."""
    cid = (row.get("company_id") or "").strip()
    if cid:
        if not _COMPANY_ID.match(cid):
            return None, None, f"{cid!r} is not a Firmable company ID (f followed by 12 digits)."
        return f"id:{cid}", {"company_id": cid}, None
    domain = normalise_domain(row.get("domain"))
    if not domain:
        return None, None, f"{row.get('domain')!r} is not a valid domain."
    return f"domain:{domain}", {"domain": domain}, None


def _unique_subjects(rows: list[dict[str, str]]) -> list[str]:
    out: list[str] = []
    for r in rows:
        key = _subject(r)[0]
        if key and key not in out:
            out.append(key)
    return out


def _batches(n: int, size: int) -> int:
    return (n + size - 1) // size


def plan(rows: list[dict[str, str]], config: dict[str, Any]) -> list[PlannedCall]:
    n = len(_unique_subjects(rows))
    q = len(config["questions"])
    calls = [PlannedCall("GET /decisions", "Read the decision tool list and check the configured questions", 1, [])]
    if config["fetch_company"]:
        calls.append(PlannedCall("GET /company", "Company profile for each unique valid company", n,
                                 [("company", pricing.round4(pricing.COMPANY_PROFILE * n))]))
    calls.append(PlannedCall("POST /decisions",
                             f"{q} question(s) for each unique valid company, in batches of up to "
                             f"{config['batch_size']}",
                             q * _batches(n, config["batch_size"]),
                             pricing.estimate_decision(n * q, config["with_reasoning"])))
    return calls


# ----- answers ------------------------------------------------------------------------------------

def _blank(outcome: str, error: dict[str, Any] | None = None) -> dict[str, Any]:
    return {"outcome": outcome, "answer": None, "confidence": None, "details": None, "reasoning": None,
            "answered_at": None, "credits": None, "answer_error": None, "entity_id": None, "request_id": None,
            "error": error}


def _is_not_found_code(code: Any) -> bool:
    return isinstance(code, str) and code.endswith("not_found") and code != "tool_not_found"


def _from_result(res: dict[str, Any]) -> dict[str, Any]:
    ans = answer_from(res)
    err = ans["answer_error"]
    if ans["answer"] in ("yes", "no", "unknown"):
        outcome = ans["answer"]
    elif isinstance(err, dict) and _is_not_found_code(err.get("code")):
        outcome = "not_found"
    else:
        outcome = "error"
    return {"outcome": outcome, **ans, "error": None}


def _ask(ctx: RunContext, tool: str, inputs: dict[str, Any], chunk: list[tuple[str, dict[str, str], str]],
         with_reasoning: bool) -> dict[str, dict[str, Any]]:
    """Asks one tool about a chunk of (external_id, subject, first_row_id). Returns answers by external_id."""
    if ctx.stopped is not None:
        return {ext: _blank("not_asked") for ext, _, _ in chunk}
    records = [{**subject, "external_id": ext} for ext, subject, _ in chunk]
    try:
        resp = ctx.client.make_decision(tool, {**inputs, "records": records}, with_reasoning=with_reasoning)
    except FirmableError as e:
        if isinstance(e, NotFoundError) and _is_not_found_code(e.code) and len(chunk) == 1:
            return {chunk[0][0]: {**_blank("not_found"), "answer_error": {"code": e.code, "message": e.message}}}
        entry = ctx.record_error(chunk[0][2] if len(chunk) == 1 else None, e)
        return {ext: _blank("error", entry) for ext, _, _ in chunk}
    results = resp.get("results") if isinstance(resp.get("results"), list) else [resp]
    by_ext = {r.get("external_id"): r for r in results if isinstance(r, dict)}
    out: dict[str, dict[str, Any]] = {}
    for ext, _, _ in chunk:
        r = by_ext.get(ext)
        out[ext] = _from_result(r) if r is not None else _blank(
            "error", {"message": "The batch response has no answer for this company."})
    return out


# ----- workflow -----------------------------------------------------------------------------------

def _conflicts(company: dict[str, Any] | None, answers: list[dict[str, Any]]) -> list[str]:
    """Deterministic checks for profile facts that contradict an answer. Nothing is corrected."""
    if not company:
        return []
    out: list[str] = []
    founded = company.get("year_founded")
    years = sorted({a["answered_at"][:4] for a in answers
                    if isinstance(a.get("answered_at"), str) and re.match(r"^\d{4}", a["answered_at"])})
    if isinstance(founded, int) and not isinstance(founded, bool) and years and founded > int(years[-1]):
        out.append(f"The profile field year_founded is {founded}, which is later than the year the answers "
                   f"were made ({years[-1]}).")
    ctype = company.get("company_type")
    if isinstance(ctype, str):
        low = ctype.lower()
        for a in answers:
            if a["tool"] != "is_publicly_listed":
                continue
            if a["outcome"] == "yes" and "private" in low:
                out.append(f"The question \"{a['label']}\" answered yes, but the profile field company_type is "
                           f"\"{ctype}\".")
            if a["outcome"] == "no" and "public company" in low:
                out.append(f"The question \"{a['label']}\" answered no, but the profile field company_type is "
                           f"\"{ctype}\".")
    return out


def _status(answers: list[dict[str, Any]], fetched: bool) -> tuple[str, str]:
    counts = {o: sum(1 for a in answers if a["outcome"] == o) for o in OUTCOMES}
    n = len(answers)
    answered = counts["yes"] + counts["no"] + counts["unknown"]
    if counts["not_asked"] == n:
        return "not_processed", "The run stopped before any question was asked for this company."
    if not fetched and counts["not_found"] == n:
        return "company_not_found", "Firmable did not match this company for any question."
    summary = (f"{counts['yes']} yes, {counts['no']} no, {counts['unknown']} unknown of {n} question(s).")
    if answered == n:
        return "brief_ready", summary
    missing = n - answered
    return "partial", f"{summary} {missing} question(s) have no answer (error, not found or not asked)."


def run(ctx: RunContext) -> dict[str, Any]:
    cfg = ctx.config
    client = ctx.client
    questions = cfg["questions"]
    coverage = [
        "The companies come from your input file. The REST API has no general company search.",
        "An unknown answer means Firmable does not hold the fact. It is never counted as a no.",
        "Answers describe each company as Firmable holds it on the last refreshed date. They are not a live check.",
    ]

    def stop_all(reason: str) -> dict[str, Any]:
        rows = [{"row_id": r["row_id"], "input": r, "status": "not_processed", "reason": reason} for r in ctx.rows]
        return {"rows": rows, "summary": {"status_counts": {"not_processed": len(rows)}, "question_counts": {}},
                "coverage": coverage}

    try:
        catalogue = client.list_decision_tools()
    except FirmableError as e:
        ctx.record_error(None, e)
        return stop_all("The decision tool list could not be read, so no questions were asked.")
    problems = check_tools(catalogue, questions, "company")
    if problems:
        for p in problems:
            ctx.errors.append({"row_id": None, "kind": "config", "status": None, "code": None,
                               "endpoint": "GET /decisions", "message": p, "charge_uncertain": False,
                               "retry_after": None})
        coverage.extend(problems)
        return stop_all("The configuration names decision tools or inputs the API does not accept.")
    model_tools = sorted({q["tool"] for q in questions if uses_model(catalogue, q["tool"])})
    if model_tools:
        coverage.append(f"These decision tools use a decision model inside Firmable's service: "
                        f"{', '.join(model_tools)}. This code adds no model of its own.")
    if not cfg["fetch_company"]:
        coverage.append("Company profiles were not fetched (fetch_company is false), so briefs have no profile facts.")
    if not cfg["with_reasoning"]:
        coverage.append("Reasoning was not requested (with_reasoning is false), so briefs show no reason, source "
                        "or dates.")

    # Unique subjects in input order.
    keyed: list[dict[str, Any]] = []
    for r in ctx.rows:
        key, ident, problem = _subject(r)
        keyed.append({"row": r, "key": key, "ident": ident, "problem": problem})
    dupes = find_duplicates([{"row_id": k["row"]["row_id"], "_key": k["key"] or ""} for k in keyed], "_key")
    if dupes:
        coverage.append(f"{len(dupes)} row(s) repeat an earlier company; they reuse its answers and its brief.")
    subjects: dict[str, dict[str, Any]] = {}
    for k in keyed:
        if k["key"] and k["key"] not in subjects:
            subjects[k["key"]] = {"ext": f"subject-{len(subjects) + 1}", "ident": k["ident"],
                                  "row_id": k["row"]["row_id"], "company": None, "company_error": None,
                                  "not_found": False, "asked": False}

    # Profiles.
    if cfg["fetch_company"]:
        for s in subjects.values():
            if ctx.stopped is not None:
                break
            ident = s["ident"]
            query = {"id": ident["company_id"]} if "company_id" in ident else {"fqdn": ident["domain"]}
            try:
                s["company"] = client.get_company(**query)
            except NotFoundError:
                s["not_found"] = True
            except FirmableError as e:
                s["company_error"] = ctx.record_error(s["row_id"], e)

    # Questions, in batches over the companies that can be asked.
    askable = [(key, s) for key, s in subjects.items()
               if not s["not_found"] and s["company_error"] is None
               and (s["company"] is not None or not cfg["fetch_company"])]
    answers: dict[str, dict[str, dict[str, Any]]] = {key: {} for key, _ in askable}
    size = cfg["batch_size"]
    for start in range(0, len(askable), size):
        part = askable[start:start + size]
        chunk = []
        for key, s in part:
            s["asked"] = True
            subj = {"company_id": s["company"]["id"]} if s["company"] else s["ident"]
            chunk.append((s["ext"], subj, s["row_id"]))
        for q in questions:
            got = _ask(ctx, q["tool"], q["inputs"], chunk, cfg["with_reasoning"])
            for key, s in part:
                answers[key][q["id"]] = got[s["ext"]]

    def build(k: dict[str, Any]) -> dict[str, Any]:
        row = k["row"]
        base = {"row_id": row["row_id"], "input": row, "subject": k["ident"],
                "duplicate_of": dupes.get(row["row_id"]), "company": None, "answers": [], "conflicts": [],
                "brief_file": None}
        if k["problem"]:
            return {**base, "status": "invalid_input", "status_reason": k["problem"]}
        s = subjects[k["key"]]
        first = s["row_id"]
        if s["not_found"]:
            return {**base, "status": "company_not_found",
                    "status_reason": "Firmable has no company profile for this identifier, so no questions were asked."}
        if s["company_error"] is not None:
            return {**base, "status": "error", "error": s["company_error"],
                    "status_reason": f"The company profile could not be read: {s['company_error']['message']}"}
        if cfg["fetch_company"] and s["company"] is None:
            return {**base, "status": "not_processed",
                    "reason": f"Run stopped earlier: {ctx.stopped['message'] if ctx.stopped else 'no profile'}"}
        company = {f: s["company"].get(f) for f in PROFILE_FIELDS} if s["company"] else None
        got = answers.get(k["key"], {})
        rows_answers = []
        for q in questions:
            a = got.get(q["id"]) or _blank("not_asked")
            rows_answers.append({"question_id": q["id"], "label": q["label"], "tool": q["tool"],
                                 "inputs": q["inputs"], **a})
        status, reason = _status(rows_answers, cfg["fetch_company"])
        if status == "not_processed":
            return {**base, "company": company, "answers": rows_answers, "status": status,
                    "reason": f"Run stopped earlier: {ctx.stopped['message'] if ctx.stopped else reason}"}
        brief = f"brief-{first}.md" if status in ("brief_ready", "partial") else None
        return {**base, "company": company, "answers": rows_answers, "status": status, "status_reason": reason,
                "conflicts": _conflicts(company, rows_answers), "brief_file": brief}

    rows = [build(k) for k in keyed]
    if any(r.get("conflicts") for r in rows):
        coverage.append("Some profile facts contradict an answer. The brief lists them under Possible conflicts and "
                        "does not correct Firmable's data.")
    counts: dict[str, int] = {}
    for r in rows:
        counts[r["status"]] = counts.get(r["status"], 0) + 1
    qcounts: dict[str, dict[str, int]] = {q["id"]: {o: 0 for o in OUTCOMES} for q in questions}
    for r in rows:
        if r.get("duplicate_of"):
            continue
        for a in r.get("answers") or []:
            qcounts[a["question_id"]][a["outcome"]] += 1
    return {"rows": rows, "summary": {"status_counts": counts, "question_counts": qcounts}, "coverage": coverage}


# ----- outputs ------------------------------------------------------------------------------------

def csv_columns(result: dict[str, Any]) -> list[str]:
    qids = [q["id"] for q in result["input"]["config"]["questions"]]
    return (["row_id", "domain", "company_id", "duplicate_of", "status", "status_reason", "company_name",
             "answers_yes", "answers_no", "answers_unknown", "answers_missing", "brief_file"]
            + [f"q_{q}" for q in qids])


def csv_rows(result: dict[str, Any]) -> list[dict[str, Any]]:
    out = []
    for r in result["rows"]:
        answers = r.get("answers") or []
        company = r.get("company") or {}
        subject = r.get("subject") or {}
        row = {
            "row_id": r["row_id"], "domain": subject.get("domain") or r["input"].get("domain"),
            "company_id": company.get("id") or subject.get("company_id"), "duplicate_of": r.get("duplicate_of"),
            "status": r["status"],
            "status_reason": r.get("status_reason") or r.get("reason") or (r.get("error") or {}).get("message"),
            "company_name": company.get("name") or r["input"].get("company_name"),
            "answers_yes": sum(1 for a in answers if a["outcome"] == "yes"),
            "answers_no": sum(1 for a in answers if a["outcome"] == "no"),
            "answers_unknown": sum(1 for a in answers if a["outcome"] == "unknown"),
            "answers_missing": sum(1 for a in answers if a["outcome"] not in ("yes", "no", "unknown")),
            "brief_file": r.get("brief_file"),
        }
        for a in answers:
            row[f"q_{a['question_id']}"] = a["outcome"]
        out.append(row)
    return out


_MD_SPECIAL = set("\\`*_[]<>|")
_MD_URL = re.compile(r"^https?://[^\s()<>\[\]]+$", re.IGNORECASE)


def text_of(v: Any) -> str:
    """Plain text for a returned value, the same in Python and TypeScript."""
    if v is None:
        return ""
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    if isinstance(v, list):
        return ", ".join(text_of(x) for x in v)
    if isinstance(v, dict):
        return json.dumps(v, ensure_ascii=False, separators=(",", ":"))
    return str(v)


def md(v: Any, empty: str = "not returned") -> str:
    """Escapes a value for Markdown: \\ ` * _ [ ] < > | and a leading #. Line breaks become spaces."""
    s = text_of(v)
    if s == "":
        return empty
    s = s.replace("\r\n", " ").replace("\n", " ").replace("\r", " ")
    out = "".join("\\" + ch if ch in _MD_SPECIAL else ch for ch in s)
    return "\\" + out if out.startswith("#") else out


def md_link(url: Any, text: Any = None) -> str:
    label = md(text if text is not None else url)
    if isinstance(url, str) and _MD_URL.match(url.strip()):
        return f"[{label}]({url.strip()})"
    return label


def _outcome_text(o: str) -> str:
    return o.replace("_", " ")


def _rs_cell(rs: Any, key: str, empty: str) -> str:
    """A reasoning field for a table cell: "none" when the API sent null, the fallback when it sent nothing."""
    if not isinstance(rs, dict):
        return empty
    if rs.get(key) is None:
        return "none" if key in rs else "not returned"
    return md(rs[key])


def _brief(r: dict[str, Any], cfg: dict[str, Any]) -> str:
    company = r.get("company")
    subject = r.get("subject") or {}
    title = (company or {}).get("name") or subject.get("domain") or subject.get("company_id") or r["row_id"]
    lines = [f"# Company fact brief: {md(title)}", "",
             f"Input row {md(r['row_id'])}. Every value below is returned by the Firmable API or is fixed text in "
             "this recipe.", ""]
    lines += ["## Profile facts", ""]
    if company:
        lines += ["From GET /company, with the API field names.", "", "| Field | Value |", "| - | - |"]
        for f in PROFILE_FIELDS:
            v = company.get(f)
            val = md_link(v) if f == "website" and v else md(v)
            lines.append(f"| {md(f)} | {val} |")
    else:
        lines.append("The profile was not fetched (fetch_company is false).")
    lines += ["", "## Answers", ""]
    reason_empty = "not returned" if cfg["with_reasoning"] else "not requested"
    lines += ["| Question | Tool | Answer | Reason as returned | Source | Fact date | Last refreshed |",
              "| - | - | - | - | - | - | - |"]
    for a in r["answers"]:
        cells = " | ".join(_rs_cell(a.get("reasoning"), k, reason_empty)
                           for k in ("reason", "source", "fact_date", "last_refreshed"))
        lines.append(f"| {md(a['label'])} | {md(a['tool'])} | {md(_outcome_text(a['outcome']))} | {cells} |")
    detailed = [a for a in r["answers"] if isinstance(a.get("details"), dict) and a["details"]]
    if detailed:
        lines += ["", "### Details as returned", ""]
        for a in detailed:
            parts = "; ".join(f"{md(k)}: {md(v)}" for k, v in a["details"].items())
            lines.append(f"- {md(a['label'])}: {parts}")
    lines += ["", "## What is unknown", ""]
    unknown = [a for a in r["answers"] if a["outcome"] == "unknown"]
    if unknown:
        lines += ["Firmable does not hold these facts. An unknown answer is not a no.", ""]
        lines += [f"- {md(a['label'])}: Firmable does not hold this fact." for a in unknown]
    else:
        lines.append("No question answered unknown.")
    missing = [a for a in r["answers"] if a["outcome"] in ("not_found", "error", "not_asked")]
    if missing:
        lines += ["", "## Not answered", "",
                  "These questions have no answer. This says nothing about the company.", ""]
        for a in missing:
            if a["outcome"] == "not_asked":
                why = "not asked, because the run stopped first."
            elif a["outcome"] == "not_found":
                why = f"not found ({md((a.get('answer_error') or {}).get('code'))})."
            else:
                err = a.get("error") or a.get("answer_error") or {}
                why = f"error: {md(err.get('message') if isinstance(err, dict) else err)}"
            lines.append(f"- {md(a['label'])}: {why}")
    if r.get("conflicts"):
        lines += ["", "## Possible conflicts", "",
                  "These returned facts contradict each other. This brief shows both and does not correct them.", ""]
        lines += [f"- {md(c)}" for c in r["conflicts"]]
    lines += ["", "## Interpretation", ""] + [f"- {t}" for t in INTERPRETATION] + [""]
    return "\n".join(lines)


def markdown(result: dict[str, Any]) -> dict[str, str]:
    cfg = result["input"]["config"]
    out: dict[str, str] = {}
    for r in result["rows"]:
        if r.get("brief_file") and not r.get("duplicate_of"):
            out[r["brief_file"]] = _brief(r, cfg)
    return out


def render(report: Any, result: dict[str, Any]) -> None:
    cfg = result["input"]["config"]
    counts = result["summary"].get("status_counts", {})
    report.add("Result", "Brief summary",
               "<p>" + " ".join(badge(f"{k.replace('_', ' ')}: {v}", STATUS_TONE.get(k, "neutral"))
                                for k, v in counts.items()) + "</p>"
               + note("Unknown means Firmable does not hold the fact. It is never a no.", "unknown"))
    cards = []
    for r in result["rows"]:
        status = r["status"]
        company = r.get("company") or {}
        subject = r.get("subject") or {}
        title = company.get("name") or subject.get("domain") or subject.get("company_id") or r["row_id"]
        reason = r.get("status_reason") or r.get("reason") or (r.get("error") or {}).get("message") or ""
        left = f"<p>{esc(reason)}</p>"
        if company:
            left += kv([(f, Raw(link(company.get(f))) if f == "website" and company.get(f)
                         else (", ".join(company.get(f)) if isinstance(company.get(f), list) else company.get(f)))
                        for f in PROFILE_FIELDS])
        if r.get("duplicate_of"):
            left += note(f"Same company as row {esc(r['duplicate_of'])}; its answers and brief were reused.", "info")
        if r.get("brief_file"):
            left += f"<p class=\"muted\">Markdown brief: {esc(r['brief_file'])}</p>"
        right = ""
        answers = r.get("answers") or []
        if answers:
            empty = "not returned" if cfg["with_reasoning"] else "not requested"
            right += table(["Question", "Answer", "Reason as returned", "Source", "Fact date", "Last refreshed"], [
                [a["label"], Raw(badge(_outcome_text(a["outcome"]), OUTCOME_TONE.get(a["outcome"], "neutral"))),
                 (a.get("reasoning") or {}).get("reason") or empty, (a.get("reasoning") or {}).get("source") or empty,
                 (a.get("reasoning") or {}).get("fact_date") or empty,
                 (a.get("reasoning") or {}).get("last_refreshed") or empty] for a in answers])
            unknown = [a["label"] for a in answers if a["outcome"] == "unknown"]
            right += "<h3>What is unknown</h3>" + (
                bullet_list(f"{u}: Firmable does not hold this fact." for u in unknown) if unknown
                else "<p>No question answered unknown.</p>")
            for a in answers:
                err = a.get("error") or a.get("answer_error")
                if a["outcome"] in ("error", "not_found") and err:
                    right += note(f"{esc(a['label'])}: {esc(err.get('message') if isinstance(err, dict) else err)}",
                                  "error" if a["outcome"] == "error" else "unknown")
        if r.get("conflicts"):
            right += "<h3>Possible conflicts</h3>" + bullet_list(r["conflicts"])
        if answers:
            right += "<h3>Interpretation</h3>" + note(bullet_list(INTERPRETATION), "info")
            right += details_json("Answers as JSON", answers)
        cards.append(card(str(title), badge(status.replace("_", " "), STATUS_TONE.get(status, "neutral")), left,
                          right or "<p class=\"muted\">No questions were asked for this row.</p>",
                          sub=f"Row {r['row_id']}"))
    report.add("Companies", "Each company with its facts", "".join(cards))


RECIPE = Recipe(NAME, TITLE, DESCRIPTION, load_config, read_input, plan, run, csv_columns, csv_rows, render,
                markdown=markdown)
