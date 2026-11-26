import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, InputError, main as cliMain, Json } from "firmable-api-client";
import { fixturesDir, runWithFixtures } from "firmable-api-client/testing";
import { RECIPE, loadConfig, md, plan } from "../src/recipe.js";

const F = fixturesDir("company-fact-brief");
const tmp = () => mkdtempSync(join(tmpdir(), "cfb-"));

function run(name: string, o: { maxCredits?: number; out?: string } = {}) {
  const cfg = join(F, `${name}.config.json`);
  return runWithFixtures(RECIPE, {
    inputPath: join(F, `${name}.input.csv`), configPath: existsSync(cfg) ? cfg : join(F, "config.json"),
    scenario: join(F, `${name}.scenario.json`), maxCredits: o.maxCredits ?? 100, outDir: o.out,
  });
}
const byId = (result: Json): Record<string, Json> => Object.fromEntries(result.rows.map((r: Json) => [r.row_id, r]));
const answers = (row: Json): Record<string, Json> => Object.fromEntries(row.answers.map((a: Json) => [a.question_id, a]));

test("happy path statuses and batches", async () => {
  const out = tmp();
  const [result, transport] = await run("happy", { out });
  const rows = byId(result);
  assert.equal(rows.r1.status, "brief_ready");
  assert.equal(rows.r2.status, "partial");
  assert.equal(rows.r3.duplicate_of, "r1");
  assert.equal(rows.r3.brief_file, "brief-r1.md");
  assert.equal(rows.r4.status, "invalid_input");
  assert.equal(rows.r5.status, "company_not_found");
  assert.equal(rows.r6.status, "brief_ready");
  assert.deepEqual(transport.unused(), []);
  assert.equal(transport.sent.filter((r) => r.path === "/company").length, 4);
  const decisionCalls = transport.sent.filter((r) => r.path === "/decisions" && r.method === "POST");
  assert.equal(decisionCalls.length, 8);
  assert.deepEqual(readdirSync(out).filter((f) => f.endsWith(".md")).sort(), ["brief-r1.md", "brief-r2.md", "brief-r6.md"]);
});

test("answers are kept as returned", async () => {
  const [result] = await run("happy");
  const a = answers(byId(result).r1);
  assert.equal(a.b2b.reasoning.reason, "Sells *to* businesses | per [site](javascript:alert(1))");
  assert.deepEqual(a.size_200.details, { counted: "worldwide", staff_band: "201 - 500", staff_count: 320 });
});

test("unknown is not no and row errors are not answers", async () => {
  const out = tmp();
  const [result] = await run("happy", { out });
  const a = answers(byId(result).r2);
  assert.equal(a.listed.outcome, "unknown");
  assert.equal(a.rd_tax.outcome, "error");
  assert.equal(a.rd_tax.answer_error.code, "upstream_error");
  const brief = readFileSync(join(out, "brief-r2.md"), "utf-8");
  const unknownPart = brief.split("## What is unknown")[1].split("##")[0];
  assert.ok(unknownPart.includes("Publicly listed: Firmable does not hold this fact."));
  assert.ok(!unknownPart.includes("Sells to other businesses"));
  assert.ok(brief.includes("## Not answered"));
});

test("conflicting profile facts are flagged, not corrected", async () => {
  const out = tmp();
  const [result] = await run("happy", { out });
  const r6 = byId(result).r6;
  assert.equal(r6.conflicts.length, 2);
  assert.ok(r6.conflicts[0].includes("year_founded is 2031"));
  assert.ok(readFileSync(join(out, "brief-r6.md"), "utf-8").includes("## Possible conflicts"));
  assert.deepEqual(byId(result).r1.conflicts, []);
});

test("markdown is escaped", async () => {
  const out = tmp();
  await run("happy", { out });
  const brief = readFileSync(join(out, "brief-r1.md"), "utf-8");
  assert.ok(brief.startsWith("# Company fact brief: Alpha \\*Example\\* \\<b\\>Pty\\</b\\>"));
  assert.ok(brief.includes("Sells \\*to\\* businesses \\| per \\[site\\](javascript:alert(1))"));
  assert.equal(md("# heading"), "\\# heading");
  assert.equal(md(null), "not returned");
  assert.equal(md(["a", "b"]), "a, b");
});

