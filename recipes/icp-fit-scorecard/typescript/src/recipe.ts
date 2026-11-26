/**
 * ICP fit scorecard: which accounts fit one ideal customer profile, and on which criteria.
 * Mirrors recipes/icp-fit-scorecard/python/src/icp_fit_scorecard/recipe.py; see that file and the
 * recipe README for the rules.
 */
import {
  ConfigError, FirmableError, Json, NotFoundError, PlannedCall, Raw, Recipe, Report, RunContext, Row,
  badge, bulletList, card, decisions, detailsJson, esc, findDuplicates, kv, normaliseDomain, note, pricing, pyRepr,
  readRows, table,
} from "firmable-api-client";

export const NAME = "icp-fit-scorecard";
export const TITLE = "ICP fit scorecard";
export const DESCRIPTION = "Asks Firmable whether each account fits one ideal customer profile, shows each criterion as met, " +
  "not met or not shown, and assigns the first matching tier from the configuration.";
const TOOL = "is_icp_fit";

const TOP_KEYS = new Set(["icp", "with_reasoning", "batch_size", "tiers"]);
const ICP_ORDER = ["min_staff", "max_staff", "staff_in", "industries", "countries", "revenue_bands", "criteria"];
const STAFF_IN = ["AU", "NZ", "SG", "MY", "ID", "PH", "HK", "JP", "VN", "KR", "TH", "US", "CA"];
const REVENUE_BANDS = ["<$1M", "$1M - $5M", "$5M - $10M", "$10M - $50M", "$50M - $100M", "$100M - $250M",
  "$250M - $500M", "$500M - $1B", ">$1B+"];
const ID = /^[a-z0-9_]{1,40}$/;
const COMPANY_ID = /^f\d{12}$/;
const STATUS_TONE: Record<string, string> = {
  fit: "good", not_fit: "bad", needs_review: "review", not_found: "unknown", error: "error", invalid_input: "error",
  not_processed: "unknown",
};
const CRITERION_TONE: Record<string, string> = { met: "good", not_met: "bad", not_shown: "unknown" };
const STATUS_ORDER = ["fit", "needs_review", "not_fit", "not_found", "error", "invalid_input", "not_processed"];

const isObj = (x: unknown): x is Record<string, any> => !!x && typeof x === "object" && !Array.isArray(x);
const isInt = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x);
const textList = (v: unknown): v is string[] =>
  Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string" && x.trim() !== "");
const chars = (s: string): number => [...s].length;
const norm = (s: string): string => s.trim().split(/\s+/).filter(Boolean).join(" ").toLowerCase();

// ----- configuration and input -------------------------------------------------------------------

function loadIcp(icp: unknown): Json {
  if (!isObj(icp)) throw new ConfigError("icp must be an object.");
  if ("description" in icp) throw new ConfigError("icp.description is not accepted by is_icp_fit. Give icp.criteria instead.");
  const extra = Object.keys(icp).filter((k) => !ICP_ORDER.includes(k)).sort();
  if (extra.length) throw new ConfigError(`icp has unknown key(s): ${extra.join(", ")}`);
  const out: Json = {};
  for (const key of ICP_ORDER) {
    if (!(key in icp) || icp[key] === null || icp[key] === undefined) continue;
    const value = icp[key];
    if (key === "min_staff" || key === "max_staff") {
      if (!isInt(value) || value < 0) throw new ConfigError(`icp.${key} must be a whole number, 0 or more.`);
    } else if (key === "staff_in") {
      if (!STAFF_IN.includes(value)) throw new ConfigError(`icp.staff_in must be one of: ${STAFF_IN.join(", ")}.`);
    } else if (key === "criteria") {
      if (!Array.isArray(value) || !value.length || value.length > 10 ||
        !value.every((c) => typeof c === "string" && chars(c.trim()) >= 2)) {
        throw new ConfigError("icp.criteria must be a list of 1 to 10 text items, each at least 2 characters.");
      }
      if (value.reduce((s: number, c: string) => s + chars(c), 0) > 2000) {
        throw new ConfigError("icp.criteria must be 2,000 characters or fewer in all.");
      }
      if (new Set(value.map((c: string) => norm(c))).size !== value.length) {
        throw new ConfigError("icp.criteria has the same criterion twice.");
      }
    } else {
      if (!textList(value)) throw new ConfigError(`icp.${key} must be a non-empty list of text values.`);
      if (key === "revenue_bands") {
        for (const band of value) {
          if (!REVENUE_BANDS.includes(band)) throw new ConfigError(`icp.revenue_bands has ${pyRepr(band)}, which is not a Firmable revenue band.`);
        }
      }
    }
    out[key] = value;
  }
  if ("min_staff" in out && "max_staff" in out && out.min_staff > out.max_staff) {
    throw new ConfigError("icp.min_staff is more than icp.max_staff.");
  }
  if (!Object.keys(out).length) throw new ConfigError("icp must hold at least one filter or criterion.");
  return out;
}

