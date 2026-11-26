/**
 * Call priority list: who in a contact list a rep should call first.
 * Mirrors recipes/call-priority-list/python/src/call_priority_list/recipe.py; see that file and the
 * recipe README for the priority rules.
 */
import {
  ConfigError, FirmableError, Json, NotFoundError, PlannedCall, Raw, Recipe, Report, RunContext, Row,
  badge, card, decisions, detailsJson, esc, findDuplicates, kv, note, pricing, readRows, table,
} from "firmable-api-client";

export const NAME = "call-priority-list";
export const TITLE = "Call priority list";
export const DESCRIPTION = "Ranks a contact list for calling with fixed rules: seniority and department match, reachability " +
  "and the Australian Do Not Call register, each from Firmable Decisions, with the reason for every person.";

const TOP_KEYS = new Set(["target_seniorities", "target_departments", "decision_maker", "check_reachability", "check_dnc",
  "with_reasoning", "batch_size"]);
const PERSON_ID = /^fp\d{12}$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const LINKEDIN = /linkedin\.com\/in\/([^/?#\s]+)/i;
export const DELIVERABLE_GRADES = ["Highly likely", "Likely"];
const PRIORITY_ORDER = ["P1", "P2", "P3", "review", "exclude_dnc", "no_priority", "not_found", "incomplete",
  "invalid_input", "error", "not_processed"];
const PRIORITY_TONE: Record<string, string> = {
  P1: "good", P2: "good", P3: "info", review: "review", exclude_dnc: "bad", no_priority: "neutral", not_found: "unknown",
  incomplete: "error", invalid_input: "error", error: "error", not_processed: "unknown",
};
const OUTCOME_TONE: Record<string, string> = {
  yes: "good", no: "bad", unknown: "unknown", not_found: "unknown", error: "error", not_asked: "neutral", not_checked: "neutral",
};
const CHECK_NAMES: Record<string, string> = {
  seniority: "seniority", department: "department", reachable: "reachability", dnc: "Do Not Call status",
  decision_maker: "decision maker",
};
const CHECK_KEYS = ["seniority", "department", "reachable", "dnc", "decision_maker"];

const isObj = (x: unknown): x is Record<string, any> => !!x && typeof x === "object" && !Array.isArray(x);
const isInt = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x);

// ----- configuration and input -------------------------------------------------------------------

function labels(raw: unknown, key: string): string[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 20 ||
    !raw.every((x) => typeof x === "string" && x.trim() && x.length <= 100)) {
    throw new ConfigError(`${key} must be a list of 1 to 20 labels.`);
  }
  if (new Set(raw).size !== raw.length) throw new ConfigError(`${key} has the same label twice.`);
  return [...raw];
}

export function loadConfig(raw: Json): Json {
  const unknown = Object.keys(raw).filter((k) => !TOP_KEYS.has(k)).sort();
  if (unknown.length) throw new ConfigError(`Unknown configuration key(s): ${unknown.join(", ")}`);
  const seniorities = labels(raw.target_seniorities, "target_seniorities");
  const departments = labels(raw.target_departments, "target_departments");
  let dm = raw.decision_maker ?? null;
  if (dm !== null) {
    if (!isObj(dm)) throw new ConfigError("decision_maker must be an object with seller and an optional buyer.");
    const extra = Object.keys(dm).filter((k) => k !== "seller" && k !== "buyer").sort();
    if (extra.length) throw new ConfigError(`decision_maker has unknown key(s): ${extra.join(", ")}`);
    const seller = dm.seller;
    if (typeof seller !== "string" || seller.trim().length < 3 || seller.length > 2000) {
      throw new ConfigError("decision_maker.seller must be text of 3 to 2,000 characters.");
    }
    const buyer = dm.buyer ?? null;
    if (buyer !== null && (typeof buyer !== "string" || !buyer.trim() || buyer.length > 2000)) {
      throw new ConfigError("decision_maker.buyer must be text of up to 2,000 characters.");
    }
    dm = buyer === null ? { seller } : { seller, buyer };
  }
  for (const key of ["check_reachability", "check_dnc"]) {
    if (typeof (raw[key] ?? true) !== "boolean") throw new ConfigError(`${key} must be true or false.`);
  }
  if (typeof (raw.with_reasoning ?? false) !== "boolean") throw new ConfigError("with_reasoning must be true or false.");
  const bs = raw.batch_size ?? 100;
  if (!isInt(bs) || bs < 1 || bs > 100) throw new ConfigError("batch_size must be a whole number from 1 to 100.");
  return { target_seniorities: seniorities, target_departments: departments, decision_maker: dm,
    check_reachability: raw.check_reachability ?? true, check_dnc: raw.check_dnc ?? true,
    with_reasoning: raw.with_reasoning ?? false, batch_size: bs };
}

