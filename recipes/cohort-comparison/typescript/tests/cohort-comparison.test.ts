import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, InputError, main as cliMain, Json, parseCsv } from "firmable-api-client";
import { fixturesDir, runWithFixtures } from "firmable-api-client/testing";
import { RECIPE, loadConfig, mdEscape, plan } from "../src/recipe.js";

const F = fixturesDir("cohort-comparison");
const tmp = () => mkdtempSync(join(tmpdir(), "cc-"));

function run(name: string, o: { config?: string; maxCredits?: number; out?: string; ext?: string } = {}) {
  return runWithFixtures(RECIPE, {
    inputPath: join(F, `${name}.input.${o.ext ?? "csv"}`), configPath: join(F, o.config ?? "config.json"),
    scenario: join(F, `${name}.scenario.json`), maxCredits: o.maxCredits ?? 100, outDir: o.out,
  });
}
const byId = (result: Json): Record<string, Json> => Object.fromEntries(result.rows.map((r: Json) => [r.row_id, r]));
const answers = (row: Json): Record<string, Json> => Object.fromEntries(row.answers.map((a: Json) => [a.question_id, a]));
const question = (result: Json, qid: string): Json => result.summary.questions.find((q: Json) => q.id === qid);

test("happy path rows, cohorts and batches", async () => {
  const [result, transport] = await run("happy");
  const rows = byId(result);
  assert.equal(rows.k07.status, "ignored");
  assert.equal(rows.k11.status, "ignored");
  assert.equal(rows.k08.status, "invalid_input");
  assert.equal(rows.k01.in_both_cohorts, true);
  assert.equal(rows.k06.duplicate_of, "k01");
  assert.equal(rows.k09.status, "incomplete");
  assert.deepEqual(result.summary.cohort_sizes, { customers: 3, prospects: 4 });
  assert.deepEqual(result.summary.ignored_cohort_values, [{ cohort: "partners", rows: 1 }, { cohort: "", rows: 1 }]);
  assert.equal(transport.sent.filter((r) => r.method === "POST").length, 4);
  assert.deepEqual(transport.unused(), []);
});

test("difference and denominators", async () => {
  const [result] = await run("happy");
  const q = question(result, "b2b");
  assert.equal(q.cohorts[0].measure.yes_share, "3 of 3 answered (100.0%)");
  assert.equal(q.cohorts[1].measure.unknown_share, "1 of 4 asked (25.0%)");
  assert.deepEqual(q.difference, { comparable: true, yes_share_difference_pp: 33.3,
    text: "+33.3 percentage points (customers minus prospects)" });
});

test("too few answers gives no difference", async () => {
  const [result] = await run("happy");
  const q = question(result, "staff_200");
  assert.equal(q.cohorts[0].measure.yes_share_pct, null);
  assert.equal(q.difference.comparable, false);
  assert.ok(q.difference.text.startsWith("too few answers to compare"));
});

test("unknown and row errors kept distinct", async () => {
  const [result] = await run("happy");
  const rows = byId(result);
  assert.equal(answers(rows.k02).staff_200.answer, "unknown");
  assert.equal(answers(rows.k09).staff_200.error.code, "upstream_error");
  const m = question(result, "staff_200").cohorts[1].measure;
  assert.deepEqual([m.yes, m.no, m.unknown, m.error, m.answered], [1, 2, 0, 1, 3]);
});

test("negative difference and JSON input", async () => {
  const [result] = await run("comparable", { config: "comparable.config.json", ext: "json" });
  const q = question(result, "b2b");
  assert.equal(q.difference.yes_share_difference_pp, -66.7);
  assert.equal(q.difference.text, "-66.7 percentage points (2025 minus 2026)");
});

test("errors and 402 stop", async () => {
  const [result, transport] = await run("errors", { config: "errors.config.json" });
  const rows = byId(result);
  assert.equal(answers(rows["row-1"]).b2b.error.status, 502);
  assert.equal(answers(rows["row-3"]).b2b.error.kind, "invalid_response");
  assert.equal(answers(rows["row-1"]).staff_200.error.kind, "insufficient_credits");
  assert.equal(answers(rows["row-3"]).staff_200.answer, "not_asked");
  assert.equal(transport.sent.length, 4);
});

test("budget stops before the next batch", async () => {
  const [result, transport] = await run("budget", { config: "budget.config.json", maxCredits: 1.1 });
  assert.equal(byId(result)["row-3"].status, "not_processed");
  assert.equal(result.errors[0].kind, "budget_exceeded");
  assert.equal(transport.sent.length, 2);
});