function loadTiers(raw: unknown, nCriteria: number): Json[] {
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 10) throw new ConfigError("tiers must be a list of up to 10 tiers.");
  const tiers: Json[] = [];
  const seen = new Set<string>();
  raw.forEach((t: Json, idx: number) => {
    const i = idx + 1;
    if (!isObj(t)) throw new ConfigError(`tiers[${i}] must be an object.`);
    let extra = Object.keys(t).filter((k) => !["id", "label", "when"].includes(k)).sort();
    if (extra.length) throw new ConfigError(`tiers[${i}] has unknown key(s): ${extra.join(", ")}`);
    const tid = t.id;
    if (typeof tid !== "string" || !ID.test(tid)) throw new ConfigError(`tiers[${i}].id must be 1 to 40 lower-case letters, digits or underscores.`);
    if (seen.has(tid)) throw new ConfigError(`tiers[${i}].id ${pyRepr(tid)} is used twice.`);
    seen.add(tid);
    const label = t.label ?? tid;
    if (typeof label !== "string" || !label.trim()) throw new ConfigError(`tiers[${i}].label must be text.`);
    const when = t.when;
    if (!isObj(when) || !Object.keys(when).length) throw new ConfigError(`tiers[${i}].when must be an object with at least one condition.`);
    extra = Object.keys(when).filter((k) => k !== "fit" && k !== "min_criteria_met").sort();
    if (extra.length) throw new ConfigError(`tiers[${i}].when has unknown key(s): ${extra.join(", ")}`);
    const cond: Json = {};
    if ("fit" in when) {
      if (!["yes", "no", "unknown"].includes(when.fit)) throw new ConfigError(`tiers[${i}].when.fit must be yes, no or unknown.`);
      cond.fit = when.fit;
    }
    if ("min_criteria_met" in when) {
      const m = when.min_criteria_met;
      if (!isInt(m) || m < 0) throw new ConfigError(`tiers[${i}].when.min_criteria_met must be a whole number, 0 or more.`);
      if (m > nCriteria) throw new ConfigError(`tiers[${i}].when.min_criteria_met is ${m} but icp.criteria has ${nCriteria} criteria.`);
      cond.min_criteria_met = m;
    }
    tiers.push({ id: tid, label, when: cond });
  });
  return tiers;
}

export function loadConfig(raw: Json): Json {
  const unknown = Object.keys(raw).filter((k) => !TOP_KEYS.has(k)).sort();
  if (unknown.length) throw new ConfigError(`Unknown configuration key(s): ${unknown.join(", ")}`);
  if (!("icp" in raw)) throw new ConfigError("icp is required.");
  const icp = loadIcp(raw.icp);
  if (typeof (raw.with_reasoning ?? true) !== "boolean") throw new ConfigError("with_reasoning must be true or false.");
  const bs = raw.batch_size ?? 100;
  if (!isInt(bs) || bs < 1 || bs > 100) throw new ConfigError("batch_size must be a whole number from 1 to 100.");
  const tiers = loadTiers(raw.tiers, (icp.criteria ?? []).length);
  return { icp, with_reasoning: raw.with_reasoning ?? true, batch_size: bs, tiers };
}

export function readInput(path: string): Row[] {
  return readRows(path, { anyOf: ["domain", "company_id"] });
}

function subjectOf(row: Row): [string | null, Record<string, string> | null, string | null] {
  const cid = (row.company_id ?? "").trim();
  if (cid) {
    if (!COMPANY_ID.test(cid)) return [null, null, `${pyRepr(cid)} is not a Firmable company ID (f followed by 12 digits).`];
    return [`id:${cid}`, { company_id: cid }, null];
  }
  const domain = normaliseDomain(row.domain);
  if (!domain) return [null, null, `${pyRepr(row.domain)} is not a valid domain.`];
  return [`domain:${domain}`, { domain }, null];
}