export function readInput(path: string): Row[] {
  return readRows(path, { anyOf: ["person_id", "work_email", "linkedin_url"] });
}

function subjectOf(row: Row): [string | null, Record<string, string> | null, string | null] {
  const pid = (row.person_id ?? "").trim();
  if (pid) {
    if (!PERSON_ID.test(pid)) return [null, null, "person_id is not a Firmable person ID (fp followed by 12 digits)."];
    return [`person_id:${pid}`, { person_id: pid }, null];
  }
  const email = (row.work_email ?? "").trim();
  if (email) {
    if (email.length > 254 || !EMAIL.test(email)) return [null, null, "work_email is not an email address."];
    return [`work_email:${email.toLowerCase()}`, { work_email: email }, null];
  }
  const url = (row.linkedin_url ?? "").trim();
  const m = LINKEDIN.exec(url);
  if (url.length > 300 || !m) return [null, null, "linkedin_url is not a LinkedIn profile URL (linkedin.com/in/...)."];
  return [`linkedin_url:${m[1].toLowerCase()}`, { linkedin_url: url }, null];
}

function toolsOf(config: Json): Json[] {
  const tools: Json[] = [
    { key: "seniority", tool: "matches_seniority", inputs: { seniorities: config.target_seniorities } },
    { key: "department", tool: "matches_department", inputs: { departments: config.target_departments } },
  ];
  if (config.check_reachability) tools.push({ key: "reachable", tool: "is_reachable", inputs: {} });
  if (config.check_dnc) tools.push({ key: "dnc", tool: "is_mobile_on_dnc", inputs: {} });
  if (config.decision_maker) tools.push({ key: "decision_maker", tool: "is_decision_maker", inputs: { ...config.decision_maker } });
  return tools;
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
  const batches = Math.floor((n + size - 1) / size);
  const calls = [new PlannedCall("GET /decisions", "Read the decision tool list and check the tools and labels", 1, [])];
  for (const t of toolsOf(config)) {
    calls.push(new PlannedCall("POST /decisions", `${t.tool} for each unique valid person, in batches of up to ${size}`,
      batches, pricing.estimateDecision(n, config.with_reasoning)));
  }
  return calls;
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
    out[ext] = r !== undefined ? fromResult(r) : blank("error", { message: "The batch response has no answer for this person." });
  }
  return out;
}

// ----- rules -------------------------------------------------------------------------------------

/** True for a held work email graded Highly likely or Likely, false for none or a lower grade, null when unsaid. */
export function deliverableEmail(reachable: Json): boolean | null {
  const details = (reachable ?? {}).details;
  if (!isObj(details)) return null;
  const held = details.work_email_held;
  const grade = details.work_email_grade;
  if (held === false) return false;
  if (held === true && typeof grade === "string") return DELIVERABLE_GRADES.includes(grade);
  return null;
}

