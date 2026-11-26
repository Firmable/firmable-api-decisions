/**
 * Company fact brief: what Firmable holds about one company, stated as checkable facts.
 * Mirrors recipes/company-fact-brief/python/src/company_fact_brief/recipe.py; see that file and the
 * recipe README for the workflow and the answer outcomes.
 */
import { basename } from "node:path";
import {
  ConfigError, FirmableError, InputError, Json, NotFoundError, PlannedCall, Raw, Recipe, Report, RunContext, Row,
  badge, bulletList, card, decisions, detailsJson, esc, findDuplicates, kv, link, normaliseDomain, note, pricing,
  pyRepr, readRows, table,
} from "firmable-api-client";

export const NAME = "company-fact-brief";
export const TITLE = "Company fact brief";
export const DESCRIPTION = "Writes a Markdown brief for each company: profile facts from Firmable, then each configured " +
  "Decisions question with its answer, reason, source and dates as returned.";

export const MAX_ROWS = 25;
const ID = /^[a-z0-9_]{1,40}$/;
const COMPANY_ID = /^f\d{12}$/;
const TOP_KEYS = new Set(["questions", "with_reasoning", "fetch_company", "batch_size"]);
const QUESTION_KEYS = new Set(["id", "label", "tool", "inputs"]);
const OUTCOMES = ["yes", "no", "unknown", "not_found", "error", "not_asked"];
const STATUS_TONE: Record<string, string> = {
  brief_ready: "good", partial: "review", company_not_found: "unknown", invalid_input: "error", error: "error",
  not_processed: "unknown",
};
const OUTCOME_TONE: Record<string, string> = {
  yes: "good", no: "bad", unknown: "unknown", not_found: "unknown", error: "error", not_asked: "neutral",
};
const PROFILE_FIELDS = ["id", "name", "website", "fqdn", "hq_country", "company_size", "industries", "year_founded",
  "company_type"];
const INTERPRETATION = [
  "Yes and no are Firmable's answers to the question as asked, from Firmable data as of the last refreshed " +
    "date shown.",
  "Unknown means Firmable does not hold the fact needed to answer. It is not a no.",
  "Not found means Firmable could not match the company for that question.",
  "Error and not asked mean no answer came back. They say nothing about the company.",
  "Some decision tools use a decision model inside Firmable's service. This brief adds no model of its own and " +
    "no narrative: every sentence above the Interpretation section is a returned value or fixed text.",
];

const isObj = (x: unknown): x is Record<string, any> => !!x && typeof x === "object" && !Array.isArray(x);
const isInt = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x);

// ----- configuration and input -------------------------------------------------------------------

export function loadConfig(raw: Json): Json {
  const unknown = Object.keys(raw).filter((k) => !TOP_KEYS.has(k)).sort();
  if (unknown.length) throw new ConfigError(`Unknown configuration key(s): ${unknown.join(", ")}`);
  const qs = raw.questions;
  if (!Array.isArray(qs) || qs.length < 1 || qs.length > 10) throw new ConfigError("questions must be a list of 1 to 10 questions.");
  const questions: Json[] = [];
  const seen = new Set<string>();
  qs.forEach((q: Json, idx: number) => {
    const i = idx + 1;
    if (!isObj(q)) throw new ConfigError(`questions[${i}] must be an object.`);
    const extra = Object.keys(q).filter((k) => !QUESTION_KEYS.has(k)).sort();
    if (extra.length) throw new ConfigError(`questions[${i}] has unknown key(s): ${extra.join(", ")}`);
    const qid = q.id;
    if (typeof qid !== "string" || !ID.test(qid)) throw new ConfigError(`questions[${i}].id must be 1 to 40 lower-case letters, digits or underscores.`);
    if (seen.has(qid)) throw new ConfigError(`questions[${i}].id ${pyRepr(qid)} is used twice.`);
    seen.add(qid);
    const tool = q.tool;
    if (typeof tool !== "string" || !tool) throw new ConfigError(`questions[${i}].tool must name a decision tool.`);
    const inputs = q.inputs ?? {};
    if (!isObj(inputs)) throw new ConfigError(`questions[${i}].inputs must be an object.`);
    const label = q.label ?? qid;
    if (typeof label !== "string" || !label.trim()) throw new ConfigError(`questions[${i}].label must be text.`);
    questions.push({ id: qid, label, tool, inputs });
  });
  for (const key of ["with_reasoning", "fetch_company"]) {
    if (typeof (raw[key] ?? true) !== "boolean") throw new ConfigError(`${key} must be true or false.`);
  }
  const bs = raw.batch_size ?? 100;
  if (!isInt(bs) || bs < 1 || bs > 100) throw new ConfigError("batch_size must be a whole number from 1 to 100.");
  return { questions, with_reasoning: raw.with_reasoning ?? true, fetch_company: raw.fetch_company ?? true, batch_size: bs };
}