function uniqueSubjects(rows: Row[]): string[] {
  const out: string[] = [];
  for (const r of rows) {
    const key = subjectOf(r)[0];
    if (key && !out.includes(key)) out.push(key);
  }
  return out;
}

export function plan(rows: Row[], config: Json): PlannedCall[] {
  const n = uniqueSubjects(rows).length;
  const size: number = config.batch_size;
  return [
    new PlannedCall("GET /decisions", "Read the decision tool list and check is_icp_fit accepts the ICP", 1, []),
    new PlannedCall("POST /decisions", `is_icp_fit for each unique valid account, in batches of up to ${size}`,
      Math.floor((n + size - 1) / size), pricing.estimateDecision(n, config.with_reasoning)),
  ];
}

// ----- answers -----------------------------------------------------------------------------------

function blank(outcome: string, error: Json = null): Json {
  return { outcome, answer: null, confidence: null, details: null, reasoning: null, answered_at: null, credits: null,
    answer_error: null, entity_id: null, request_id: null, error };
}

const isNotFoundCode = (code: unknown): boolean =>
  typeof code === "string" && code.endsWith("not_found") && code !== "tool_not_found";

function fromResult(res: Json): Json {
  const ans = decisions.answerFrom(res);
  const err = ans.answer_error;
  let outcome: string;
  if (["yes", "no", "unknown"].includes(ans.answer)) outcome = ans.answer;
  else if (isObj(err) && isNotFoundCode(err.code)) outcome = "not_found";
  else outcome = "error";
  return { outcome, ...ans, error: null };
}

type Chunk = [string, Record<string, string>, string][];

async function ask(ctx: RunContext, tool: string, inputs: Json, chunk: Chunk, withReasoning: boolean): Promise<Record<string, Json>> {
  const out: Record<string, Json> = {};
  if (ctx.stopped !== null) {
    for (const [ext] of chunk) out[ext] = blank("not_asked");
    return out;
  }
  const records = chunk.map(([ext, subject]) => ({ ...subject, external_id: ext }));
  let resp: Json;
  try {
    resp = await ctx.client.makeDecision(tool, { ...inputs, records }, { withReasoning });
  } catch (e) {
    if (!(e instanceof FirmableError)) throw e;
    if (e instanceof NotFoundError && isNotFoundCode(e.code) && chunk.length === 1) {
      out[chunk[0][0]] = { ...blank("not_found"), answer_error: { code: e.code, message: e.message } };
      return out;
    }
    const entry = ctx.recordError(chunk.length === 1 ? chunk[0][2] : null, e);
    for (const [ext] of chunk) out[ext] = blank("error", entry);
    return out;
  }
  const results: Json[] = Array.isArray(resp.results) ? resp.results : [resp];
  const byExt = new Map<unknown, Json>();
  for (const r of results) if (isObj(r)) byExt.set(r.external_id, r);
  for (const [ext] of chunk) {
    const r = byExt.get(ext);
    out[ext] = r !== undefined ? fromResult(r) : blank("error", { message: "The batch response has no answer for this account." });
  }
  return out;
}

// ----- rules -------------------------------------------------------------------------------------

function criteriaOf(configured: string[], details: unknown): [Json[], Json[]] {
  const returned = isObj(details) ? details.criteria : null;
  const entries: Json[] = Array.isArray(returned) ? returned : [];
  const used = new Set<number>();
  const out: Json[] = [];
  for (const c of configured) {
    let match: number | null = null;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (used.has(i) || !isObj(e) || typeof e.criterion !== "string") continue;
      if (norm(e.criterion) === norm(c)) { match = i; break; }
    }
    const entry = match !== null ? entries[match] : null;
    if (match !== null) used.add(match);
    const met = isObj(entry) ? entry.met : null;
    const result = met === true ? "met" : met === false ? "not_met" : "not_shown";
    out.push({ criterion: c, result, returned: entry });
  }
  const others = entries.filter((_, i) => !used.has(i));
  return [out, others];
}

