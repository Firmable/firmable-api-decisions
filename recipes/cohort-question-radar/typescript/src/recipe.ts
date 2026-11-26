/**
 * Cohort question radar: asks the same Decisions company questions across a cohort you supply.
 * Mirrors recipes/cohort-question-radar/python/src/cohort_question_radar/recipe.py; see that file
 * and the recipe README for the workflow and the measure rules.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ConfigError, FirmableError, InvalidResponseError, Json, PlannedCall, Raw, Recipe, Report, RunContext, Row,
  badge, decisions, detailsJson, esc, normaliseDomain, note, pricing, pyRepr, readRows, table,
} from "firmable-api-client";

export const NAME = "cohort-question-radar";
export const TITLE = "Cohort question radar";
export const DESCRIPTION = "Asks the same Firmable Decisions company questions across a cohort of companies you supply, " +
  "and shows how the answers come out, with every count beside its denominator.";

export const ASSET = fileURLToPath(new URL("../../../assets/explorer.js", import.meta.url));
export const ANSWERS = ["yes", "no", "unknown", "error", "not_found", "not_asked"];
const STATUS_TONE: Record<string, string> = {
  answered: "good", incomplete: "review", not_found: "review", invalid_input: "error", not_processed: "unknown",
};
export const BASE_COLUMNS = ["row_id", "domain", "company_id", "company_name", "group", "status", "status_reason",
  "duplicate_of", "firmable_id"];
const NO_GROUP = "(no value)";
const ID = /^[a-z0-9_]{1,40}$/;
const COMPANY_ID = /^f\d{12}$/;
const TOP_KEYS = new Set(["questions", "with_reasoning", "batch_size", "min_answered", "group_by"]);
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
  const gb = raw.group_by ?? null;
  if (gb !== null && (typeof gb !== "string" || !gb || gb === "row_id")) {
    throw new ConfigError("group_by must be the name of an input column other than row_id.");
  }
  return { questions, with_reasoning: wr, batch_size: bs, min_answered: ma, group_by: gb };
}

export function readInput(path: string): Row[] {
  return readRows(path, { anyOf: ["domain", "company_id"] });
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

/** Unique valid companies in order of first appearance. */
function companiesOf(rows: Row[]): Json[] {
  const out: Json[] = [];
  const index = new Map<string, Json>();
  for (const r of rows) {
    const [subject] = subjectOf(r);
    if (subject === null) continue;
    const k = keyOf(subject);
    if (!index.has(k)) {
      const c = { key: k, subject, ext: `c-${out.length + 1}`, row_ids: [] as string[] };
      index.set(k, c);
      out.push(c);
    }
    index.get(k).row_ids.push(r.row_id);
  }
  return out;
}

export function plan(rows: Row[], config: Json): PlannedCall[] {
  const n = companiesOf(rows).length;
  const q = config.questions.length;
  const b = config.batch_size;
  const batches = Math.ceil(n / b);
  return [
    new PlannedCall("GET /decisions", "Read the decision tool list and check each question's tool and inputs", 1, []),
    new PlannedCall("POST /decisions", `${q} question(s) for ${n} unique valid company(ies), in batches of up to ${b}`,
      q * batches, pricing.estimateDecision(n * q, config.with_reasoning)),
  ];
}

/** part / whole as a percentage rounded half up to one decimal, computed with whole numbers. */
function pct(part: number, wholeN: number): [number, string] {
  const tenths = Math.floor((2000 * part + wholeN) / (2 * wholeN));
  return [tenths / 10, `${Math.floor(tenths / 10)}.${tenths % 10}`];
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
  const entity = isObj(resp.entity) ? resp.entity : {};
  return {
    question_id: qid, answer: outcome, decision: ans.answer, confidence: ans.confidence, details: ans.details,
    reasoning: ans.reasoning, answered_at: ans.answered_at, credits: ans.credits, error: truthy(err) ? err : null,
    entity_id: ans.entity_id, profile_url: entity.profile_url ?? null, request_id: ans.request_id,
  };
}

