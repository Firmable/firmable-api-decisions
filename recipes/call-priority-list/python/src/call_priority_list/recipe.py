"""Call priority list: who in a contact list a rep should call first.

Workflow:
1. Read the decision tool list (GET /decisions, free) and check every tool, input and label.
2. For each batch of up to batch_size unique valid people, ask matches_seniority, matches_department,
   and, when switched on, is_reachable, is_mobile_on_dnc and is_decision_maker (POST /decisions).
3. Apply the fixed priority rules below. Every person gets a priority and the reason for it.

Priority rules, first match wins:
- not_found: any answer came back person_not_found (or another code ending in not_found).
- exclude_dnc: the mobile is on the Do Not Call register (is_mobile_on_dnc yes) and is_reachable
  details show no deliverable work email.
- incomplete: an answer the rules need is missing (error, or the run stopped part way).
- Base priority from seniority (S), department (D) and reachability (R):
  P1: S yes, D yes, R yes. P2: S yes, D yes, R unknown or not checked. P3: S yes and D yes with R no,
  or exactly one of S and D yes with the other no. review: an unknown S or D that could lift the
  priority. no_priority: S no and D no.
- Do Not Call overlay: a P1, P2 or P3 whose mobile is on the register becomes review. A P1 whose
  register status is unknown becomes review.
is_decision_maker is shown beside the priority and does not change it.
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from firmable_client import pricing
from firmable_client.decisions import answer_from, check_tools, uses_model
from firmable_client.errors import ConfigError, FirmableError, NotFoundError
from firmable_client.io import find_duplicates, read_rows
from firmable_client.recipe import PlannedCall, Recipe, RunContext
from firmable_client.report import Raw, badge, card, details_json, esc, kv, note, table

NAME = "call-priority-list"
TITLE = "Call priority list"
DESCRIPTION = ("Ranks a contact list for calling with fixed rules: seniority and department match, reachability "
               "and the Australian Do Not Call register, each from Firmable Decisions, with the reason for every "
               "person.")

_TOP_KEYS = {"target_seniorities", "target_departments", "decision_maker", "check_reachability", "check_dnc",
             "with_reasoning", "batch_size"}
_PERSON_ID = re.compile(r"^fp\d{12}$")
_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_LINKEDIN = re.compile(r"linkedin\.com/in/([^/?#\s]+)", re.IGNORECASE)
DELIVERABLE_GRADES = ["Highly likely", "Likely"]
PRIORITY_ORDER = ["P1", "P2", "P3", "review", "exclude_dnc", "no_priority", "not_found", "incomplete",
                  "invalid_input", "error", "not_processed"]
PRIORITY_TONE = {"P1": "good", "P2": "good", "P3": "info", "review": "review", "exclude_dnc": "bad",
                 "no_priority": "neutral", "not_found": "unknown", "incomplete": "error", "invalid_input": "error",
                 "error": "error", "not_processed": "unknown"}
OUTCOME_TONE = {"yes": "good", "no": "bad", "unknown": "unknown", "not_found": "unknown", "error": "error",
                "not_asked": "neutral", "not_checked": "neutral"}
CHECK_NAMES = {"seniority": "seniority", "department": "department", "reachable": "reachability",
               "dnc": "Do Not Call status", "decision_maker": "decision maker"}


# ----- configuration and input ------------------------------------------------------------------

def _labels(raw: Any, key: str) -> list[str]:
    if (not isinstance(raw, list) or not 1 <= len(raw) <= 20
            or not all(isinstance(x, str) and x.strip() and len(x) <= 100 for x in raw)):
        raise ConfigError(f"{key} must be a list of 1 to 20 labels.")
    if len(set(raw)) != len(raw):
        raise ConfigError(f"{key} has the same label twice.")
    return list(raw)


def load_config(raw: dict[str, Any]) -> dict[str, Any]:
    unknown = sorted(set(raw) - _TOP_KEYS)
    if unknown:
        raise ConfigError(f"Unknown configuration key(s): {', '.join(unknown)}")
    seniorities = _labels(raw.get("target_seniorities"), "target_seniorities")
    departments = _labels(raw.get("target_departments"), "target_departments")
    dm = raw.get("decision_maker")
    if dm is not None:
        if not isinstance(dm, dict):
            raise ConfigError("decision_maker must be an object with seller and an optional buyer.")
        extra = sorted(set(dm) - {"seller", "buyer"})
        if extra:
            raise ConfigError(f"decision_maker has unknown key(s): {', '.join(extra)}")
        seller = dm.get("seller")
        if not isinstance(seller, str) or not 3 <= len(seller.strip()) or len(seller) > 2000:
            raise ConfigError("decision_maker.seller must be text of 3 to 2,000 characters.")
        buyer = dm.get("buyer")
        if buyer is not None and (not isinstance(buyer, str) or not buyer.strip() or len(buyer) > 2000):
            raise ConfigError("decision_maker.buyer must be text of up to 2,000 characters.")
        dm = {"seller": seller} if buyer is None else {"seller": seller, "buyer": buyer}
    for key in ("check_reachability", "check_dnc"):
        if not isinstance(raw.get(key, True), bool):
            raise ConfigError(f"{key} must be true or false.")
    if not isinstance(raw.get("with_reasoning", False), bool):
        raise ConfigError("with_reasoning must be true or false.")
    bs = raw.get("batch_size", 100)
    if not isinstance(bs, int) or isinstance(bs, bool) or not 1 <= bs <= 100:
        raise ConfigError("batch_size must be a whole number from 1 to 100.")
    return {"target_seniorities": seniorities, "target_departments": departments, "decision_maker": dm,
            "check_reachability": raw.get("check_reachability", True), "check_dnc": raw.get("check_dnc", True),
            "with_reasoning": raw.get("with_reasoning", False), "batch_size": bs}


def read_input(path: Path) -> list[dict[str, str]]:
    return read_rows(path, any_of=["person_id", "work_email", "linkedin_url"])


def _subject(row: dict[str, str]) -> tuple[str | None, dict[str, str] | None, str | None]:
    """Uses the first identifier present, in the order person_id, work_email, linkedin_url."""
    pid = (row.get("person_id") or "").strip()
    if pid:
        if not _PERSON_ID.match(pid):
            return None, None, "person_id is not a Firmable person ID (fp followed by 12 digits)."
        return f"person_id:{pid}", {"person_id": pid}, None
    email = (row.get("work_email") or "").strip()
    if email:
        if len(email) > 254 or not _EMAIL.match(email):
            return None, None, "work_email is not an email address."
        return f"work_email:{email.lower()}", {"work_email": email}, None
    url = (row.get("linkedin_url") or "").strip()
    m = _LINKEDIN.search(url)
    if len(url) > 300 or not m:
        return None, None, "linkedin_url is not a LinkedIn profile URL (linkedin.com/in/...)."
    return f"linkedin_url:{m.group(1).lower()}", {"linkedin_url": url}, None


def _tools(config: dict[str, Any]) -> list[dict[str, Any]]:
    """The questions asked about every person, in the order they are asked."""
    tools = [{"key": "seniority", "tool": "matches_seniority", "inputs": {"seniorities": config["target_seniorities"]}},
             {"key": "department", "tool": "matches_department",
              "inputs": {"departments": config["target_departments"]}}]
    if config["check_reachability"]:
        tools.append({"key": "reachable", "tool": "is_reachable", "inputs": {}})
    if config["check_dnc"]:
        tools.append({"key": "dnc", "tool": "is_mobile_on_dnc", "inputs": {}})
    if config["decision_maker"]:
        tools.append({"key": "decision_maker", "tool": "is_decision_maker", "inputs": dict(config["decision_maker"])})
    return tools


def _unique_subjects(rows: list[dict[str, str]]) -> list[str]:
    out: list[str] = []
    for r in rows:
        key = _subject(r)[0]
        if key and key not in out:
            out.append(key)
    return out


def plan(rows: list[dict[str, str]], config: dict[str, Any]) -> list[PlannedCall]:
    n = len(_unique_subjects(rows))
    size = config["batch_size"]
    batches = (n + size - 1) // size
    calls = [PlannedCall("GET /decisions", "Read the decision tool list and check the tools and labels", 1, [])]
    for t in _tools(config):
        calls.append(PlannedCall("POST /decisions", f"{t['tool']} for each unique valid person, in batches of up to "
                                 f"{size}", batches, pricing.estimate_decision(n, config["with_reasoning"])))
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
            "error", {"message": "The batch response has no answer for this person."})
    return out


# ----- rules --------------------------------------------------------------------------------------

def deliverable_email(reachable: dict[str, Any] | None) -> bool | None:
    """True when is_reachable details show a held work email graded Highly likely or Likely, False when they
    show none or a lower grade, None when the details do not say."""
    details = (reachable or {}).get("details")
    if not isinstance(details, dict):
        return None
    held = details.get("work_email_held")
    grade = details.get("work_email_grade")
    if held is False:
        return False
    if held is True and isinstance(grade, str):
        return grade in DELIVERABLE_GRADES
    return None


def prioritise(a: dict[str, dict[str, Any]], cfg: dict[str, Any]) -> tuple[str, str]:
    """Applies the priority rules to one person's answers, keyed by check: seniority, department,
    reachable, dnc. Returns (priority, reason)."""
    s = a["seniority"]["outcome"]
    d = a["department"]["outcome"]
    r = a["reachable"]["outcome"] if cfg["check_reachability"] else "not_checked"
    n = a["dnc"]["outcome"] if cfg["check_dnc"] else "not_checked"
    needed = ["seniority", "department"] + (["reachable"] if cfg["check_reachability"] else []) \
        + (["dnc"] if cfg["check_dnc"] else [])
    found = [k for k in needed + (["decision_maker"] if cfg["decision_maker"] else []) if a[k]["outcome"] == "not_found"]
    if found:
        code = (a[found[0]].get("answer_error") or {}).get("code") or "not_found"
        return "not_found", f"Firmable did not find this person ({code})."
    email = deliverable_email(a["reachable"]) if cfg["check_reachability"] else None
    if n == "yes" and email is False:
        return "exclude_dnc", ("The mobile is on the Do Not Call register and Firmable holds no deliverable work "
                               "email.")
    missing = [CHECK_NAMES[k] for k in needed if a[k]["outcome"] in ("error", "not_asked")]
    if missing:
        return "incomplete", f"No answer for: {', '.join(missing)}. The priority cannot be set."
    if s == "yes" and d == "yes":
        if r == "yes":
            base = ("P1", "Seniority and department match, and the person is reachable.")
        elif r == "unknown":
            base = ("P2", "Seniority and department match; reachability is unknown.")
        elif r == "not_checked":
            base = ("P2", "Seniority and department match; reachability was not checked.")
        else:
            base = ("P3", "Seniority and department match, but Firmable holds no reachable channel.")
    elif s == "yes" or d == "yes":
        matched, other, other_answer = ("seniority", "department", d) if s == "yes" else ("department", "seniority", s)
        if other_answer == "unknown":
            base = ("review", f"The {matched} matches; the {other} is unknown, which blocks a higher priority.")
        else:
            base = ("P3", f"Only the {matched} matches.")
    elif s == "unknown" or d == "unknown":
        unknown = [name for name, v in (("seniority", s), ("department", d)) if v == "unknown"]
        base = ("review", f"Unknown: {', '.join(unknown)}. An unknown answer blocks a priority.")
    else:
        base = ("no_priority", "Neither the seniority nor the department matches.")
    if base[0] in ("P1", "P2", "P3") and n == "yes":
        return "review", (f"Would be {base[0]}, but the mobile is on the Do Not Call register and a deliverable "
                          "work email is held or not known. Check the channel before calling.")
    if base[0] == "P1" and n == "unknown":
        return "review", "Would be P1, but the Do Not Call status is unknown, which blocks P1."
    if base[0] in ("P1", "P2", "P3"):
        tail = {"no": " The mobile is not on the Do Not Call register.",
                "unknown": " The Do Not Call status is unknown.",
                "not_checked": " The Do Not Call register was not checked."}[n]
        return base[0], base[1] + tail
    return base


def run(ctx: RunContext) -> dict[str, Any]:
    cfg = ctx.config
    client = ctx.client
    tools = _tools(cfg)
    coverage = [
        "The people come from your input file. This recipe does not search for people.",
        "An unknown answer means Firmable does not hold the fact. It is never counted as a no.",
        "Person answers are advisory: each is a fact to check, as at Firmable's last refresh, not a live check.",
        "The Do Not Call check covers Australian mobiles on the register as at Firmable's last refresh. It is not a "
        "live register check and does not replace your own compliance process.",
        "A deliverable work email means is_reachable details show work_email_held true and a work_email_grade of "
        "Highly likely or Likely, the grades is_email_valid treats as yes.",
        "Names and companies in the input are kept as given. They are not sent to the API.",
    ]
    if cfg["decision_maker"]:
        coverage.append("is_decision_maker is shown beside each person. It does not change the priority.")

    def stop_all(reason: str) -> dict[str, Any]:
        rows = [{"row_id": r["row_id"], "input": r, "priority": "not_processed", "reason": reason} for r in ctx.rows]
        return {"rows": rows, "summary": {"priority_counts": {"not_processed": len(rows)}}, "coverage": coverage}

    try:
        catalogue = client.list_decision_tools()
    except FirmableError as e:
        ctx.record_error(None, e)
        return stop_all("The decision tool list could not be read, so no questions were asked.")
    problems = check_tools(catalogue, tools, "person")
    accepted = catalogue.get("accepted_values") if isinstance(catalogue.get("accepted_values"), dict) else {}
    for key, label in (("target_seniorities", "seniorities"), ("target_departments", "departments")):
        allowed = accepted.get(label)
        if isinstance(allowed, list):
            bad = [v for v in cfg[key] if v not in allowed]
            if bad:
                problems.append(f"{key} has label(s) that are not in the tool list's accepted {label}: "
                                f"{', '.join(bad)}.")
    if problems:
        for p in problems:
            ctx.errors.append({"row_id": None, "kind": "config", "status": None, "code": None,
                               "endpoint": "GET /decisions", "message": p, "charge_uncertain": False,
                               "retry_after": None})
        coverage.extend(problems)
        return stop_all("The configuration names decision tools, inputs or labels the API does not accept.")
    model_tools = sorted({t["tool"] for t in tools if uses_model(catalogue, t["tool"])})
    if model_tools:
        coverage.append(f"These decision tools use a decision model inside Firmable's service: "
                        f"{', '.join(model_tools)}. This code applies only the fixed priority rules.")

    keyed: list[dict[str, Any]] = []
    for r in ctx.rows:
        key, ident, problem = _subject(r)
        keyed.append({"row": r, "key": key, "ident": ident, "problem": problem})
    dupes = find_duplicates([{"row_id": k["row"]["row_id"], "_key": k["key"] or ""} for k in keyed], "_key")
    if dupes:
        coverage.append(f"{len(dupes)} row(s) repeat an earlier person; they reuse that person's answers.")
    subjects: dict[str, dict[str, Any]] = {}
    for k in keyed:
        if k["key"] and k["key"] not in subjects:
            subjects[k["key"]] = {"ext": f"subject-{len(subjects) + 1}", "ident": k["ident"],
                                  "row_id": k["row"]["row_id"]}
    items = list(subjects.items())
    answers: dict[str, dict[str, dict[str, Any]]] = {key: {} for key, _ in items}
    size = cfg["batch_size"]
    for start in range(0, len(items), size):
        part = items[start:start + size]
        chunk = [(s["ext"], s["ident"], s["row_id"]) for _, s in part]
        for t in tools:
            got = _ask(ctx, t["tool"], t["inputs"], chunk, cfg["with_reasoning"])
            for key, s in part:
                answers[key][t["key"]] = got[s["ext"]]

    def build(k: dict[str, Any]) -> dict[str, Any]:
        row = k["row"]
        base = {"row_id": row["row_id"], "input": row, "identifier_type": next(iter(k["ident"])) if k["ident"] else None,
                "name": row.get("name") or None, "company": row.get("company") or None,
                "duplicate_of": dupes.get(row["row_id"]), "answers": {}, "firmable_person_id": None,
                "deliverable_work_email": None}
        if k["problem"]:
            return {**base, "priority": "invalid_input", "reason": k["problem"]}
        a = answers[k["key"]]
        full = {t: a.get(t) or _blank("not_checked") for t in ("seniority", "department", "reachable", "dnc",
                                                               "decision_maker")}
        if all(v["outcome"] == "not_asked" for v in a.values()):
            msg = ctx.stopped["message"] if ctx.stopped else "the run stopped"
            return {**base, "answers": full, "priority": "not_processed", "reason": f"Run stopped earlier: {msg}"}
        priority, reason = prioritise(full, cfg)
        pid = next((v["entity_id"] for v in full.values() if v.get("entity_id")), None)
        return {**base, "answers": full, "priority": priority, "reason": reason, "firmable_person_id": pid,
                "deliverable_work_email": deliverable_email(full["reachable"]) if cfg["check_reachability"] else None}

    rows = [build(k) for k in keyed]
    counts: dict[str, int] = {}
    for r in rows:
        counts[r["priority"]] = counts.get(r["priority"], 0) + 1
    ordered = {p: counts[p] for p in PRIORITY_ORDER if p in counts}
    return {"rows": rows, "summary": {"priority_counts": ordered}, "coverage": coverage}


# ----- outputs ------------------------------------------------------------------------------------

CSV_COLUMNS = ["row_id", "name", "company", "identifier_type", "duplicate_of", "priority", "reason",
               "firmable_person_id", "seniority_match", "seniority", "department_match", "department",
               "reachable", "work_email_held", "work_email_grade", "deliverable_work_email", "mobile_on_dnc",
               "dnc_status", "decision_maker"]


def _detail(a: dict[str, Any], key: str, field: str) -> Any:
    details = ((a.get("answers") or {}).get(key) or {}).get("details")
    return details.get(field) if isinstance(details, dict) else None


def _outcome(a: dict[str, Any], key: str) -> Any:
    return ((a.get("answers") or {}).get(key) or {}).get("outcome")


def csv_rows(result: dict[str, Any]) -> list[dict[str, Any]]:
    out = []
    for r in result["rows"]:
        out.append({
            "row_id": r["row_id"], "name": r.get("name"), "company": r.get("company"),
            "identifier_type": r.get("identifier_type"), "duplicate_of": r.get("duplicate_of"),
            "priority": r["priority"], "reason": r.get("reason"), "firmable_person_id": r.get("firmable_person_id"),
            "seniority_match": _outcome(r, "seniority"), "seniority": _detail(r, "seniority", "seniority"),
            "department_match": _outcome(r, "department"), "department": _detail(r, "department", "department"),
            "reachable": _outcome(r, "reachable"), "work_email_held": _detail(r, "reachable", "work_email_held"),
            "work_email_grade": _detail(r, "reachable", "work_email_grade"),
            "deliverable_work_email": r.get("deliverable_work_email"), "mobile_on_dnc": _outcome(r, "dnc"),
            "dnc_status": _detail(r, "dnc", "status"), "decision_maker": _outcome(r, "decision_maker"),
        })
    return out


def render(report: Any, result: dict[str, Any]) -> None:
    counts = result["summary"].get("priority_counts", {})
    report.add("Result", "Call priorities",
               "<p>" + " ".join(badge(f"{k.replace('_', ' ')}: {v}", PRIORITY_TONE.get(k, "neutral"))
                                for k, v in counts.items()) + "</p>"
               + table(["Priority", "Rule"], [
                   ["P1", "Seniority and department match, reachable, mobile not on Do Not Call (or not checked)."],
                   ["P2", "Seniority and department match; reachability unknown or not checked."],
                   ["P3", "Seniority and department match but not reachable, or only one of them matches."],
                   ["review", "An unknown answer blocks a higher priority, or the mobile is on Do Not Call."],
                   ["exclude_dnc", "Mobile on Do Not Call and no deliverable work email."],
                   ["no_priority", "Neither seniority nor department matches."]])
               + note("Unknown means Firmable does not hold the fact. It is never a no. Do Not Call answers are as at "
                      "Firmable's last refresh, not a live register check.", "unknown"))
    sections = []
    for p in PRIORITY_ORDER:
        group = [r for r in result["rows"] if r["priority"] == p]
        if not group:
            continue
        cards = []
        for r in group:
            title = r.get("name") or r.get("firmable_person_id") or r["row_id"]
            left = f"<p>{esc(r.get('reason'))}</p>" + kv([
                ("Company (input)", r.get("company")), ("Identifier used", r.get("identifier_type")),
                ("Firmable person ID", r.get("firmable_person_id")),
                ("Deliverable work email", r.get("deliverable_work_email"))])
            if r.get("duplicate_of"):
                left += note(f"Same person as row {esc(r['duplicate_of'])}; answers were reused.", "info")
            answers = r.get("answers") or {}
            right = ""
            if answers:
                right += table(["Check", "Answer", "Details as returned"], [
                    [CHECK_NAMES[k], Raw(badge(v["outcome"].replace("_", " "), OUTCOME_TONE.get(v["outcome"], "neutral"))),
                     v.get("details") if v.get("details") else (v.get("error") or v.get("answer_error") or {}).get("message")]
                    for k, v in answers.items()])
                for k, v in answers.items():
                    rs = v.get("reasoning") or {}
                    if rs.get("reason"):
                        right += (f"<p><strong>{esc(CHECK_NAMES[k])}:</strong> {esc(rs.get('reason'))}</p>"
                                  f"<p class=\"muted\">Source: {esc(rs.get('source'))}. Last refreshed: "
                                  f"{esc(rs.get('last_refreshed'))}.</p>")
                right += details_json("Answers as JSON", answers)
            cards.append(card(str(title), badge(p.replace("_", " "), PRIORITY_TONE.get(p, "neutral")), left,
                              right or "<p class=\"muted\">No questions were asked for this row.</p>",
                              sub=f"Row {r['row_id']}"))
        sections.append(f"<h3>{esc(p.replace('_', ' '))} ({len(group)})</h3>" + "".join(cards))
    report.add("People", "Each person by priority", "".join(sections))


RECIPE = Recipe(NAME, TITLE, DESCRIPTION, load_config, read_input, plan, run, CSV_COLUMNS, csv_rows, render)