export function readInput(path: string): Row[] {
  const rows = readRows(path, { anyOf: ["domain", "company_id"] });
  if (rows.length > MAX_ROWS) {
    throw new InputError(`${basename(path)} has ${rows.length} rows; this recipe takes up to ${MAX_ROWS} companies.`);
  }
  return rows;
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

const batches = (n: number, size: number): number => Math.floor((n + size - 1) / size);

export function plan(rows: Row[], config: Json): PlannedCall[] {
  const n = uniqueSubjects(rows).length;
  const q = config.questions.length;
  const calls = [new PlannedCall("GET /decisions", "Read the decision tool list and check the configured questions", 1, [])];
  if (config.fetch_company) {
    calls.push(new PlannedCall("GET /company", "Company profile for each unique valid company", n,
      [["company", pricing.round4(pricing.COMPANY_PROFILE * n)]]));
  }
  calls.push(new PlannedCall("POST /decisions",
    `${q} question(s) for each unique valid company, in batches of up to ${config.batch_size}`,
    q * batches(n, config.batch_size), pricing.estimateDecision(n * q, config.with_reasoning)));
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
    out[ext] = r !== undefined ? fromResult(r) : blank("error", { message: "The batch response has no answer for this company." });
  }
  return out;
}

// ----- workflow ----------------------------------------------------------------------------------

function conflicts(company: Json, answers: Json[]): string[] {
  if (!company) return [];
  const out: string[] = [];
  const founded = company.year_founded;
  const years = [...new Set(answers.filter((a) => typeof a.answered_at === "string" && /^\d{4}/.test(a.answered_at))
    .map((a) => a.answered_at.slice(0, 4) as string))].sort();
  if (isInt(founded) && years.length && founded > Number(years[years.length - 1])) {
    out.push(`The profile field year_founded is ${founded}, which is later than the year the answers ` +
      `were made (${years[years.length - 1]}).`);
  }
  const ctype = company.company_type;
  if (typeof ctype === "string") {
    const low = ctype.toLowerCase();
    for (const a of answers) {
      if (a.tool !== "is_publicly_listed") continue;
      if (a.outcome === "yes" && low.includes("private")) {
        out.push(`The question "${a.label}" answered yes, but the profile field company_type is "${ctype}".`);
      }
      if (a.outcome === "no" && low.includes("public company")) {
        out.push(`The question "${a.label}" answered no, but the profile field company_type is "${ctype}".`);
      }
    }
  }
  return out;
}

function statusOf(answers: Json[], fetched: boolean): [string, string] {
  const counts: Record<string, number> = {};
  for (const o of OUTCOMES) counts[o] = answers.filter((a) => a.outcome === o).length;
  const n = answers.length;
  const answered = counts.yes + counts.no + counts.unknown;
  if (counts.not_asked === n) return ["not_processed", "The run stopped before any question was asked for this company."];
  if (!fetched && counts.not_found === n) return ["company_not_found", "Firmable did not match this company for any question."];
  const summary = `${counts.yes} yes, ${counts.no} no, ${counts.unknown} unknown of ${n} question(s).`;
  if (answered === n) return ["brief_ready", summary];
  return ["partial", `${summary} ${n - answered} question(s) have no answer (error, not found or not asked).`];
}