export function prioritise(a: Record<string, Json>, cfg: Json): [string, string] {
  const s = a.seniority.outcome;
  const d = a.department.outcome;
  const r = cfg.check_reachability ? a.reachable.outcome : "not_checked";
  const n = cfg.check_dnc ? a.dnc.outcome : "not_checked";
  const needed = ["seniority", "department", ...(cfg.check_reachability ? ["reachable"] : []), ...(cfg.check_dnc ? ["dnc"] : [])];
  const found = [...needed, ...(cfg.decision_maker ? ["decision_maker"] : [])].filter((k) => a[k].outcome === "not_found");
  if (found.length) {
    const code = (a[found[0]].answer_error ?? {}).code || "not_found";
    return ["not_found", `Firmable did not find this person (${code}).`];
  }
  const email = cfg.check_reachability ? deliverableEmail(a.reachable) : null;
  if (n === "yes" && email === false) {
    return ["exclude_dnc", "The mobile is on the Do Not Call register and Firmable holds no deliverable work email."];
  }
  const missing = needed.filter((k) => a[k].outcome === "error" || a[k].outcome === "not_asked").map((k) => CHECK_NAMES[k]);
  if (missing.length) return ["incomplete", `No answer for: ${missing.join(", ")}. The priority cannot be set.`];
  let base: [string, string];
  if (s === "yes" && d === "yes") {
    if (r === "yes") base = ["P1", "Seniority and department match, and the person is reachable."];
    else if (r === "unknown") base = ["P2", "Seniority and department match; reachability is unknown."];
    else if (r === "not_checked") base = ["P2", "Seniority and department match; reachability was not checked."];
    else base = ["P3", "Seniority and department match, but Firmable holds no reachable channel."];
  } else if (s === "yes" || d === "yes") {
    const [matched, other, otherAnswer] = s === "yes" ? ["seniority", "department", d] : ["department", "seniority", s];
    if (otherAnswer === "unknown") base = ["review", `The ${matched} matches; the ${other} is unknown, which blocks a higher priority.`];
    else base = ["P3", `Only the ${matched} matches.`];
  } else if (s === "unknown" || d === "unknown") {
    const unknown = [["seniority", s], ["department", d]].filter(([, v]) => v === "unknown").map(([name]) => name);
    base = ["review", `Unknown: ${unknown.join(", ")}. An unknown answer blocks a priority.`];
  } else {
    base = ["no_priority", "Neither the seniority nor the department matches."];
  }
  const ranked = ["P1", "P2", "P3"].includes(base[0]);
  if (ranked && n === "yes") {
    return ["review", `Would be ${base[0]}, but the mobile is on the Do Not Call register and a deliverable ` +
      "work email is held or not known. Check the channel before calling."];
  }
  if (base[0] === "P1" && n === "unknown") return ["review", "Would be P1, but the Do Not Call status is unknown, which blocks P1."];
  if (ranked) {
    const tail: Record<string, string> = {
      no: " The mobile is not on the Do Not Call register.",
      unknown: " The Do Not Call status is unknown.",
      not_checked: " The Do Not Call register was not checked.",
    };
    return [base[0], base[1] + tail[n]];
  }
  return base;
}