function empty(qid: string, outcome: string, error: Json = null): Json {
  return { question_id: qid, answer: outcome, decision: null, confidence: null, details: null, reasoning: null,
    answered_at: null, credits: null, error, entity_id: null, profile_url: null, request_id: null };
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
  const gb: string | null = cfg.group_by;
  const coverage: string[] = [
    "The cohort is the input file you supplied. The REST API has no general company search and no reverse " +
      "lookup by decision, so this recipe cannot add companies to the cohort.",
    "Answers describe the companies in this cohort only. They do not describe a market, sector or population.",
    "An unknown answer means Firmable does not hold the fact. It is never counted as a no.",
    "A yes share is yes over yes plus no among the companies checked, shown with that denominator. The unknown " +
      "share is unknown over the companies asked.",
    `A question with fewer than ${m} yes or no answers is marked too few answers to compare and shows no yes share.`,
    "Duplicate rows are matched on the identifier as given. The same company entered once by domain and once by " +
      "company ID is asked twice and counted twice.",
  ];
  const companies = companiesOf(ctx.rows);
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
  if (gb !== null && !ctx.rows.some((r) => gb in r)) {
    coverage.push(`The group_by column ${pyRepr(gb)} is not in the input, so every company is in the group ${NO_GROUP}.`);
  }
  const answers = await askAll(ctx, questions, companies, cfg.batch_size, cfg.with_reasoning);
  return finish(answers, null);
}

function assemble(ctx: RunContext, cfg: Json, companies: Json[], answersIn: Record<string, Record<string, Json>> | null,
  stopReason: string | null, coverage: string[], labels: Record<string, string>) {
  const questions: Json[] = cfg.questions;
  const gb: string | null = cfg.group_by;
  const m: number = cfg.min_answered;
  let answers = answersIn;
  if (answers === null) {
    answers = {};
    for (const c of companies) answers[c.key] = Object.fromEntries(questions.map((q) => [q.id, empty(q.id, "not_asked")]));
  }
  const firstRow = new Map<string, string>();
  const rowsOut: Json[] = [];
  const groupMembers = new Map<string, string[]>();
  const companyGroups = new Map<string, string[]>();
  for (const r of ctx.rows) {
    const group = gb !== null ? (r[gb] || NO_GROUP) : null;
    const [subject, reason] = subjectOf(r);
    const base: Json = { row_id: r.row_id, input: r, group, company_key: null, duplicate_of: null, firmable_id: null, answers: [] };
    if (subject === null) {
      rowsOut.push({ ...base, status: "invalid_input", status_reason: reason });
      continue;
    }
    const k = keyOf(subject);
    if (group !== null) {
      if (!groupMembers.has(group)) groupMembers.set(group, []);
      const members = groupMembers.get(group)!;
      if (!members.includes(k)) members.push(k);
      if (!companyGroups.has(k)) companyGroups.set(k, []);
      const groups = companyGroups.get(k)!;
      if (!groups.includes(group)) groups.push(group);
    }
    const dup = firstRow.get(k) ?? null;
    if (!firstRow.has(k)) firstRow.set(k, r.row_id);
    const recs = questions.map((q) => answers![k][q.id]);
    const [status, why] = stopReason !== null ? ["not_processed", stopReason] : rowStatus(recs, labels);
    const ids: string[] = recs.map((x) => x.entity_id).filter((x) => truthy(x));
    rowsOut.push({ ...base, company_key: k, duplicate_of: dup, firmable_id: ids.length ? ids[0] : null,
      firmable_ids_differ: new Set(ids).size > 1, status, status_reason: why, answers: recs });
  }

  const keys = companies.map((c) => c.key);
  const summaries = questions.map((q) => {
    const entry: Json = { id: q.id, label: q.label, tool: q.tool, measure: measure(keys, answers!, q.id, m), groups: [] };
    if (gb !== null) {
      entry.groups = [...groupMembers.entries()].map(([g, ks]) => ({ group: g, measure: measure(ks, answers!, q.id, m) }));
    }
    return entry;
  });
  const counts: Record<string, number> = {};
  for (const r of rowsOut) counts[r.status] = (counts[r.status] ?? 0) + 1;
  const dupes = rowsOut.filter((r) => r.duplicate_of).length;
  if (dupes) coverage.push(`${dupes} row(s) repeat an earlier company; that company's answers were reused and it is counted once.`);
  const multi = [...companyGroups.values()].filter((g) => g.length > 1).length;
  if (multi) coverage.push(`${multi} company(ies) appear in more than one group and are counted once in each group.`);
  const differ = [...new Set<string>(rowsOut.filter((r) => r.firmable_ids_differ).map((r) => r.company_key))].sort();
  if (differ.length) {
    coverage.push(`${differ.length} company(ies) were matched to different Firmable IDs by different questions: ` +
      `${differ.join(", ")}. The answers are shown as returned.`);
  }
  const summary = { input_rows: ctx.rows.length, invalid_rows: counts.invalid_input ?? 0, duplicate_rows: dupes,
    companies_in_cohort: companies.length, min_answered: m, group_by: gb, status_counts: counts, questions: summaries };
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
      company_name: inp.company_name ?? null, group: r.group ?? null, status: r.status,
      status_reason: r.status_reason || r.reason || null, duplicate_of: r.duplicate_of ?? null,
      firmable_id: r.firmable_id ?? null,
    };
    for (const a of r.answers ?? []) row[a.question_id] = a.answer;
    return row;
  });
}

