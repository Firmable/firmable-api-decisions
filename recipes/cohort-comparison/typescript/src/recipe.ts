/**
 * Cohort comparison: asks the same Decisions company questions of two cohorts and compares them.
 * Mirrors recipes/cohort-comparison/python/src/cohort_comparison/recipe.py; see that file and the
 * recipe README for the workflow and the measure rules.
 */
import { basename } from "node:path";
import {
  ConfigError, FirmableError, InputError, InvalidResponseError, Json, PlannedCall, Raw, Recipe, Report, RunContext,
  Row, badge, decisions, detailsJson, esc, normaliseDomain, note, pricing, pyRepr, readRows, table,
} from "firmable-api-client";

export const NAME = "cohort-comparison";
export const TITLE = "Cohort comparison";
export const DESCRIPTION = "Asks the same Firmable Decisions company questions of two cohorts you supply, and shows both " +
  "cohorts' answers side by side with the difference in yes share where both have enough answers.";

export const ANSWERS = ["yes", "no", "unknown", "error", "not_found", "not_asked"];
const STATUS_TONE: Record<string, string> = {
  answered: "good", incomplete: "review", not_found: "review", invalid_input: "error", not_processed: "unknown", ignored: "neutral",
};
export const BASE_COLUMNS = ["row_id", "domain", "company_id", "company_name", "cohort", "in_both_cohorts", "status",
  "status_reason", "duplicate_of", "firmable_id"];
export const FIXED_NOTE = "Differences describe these two cohorts only. They are not tested for statistical significance and " +
  "do not describe a market, sector or population.";
const ID = /^[a-z0-9_]{1,40}$/;
const COMPANY_ID = /^f\d{12}$/;
const TOP_KEYS = new Set(["cohorts", "questions", "with_reasoning", "batch_size", "min_answered"]);
const QUESTION_KEYS = new Set(["id", "label", "tool", "inputs"]);

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const whole = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x);
/** Python truthiness for values that come back from the API. */
const truthy = (x: unknown): boolean => {
  if (x === null || x === undefined || x === false || x === 0 || x === "") return false;
  if (Array.isArray(x)) return x.length > 0;
  if (typeof x === "object") return Object.keys(x as object).length > 0;
  return true;
};