export async function run(ctx: RunContext): Promise<{ rows: Json[]; summary: Json; coverage: string[] }> {
  const cfg = ctx.config;
  const client = ctx.client;
  const tools = toolsOf(cfg);
  const coverage: string[] = [
    "The people come from your input file. This recipe does not search for people.",
    "An unknown answer means Firmable does not hold the fact. It is never counted as a no.",
    "Person answers are advisory: each is a fact to check, as at Firmable's last refresh, not a live check.",
    "The Do Not Call check covers Australian mobiles on the register as at Firmable's last refresh. It is not a " +
      "live register check and does not replace your own compliance process.",
    "A deliverable work email means is_reachable details show work_email_held true and a work_email_grade of " +
      "Highly likely or Likely, the grades is_email_valid treats as yes.",
    "Names and companies in the input are kept as given. They are not sent to the API.",
  ];
  if (cfg.decision_maker) coverage.push("is_decision_maker is shown beside each person. It does not change the priority.");
  const stopAll = (reason: string) => {
    const rows = ctx.rows.map((r) => ({ row_id: r.row_id, input: r, priority: "not_processed", reason }));
    return { rows, summary: { priority_counts: { not_processed: rows.length } }, coverage };
  };

  let catalogue: Json;
  try {
    catalogue = await client.listDecisionTools();
  } catch (e) {
    if (!(e instanceof FirmableError)) throw e;
    ctx.recordError(null, e);
    return stopAll("The decision tool list could not be read, so no questions were asked.");
  }
  const problems = decisions.checkTools(catalogue, tools, "person");
  const accepted = isObj(catalogue.accepted_values) ? catalogue.accepted_values : {};
  for (const [key, label] of [["target_seniorities", "seniorities"], ["target_departments", "departments"]]) {
    const allowed = accepted[label];
    if (Array.isArray(allowed)) {
      const bad = cfg[key].filter((v: string) => !allowed.includes(v));
      if (bad.length) problems.push(`${key} has label(s) that are not in the tool list's accepted ${label}: ${bad.join(", ")}.`);
    }
  }
  if (problems.length) {
    for (const p of problems) {
      ctx.errors.push({ row_id: null, kind: "config" as never, status: null, code: null, endpoint: "GET /decisions",
        message: p, charge_uncertain: false, retry_after: null });
    }
    coverage.push(...problems);
    return stopAll("The configuration names decision tools, inputs or labels the API does not accept.");
  }
  const modelTools = [...new Set<string>(tools.filter((t) => decisions.usesModel(catalogue, t.tool)).map((t) => t.tool))].sort();
  if (modelTools.length) {
    coverage.push(`These decision tools use a decision model inside Firmable's service: ${modelTools.join(", ")}. ` +
      "This code applies only the fixed priority rules.");
  }

  const keyed = ctx.rows.map((r) => {
    const [key, ident, problem] = subjectOf(r);
    return { row: r, key, ident, problem };
  });
  const dupes = findDuplicates(keyed.map((k) => ({ row_id: k.row.row_id, _key: k.key ?? "" })) as Row[], "_key");
  const nDupes = Object.keys(dupes).length;
  if (nDupes) coverage.push(`${nDupes} row(s) repeat an earlier person; they reuse that person's answers.`);
  const subjects = new Map<string, Json>();
  for (const k of keyed) {
    if (k.key && !subjects.has(k.key)) subjects.set(k.key, { ext: `subject-${subjects.size + 1}`, ident: k.ident, row_id: k.row.row_id });
  }
  const items = [...subjects.entries()];
  const answers: Record<string, Record<string, Json>> = {};
  for (const [key] of items) answers[key] = {};
  const size: number = cfg.batch_size;
  for (let start = 0; start < items.length; start += size) {
    const part = items.slice(start, start + size);
    const chunk: Chunk = part.map(([, s]) => [s.ext, s.ident, s.row_id]);
    for (const t of tools) {
      const got = await ask(ctx, t.tool, t.inputs, chunk, cfg.with_reasoning);
      for (const [key, s] of part) answers[key][t.key] = got[s.ext];
    }
  }

  const build = (k: Json): Json => {
    const row = k.row;
    const base: Json = { row_id: row.row_id, input: row, identifier_type: k.ident ? Object.keys(k.ident)[0] : null,
      name: row.name || null, company: row.company || null, duplicate_of: dupes[row.row_id] ?? null, answers: {},
      firmable_person_id: null, deliverable_work_email: null };
    if (k.problem) return { ...base, priority: "invalid_input", reason: k.problem };
    const a = answers[k.key];
    const full: Record<string, Json> = {};
    for (const t of CHECK_KEYS) full[t] = a[t] ?? blank("not_checked");
    if (Object.values(a).every((v) => v.outcome === "not_asked")) {
      const msg = ctx.stopped ? ctx.stopped.message : "the run stopped";
      return { ...base, answers: full, priority: "not_processed", reason: `Run stopped earlier: ${msg}` };
    }
    const [priority, reason] = prioritise(full, cfg);
    const pid = Object.values(full).find((v) => v.entity_id)?.entity_id ?? null;
    return { ...base, answers: full, priority, reason, firmable_person_id: pid,
      deliverable_work_email: cfg.check_reachability ? deliverableEmail(full.reachable) : null };
  };

  const rows = keyed.map(build);
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.priority] = (counts[r.priority] ?? 0) + 1;
  const ordered: Record<string, number> = {};
  for (const p of PRIORITY_ORDER) if (p in counts) ordered[p] = counts[p];
  return { rows, summary: { priority_counts: ordered }, coverage };
}

// ----- outputs -----------------------------------------------------------------------------------

export const CSV_COLUMNS = ["row_id", "name", "company", "identifier_type", "duplicate_of", "priority", "reason",
  "firmable_person_id", "seniority_match", "seniority", "department_match", "department", "reachable",
  "work_email_held", "work_email_grade", "deliverable_work_email", "mobile_on_dnc", "dnc_status", "decision_maker"];

const detail = (r: Json, key: string, field: string): unknown => {
  const details = ((r.answers ?? {})[key] ?? {}).details;
  return isObj(details) ? details[field] ?? null : null;
};
const outcomeOf = (r: Json, key: string): unknown => ((r.answers ?? {})[key] ?? {}).outcome ?? null;

