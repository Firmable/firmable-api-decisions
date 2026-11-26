import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, main as cliMain, Json, parseCsv } from "firmable-api-client";
import { fixturesDir, runWithFixtures } from "firmable-api-client/testing";
import { ASSET, RECIPE, loadConfig, plan } from "../src/recipe.js";

const F = fixturesDir("cohort-question-radar");
const tmp = () => mkdtempSync(join(tmpdir(), "cqr-"));

function run(name: string, o: { config?: string; maxCredits?: number; out?: string; ext?: string } = {}) {
  return runWithFixtures(RECIPE, {
    inputPath: join(F, `${name}.input.${o.ext ?? "csv"}`), configPath: join(F, o.config ?? "config.json"),
    scenario: join(F, `${name}.scenario.json`), maxCredits: o.maxCredits ?? 100, outDir: o.out,
  });
}
const byId = (result: Json): Record<string, Json> => Object.fromEntries(result.rows.map((r: Json) => [r.row_id, r]));
const answers = (row: Json): Record<string, Json> => Object.fromEntries(row.answers.map((a: Json) => [a.question_id, a]));
const question = (result: Json, qid: string): Json => result.summary.questions.find((q: Json) => q.id === qid);

test("happy path statuses and batches", async () => {
  const [result, transport] = await run("happy");
  const rows = byId(result);
  assert.equal(rows.r01.status, "answered");
  assert.equal(rows.r04.duplicate_of, "r01");
  assert.equal(rows.r05.status, "invalid_input");
  assert.equal(rows.r10.status, "invalid_input");
  assert.equal(rows.r06.firmable_id, "f900000000006");
  assert.equal(rows.r07.status, "not_found");
  assert.equal(rows.r11.status, "incomplete");
  assert.deepEqual(transport.unused(), []);
  const posts = transport.sent.filter((r) => r.method === "POST");
  assert.equal(posts.length, 8);
  assert.ok(posts.every((r) => (r.jsonBody as Json).question.records.length <= 4));
  assert.equal(result.summary.companies_in_cohort, 7);
});

test("measure block states denominators", async () => {
  const [result] = await run("happy");
  const b = question(result, "b2b").measure;
  assert.deepEqual([b.companies_in_cohort, b.companies_asked, b.yes, b.no, b.unknown, b.error, b.not_found], [7, 7, 3, 1, 1, 1, 1]);
  assert.equal(b.yes_share, "3 of 4 answered (75.0%)");
  assert.equal(b.unknown_share, "1 of 7 asked (14.3%)");
});

test("unknown is never no and row errors are isolated", async () => {
  const [result] = await run("happy");
  const rows = byId(result);
  assert.equal(answers(rows.r08).b2b.answer, "unknown");
  const eta = answers(rows.r11);
  assert.equal(eta.b2b.answer, "error");
  assert.equal(eta.b2b.error.code, "upstream_error");
  assert.equal(eta.staff_200.answer, "unknown");
  assert.equal(answers(rows.r07).b2b.answer, "not_found");
  assert.ok(!result.errors.some((e: Json) => e.code === "company_not_found"));
});

test("groups and too few answers", async () => {
  const [result] = await run("happy");
  const groups = Object.fromEntries(question(result, "b2b").groups.map((g: Json) => [g.group, g.measure]));
  assert.deepEqual(Object.keys(groups), ["Software", "Payments", "Logistics", "(no value)"]);
  assert.equal(groups.Software.yes_share_pct, null);
  assert.equal(groups.Software.yes_share, "too few answers to compare (2 answered, minimum 3)");
  assert.equal(groups.Payments.companies_in_cohort, 3);
});

test("equivalent questions kept as returned and ID conflict surfaced", async () => {
  const [result] = await run("happy");
  const gamma = answers(byId(result).r03);
  assert.equal(gamma.au_code.answer, "yes");
  assert.equal(gamma.au_name.answer, "unknown");
  assert.ok(result.coverage.some((c: string) => c.includes("different Firmable IDs") && c.includes("gamma.example")));
});

test("errors and 402 stop", async () => {
  const [result, transport] = await run("errors", { config: "errors.config.json" });
  const rows = byId(result);
  const e1 = answers(rows.e1);
  assert.equal(e1.b2b.error.status, 502);
  assert.equal(e1.staff_200.error.kind, "timeout");
  assert.equal(answers(rows.e3).b2b.error.kind, "invalid_response");
  assert.ok(answers(rows.e6).b2b.error.message.includes("external_id 'c-6'"));
  assert.equal(answers(rows.e5).staff_200.error.kind, "insufficient_credits");
  assert.ok(result.rows.every((r: Json) => answers(r).au_code.answer === "not_asked"));
  assert.equal(result.credits.requests_with_uncertain_charge, 3);
  assert.equal(transport.sent.length, 7);
});