test("errors are recorded and 402 stops the run", async () => {
  const [result, transport] = await run("errors");
  const rows = byId(result);
  assert.equal(rows.e1.status, "error");
  assert.equal(rows.e1.error.status, 500);
  const a = answers(rows.e2);
  assert.equal(a.b2b.error.kind, "timeout");
  assert.equal(a.listed.error.kind, "invalid_response");
  assert.equal(a.size_200.error.kind, "insufficient_credits");
  assert.equal(a.rd_tax.outcome, "not_asked");
  assert.equal(rows.e3.status, "not_processed");
  assert.equal(result.credits.requests_with_uncertain_charge, 3);
  assert.equal(transport.sent.length, 7);
});

test("budget stops before the next paid call", async () => {
  const [result, transport] = await run("budget", { maxCredits: 3.2 });
  const a = answers(byId(result)["row-1"]);
  assert.equal(a.b2b.outcome, "yes");
  assert.equal(a.listed.error.kind, "budget_exceeded");
  assert.equal(a.size_200.outcome, "not_asked");
  assert.equal(transport.sent.length, 4);
});

test("bad tool stops before paid calls", async () => {
  const [result, transport] = await run("bad-tool");
  assert.deepEqual(result.rows.map((r: Json) => r.status), ["not_processed"]);
  const msgs = result.errors.map((e: Json) => e.message).join(" ");
  assert.ok(msgs.includes("'is_imaginary' is not in the current tool list"));
  assert.ok(msgs.includes("needs input(s): types"));
  assert.deepEqual(transport.sent.map((r) => r.path), ["/decisions"]);
});

test("not fetched asks by domain and keeps not found", async () => {
  const [result, transport] = await run("not-fetched");
  const rows = byId(result);
  assert.equal(rows.n1.status, "brief_ready");
  assert.equal(rows.n2.status, "company_not_found");
  assert.ok(!transport.sent.some((r) => r.path === "/company"));
});

test("outputs are safe", async () => {
  const out = tmp();
  await run("happy", { out });
  const html = readFileSync(join(out, "report.html"), "utf-8");
  assert.ok(!html.includes("<b>Pty</b>") && html.includes("&lt;b&gt;Pty&lt;/b&gt;"));
  assert.ok(!html.includes('href="javascript'));
  assert.ok(!readFileSync(join(out, "results.json"), "utf-8").includes("fbl_dev_"));
});

test("plan counts unique valid companies and batches", () => {
  const cfg = loadConfig(JSON.parse(readFileSync(join(F, "config.json"), "utf-8")));
  const rows = RECIPE.readInput(join(F, "happy.input.csv"));
  const calls = Object.fromEntries(plan(rows, cfg).map((c) => [c.endpoint, c]));
  assert.equal(calls["GET /company"].requests, 4);
  assert.equal(calls["POST /decisions"].requests, 8);
});

const bad: [(c: Json) => void, string][] = [
  [(c) => { c.questions = []; }, "questions must be a list of 1 to 10"],
  [(c) => { c.questions[1].id = "b2b"; }, "used twice"],
  [(c) => { c.questions[0].want = "yes"; }, "unknown key"],
  [(c) => { c.batch_size = 101; }, "batch_size must be a whole number from 1 to 100"],
  [(c) => { c.with_reasoning = "yes"; }, "with_reasoning must be true or false"],
  [(c) => { c.colour = "orange"; }, "Unknown configuration key"],
];
for (const [mutate, message] of bad) {
  test(`invalid config: ${message}`, () => {
    const cfg = JSON.parse(readFileSync(join(F, "config.json"), "utf-8"));
    mutate(cfg);
    assert.throws(() => loadConfig(cfg), (e: Error) => e instanceof ConfigError && e.message.includes(message));
  });
}

test("more than 25 companies is rejected", () => {
  const d = tmp();
  writeFileSync(join(d, "many.csv"), "domain\n" + Array.from({ length: 26 }, (_, i) => `c${i}.example\n`).join(""));
  assert.throws(() => RECIPE.readInput(join(d, "many.csv")), (e: Error) => e instanceof InputError && e.message.includes("up to 25 companies"));
});

test("CLI plan mode makes no calls", async () => {
  const out = tmp();
  delete process.env.FIRMABLE_API_KEY;
  const code = await cliMain(RECIPE, ["--input", join(F, "happy.input.csv"), "--config", join(F, "config.json"), "--out", out]);
  assert.equal(code, 0);
  assert.equal(JSON.parse(readFileSync(join(out, "plan.json"), "utf-8")).published_estimate_upper_bound, 5.28);
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