export async function run(ctx: RunContext): Promise<{ rows: Json[]; summary: Json; coverage: string[] }> {
  const cfg = ctx.config;
  const client = ctx.client;
  const questions: Json[] = cfg.questions;
  const coverage: string[] = [
    "The companies come from your input file. The REST API has no general company search.",
    "An unknown answer means Firmable does not hold the fact. It is never counted as a no.",
    "Answers describe each company as Firmable holds it on the last refreshed date. They are not a live check.",
  ];
  const stopAll = (reason: string) => {
    const rows = ctx.rows.map((r) => ({ row_id: r.row_id, input: r, status: "not_processed", reason }));
    return { rows, summary: { status_counts: { not_processed: rows.length }, question_counts: {} }, coverage };
  };

  let catalogue: Json;
  try {
    catalogue = await client.listDecisionTools();
  } catch (e) {
    if (!(e instanceof FirmableError)) throw e;
    ctx.recordError(null, e);
    return stopAll("The decision tool list could not be read, so no questions were asked.");
  }
  const problems = decisions.checkTools(catalogue, questions, "company");
  if (problems.length) {
    for (const p of problems) {
      ctx.errors.push({ row_id: null, kind: "config" as never, status: null, code: null, endpoint: "GET /decisions",
        message: p, charge_uncertain: false, retry_after: null });
    }
    coverage.push(...problems);
    return stopAll("The configuration names decision tools or inputs the API does not accept.");
  }
  const modelTools = [...new Set<string>(questions.filter((q) => decisions.usesModel(catalogue, q.tool)).map((q) => q.tool))].sort();
  if (modelTools.length) {
    coverage.push(`These decision tools use a decision model inside Firmable's service: ${modelTools.join(", ")}. ` +
      "This code adds no model of its own.");
  }
  if (!cfg.fetch_company) coverage.push("Company profiles were not fetched (fetch_company is false), so briefs have no profile facts.");
  if (!cfg.with_reasoning) {
    coverage.push("Reasoning was not requested (with_reasoning is false), so briefs show no reason, source or dates.");
  }

  const keyed = ctx.rows.map((r) => {
    const [key, ident, problem] = subjectOf(r);
    return { row: r, key, ident, problem };
  });
  const dupes = findDuplicates(keyed.map((k) => ({ row_id: k.row.row_id, _key: k.key ?? "" })) as Row[], "_key");
  const nDupes = Object.keys(dupes).length;
  if (nDupes) coverage.push(`${nDupes} row(s) repeat an earlier company; they reuse its answers and its brief.`);
  const subjects = new Map<string, Json>();
  for (const k of keyed) {
    if (k.key && !subjects.has(k.key)) {
      subjects.set(k.key, { ext: `subject-${subjects.size + 1}`, ident: k.ident, row_id: k.row.row_id, company: null,
        company_error: null, not_found: false, asked: false });
    }
  }

  if (cfg.fetch_company) {
    for (const s of subjects.values()) {
      if (ctx.stopped !== null) break;
      const query: Record<string, string> = "company_id" in s.ident ? { id: s.ident.company_id } : { fqdn: s.ident.domain };
      try {
        s.company = await client.getCompany(query);
      } catch (e) {
        if (e instanceof NotFoundError) { s.not_found = true; continue; }
        if (!(e instanceof FirmableError)) throw e;
        s.company_error = ctx.recordError(s.row_id, e);
      }
    }
  }

  const askable = [...subjects.entries()].filter(([, s]) => !s.not_found && s.company_error === null &&
    (s.company !== null || !cfg.fetch_company));
  const answers: Record<string, Record<string, Json>> = {};
  for (const [key] of askable) answers[key] = {};
  const size: number = cfg.batch_size;
  for (let start = 0; start < askable.length; start += size) {
    const part = askable.slice(start, start + size);
    const chunk: Chunk = part.map(([, s]) => {
      s.asked = true;
      return [s.ext, s.company ? { company_id: s.company.id } : s.ident, s.row_id];
    });
    for (const q of questions) {
      const got = await ask(ctx, q.tool, q.inputs, chunk, cfg.with_reasoning);
      for (const [key, s] of part) answers[key][q.id] = got[s.ext];
    }
  }

  const stoppedMsg = (fallback: string) => `Run stopped earlier: ${ctx.stopped ? ctx.stopped.message : fallback}`;
  const build = (k: Json): Json => {
    const row = k.row;
    const base: Json = { row_id: row.row_id, input: row, subject: k.ident, duplicate_of: dupes[row.row_id] ?? null,
      company: null, answers: [], conflicts: [], brief_file: null };
    if (k.problem) return { ...base, status: "invalid_input", status_reason: k.problem };
    const s = subjects.get(k.key)!;
    if (s.not_found) {
      return { ...base, status: "company_not_found",
        status_reason: "Firmable has no company profile for this identifier, so no questions were asked." };
    }
    if (s.company_error !== null) {
      return { ...base, status: "error", error: s.company_error,
        status_reason: `The company profile could not be read: ${s.company_error.message}` };
    }
    if (cfg.fetch_company && s.company === null) return { ...base, status: "not_processed", reason: stoppedMsg("no profile") };
    const company = s.company ? Object.fromEntries(PROFILE_FIELDS.map((f) => [f, s.company[f] ?? null])) : null;
    const got = answers[k.key] ?? {};
    const rowAnswers = questions.map((q) => ({ question_id: q.id, label: q.label, tool: q.tool, inputs: q.inputs,
      ...(got[q.id] ?? blank("not_asked")) }));
    const [status, reason] = statusOf(rowAnswers, cfg.fetch_company);
    if (status === "not_processed") {
      return { ...base, company, answers: rowAnswers, status, reason: stoppedMsg(reason) };
    }
    const brief = status === "brief_ready" || status === "partial" ? `brief-${s.row_id}.md` : null;
    return { ...base, company, answers: rowAnswers, status, status_reason: reason,
      conflicts: conflicts(company, rowAnswers), brief_file: brief };
  };

  const rows = keyed.map(build);
  if (rows.some((r) => (r.conflicts ?? []).length)) {
    coverage.push("Some profile facts contradict an answer. The brief lists them under Possible conflicts and " +
      "does not correct Firmable's data.");
  }
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1;
  const qcounts: Record<string, Record<string, number>> = {};
  for (const q of questions) qcounts[q.id] = Object.fromEntries(OUTCOMES.map((o) => [o, 0]));
  for (const r of rows) {
    if (r.duplicate_of) continue;
    for (const a of r.answers ?? []) qcounts[a.question_id][a.outcome] += 1;
  }
  return { rows, summary: { status_counts: counts, question_counts: qcounts }, coverage };
}