function tierOf(tiers: Json[], outcome: string, met: number): Json | null {
  if (!["yes", "no", "unknown"].includes(outcome)) return null;
  for (const t of tiers) {
    const w = t.when;
    if ("fit" in w && w.fit !== outcome) continue;
    if ("min_criteria_met" in w && met < w.min_criteria_met) continue;
    return t;
  }
  return null;
}

function statusOf(a: Json, met: number, notMet: number, notShown: number): [string, string] {
  const counts = `Criteria met: ${met}; not met: ${notMet}; not shown: ${notShown}.`;
  if (a.outcome === "yes") return ["fit", `is_icp_fit answered yes. ${counts}`];
  if (a.outcome === "no") return ["not_fit", `is_icp_fit answered no. ${counts}`];
  if (a.outcome === "unknown") {
    return ["needs_review", "is_icp_fit answered unknown: Firmable does not hold the facts to judge fit. " +
      `Unknown is not a no. ${counts}`];
  }
  if (a.outcome === "not_found") {
    const code = (a.answer_error ?? {}).code;
    return ["not_found", `Firmable did not match this account (error code ${code || "not given"}).`];
  }
  const err = a.error || a.answer_error || {};
  const msg = isObj(err) ? err.message : err;
  return ["error", `No answer: ${msg || "no message"}`];
}