/** Escapes Markdown special characters in text from the API, the input or the configuration. */
export function mdEscape(value: unknown): string {
  let s = value === null || value === undefined ? "" : String(value);
  s = s.replace(/[\r\n]+/g, " ").replace(/([\\`*_[\]<>|])/g, "\\$1");
  return s.startsWith("#") ? "\\" + s : s;
}

export function loadConfig(raw: Json): Json {
  const unknown = Object.keys(raw).filter((k) => !TOP_KEYS.has(k)).sort();
  if (unknown.length) throw new ConfigError(`Unknown configuration key(s): ${unknown.join(", ")}`);
  let cohorts = raw.cohorts;
  if (!Array.isArray(cohorts) || cohorts.length !== 2 || !cohorts.every((c) => typeof c === "string" && c.trim())) {
    throw new ConfigError("cohorts must list exactly two cohort values, as text.");
  }
  cohorts = cohorts.map((c: string) => c.trim());
  if (cohorts[0] === cohorts[1]) throw new ConfigError("cohorts must name two different values.");
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
    if (BASE_COLUMNS.includes(qid)) throw new ConfigError(`questions[${i}].id ${pyRepr(qid)} is reserved for an output column.`);
    seen.add(qid);
    const tool = q.tool;
    if (typeof tool !== "string" || !tool) throw new ConfigError(`questions[${i}].tool must name a decision tool.`);
    const inputs = q.inputs ?? {};
    if (!isObj(inputs)) throw new ConfigError(`questions[${i}].inputs must be an object.`);
    const subject = Object.keys(inputs).filter((k) => decisions.SUBJECT_KEYS.has(k)).sort();
    if (subject.length) throw new ConfigError(`questions[${i}].inputs must not include ${subject.join(", ")}; the recipe adds each company.`);
    const label = q.label ?? qid;
    if (typeof label !== "string" || !label) throw new ConfigError(`questions[${i}].label must be text.`);
    questions.push({ id: qid, label, tool, inputs });
  });
  const wr = raw.with_reasoning ?? false;
  if (typeof wr !== "boolean") throw new ConfigError("with_reasoning must be true or false.");
  const bs = raw.batch_size ?? 100;
  if (!whole(bs) || bs < 1 || bs > 100) throw new ConfigError("batch_size must be a whole number from 1 to 100.");
  const ma = raw.min_answered ?? 5;
  if (!whole(ma) || ma < 1) throw new ConfigError("min_answered must be a whole number, 1 or more.");
  return { cohorts, questions, with_reasoning: wr, batch_size: bs, min_answered: ma };
}

export function readInput(path: string): Row[] {
  const rows = readRows(path, { anyOf: ["domain", "company_id"] });
  if (!rows.some((r) => "cohort" in r)) throw new InputError(`${basename(path)} is missing column(s): cohort`);
  return rows;
}

/** The company a row names, or the reason it names none. company_id wins over domain. */
function subjectOf(row: Row): [Record<string, string> | null, string | null] {
  const cid = row.company_id || "";
  if (cid) {
    if (!COMPANY_ID.test(cid)) return [null, `${pyRepr(cid)} is not a Firmable company ID (f followed by 12 digits).`];
    return [{ company_id: cid }, null];
  }
  const raw = row.domain || "";
  const d = normaliseDomain(raw);
  if (!d) return [null, `${pyRepr(raw)} is not a valid domain.`];
  return [{ domain: d }, null];
}

const keyOf = (subject: Record<string, string>): string => {
  const k = Object.keys(subject)[0];
  return `${k}:${subject[k]}`;
};

/** Unique valid companies in either compared cohort, in order of first appearance. */
function companiesOf(rows: Row[], cohorts: string[]): Json[] {
  const out: Json[] = [];
  const index = new Map<string, Json>();
  for (const r of rows) {
    if (!cohorts.includes(r.cohort || "")) continue;
    const [subject] = subjectOf(r);
    if (subject === null) continue;
    const k = keyOf(subject);
    if (!index.has(k)) {
      const c = { key: k, subject, ext: `c-${out.length + 1}`, row_ids: [] as string[], cohorts: [] as string[] };
      index.set(k, c);
      out.push(c);
    }
    const c = index.get(k);
    c.row_ids.push(r.row_id);
    if (!c.cohorts.includes(r.cohort)) c.cohorts.push(r.cohort);
  }
  return out;
}

export function plan(rows: Row[], config: Json): PlannedCall[] {
  const n = companiesOf(rows, config.cohorts).length;
  const q = config.questions.length;
  const b = config.batch_size;
  const batches = Math.ceil(n / b);
  return [
    new PlannedCall("GET /decisions", "Read the decision tool list and check each question's tool and inputs", 1, []),
    new PlannedCall("POST /decisions", `${q} question(s) for ${n} unique valid company(ies) in the two cohorts, in batches of up to ${b}`,
      q * batches, pricing.estimateDecision(n * q, config.with_reasoning)),
  ];
}

/** num / den x 1000, rounded half away from zero to a whole number, computed with whole numbers. */
function tenthsOf(num: number, den: number): number {
  const t = Math.floor((2000 * Math.abs(num) + den) / (2 * den));
  return num < 0 ? -t : t;
}

function pct(part: number, wholeN: number): [number, string] {
  const t = tenthsOf(part, wholeN);
  return [t / 10, `${Math.floor(t / 10)}.${t % 10}`];
}

export function measure(keys: string[], answers: Record<string, Record<string, Json>>, qid: string, minAnswered: number): Json {
  const counts: Record<string, number> = {};
  for (const a of ANSWERS) counts[a] = 0;
  for (const k of keys) counts[answers[k][qid].answer] += 1;
  const n = keys.length;
  const asked = n - counts.not_asked;
  const answered = counts.yes + counts.no;
  const enough = answered >= minAnswered;
  const block: Json = { companies_in_cohort: n, companies_asked: asked, ...counts, answered, enough_answers: enough };
  if (enough) {
    const [value, text] = pct(counts.yes, answered);
    block.yes_share_pct = value;
    block.yes_share = `${counts.yes} of ${answered} answered (${text}%)`;
  } else {
    block.yes_share_pct = null;
    block.yes_share = `too few answers to compare (${answered} answered, minimum ${minAnswered})`;
  }
  if (asked) {
    const [value, text] = pct(counts.unknown, asked);
    block.unknown_share_pct = value;
    block.unknown_share = `${counts.unknown} of ${asked} asked (${text}%)`;
  } else {
    block.unknown_share_pct = null;
    block.unknown_share = "no companies asked";
  }
  return block;
}

export function difference(a: Json, b: Json, names: string[], minAnswered: number): Json {
  if (!(a.enough_answers && b.enough_answers)) {
    return { comparable: false, yes_share_difference_pp: null,
      text: `too few answers to compare (${names[0]}: ${a.answered} answered, ${names[1]}: ${b.answered} answered, minimum ${minAnswered})` };
  }
  const t = tenthsOf(a.yes * b.answered - b.yes * a.answered, a.answered * b.answered);
  const sign = t > 0 ? "+" : t < 0 ? "-" : "";
  const abs = Math.abs(t);
  return { comparable: true, yes_share_difference_pp: t / 10,
    text: `${sign}${Math.floor(abs / 10)}.${abs % 10} percentage points (${names[0]} minus ${names[1]})` };
}

function record(qid: string, resp: Json): Json {
  const ans = decisions.answerFrom(resp);
  const err = resp.error;
  let outcome: string;
  if (ans.answer === "yes" || ans.answer === "no" || ans.answer === "unknown") {
    outcome = ans.answer;
  } else {
    const code = isObj(err) ? err.code : null;
    outcome = typeof code === "string" && code.endsWith("not_found") ? "not_found" : "error";
  }
  return {
    question_id: qid, answer: outcome, decision: ans.answer, confidence: ans.confidence, details: ans.details,
    reasoning: ans.reasoning, answered_at: ans.answered_at, credits: ans.credits, error: truthy(err) ? err : null,
    entity_id: ans.entity_id, request_id: ans.request_id,
  };
}

function empty(qid: string, outcome: string, error: Json = null): Json {
  return { question_id: qid, answer: outcome, decision: null, confidence: null, details: null, reasoning: null,
    answered_at: null, credits: null, error, entity_id: null, request_id: null };
}

function errorText(err: Json): string {
  if (isObj(err)) return String(err.message || err.code || "error");
  return String(err);
}

/** Asks every question for every company in batches. Returns answers[company_key][question_id]. */
export async function askAll(ctx: RunContext, questions: Json[], companies: Json[], batchSize: number,
  withReasoning: boolean): Promise<Record<string, Record<string, Json>>> {
  const answers: Record<string, Record<string, Json>> = {};
  for (const c of companies) answers[c.key] = {};
  for (const q of questions) {
    const qid = q.id;
    for (let start = 0; start < companies.length; start += batchSize) {
      const chunk = companies.slice(start, start + batchSize);
      const batchNo = Math.floor(start / batchSize) + 1;
      if (ctx.stopped !== null) {
        for (const c of chunk) answers[c.key][qid] = empty(qid, "not_asked");
        continue;
      }
      const records = chunk.map((c) => ({ ...c.subject, external_id: c.ext }));
      let results: Json[];
      try {
        const resp = await ctx.client.makeDecision(q.tool, { ...q.inputs, records }, { withReasoning });
        if (!Array.isArray(resp.results)) {
          throw new InvalidResponseError("The batch response has no results list.", { endpoint: "POST /decisions" });
        }
        results = resp.results;
      } catch (e) {
        if (!(e instanceof FirmableError)) throw e;
        const entry: Json = ctx.recordError(chunk[0].row_ids[0], e);
        entry.question_id = qid;
        entry.batch = batchNo;
        // A request stopped by the credit limit was never sent, so its companies were not asked.
        const outcome = e.kind === "budget_exceeded" ? "not_asked" : "error";
        for (const c of chunk) answers[c.key][qid] = empty(qid, outcome, entry);
        continue;
      }
      const byExt = new Map<unknown, Json>();
      for (const r of results) if (isObj(r) && truthy(r.external_id)) byExt.set(r.external_id, r);
      chunk.forEach((c, idx) => {
        let r = byExt.get(c.ext) ?? null;
        if (r === null && results.length === chunk.length && isObj(results[idx]) && !truthy(results[idx].external_id)) {
          r = results[idx];
        }
        if (r === null) {
          const entry: Json = ctx.recordError(c.row_ids[0], new InvalidResponseError(
            `The batch response has no answer for external_id ${pyRepr(c.ext)}.`, { endpoint: "POST /decisions" }));
          entry.question_id = qid;
          entry.batch = batchNo;
          answers[c.key][qid] = empty(qid, "error", entry);
          return;
        }
        const rec = record(qid, r);
        answers[c.key][qid] = rec;
        if (rec.answer === "error") {
          ctx.errors.push({ row_id: c.row_ids[0], kind: "answer_error" as never, status: null,
            code: isObj(rec.error) ? rec.error.code ?? null : null, endpoint: "POST /decisions",
            message: errorText(rec.error), charge_uncertain: false, retry_after: null,
            question_id: qid, batch: batchNo } as never);
        }
      });
    }
  }
  return answers;
}

function rowStatus(recs: Json[], labels: Record<string, string>): [string, string] {
  const outcomes: string[] = recs.map((r) => r.answer);
  const total = outcomes.length;
  if (outcomes.every((o) => o === "not_asked")) return ["not_processed", "The run stopped before any question was asked for this company."];
  if (outcomes.every((o) => o === "not_found")) return ["not_found", "Firmable did not find this company for any question."];
  const missing = recs.filter((r) => r.answer === "error" || r.answer === "not_found" || r.answer === "not_asked");
  if (missing.length) {
    const parts = missing.map((r) => `${labels[r.question_id]} (${r.answer})`).join(", ");
    return ["incomplete", `${missing.length} of ${total} question(s) have no yes, no or unknown answer: ${parts}.`];
  }
  const count = (v: string) => outcomes.filter((o) => o === v).length;
  return ["answered", `All ${total} question(s) answered: ${count("yes")} yes, ${count("no")} no, ${count("unknown")} unknown.`];
}

export async function run(ctx: RunContext): Promise<{ rows: Json[]; summary: Json; coverage: string[] }> {
  const cfg = ctx.config;
  const questions: Json[] = cfg.questions;
  const m: number = cfg.min_answered;
  const coverage: string[] = [
    "The two cohorts are the input file you supplied. The REST API has no general company search and no reverse " +
      "lookup by decision, so this recipe cannot add companies to either cohort.",
    FIXED_NOTE,
    "An unknown answer means Firmable does not hold the fact. It is never counted as a no.",
    "A yes share is yes over yes plus no among the companies checked, shown with that denominator. The unknown " +
      "share is unknown over the companies asked.",
    `A difference is shown only when both cohorts have at least ${m} yes or no answers to the question.`,
    "Duplicate rows are matched on the identifier as given. The same company entered once by domain and once by " +
      "company ID is asked twice and counted twice.",
  ];
  const companies = companiesOf(ctx.rows, cfg.cohorts);
  const labels: Record<string, string> = Object.fromEntries(questions.map((q) => [q.id, q.label]));
  const finish = (answers: Record<string, Record<string, Json>> | null, stopReason: string | null) =>
    assemble(ctx, cfg, companies, answers, stopReason, coverage, labels);

  let catalogue: Json;
  try {
    catalogue = await ctx.client.listDecisionTools();
  } catch (e) {
    if (!(e instanceof FirmableError)) throw e;
    ctx.recordError(null, e);
    return finish(null, "The decision tool list could not be read, so no questions were asked.");
  }
  const problems = decisions.checkTools(catalogue, questions, "company");
  if (problems.length) {
    for (const p of problems) {
      ctx.errors.push({ row_id: null, kind: "config" as never, status: null, code: null, endpoint: "GET /decisions",
        message: p, charge_uncertain: false, retry_after: null });
    }
    coverage.push(...problems);
    return finish(null, "The configuration names decision tools or inputs the API does not accept.");
  }
  const modelTools = [...new Set<string>(questions.filter((q) => decisions.usesModel(catalogue, q.tool)).map((q) => q.tool))].sort();
  if (modelTools.length) {
    coverage.push(`These decision tools use a decision model inside Firmable's service: ${modelTools.join(", ")}. ` +
      "This code adds no model of its own and only counts the answers.");
  }
  const answers = await askAll(ctx, questions, companies, cfg.batch_size, cfg.with_reasoning);
  return finish(answers, null);
}

function assemble(ctx: RunContext, cfg: Json, companies: Json[], answersIn: Record<string, Record<string, Json>> | null,
  stopReason: string | null, coverage: string[], labels: Record<string, string>) {
  const questions: Json[] = cfg.questions;
  const names: string[] = cfg.cohorts;
  const m: number = cfg.min_answered;
  let answers = answersIn;
  if (answers === null) {
    answers = {};
    for (const c of companies) answers[c.key] = Object.fromEntries(questions.map((q) => [q.id, empty(q.id, "not_asked")]));
  }
  const both = new Set<string>(companies.filter((c) => c.cohorts.length > 1).map((c) => c.key));
  const firstRow = new Map<string, string>();
  const members = new Map<string, string[]>(names.map((n) => [n, [] as string[]]));
  const rowsOut: Json[] = [];
  const ignored = new Map<string, number>();
  for (const r of ctx.rows) {
    const cohort = r.cohort || "";
    const base: Json = { row_id: r.row_id, input: r, cohort, company_key: null, in_both_cohorts: false,
      duplicate_of: null, firmable_id: null, answers: [] };
    if (!names.includes(cohort)) {
      ignored.set(cohort, (ignored.get(cohort) ?? 0) + 1);
      rowsOut.push({ ...base, status: "ignored", status_reason: `Cohort ${pyRepr(cohort)} is not one of the two compared cohorts.` });
      continue;
    }
    const [subject, reason] = subjectOf(r);
    if (subject === null) {
      rowsOut.push({ ...base, status: "invalid_input", status_reason: reason });
      continue;
    }
    const k = keyOf(subject);
    const list = members.get(cohort)!;
    if (!list.includes(k)) list.push(k);
    const dup = firstRow.get(k) ?? null;
    if (!firstRow.has(k)) firstRow.set(k, r.row_id);
    const recs = questions.map((q) => answers![k][q.id]);
    const [status, why] = stopReason !== null ? ["not_processed", stopReason] : rowStatus(recs, labels);
    const ids: string[] = recs.map((x) => x.entity_id).filter((x) => truthy(x));
    rowsOut.push({ ...base, company_key: k, in_both_cohorts: both.has(k), duplicate_of: dup,
      firmable_id: ids.length ? ids[0] : null, status, status_reason: why, answers: recs });
  }

  const summaries = questions.map((q) => {
    const blocks = names.map((n) => ({ cohort: n, measure: measure(members.get(n)!, answers!, q.id, m) }));
    return { id: q.id, label: q.label, tool: q.tool, cohorts: blocks,
      difference: difference(blocks[0].measure, blocks[1].measure, names, m) };
  });
  const counts: Record<string, number> = {};
  for (const r of rowsOut) counts[r.status] = (counts[r.status] ?? 0) + 1;
  const dupes = rowsOut.filter((r) => r.duplicate_of).length;
  if (both.size) coverage.push(`${both.size} company(ies) are in both cohorts. Each was asked once and is counted in both.`);
  if (dupes) coverage.push(`${dupes} row(s) repeat an earlier company; that company's answers were reused.`);
  const nIgnored = [...ignored.values()].reduce((s, v) => s + v, 0);
  if (nIgnored) coverage.push(`${nIgnored} row(s) had another cohort value and were ignored.`);
  const summary = { cohorts: names, input_rows: ctx.rows.length, ignored_rows: nIgnored,
    ignored_cohort_values: [...ignored.entries()].map(([k, v]) => ({ cohort: k, rows: v })),
    invalid_rows: counts.invalid_input ?? 0, duplicate_rows: dupes, companies_in_both: both.size,
    companies_asked_once: companies.length,
    cohort_sizes: Object.fromEntries(names.map((n) => [n, members.get(n)!.length])), min_answered: m,
    status_counts: counts, questions: summaries };
  return { rows: rowsOut, summary, coverage };
}

export function csvColumns(result: Json): string[] {
  return [...BASE_COLUMNS, ...result.input.config.questions.map((q: Json) => q.id)];
}

export function csvRows(result: Json): Record<string, unknown>[] {
  return result.rows.map((r: Json) => {
    const inp = r.input;
    const row: Record<string, unknown> = {
      row_id: r.row_id, domain: inp.domain ?? null, company_id: inp.company_id ?? null,
      company_name: inp.company_name ?? null, cohort: r.cohort ?? inp.cohort ?? null,
      in_both_cohorts: r.in_both_cohorts ?? null, status: r.status,
      status_reason: r.status_reason || r.reason || null, duplicate_of: r.duplicate_of ?? null,
      firmable_id: r.firmable_id ?? null,
    };
    for (const a of r.answers ?? []) row[a.question_id] = a.answer;
    return row;
  });
}

const MEASURE_ROWS: [string, string][] = [["Companies", "companies_in_cohort"], ["Asked", "companies_asked"], ["Yes", "yes"],
  ["No", "no"], ["Unknown", "unknown"], ["Error", "error"], ["Not found", "not_found"], ["Not asked", "not_asked"],
  ["Yes share of answered", "yes_share"], ["Unknown share of asked", "unknown_share"]];
const INTERPRETATION = [
  "Yes and no are Firmable's answers as returned. Unknown means Firmable does not hold the fact; it is not a no.",
  "A yes share counts only yes and no answers. Its denominator is shown beside it.",
  "Error, not found and not asked are not answers and are left out of every share.",
  FIXED_NOTE,
];

export function markdown(result: Json): Record<string, string> {
  const s = result.summary;
  const [a, b] = s.cohorts;
  const sizes = s.cohort_sizes;
  let lines: string[] = [`# Cohort comparison: ${mdEscape(a)} and ${mdEscape(b)}`, "",
    `Cohort ${mdEscape(a)}: ${sizes[a]} company(ies). Cohort ${mdEscape(b)}: ${sizes[b]} company(ies).`,
    `${s.companies_in_both} company(ies) are in both cohorts and are counted in both.`,
    `${s.ignored_rows} input row(s) had another cohort value and were ignored. ${s.invalid_rows} row(s) were not valid.`, "",
    `> ${mdEscape(FIXED_NOTE)}`, ""];
  for (const q of s.questions) {
    const ma = q.cohorts[0].measure;
    const mb = q.cohorts[1].measure;
    lines.push(`## ${mdEscape(q.label)}`, "", `Tool: ${mdEscape(q.tool)}`, "", `| Measure | ${mdEscape(a)} | ${mdEscape(b)} |`, "| - | - | - |");
    for (const [label, key] of MEASURE_ROWS) lines.push(`| ${label} | ${mdEscape(ma[key])} | ${mdEscape(mb[key])} |`);
    lines.push("", `Difference in yes share: ${mdEscape(q.difference.text)}.`, "");
  }
  lines = lines.concat(["## How to read this", ""], INTERPRETATION.map((t) => `- ${mdEscape(t)}`));
  if ((result.coverage ?? []).length) {
    lines = lines.concat(["", "## Coverage and limitations", ""], result.coverage.map((c: string) => `- ${mdEscape(c)}`));
  }
  return { "comparison.md": lines.join("\n") + "\n" };
}

function companyLabel(r: Json): string {
  const inp = r.input;
  return inp.company_name || inp.domain || inp.company_id || r.row_id;
}

export function render(report: Report, result: Json): void {
  const s = result.summary;
  const [a, b] = s.cohorts;
  const counts: Record<string, number> = s.status_counts ?? {};
  let body = "<p>" + Object.entries(counts).map(([k, v]) => badge(`${k.replace(/_/g, " ")}: ${v}`, STATUS_TONE[k] ?? "neutral")).join(" ") + "</p>" +
    `<p>Cohort ${esc(a)}: ${esc(s.cohort_sizes[a])} company(ies). Cohort ${esc(b)}: ${esc(s.cohort_sizes[b])} company(ies). ` +
    `${esc(s.companies_in_both)} company(ies) are in both and are counted in both. ${esc(s.ignored_rows)} row(s) had another ` +
    "cohort value and were ignored.</p>" + note(esc(FIXED_NOTE), "unknown");
  for (const q of s.questions) {
    const ma = q.cohorts[0].measure;
    const mb = q.cohorts[1].measure;
    const diff = q.difference;
    body += `<h3>${esc(q.label)}</h3><p class="muted">Tool: ${esc(q.tool)}</p>` +
      table(["Measure", a, b], MEASURE_ROWS.map(([label, key]) => [label, ma[key], mb[key]])) +
      note(`Difference in yes share: ${esc(diff.text)}.`, diff.comparable ? "info" : "unknown");
  }
  report.add("Result", "The two cohorts side by side", body);

  const rows = result.rows.map((r: Json) => {
    const answers = (r.answers ?? []).map((x: Json) => `${x.question_id}=${x.answer}`).join(" ");
    return [r.row_id, companyLabel(r), r.cohort ?? null, r.in_both_cohorts ? "yes" : "no",
      new Raw(badge(r.status.replace(/_/g, " "), STATUS_TONE[r.status] ?? "neutral")), r.status_reason || r.reason || "", answers];
  });
  report.add("Companies", "Each input row",
    table(["Row", "Company", "Cohort", "In both", "Status", "Reason", "Answers"], rows) +
    detailsJson("Answers as JSON", result.rows.map((r: Json) => ({ row_id: r.row_id, answers: r.answers ?? null }))));
}

export const RECIPE: Recipe = {
  name: NAME, title: TITLE, description: DESCRIPTION, loadConfig, readInput, plan, run,
  csvColumns, csvRows, render, markdown,
};