// ----- outputs -----------------------------------------------------------------------------------

export function csvColumns(result: Json): string[] {
  const qids: string[] = result.input.config.questions.map((q: Json) => q.id);
  return ["row_id", "domain", "company_id", "duplicate_of", "status", "status_reason", "company_name",
    "answers_yes", "answers_no", "answers_unknown", "answers_missing", "brief_file", ...qids.map((q) => `q_${q}`)];
}

export function csvRows(result: Json): Record<string, unknown>[] {
  return result.rows.map((r: Json) => {
    const answers: Json[] = r.answers ?? [];
    const company = r.company ?? {};
    const subject = r.subject ?? {};
    const row: Record<string, unknown> = {
      row_id: r.row_id, domain: subject.domain || r.input.domain || null,
      company_id: company.id || subject.company_id || null, duplicate_of: r.duplicate_of ?? null, status: r.status,
      status_reason: r.status_reason || r.reason || (r.error ?? {}).message || null,
      company_name: company.name || r.input.company_name || null,
      answers_yes: answers.filter((a) => a.outcome === "yes").length,
      answers_no: answers.filter((a) => a.outcome === "no").length,
      answers_unknown: answers.filter((a) => a.outcome === "unknown").length,
      answers_missing: answers.filter((a) => !["yes", "no", "unknown"].includes(a.outcome)).length,
      brief_file: r.brief_file ?? null,
    };
    for (const a of answers) row[`q_${a.question_id}`] = a.outcome;
    return row;
  });
}

const MD_SPECIAL = new Set("\\`*_[]<>|".split(""));
const MD_URL = /^https?:\/\/[^\s()<>[\]]+$/i;