function companyLabel(r: Json): string {
  const inp = r.input;
  return inp.company_name || inp.domain || inp.company_id || r.row_id;
}

export function explorerData(result: Json): Json {
  const cfg = result.input.config;
  const companies: Json[] = [];
  const index = new Map<string, Json>();
  for (const r of result.rows) {
    const k = r.company_key;
    if (!k) continue;
    if (index.has(k)) {
      const c = index.get(k);
      c.row_ids.push(r.row_id);
      if (r.group !== null && r.group !== undefined && !c.groups.includes(r.group)) c.groups.push(r.group);
      continue;
    }
    const profile = (r.answers.find((a: Json) => a.profile_url) ?? {}).profile_url ?? null;
    const c: Json = { key: k, label: companyLabel(r), identifier: k.split(":").slice(1).join(":"), row_ids: [r.row_id],
      groups: r.group !== null && r.group !== undefined ? [r.group] : [], firmable_id: r.firmable_id ?? null,
      profile_url: profile, status: r.status, status_reason: r.status_reason ?? null, answers: {} };
    for (const a of r.answers) {
      const rs = a.reasoning ?? {};
      c.answers[a.question_id] = { answer: a.answer, confidence: a.confidence ?? null, details: a.details ?? null,
        reason: rs.reason ?? null, source: rs.source ?? null, fact_date: rs.fact_date ?? null,
        last_refreshed: rs.last_refreshed ?? null, would_change_if: rs.would_change_if ?? null,
        error: a.error ? errorText(a.error) : null };
    }
    index.set(k, c);
    companies.push(c);
  }
  return { questions: cfg.questions.map((q: Json) => ({ id: q.id, label: q.label, tool: q.tool })),
    group_by: cfg.group_by ?? null, min_answered: cfg.min_answered, answer_values: ANSWERS,
    measures: result.summary.questions ?? [], companies };
}

const MEASURE_HEADERS = ["Question", "Companies", "Asked", "Yes", "No", "Unknown", "Error", "Not found", "Not asked",
  "Yes share of answered", "Unknown share of asked"];