test("bad tools stop before paid calls", async () => {
  const [result, transport] = await run("bad-tool", { config: "bad-tool.config.json" });
  assert.deepEqual(result.rows.map((r: Json) => r.status), ["not_processed"]);
  assert.deepEqual(transport.sent.map((r) => r.path), ["/decisions"]);
});

test("markdown and outputs", async () => {
  const out = tmp();
  await run("happy", { out });
  const md = readFileSync(join(out, "comparison.md"), "utf-8");
  assert.ok(md.startsWith("# Cohort comparison: customers and prospects\n"));
  assert.ok(md.includes("Difference in yes share: +33.3 percentage points (customers minus prospects)."));
  assert.ok(md.includes("Tool: matches\\_company\\_size"));
  const csvTable = parseCsv(readFileSync(join(out, "results.csv"), "utf-8"));
  const h = csvTable[0];
  assert.equal(csvTable[1][h.indexOf("b2b")], "yes");
  assert.equal(csvTable[1][h.indexOf("in_both_cohorts")], "true");
  const html = readFileSync(join(out, "report.html"), "utf-8");
  assert.ok(!html.includes("<b>A3</b>") && html.includes("&lt;b&gt;A3&lt;/b&gt;"));
});

test("mdEscape", () => {
  assert.equal(mdEscape("a|b *c* _d_ [e](f) <g> `h` \\"), "a\\|b \\*c\\* \\_d\\_ \\[e\\](f) \\<g\\> \\`h\\` \\\\");
  assert.equal(mdEscape("# heading"), "\\# heading");
  assert.equal(mdEscape("line\nbreak"), "line break");
});

test("plan counts companies once", () => {
  const cfg = loadConfig(JSON.parse(readFileSync(join(F, "config.json"), "utf-8")));
  const rows = RECIPE.readInput(join(F, "happy.input.csv"));
  const calls = Object.fromEntries(plan(rows, cfg).map((c) => [c.endpoint, c]));
  assert.equal(calls["POST /decisions"].requests, 4);
  assert.equal(calls["POST /decisions"].toDict().published_estimate_upper_bound, 0.96);
});

test("input needs a cohort column", () => {
  const d = tmp();
  writeFileSync(join(d, "in.csv"), "domain\na.example\n");
  assert.throws(() => RECIPE.readInput(join(d, "in.csv")), (e: Error) => e instanceof InputError && e.message.includes("missing column"));
});

const bad: [(c: Json) => void, string][] = [
  [(c) => { c.cohorts = ["customers"]; }, "exactly two cohort values"],
  [(c) => { c.cohorts = ["a", 2]; }, "exactly two cohort values"],
  [(c) => { c.cohorts = ["a", " a "]; }, "two different values"],
  [(c) => { c.questions = []; }, "questions must be a list of 1 to 10"],
  [(c) => { c.questions[1].id = "b2b"; }, "used twice"],
  [(c) => { c.questions[0].id = "cohort"; }, "reserved for an output column"],
  [(c) => { c.questions[0].inputs = { company_id: "f900000000001" }; }, "must not include company_id"],
  [(c) => { c.batch_size = 150; }, "batch_size must be a whole number from 1 to 100"],
  [(c) => { c.min_answered = -1; }, "min_answered must be a whole number"],
  [(c) => { c.group_by = "segment"; }, "Unknown configuration key"],
];
for (const [mutate, message] of bad) {
  test(`invalid config: ${message}`, () => {
    const cfg = JSON.parse(readFileSync(join(F, "config.json"), "utf-8"));
    mutate(cfg);
    assert.throws(() => loadConfig(cfg), (e: Error) => e instanceof ConfigError && e.message.includes(message));
  });
}

test("CLI plan mode makes no calls", async () => {
  const out = tmp();
  delete process.env.FIRMABLE_API_KEY;
  const code = await cliMain(RECIPE, ["--input", join(F, "happy.input.csv"), "--config", join(F, "config.json"), "--out", out]);
  assert.equal(code, 0);
  assert.equal(JSON.parse(readFileSync(join(out, "plan.json"), "utf-8")).requests_upper_bound, 5);
});

test("CLI live needs a limit and a key", async () => {
  const out = tmp();
  const args = ["--input", join(F, "happy.input.csv"), "--config", join(F, "config.json"), "--out", out];
  assert.equal(await cliMain(RECIPE, [...args, "--live"]), 2);
  delete process.env.FIRMABLE_API_KEY;
  assert.equal(await cliMain(RECIPE, [...args, "--live", "--max-credits", "5"]), 2);
});

test("CLI rejects bad input", async () => {
  const d = tmp();
  writeFileSync(join(d, "in.csv"), "name,cohort\nAcme,customers\n");
  assert.equal(await cliMain(RECIPE, ["--input", join(d, "in.csv"), "--config", join(F, "config.json"), "--out", d]), 2);
});