/** Plain text for a returned value, the same in Python and TypeScript. */
export function textOf(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (Array.isArray(v)) return v.map(textOf).join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** Escapes a value for Markdown: \ ` * _ [ ] < > | and a leading #. Line breaks become spaces. */
export function md(v: unknown, empty = "not returned"): string {
  let s = textOf(v);
  if (s === "") return empty;
  s = s.replace(/\r\n/g, " ").replace(/\n/g, " ").replace(/\r/g, " ");
  const out = [...s].map((ch) => (MD_SPECIAL.has(ch) ? "\\" + ch : ch)).join("");
  return out.startsWith("#") ? "\\" + out : out;
}

export function mdLink(url: unknown, text?: unknown): string {
  const label = md(text !== undefined ? text : url);
  if (typeof url === "string" && MD_URL.test(url.trim())) return `[${label}](${url.trim()})`;
  return label;
}

const outcomeText = (o: string): string => o.replace(/_/g, " ");

function rsCell(rs: unknown, key: string, empty: string): string {
  if (!isObj(rs)) return empty;
  if (rs[key] === null || rs[key] === undefined) return key in rs ? "none" : "not returned";
  return md(rs[key]);
}

function brief(r: Json, cfg: Json): string {
  const company = r.company;
  const subject = r.subject ?? {};
  const title = company?.name || subject.domain || subject.company_id || r.row_id;
  const lines: string[] = [`# Company fact brief: ${md(title)}`, "",
    `Input row ${md(r.row_id)}. Every value below is returned by the Firmable API or is fixed text in ` +
      "this recipe.", ""];
  lines.push("## Profile facts", "");
  if (company) {
    lines.push("From GET /company, with the API field names.", "", "| Field | Value |", "| - | - |");
    for (const f of PROFILE_FIELDS) {
      const v = company[f];
      const val = f === "website" && v ? mdLink(v) : md(v);
      lines.push(`| ${md(f)} | ${val} |`);
    }
  } else {
    lines.push("The profile was not fetched (fetch_company is false).");
  }
  lines.push("", "## Answers", "");
  const reasonEmpty = cfg.with_reasoning ? "not returned" : "not requested";
  lines.push("| Question | Tool | Answer | Reason as returned | Source | Fact date | Last refreshed |",
    "| - | - | - | - | - | - | - |");
  for (const a of r.answers) {
    const cells = ["reason", "source", "fact_date", "last_refreshed"].map((k) => rsCell(a.reasoning, k, reasonEmpty)).join(" | ");
    lines.push(`| ${md(a.label)} | ${md(a.tool)} | ${md(outcomeText(a.outcome))} | ${cells} |`);
  }
  const detailed = r.answers.filter((a: Json) => isObj(a.details) && Object.keys(a.details).length);
  if (detailed.length) {
    lines.push("", "### Details as returned", "");
    for (const a of detailed) {
      const parts = Object.entries(a.details).map(([k, v]) => `${md(k)}: ${md(v)}`).join("; ");
      lines.push(`- ${md(a.label)}: ${parts}`);
    }
  }
  lines.push("", "## What is unknown", "");
  const unknown = r.answers.filter((a: Json) => a.outcome === "unknown");
  if (unknown.length) {
    lines.push("Firmable does not hold these facts. An unknown answer is not a no.", "");
    for (const a of unknown) lines.push(`- ${md(a.label)}: Firmable does not hold this fact.`);
  } else {
    lines.push("No question answered unknown.");
  }
  const missing = r.answers.filter((a: Json) => ["not_found", "error", "not_asked"].includes(a.outcome));
  if (missing.length) {
    lines.push("", "## Not answered", "", "These questions have no answer. This says nothing about the company.", "");
    for (const a of missing) {
      let why: string;
      if (a.outcome === "not_asked") why = "not asked, because the run stopped first.";
      else if (a.outcome === "not_found") why = `not found (${md((a.answer_error ?? {}).code)}).`;
      else {
        const err = a.error || a.answer_error || {};
        why = `error: ${md(isObj(err) ? err.message : err)}`;
      }
      lines.push(`- ${md(a.label)}: ${why}`);
    }
  }
  if ((r.conflicts ?? []).length) {
    lines.push("", "## Possible conflicts", "",
      "These returned facts contradict each other. This brief shows both and does not correct them.", "");
    for (const c of r.conflicts) lines.push(`- ${md(c)}`);
  }
  lines.push("", "## Interpretation", "", ...INTERPRETATION.map((t) => `- ${t}`), "");
  return lines.join("\n");
}