test("budget stops before the next batch", async () => {
  const [result, transport] = await run("budget", { config: "budget.config.json", maxCredits: 1.1 });
  const rows = byId(result);
  assert.equal(rows["row-1"].status, "answered");
  assert.equal(rows["row-3"].status, "not_processed");
  assert.equal(result.errors[0].kind, "budget_exceeded");
  assert.equal(transport.sent.length, 2);
});

test("bad tools stop before paid calls", async () => {
  const [result, transport] = await run("bad-tool", { config: "bad-tool.config.json" });
  assert.deepEqual(result.rows.map((r: Json) => r.status), ["not_processed"]);
  const msgs = result.errors.map((e: Json) => e.message).join(" ");
  for (const s of ["is_imaginary", "not a company", "colour", "service"]) assert.ok(msgs.includes(s), s);
  assert.deepEqual(transport.sent.map((r) => r.path), ["/decisions"]);
});

test("JSON input, no reasoning, missing group column and position match", async () => {
  const [result, transport] = await run("single", { config: "single.config.json", ext: "json" });
  assert.equal(answers(byId(result).s2).multinational.answer, "no");
  assert.deepEqual(transport.sent[1].query, {});
  assert.ok(result.coverage.some((c: string) => c.includes("group_by column 'region'")));
});

test("outputs: CSV, HTML and explorer", async () => {
  const out = tmp();
  await run("happy", { out });
  const table = parseCsv(readFileSync(join(out, "results.csv"), "utf-8"));
  const header = table[0];
  assert.equal(table[1][header.indexOf("b2b")], "yes");
  assert.equal(table[3][header.indexOf("au_name")], "unknown");
  const html = readFileSync(join(out, "report.html"), "utf-8");
  assert.ok(!html.includes("<b>Eps</b>") && !html.includes("<script>alert"));
  assert.ok(!html.includes('href="javascript'));
  assert.ok(html.includes('id="radar-data"') && html.includes("script-src 'sha256-"));
  assert.ok(!readFileSync(join(out, "results.json"), "utf-8").includes("fbl_dev_"));
});

test("explorer script has no unsafe sinks", () => {
  const js = readFileSync(ASSET, "utf-8");
  for (const sink of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "fetch(", "XMLHttpRequest", "</script"]) {
    assert.ok(!js.includes(sink), sink);
  }
  assert.ok(js.includes("textContent") && js.includes("createElement"));
});

test("plan counts batches and answers", () => {
  const cfg = loadConfig(JSON.parse(readFileSync(join(F, "config.json"), "utf-8")));
  const rows = RECIPE.readInput(join(F, "happy.input.csv"));
  const calls = Object.fromEntries(plan(rows, cfg).map((c) => [c.endpoint, c]));
  assert.equal(calls["POST /decisions"].requests, 8);
  assert.equal(calls["POST /decisions"].toDict().published_estimate_upper_bound, 2.24);
});

const bad: [(c: Json) => void, string][] = [
  [(c) => { c.questions = []; }, "questions must be a list of 1 to 10"],
  [(c) => { c.questions = [...c.questions, ...c.questions, ...c.questions]; }, "questions must be a list of 1 to 10"],
  [(c) => { c.questions[1].id = "b2b"; }, "used twice"],
  [(c) => { c.questions[0].id = "status"; }, "reserved for an output column"],
  [(c) => { c.questions[0].inputs = { domain: "x.example" }; }, "must not include domain"],
  [(c) => { c.questions[0].want = "yes"; }, "unknown key"],
  [(c) => { c.batch_size = 101; }, "batch_size must be a whole number from 1 to 100"],
  [(c) => { c.batch_size = 0; }, "batch_size must be a whole number from 1 to 100"],
  [(c) => { c.min_answered = 0; }, "min_answered must be a whole number"],
  [(c) => { c.with_reasoning = "yes"; }, "with_reasoning must be true or false"],
  [(c) => { c.group_by = ""; }, "group_by must be the name"],
  [(c) => { c.colour = "orange"; }, "Unknown configuration key"],
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
  const p = JSON.parse(readFileSync(join(out, "plan.json"), "utf-8"));
  assert.equal(p.published_estimate_upper_bound, 2.24);
  assert.equal(p.requests_upper_bound, 9);
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
  writeFileSync(join(d, "in.csv"), "name\nAcme\n");
  assert.equal(await cliMain(RECIPE, ["--input", join(d, "in.csv"), "--config", join(F, "config.json"), "--out", d]), 2);
});