export async function run(ctx: RunContext): Promise<{ rows: Json[]; summary: Json; coverage: string[] }> {
  const cfg = ctx.config;
  const client = ctx.client;
  const criteriaCfg: string[] = cfg.icp.criteria ?? [];
  const coverage: string[] = [
    "The accounts come from your input file. The REST API has no general company search.",
    "An unknown answer means Firmable does not hold the facts needed to judge fit. It is never counted as a no, " +
      "and it never satisfies a tier that asks for yes or no.",
    "A criterion is not shown when the answer does not report it. is_icp_fit leaves out a criterion the " +
      "company's record cannot show; that is not a no.",
    "The shape of details.criteria and details.filters is not documented. This recipe reads the criterion and " +
      "met keys of each criteria entry and keeps both objects as returned.",
  ];
  const stopAll = (reason: string) => {
    const rows = ctx.rows.map((r) => ({ row_id: r.row_id, input: r, status: "not_processed", reason }));
    return { rows, summary: { status_counts: { not_processed: rows.length }, tier_counts: {} }, coverage };
  };

  let catalogue: Json;
  try {
    catalogue = await client.listDecisionTools();
  } catch (e) {
    if (!(e instanceof FirmableError)) throw e;
    ctx.recordError(null, e);
    return stopAll("The decision tool list could not be read, so no accounts were checked.");
  }
  const problems = decisions.checkTools(catalogue, [{ tool: TOOL, inputs: { icp: cfg.icp } }], "company");
  if (problems.length) {
    for (const p of problems) {
      ctx.errors.push({ row_id: null, kind: "config" as never, status: null, code: null, endpoint: "GET /decisions",
        message: p, charge_uncertain: false, retry_after: null });
    }
    coverage.push(...problems);
    return stopAll("is_icp_fit is not available with this configuration, so no accounts were checked.");
  }
  if (decisions.usesModel(catalogue, TOOL)) {
    coverage.push("is_icp_fit uses a decision model inside Firmable's service to judge the criteria. This code " +
      "applies only the tier rules in the configuration.");
  }

  const keyed = ctx.rows.map((r) => {
    const [key, ident, problem] = subjectOf(r);
    return { row: r, key, ident, problem };
  });
  const dupes = findDuplicates(keyed.map((k) => ({ row_id: k.row.row_id, _key: k.key ?? "" })) as Row[], "_key");
  const nDupes = Object.keys(dupes).length;
  if (nDupes) coverage.push(`${nDupes} row(s) repeat an earlier account; they reuse its answer.`);
  const subjects = new Map<string, Json>();
  for (const k of keyed) {
    if (k.key && !subjects.has(k.key)) subjects.set(k.key, { ext: `subject-${subjects.size + 1}`, ident: k.ident, row_id: k.row.row_id });
  }
  const items = [...subjects.entries()];
  const answers: Record<string, Json> = {};
  const size: number = cfg.batch_size;
  for (let start = 0; start < items.length; start += size) {
    const part = items.slice(start, start + size);
    const got = await ask(ctx, TOOL, { icp: cfg.icp }, part.map(([, s]) => [s.ext, s.ident, s.row_id]), cfg.with_reasoning);
    for (const [key, s] of part) answers[key] = got[s.ext];
  }

  let anyOther = false;
  const build = (k: Json): Json => {
    const row = k.row;
    const base: Json = { row_id: row.row_id, input: row, subject: k.ident, company_name: row.company_name || null,
      segment: row.segment || null, duplicate_of: dupes[row.row_id] ?? null, answer: null, criteria: [],
      criteria_met: [], criteria_not_met: [], criteria_not_shown: [], criteria_other: [], filters: null, tier: null,
      tier_label: null, tier_reason: null };
    if (k.problem) return { ...base, status: "invalid_input", status_reason: k.problem };
    const a = answers[k.key];
    if (a.outcome === "not_asked") {
      const msg = ctx.stopped ? ctx.stopped.message : "the run stopped";
      return { ...base, answer: a, status: "not_processed", reason: `Run stopped earlier: ${msg}` };
    }
    const [crit, others] = ["yes", "no", "unknown"].includes(a.outcome) ? criteriaOf(criteriaCfg, a.details) : [[], []];
    if (others.length) anyOther = true;
    const met = crit.filter((c) => c.result === "met").map((c) => c.criterion);
    const notMet = crit.filter((c) => c.result === "not_met").map((c) => c.criterion);
    const notShown = crit.filter((c) => c.result === "not_shown").map((c) => c.criterion);
    const [status, reason] = statusOf(a, met.length, notMet.length, notShown.length);
    const details = isObj(a.details) ? a.details : {};
    const out: Json = { ...base, answer: a, status, status_reason: reason, criteria: crit, criteria_met: met,
      criteria_not_met: notMet, criteria_not_shown: notShown, criteria_other: others, filters: details.filters ?? null };
    if (cfg.tiers.length) {
      const t = tierOf(cfg.tiers, a.outcome, met.length);
      if (t !== null) Object.assign(out, { tier: t.id, tier_label: t.label, tier_reason: `First matching tier: ${t.label}.` });
      else if (["yes", "no", "unknown"].includes(a.outcome)) out.tier_reason = "No tier matched.";
      else out.tier_reason = "No tier: there is no answer.";
    }
    return out;
  };

  const rows = keyed.map(build);
  if (anyOther) {
    coverage.push("Some answers report criteria that are not in the configuration. They are kept as returned " +
      "under criteria_other.");
  }
  const counts: Record<string, number> = {};
  const tierCounts: Record<string, number> = {};
  for (const r of rows) {
    counts[r.status] = (counts[r.status] ?? 0) + 1;
    if (cfg.tiers.length && ["fit", "not_fit", "needs_review"].includes(r.status)) {
      const t = r.tier || "no_tier";
      tierCounts[t] = (tierCounts[t] ?? 0) + 1;
    }
  }
  const critCounts: Record<string, Record<string, number>> = {};
  for (const c of criteriaCfg) critCounts[c] = { met: 0, not_met: 0, not_shown: 0 };
  for (const r of rows) {
    if (r.duplicate_of) continue;
    for (const c of r.criteria ?? []) critCounts[c.criterion][c.result] += 1;
  }
  return { rows, summary: { status_counts: counts, tier_counts: tierCounts, criteria_counts: critCounts }, coverage };
}

// ----- outputs -----------------------------------------------------------------------------------

export const CSV_COLUMNS = ["row_id", "domain", "company_id", "company_name", "segment", "duplicate_of", "status",
  "status_reason", "tier", "tier_label", "fit_answer", "confidence", "criteria_met", "criteria_not_met",
  "criteria_not_shown", "filters", "reason", "last_refreshed"];

export function csvRows(result: Json): Record<string, unknown>[] {
  return result.rows.map((r: Json) => {
    const subject = r.subject ?? {};
    const a = r.answer ?? {};
    const rs = a.reasoning ?? {};
    return {
      row_id: r.row_id, domain: subject.domain || r.input.domain || null,
      company_id: subject.company_id || a.entity_id || null, company_name: r.company_name ?? null,
      segment: r.segment ?? null, duplicate_of: r.duplicate_of ?? null, status: r.status,
      status_reason: r.status_reason || r.reason || (r.error ?? {}).message || null,
      tier: r.tier ?? null, tier_label: r.tier_label ?? null, fit_answer: a.answer ?? null,
      confidence: a.confidence ?? null, criteria_met: r.criteria_met ?? [], criteria_not_met: r.criteria_not_met ?? [],
      criteria_not_shown: r.criteria_not_shown ?? [], filters: r.filters ?? null, reason: rs.reason ?? null,
      last_refreshed: rs.last_refreshed ?? null,
    };
  });
}