const measureCells = (label: string, b: Json): unknown[] => [label, b.companies_in_cohort, b.companies_asked, b.yes, b.no,
  b.unknown, b.error, b.not_found, b.not_asked, b.yes_share, b.unknown_share];

const EXPLORER_CSS =
  "<style>.rx-filters{display:flex;flex-wrap:wrap;gap:8px 16px;margin:0 0 12px}" +
  ".rx-filters label{display:flex;flex-direction:column;font-size:12px;color:var(--muted);font-weight:700}" +
  ".rx-filters select{font:inherit;font-size:14px;padding:4px 6px;max-width:100%}" +
  ".rx-bar{display:flex;height:12px;border-radius:6px;overflow:hidden;background:var(--shale);margin:4px 0}" +
  ".rx-bar span{display:block;height:100%}.rx-yes{background:#F15B06}.rx-no{background:#5B6170}" +
  ".rx-unknown{background:#C9CCD3}.rx-error{background:#C0392B}.rx-not_found{background:#E5A04B}" +
  ".rx-not_asked{background:#E9EAEB}.rx-q{margin:0 0 12px}.rx-company{font:inherit;background:none;border:0;" +
  "padding:0;color:var(--ember);text-decoration:underline;cursor:pointer;text-align:left}" +
  "#rx-drill{margin-top:14px}</style>";

export function render(report: Report, result: Json): void {
  const s = result.summary;
  const counts: Record<string, number> = s.status_counts ?? {};
  const head = "<p>" + Object.entries(counts).map(([k, v]) => badge(`${k.replace(/_/g, " ")}: ${v}`, STATUS_TONE[k] ?? "neutral")).join(" ") + "</p>" +
    `<p>${esc(s.companies_in_cohort)} unique company(ies) from ${esc(s.input_rows)} input row(s). ${esc(s.invalid_rows)} row(s) ` +
    `were not valid and ${esc(s.duplicate_rows)} repeated an earlier company.</p>` +
    note("These counts describe the companies in this cohort only. Unknown means Firmable does not hold " +
      "the fact; it is never counted as a no. A yes share is yes over yes plus no.", "unknown");
  let body = head + table(MEASURE_HEADERS, (s.questions ?? []).map((q: Json) => measureCells(q.label, q.measure)));
  for (const q of s.questions ?? []) {
    if ((q.groups ?? []).length) {
      body += `<h3>${esc(q.label)} by ${esc(s.group_by)}</h3>` +
        table(["Group", ...MEASURE_HEADERS.slice(1)], q.groups.map((g: Json) => measureCells(g.group, g.measure)));
    }
  }
  report.add("Result", "Answers across the cohort", body);

  report.add("Explorer", "Question-by-company explorer",
    EXPLORER_CSS + '<div id="radar-explorer"><p class="muted" id="rx-fallback">The explorer needs ' +
    "JavaScript. The tables on this page and results.csv hold the same answers.</p></div>");
  report.addData("radar-data", explorerData(result));
  report.addScript(readFileSync(ASSET, "utf-8"));

  const companyRows = result.rows.map((r: Json) => {
    const reason = r.status_reason || r.reason || "";
    const answers = (r.answers ?? []).map((a: Json) => `${a.question_id}=${a.answer}`).join(" ");
    return [r.row_id, companyLabel(r), r.group ?? null,
      new Raw(badge(r.status.replace(/_/g, " "), STATUS_TONE[r.status] ?? "neutral")), reason, answers];
  });
  report.add("Companies", "Each input row",
    table(["Row", "Company", "Group", "Status", "Reason", "Answers"], companyRows) +
    detailsJson("Answers as JSON", result.rows.map((r: Json) => ({ row_id: r.row_id, answers: r.answers ?? null }))));
}

export const RECIPE: Recipe = {
  name: NAME, title: TITLE, description: DESCRIPTION, loadConfig, readInput, plan, run,
  csvColumns, csvRows, render,
};