export function csvRows(result: Json): Record<string, unknown>[] {
  return result.rows.map((r: Json) => ({
    row_id: r.row_id, name: r.name ?? null, company: r.company ?? null, identifier_type: r.identifier_type ?? null,
    duplicate_of: r.duplicate_of ?? null, priority: r.priority, reason: r.reason ?? null,
    firmable_person_id: r.firmable_person_id ?? null,
    seniority_match: outcomeOf(r, "seniority"), seniority: detail(r, "seniority", "seniority"),
    department_match: outcomeOf(r, "department"), department: detail(r, "department", "department"),
    reachable: outcomeOf(r, "reachable"), work_email_held: detail(r, "reachable", "work_email_held"),
    work_email_grade: detail(r, "reachable", "work_email_grade"),
    deliverable_work_email: r.deliverable_work_email ?? null, mobile_on_dnc: outcomeOf(r, "dnc"),
    dnc_status: detail(r, "dnc", "status"), decision_maker: outcomeOf(r, "decision_maker"),
  }));
}

export function render(report: Report, result: Json): void {
  const counts: Record<string, number> = result.summary.priority_counts ?? {};
  report.add("Result", "Call priorities",
    "<p>" + Object.entries(counts).map(([k, v]) => badge(`${k.replace(/_/g, " ")}: ${v}`, PRIORITY_TONE[k] ?? "neutral")).join(" ") + "</p>" +
    table(["Priority", "Rule"], [
      ["P1", "Seniority and department match, reachable, mobile not on Do Not Call (or not checked)."],
      ["P2", "Seniority and department match; reachability unknown or not checked."],
      ["P3", "Seniority and department match but not reachable, or only one of them matches."],
      ["review", "An unknown answer blocks a higher priority, or the mobile is on Do Not Call."],
      ["exclude_dnc", "Mobile on Do Not Call and no deliverable work email."],
      ["no_priority", "Neither seniority nor department matches."]]) +
    note("Unknown means Firmable does not hold the fact. It is never a no. Do Not Call answers are as at " +
      "Firmable's last refresh, not a live register check.", "unknown"));
  const sections: string[] = [];
  for (const p of PRIORITY_ORDER) {
    const group = result.rows.filter((r: Json) => r.priority === p);
    if (!group.length) continue;
    const cards: string[] = [];
    for (const r of group) {
      const title = r.name || r.firmable_person_id || r.row_id;
      let left = `<p>${esc(r.reason)}</p>` + kv([["Company (input)", r.company], ["Identifier used", r.identifier_type],
        ["Firmable person ID", r.firmable_person_id], ["Deliverable work email", r.deliverable_work_email]]);
      if (r.duplicate_of) left += note(`Same person as row ${esc(r.duplicate_of)}; answers were reused.`, "info");
      const answers: Record<string, Json> = r.answers ?? {};
      let right = "";
      if (Object.keys(answers).length) {
        right += table(["Check", "Answer", "Details as returned"], Object.entries(answers).map(([k, v]) => [
          CHECK_NAMES[k], new Raw(badge(v.outcome.replace(/_/g, " "), OUTCOME_TONE[v.outcome] ?? "neutral")),
          v.details && (!isObj(v.details) || Object.keys(v.details).length) ? v.details : (v.error || v.answer_error || {}).message]));
        for (const [k, v] of Object.entries(answers)) {
          const rs = v.reasoning ?? {};
          if (rs.reason) {
            right += `<p><strong>${esc(CHECK_NAMES[k])}:</strong> ${esc(rs.reason)}</p>` +
              `<p class="muted">Source: ${esc(rs.source)}. Last refreshed: ${esc(rs.last_refreshed)}.</p>`;
          }
        }
        right += detailsJson("Answers as JSON", answers);
      }
      cards.push(card(String(title), badge(p.replace(/_/g, " "), PRIORITY_TONE[p] ?? "neutral"), left,
        right || '<p class="muted">No questions were asked for this row.</p>', `Row ${r.row_id}`));
    }
    sections.push(`<h3>${esc(p.replace(/_/g, " "))} (${group.length})</h3>` + cards.join(""));
  }
  report.add("People", "Each person by priority", sections.join(""));
}

export const RECIPE: Recipe = {
  name: NAME, title: TITLE, description: DESCRIPTION, loadConfig, readInput, plan, run,
  csvColumns: CSV_COLUMNS, csvRows, render,
};