export function render(report: Report, result: Json): void {
  const summary = result.summary;
  const counts: Record<string, number> = summary.status_counts ?? {};
  let body = "<p>" + Object.entries(counts).map(([k, v]) => badge(`${k.replace(/_/g, " ")}: ${v}`, STATUS_TONE[k] ?? "neutral")).join(" ") + "</p>";
  const tiers: Json[] = result.input.config.tiers ?? [];
  if (tiers.length && Object.keys(summary.tier_counts ?? {}).length) {
    const labels = Object.fromEntries(tiers.map((t) => [t.id, t.label]));
    body += table(["Tier", "Rows"], Object.entries(summary.tier_counts).map(([k, v]) => [labels[k] ?? "No tier matched", v]));
  }
  const crit: Record<string, Json> = summary.criteria_counts ?? {};
  if (Object.keys(crit).length) {
    body += "<h3>Criteria across unique accounts</h3>" + table(["Criterion", "Met", "Not met", "Not shown"],
      Object.entries(crit).map(([c, v]) => [c, v.met, v.not_met, v.not_shown]));
  }
  body += note("Unknown means Firmable does not hold the facts to judge fit. It is <strong>needs review</strong>, " +
    "never fit and never not fit. A criterion that is not shown is not a no.", "unknown");
  report.add("Result", "ICP fit summary", body);

  const sections: string[] = [];
  for (const status of STATUS_ORDER) {
    const group = result.rows.filter((r: Json) => r.status === status);
    if (!group.length) continue;
    const cards: string[] = [];
    for (const r of group) {
      const subject = r.subject ?? {};
      const a = r.answer ?? {};
      const title = r.company_name || subject.domain || subject.company_id || r.input.domain || r.row_id;
      const reason = r.status_reason || r.reason || "";
      let left = `<p>${esc(reason)}</p>` + kv([
        ["Identifier", subject.company_id || subject.domain], ["Firmable ID", a.entity_id], ["Segment", r.segment],
        ["Tier", r.tier_label || r.tier_reason], ["Confidence", a.confidence]]);
      if (r.duplicate_of) left += note(`Same account as row ${esc(r.duplicate_of)}; its answer was reused.`, "info");
      let right = "";
      if ((r.criteria ?? []).length) {
        right += table(["Criterion", "Result", "Returned entry"], r.criteria.map((c: Json) => [
          c.criterion, new Raw(badge(c.result.replace(/_/g, " "), CRITERION_TONE[c.result])), c.returned]));
      }
      if ((r.criteria_other ?? []).length) right += "<h3>Other criteria in the answer</h3>" + bulletList(r.criteria_other);
      if (r.filters !== null && r.filters !== undefined) {
        const f = r.filters;
        right += "<h3>Filters as returned</h3>" + (isObj(f) ? kv(Object.entries(f)) : `<p>${esc(f)}</p>`);
      }
      const rs = a.reasoning ?? {};
      if (rs.reason) {
        right += `<p><strong>Reason:</strong> ${esc(rs.reason)}</p>` +
          `<p class="muted">Source: ${esc(rs.source)}. Last refreshed: ${esc(rs.last_refreshed)}.` +
          (rs.would_change_if ? ` Would change if: ${esc(rs.would_change_if)}.` : "") + "</p>";
      }
      if (r.answer) right += detailsJson("Answer as JSON", a);
      cards.push(card(String(title), badge(status.replace(/_/g, " "), STATUS_TONE[status] ?? "neutral"), left,
        right || '<p class="muted">No answer for this row.</p>', `Row ${r.row_id}`));
    }
    sections.push(`<h3>${esc(status.replace(/_/g, " "))} (${group.length})</h3>` + cards.join(""));
  }
  report.add("Accounts", "Each account with its criteria", sections.join(""));
}

export const RECIPE: Recipe = {
  name: NAME, title: TITLE, description: DESCRIPTION, loadConfig, readInput, plan, run,
  csvColumns: CSV_COLUMNS, csvRows, render,
};
