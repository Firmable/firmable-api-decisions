"""ICP fit scorecard: which accounts fit one ideal customer profile, and on which criteria.

Workflow:
1. Read the decision tool list (GET /decisions, free) and check is_icp_fit accepts the configured ICP.
2. Ask is_icp_fit about every unique valid account, in batches of up to batch_size (POST /decisions).
3. Keep details.filters and details.criteria as returned, and place each configured criterion in one
   of three groups: met, not met, or not shown (the answer does not report it).
4. Assign the first configured tier whose conditions hold.

Status: fit (yes), not_fit (no), needs_review (unknown), not_found, error, invalid_input,
not_processed. Unknown never satisfies a tier that asks for yes or no.
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from firmable_client import pricing
from firmable_client.decisions import answer_from, check_tools, uses_model
from firmable_client.errors import ConfigError, FirmableError, NotFoundError
from firmable_client.io import find_duplicates, normalise_domain, read_rows
from firmable_client.recipe import PlannedCall, Recipe, RunContext
from firmable_client.report import Raw, badge, bullet_list, card, details_json, esc, kv, note, table

NAME = "icp-fit-scorecard"
TITLE = "ICP fit scorecard"
DESCRIPTION = ("Asks Firmable whether each account fits one ideal customer profile, shows each criterion as met, "
               "not met or not shown, and assigns the first matching tier from the configuration.")
TOOL = "is_icp_fit"

_TOP_KEYS = {"icp", "with_reasoning", "batch_size", "tiers"}
_ICP_ORDER = ["min_staff", "max_staff", "staff_in", "industries", "countries", "revenue_bands", "criteria"]
_STAFF_IN = ["AU", "NZ", "SG", "MY", "ID", "PH", "HK", "JP", "VN", "KR", "TH", "US", "CA"]
_REVENUE_BANDS = ["<$1M", "$1M - $5M", "$5M - $10M", "$10M - $50M", "$50M - $100M", "$100M - $250M",
                  "$250M - $500M", "$500M - $1B", ">$1B+"]
_ID = re.compile(r"^[a-z0-9_]{1,40}$")
_COMPANY_ID = re.compile(r"^f\d{12}$")
STATUS_TONE = {"fit": "good", "not_fit": "bad", "needs_review": "review", "not_found": "unknown", "error": "error",
               "invalid_input": "error", "not_processed": "unknown"}
CRITERION_TONE = {"met": "good", "not_met": "bad", "not_shown": "unknown"}
STATUS_ORDER = ["fit", "needs_review", "not_fit", "not_found", "error", "invalid_input", "not_processed"]


# ----- configuration and input ------------------------------------------------------------------

def _norm(s: str) -> str:
    return " ".join(s.split()).lower()


def _is_int(x: Any) -> bool:
    return isinstance(x, int) and not isinstance(x, bool)


def _text_list(v: Any) -> bool:
    return isinstance(v, list) and bool(v) and all(isinstance(x, str) and x.strip() for x in v)


def _load_icp(icp: Any) -> dict[str, Any]:
    if not isinstance(icp, dict):
        raise ConfigError("icp must be an object.")
    if "description" in icp:
        raise ConfigError("icp.description is not accepted by is_icp_fit. Give icp.criteria instead.")
    extra = sorted(set(icp) - set(_ICP_ORDER))
    if extra:
        raise ConfigError(f"icp has unknown key(s): {', '.join(extra)}")
    out: dict[str, Any] = {}
    for key in _ICP_ORDER:
        if key not in icp or icp[key] is None:
            continue
        value = icp[key]
        if key in ("min_staff", "max_staff"):
            if not _is_int(value) or value < 0:
                raise ConfigError(f"icp.{key} must be a whole number, 0 or more.")
        elif key == "staff_in":
            if value not in _STAFF_IN:
                raise ConfigError(f"icp.staff_in must be one of: {', '.join(_STAFF_IN)}.")
        elif key == "criteria":
            if (not isinstance(value, list) or not value or len(value) > 10
                    or not all(isinstance(c, str) and len(c.strip()) >= 2 for c in value)):
                raise ConfigError("icp.criteria must be a list of 1 to 10 text items, each at least 2 characters.")
            if sum(len(c) for c in value) > 2000:
                raise ConfigError("icp.criteria must be 2,000 characters or fewer in all.")
            if len({_norm(c) for c in value}) != len(value):
                raise ConfigError("icp.criteria has the same criterion twice.")
        else:
            if not _text_list(value):
                raise ConfigError(f"icp.{key} must be a non-empty list of text values.")
            if key == "revenue_bands":
                for band in value:
                    if band not in _REVENUE_BANDS:
                        raise ConfigError(f"icp.revenue_bands has {band!r}, which is not a Firmable revenue band.")
        out[key] = value
    if "min_staff" in out and "max_staff" in out and out["min_staff"] > out["max_staff"]:
        raise ConfigError("icp.min_staff is more than icp.max_staff.")
    if not out:
        raise ConfigError("icp must hold at least one filter or criterion.")
    return out


def _load_tiers(raw: Any, n_criteria: int) -> list[dict[str, Any]]:
    if raw is None:
        return []
    if not isinstance(raw, list) or len(raw) > 10:
        raise ConfigError("tiers must be a list of up to 10 tiers.")
    tiers: list[dict[str, Any]] = []
    seen: set[str] = set()
    for i, t in enumerate(raw, start=1):
        if not isinstance(t, dict):
            raise ConfigError(f"tiers[{i}] must be an object.")
        extra = sorted(set(t) - {"id", "label", "when"})
        if extra:
            raise ConfigError(f"tiers[{i}] has unknown key(s): {', '.join(extra)}")
        tid = t.get("id")
        if not isinstance(tid, str) or not _ID.match(tid):
            raise ConfigError(f"tiers[{i}].id must be 1 to 40 lower-case letters, digits or underscores.")
        if tid in seen:
            raise ConfigError(f"tiers[{i}].id {tid!r} is used twice.")
        seen.add(tid)
        label = t.get("label", tid)
        if not isinstance(label, str) or not label.strip():
            raise ConfigError(f"tiers[{i}].label must be text.")
        when = t.get("when")
        if not isinstance(when, dict) or not when:
            raise ConfigError(f"tiers[{i}].when must be an object with at least one condition.")
        extra = sorted(set(when) - {"fit", "min_criteria_met"})
        if extra:
            raise ConfigError(f"tiers[{i}].when has unknown key(s): {', '.join(extra)}")
        cond: dict[str, Any] = {}
        if "fit" in when:
            if when["fit"] not in ("yes", "no", "unknown"):
                raise ConfigError(f"tiers[{i}].when.fit must be yes, no or unknown.")
            cond["fit"] = when["fit"]
        if "min_criteria_met" in when:
            m = when["min_criteria_met"]
            if not _is_int(m) or m < 0:
                raise ConfigError(f"tiers[{i}].when.min_criteria_met must be a whole number, 0 or more.")
            if m > n_criteria:
                raise ConfigError(f"tiers[{i}].when.min_criteria_met is {m} but icp.criteria has {n_criteria} "
                                  "criteria.")
            cond["min_criteria_met"] = m
        tiers.append({"id": tid, "label": label, "when": cond})
    return tiers


def load_config(raw: dict[str, Any]) -> dict[str, Any]:
    unknown = sorted(set(raw) - _TOP_KEYS)
    if unknown:
        raise ConfigError(f"Unknown configuration key(s): {', '.join(unknown)}")
    if "icp" not in raw:
        raise ConfigError("icp is required.")
    icp = _load_icp(raw["icp"])
    if not isinstance(raw.get("with_reasoning", True), bool):
        raise ConfigError("with_reasoning must be true or false.")
    bs = raw.get("batch_size", 100)
    if not _is_int(bs) or not 1 <= bs <= 100:
        raise ConfigError("batch_size must be a whole number from 1 to 100.")
    tiers = _load_tiers(raw.get("tiers"), len(icp.get("criteria") or []))
    return {"icp": icp, "with_reasoning": raw.get("with_reasoning", True), "batch_size": bs, "tiers": tiers}


def read_input(path: Path) -> list[dict[str, str]]:
    return read_rows(path, any_of=["domain", "company_id"])


def _subject(row: dict[str, str]) -> tuple[str | None, dict[str, str] | None, str | None]:
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


def plan(rows: list[dict[str, str]], config: dict[str, Any]) -> list[PlannedCall]:
    n = len(_unique_subjects(rows))
    size = config["batch_size"]
    return [
        PlannedCall("GET /decisions", "Read the decision tool list and check is_icp_fit accepts the ICP", 1, []),
        PlannedCall("POST /decisions", f"is_icp_fit for each unique valid account, in batches of up to {size}",
                    (n + size - 1) // size, pricing.estimate_decision(n, config["with_reasoning"])),
    ]


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
            "error", {"message": "The batch response has no answer for this account."})
    return out


# ----- rules --------------------------------------------------------------------------------------

def _criteria(configured: list[str], details: Any) -> tuple[list[dict[str, Any]], list[Any]]:
    """Places each configured criterion as met, not_met or not_shown from details.criteria as returned.

    A returned entry matches a configured criterion when its "criterion" text is the same, ignoring case
    and spacing. "met": true is met; "met": false is not met; anything else, or no entry, is not shown.
    Returned entries that match no configured criterion are kept separately, as returned.
    """
    returned = details.get("criteria") if isinstance(details, dict) else None
    entries = returned if isinstance(returned, list) else []
    used: set[int] = set()
    out = []
    for c in configured:
        match = None
        for i, e in enumerate(entries):
            if i in used or not isinstance(e, dict) or not isinstance(e.get("criterion"), str):
                continue
            if _norm(e["criterion"]) == _norm(c):
                match = i
                break
        entry = entries[match] if match is not None else None
        if match is not None:
            used.add(match)
        met = entry.get("met") if isinstance(entry, dict) else None
        result = "met" if met is True else "not_met" if met is False else "not_shown"
        out.append({"criterion": c, "result": result, "returned": entry})
    others = [e for i, e in enumerate(entries) if i not in used]
    return out, others


def _tier(tiers: list[dict[str, Any]], outcome: str, met: int) -> dict[str, Any] | None:
    if outcome not in ("yes", "no", "unknown"):
        return None
    for t in tiers:
        w = t["when"]
        if "fit" in w and w["fit"] != outcome:
            continue
        if "min_criteria_met" in w and met < w["min_criteria_met"]:
            continue
        return t
    return None


def _status(a: dict[str, Any], met: int, not_met: int, not_shown: int) -> tuple[str, str]:
    counts = f"Criteria met: {met}; not met: {not_met}; not shown: {not_shown}."
    if a["outcome"] == "yes":
        return "fit", f"is_icp_fit answered yes. {counts}"
    if a["outcome"] == "no":
        return "not_fit", f"is_icp_fit answered no. {counts}"
    if a["outcome"] == "unknown":
        return "needs_review", (f"is_icp_fit answered unknown: Firmable does not hold the facts to judge fit. "
                                f"Unknown is not a no. {counts}")
    if a["outcome"] == "not_found":
        code = (a.get("answer_error") or {}).get("code")
        return "not_found", f"Firmable did not match this account (error code {code or 'not given'})."
    err = a.get("error") or a.get("answer_error") or {}
    msg = err.get("message") if isinstance(err, dict) else err
    return "error", f"No answer: {msg or 'no message'}"


def run(ctx: RunContext) -> dict[str, Any]:
    cfg = ctx.config
    client = ctx.client
    criteria_cfg: list[str] = cfg["icp"].get("criteria") or []
    coverage = [
        "The accounts come from your input file. The REST API has no general company search.",
        "An unknown answer means Firmable does not hold the facts needed to judge fit. It is never counted as a no, "
        "and it never satisfies a tier that asks for yes or no.",
        "A criterion is not shown when the answer does not report it. is_icp_fit leaves out a criterion the "
        "company's record cannot show; that is not a no.",
        "The shape of details.criteria and details.filters is not documented. This recipe reads the criterion and "
        "met keys of each criteria entry and keeps both objects as returned.",
    ]

    def stop_all(reason: str) -> dict[str, Any]:
        rows = [{"row_id": r["row_id"], "input": r, "status": "not_processed", "reason": reason} for r in ctx.rows]
        return {"rows": rows, "summary": {"status_counts": {"not_processed": len(rows)}, "tier_counts": {}},
                "coverage": coverage}

    try:
        catalogue = client.list_decision_tools()
    except FirmableError as e:
        ctx.record_error(None, e)
        return stop_all("The decision tool list could not be read, so no accounts were checked.")
    problems = check_tools(catalogue, [{"tool": TOOL, "inputs": {"icp": cfg["icp"]}}], "company")
    if problems:
        for p in problems:
            ctx.errors.append({"row_id": None, "kind": "config", "status": None, "code": None,
                               "endpoint": "GET /decisions", "message": p, "charge_uncertain": False,
                               "retry_after": None})
        coverage.extend(problems)
        return stop_all("is_icp_fit is not available with this configuration, so no accounts were checked.")
    if uses_model(catalogue, TOOL):
        coverage.append("is_icp_fit uses a decision model inside Firmable's service to judge the criteria. This code "
                        "applies only the tier rules in the configuration.")

    keyed: list[dict[str, Any]] = []
    for r in ctx.rows:
        key, ident, problem = _subject(r)
        keyed.append({"row": r, "key": key, "ident": ident, "problem": problem})
    dupes = find_duplicates([{"row_id": k["row"]["row_id"], "_key": k["key"] or ""} for k in keyed], "_key")
    if dupes:
        coverage.append(f"{len(dupes)} row(s) repeat an earlier account; they reuse its answer.")
    subjects: dict[str, dict[str, Any]] = {}
    for k in keyed:
        if k["key"] and k["key"] not in subjects:
            subjects[k["key"]] = {"ext": f"subject-{len(subjects) + 1}", "ident": k["ident"],
                                  "row_id": k["row"]["row_id"]}
    items = list(subjects.items())
    answers: dict[str, dict[str, Any]] = {}
    size = cfg["batch_size"]
    for start in range(0, len(items), size):
        part = items[start:start + size]
        got = _ask(ctx, TOOL, {"icp": cfg["icp"]}, [(s["ext"], s["ident"], s["row_id"]) for _, s in part],
                   cfg["with_reasoning"])
        for key, s in part:
            answers[key] = got[s["ext"]]

    any_other = False

    def build(k: dict[str, Any]) -> dict[str, Any]:
        nonlocal any_other
        row = k["row"]
        base = {"row_id": row["row_id"], "input": row, "subject": k["ident"],
                "company_name": row.get("company_name") or None, "segment": row.get("segment") or None,
                "duplicate_of": dupes.get(row["row_id"]), "answer": None, "criteria": [], "criteria_met": [],
                "criteria_not_met": [], "criteria_not_shown": [], "criteria_other": [], "filters": None,
                "tier": None, "tier_label": None, "tier_reason": None}
        if k["problem"]:
            return {**base, "status": "invalid_input", "status_reason": k["problem"]}
        a = answers[k["key"]]
        if a["outcome"] == "not_asked":
            msg = ctx.stopped["message"] if ctx.stopped else "the run stopped"
            return {**base, "answer": a, "status": "not_processed", "reason": f"Run stopped earlier: {msg}"}
        crit, others = _criteria(criteria_cfg, a.get("details")) if a["outcome"] in ("yes", "no", "unknown") \
            else ([], [])
        if others:
            any_other = True
        met = [c["criterion"] for c in crit if c["result"] == "met"]
        not_met = [c["criterion"] for c in crit if c["result"] == "not_met"]
        not_shown = [c["criterion"] for c in crit if c["result"] == "not_shown"]
        status, reason = _status(a, len(met), len(not_met), len(not_shown))
        details = a.get("details") if isinstance(a.get("details"), dict) else {}
        out = {**base, "answer": a, "status": status, "status_reason": reason, "criteria": crit,
               "criteria_met": met, "criteria_not_met": not_met, "criteria_not_shown": not_shown,
               "criteria_other": others, "filters": details.get("filters")}
        if cfg["tiers"]:
            t = _tier(cfg["tiers"], a["outcome"], len(met))
            if t is not None:
                out.update(tier=t["id"], tier_label=t["label"], tier_reason=f"First matching tier: {t['label']}.")
            elif a["outcome"] in ("yes", "no", "unknown"):
                out["tier_reason"] = "No tier matched."
            else:
                out["tier_reason"] = "No tier: there is no answer."
        return out

    rows = [build(k) for k in keyed]
    if any_other:
        coverage.append("Some answers report criteria that are not in the configuration. They are kept as returned "
                        "under criteria_other.")
    counts: dict[str, int] = {}
    tier_counts: dict[str, int] = {}
    for r in rows:
        counts[r["status"]] = counts.get(r["status"], 0) + 1
        if cfg["tiers"] and r["status"] in ("fit", "not_fit", "needs_review"):
            t = r["tier"] or "no_tier"
            tier_counts[t] = tier_counts.get(t, 0) + 1
    crit_counts = {c: {"met": 0, "not_met": 0, "not_shown": 0} for c in criteria_cfg}
    for r in rows:
        if r.get("duplicate_of"):
            continue
        for c in r.get("criteria") or []:
            crit_counts[c["criterion"]][c["result"]] += 1
    return {"rows": rows, "summary": {"status_counts": counts, "tier_counts": tier_counts,
                                      "criteria_counts": crit_counts}, "coverage": coverage}


# ----- outputs ------------------------------------------------------------------------------------

CSV_COLUMNS = ["row_id", "domain", "company_id", "company_name", "segment", "duplicate_of", "status",
               "status_reason", "tier", "tier_label", "fit_answer", "confidence", "criteria_met",
               "criteria_not_met", "criteria_not_shown", "filters", "reason", "last_refreshed"]


def csv_rows(result: dict[str, Any]) -> list[dict[str, Any]]:
    out = []
    for r in result["rows"]:
        subject = r.get("subject") or {}
        a = r.get("answer") or {}
        rs = a.get("reasoning") or {}
        out.append({
            "row_id": r["row_id"], "domain": subject.get("domain") or r["input"].get("domain"),
            "company_id": subject.get("company_id") or a.get("entity_id"),
            "company_name": r.get("company_name"), "segment": r.get("segment"),
            "duplicate_of": r.get("duplicate_of"), "status": r["status"],
            "status_reason": r.get("status_reason") or r.get("reason") or (r.get("error") or {}).get("message"),
            "tier": r.get("tier"), "tier_label": r.get("tier_label"), "fit_answer": a.get("answer"),
            "confidence": a.get("confidence"), "criteria_met": r.get("criteria_met") or [],
            "criteria_not_met": r.get("criteria_not_met") or [],
            "criteria_not_shown": r.get("criteria_not_shown") or [], "filters": r.get("filters"),
            "reason": rs.get("reason"), "last_refreshed": rs.get("last_refreshed"),
        })
    return out


def render(report: Any, result: dict[str, Any]) -> None:
    summary = result["summary"]
    counts = summary.get("status_counts", {})
    body = ("<p>" + " ".join(badge(f"{k.replace('_', ' ')}: {v}", STATUS_TONE.get(k, "neutral"))
                             for k, v in counts.items()) + "</p>")
    tiers = result["input"]["config"].get("tiers") or []
    if tiers and summary.get("tier_counts"):
        labels = {t["id"]: t["label"] for t in tiers}
        body += table(["Tier", "Rows"], [[labels.get(k, "No tier matched"), v]
                                             for k, v in summary["tier_counts"].items()])
    crit = summary.get("criteria_counts") or {}
    if crit:
        body += "<h3>Criteria across unique accounts</h3>" + table(
            ["Criterion", "Met", "Not met", "Not shown"], [[c, v["met"], v["not_met"], v["not_shown"]]
                                                          for c, v in crit.items()])
    body += note("Unknown means Firmable does not hold the facts to judge fit. It is <strong>needs review</strong>, "
                 "never fit and never not fit. A criterion that is not shown is not a no.", "unknown")
    report.add("Result", "ICP fit summary", body)

    sections = []
    for status in STATUS_ORDER:
        group = [r for r in result["rows"] if r["status"] == status]
        if not group:
            continue
        cards = []
        for r in group:
            subject = r.get("subject") or {}
            a = r.get("answer") or {}
            title = r.get("company_name") or subject.get("domain") or subject.get("company_id") \
                or r["input"].get("domain") or r["row_id"]
            reason = r.get("status_reason") or r.get("reason") or ""
            left = f"<p>{esc(reason)}</p>" + kv([
                ("Identifier", subject.get("company_id") or subject.get("domain")),
                ("Firmable ID", a.get("entity_id")), ("Segment", r.get("segment")),
                ("Tier", r.get("tier_label") or r.get("tier_reason")), ("Confidence", a.get("confidence"))])
            if r.get("duplicate_of"):
                left += note(f"Same account as row {esc(r['duplicate_of'])}; its answer was reused.", "info")
            right = ""
            if r.get("criteria"):
                right += table(["Criterion", "Result", "Returned entry"], [
                    [c["criterion"], Raw(badge(c["result"].replace("_", " "), CRITERION_TONE[c["result"]])),
                     c["returned"]] for c in r["criteria"]])
            if r.get("criteria_other"):
                right += "<h3>Other criteria in the answer</h3>" + bullet_list(r["criteria_other"])
            if r.get("filters") is not None:
                f = r["filters"]
                right += "<h3>Filters as returned</h3>" + (
                    kv(list(f.items())) if isinstance(f, dict) else f"<p>{esc(f)}</p>")
            rs = a.get("reasoning") or {}
            if rs.get("reason"):
                right += (f"<p><strong>Reason:</strong> {esc(rs.get('reason'))}</p>"
                          f"<p class=\"muted\">Source: {esc(rs.get('source'))}. Last refreshed: "
                          f"{esc(rs.get('last_refreshed'))}."
                          + (f" Would change if: {esc(rs.get('would_change_if'))}." if rs.get("would_change_if") else "")
                          + "</p>")
            if a:
                right += details_json("Answer as JSON", a)
            cards.append(card(str(title), badge(status.replace("_", " "), STATUS_TONE.get(status, "neutral")), left,
                              right or "<p class=\"muted\">No answer for this row.</p>", sub=f"Row {r['row_id']}"))
        sections.append(f"<h3>{esc(status.replace('_', ' '))} ({len(group)})</h3>" + "".join(cards))
    report.add("Accounts", "Each account with its criteria", "".join(sections))


RECIPE = Recipe(NAME, TITLE, DESCRIPTION, load_config, read_input, plan, run, CSV_COLUMNS, csv_rows, render)