export function markdown(result: Json): Record<string, string> {
  const cfg = result.input.config;
  const out: Record<string, string> = {};
  for (const r of result.rows) if (r.brief_file && !r.duplicate_of) out[r.brief_file] = brief(r, cfg);
  return out;
}

export function render(report: Report, result: Json): void {
  const cfg = result.input.config;
  const counts: Record<string, number> = result.summary.status_counts ?? {};
  report.add("Result", "Brief summary",
    "<p>" + Object.entries(counts).map(([k, v]) => badge(`${k.replace(/_/g, " ")}: ${v}`, STATUS_TONE[k] ?? "neutral")).join(" ") + "</p>" +
    note("Unknown means Firmable does not hold the fact. It is never a no.", "unknown"));
  const cards: string[] = [];
  for (const r of result.rows) {
    const status: string = r.status;
    const company = r.company ?? {};
    const subject = r.subject ?? {};
    const title = company.name || subject.domain || subject.company_id || r.row_id;
    const reason = r.status_reason || r.reason || r.error?.message || "";
    let left = `<p>${esc(reason)}</p>`;
    if (r.company) {
      left += kv(PROFILE_FIELDS.map((f): [string, unknown] => {
        const v = company[f];
        if (f === "website" && v) return [f, new Raw(link(v))];
        return [f, Array.isArray(v) ? v.join(", ") : v];
      }));
    }
    if (r.duplicate_of) left += note(`Same company as row ${esc(r.duplicate_of)}; its answers and brief were reused.`, "info");
    if (r.brief_file) left += `<p class="muted">Markdown brief: ${esc(r.brief_file)}</p>`;
    let right = "";
    const answers: Json[] = r.answers ?? [];
    if (answers.length) {
      const empty = cfg.with_reasoning ? "not returned" : "not requested";
      right += table(["Question", "Answer", "Reason as returned", "Source", "Fact date", "Last refreshed"], answers.map((a) => [
        a.label, new Raw(badge(outcomeText(a.outcome), OUTCOME_TONE[a.outcome] ?? "neutral")),
        a.reasoning?.reason || empty, a.reasoning?.source || empty, a.reasoning?.fact_date || empty,
        a.reasoning?.last_refreshed || empty]));
      const unknown = answers.filter((a) => a.outcome === "unknown").map((a) => a.label);
      right += "<h3>What is unknown</h3>" + (unknown.length
        ? bulletList(unknown.map((u) => `${u}: Firmable does not hold this fact.`))
        : "<p>No question answered unknown.</p>");
      for (const a of answers) {
        const err = a.error || a.answer_error;
        if ((a.outcome === "error" || a.outcome === "not_found") && err) {
          right += note(`${esc(a.label)}: ${esc(isObj(err) ? err.message : err)}`, a.outcome === "error" ? "error" : "unknown");
        }
      }
    }
    if ((r.conflicts ?? []).length) right += "<h3>Possible conflicts</h3>" + bulletList(r.conflicts);
    if (answers.length) {
      right += "<h3>Interpretation</h3>" + note(bulletList(INTERPRETATION), "info");
      right += detailsJson("Answers as JSON", answers);
    }
    cards.push(card(String(title), badge(status.replace(/_/g, " "), STATUS_TONE[status] ?? "neutral"), left,
      right || '<p class="muted">No questions were asked for this row.</p>', `Row ${r.row_id}`));
  }
  report.add("Companies", "Each company with its facts", cards.join(""));
}

export const RECIPE: Recipe = {
  name: NAME, title: TITLE, description: DESCRIPTION, loadConfig, readInput, plan, run,
  csvColumns, csvRows, render, markdown,
};
