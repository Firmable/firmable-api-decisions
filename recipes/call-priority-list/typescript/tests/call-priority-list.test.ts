import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, main as cliMain, Json } from "firmable-api-client";
import { fixturesDir, runWithFixtures } from "firmable-api-client/testing";
import { RECIPE, loadConfig, plan, prioritise } from "../src/recipe.js";

const F = fixturesDir("call-priority-list");
const tmp = () => mkdtempSync(join(tmpdir(), "cpl-"));

function run(name: string, o: { maxCredits?: number; out?: string } = {}) {
  const cfg = join(F, `${name}.config.json`);
  return runWithFixtures(RECIPE, {
    inputPath: join(F, `${name}.input.csv`), configPath: existsSync(cfg) ? cfg : join(F, "config.json"),
    scenario: join(F, `${name}.scenario.json`), maxCredits: o.maxCredits ?? 100, outDir: o.out,
  });
}
const byId = (result: Json): Record<string, Json> => Object.fromEntries(result.rows.map((r: Json) => [r.row_id, r]));

test("happy path priorities", async () => {
  const [result, transport] = await run("happy");
  const rows = byId(result);
  const want: Record<string, string> = { p1: "P1", p2: "P2", p3: "P3", p4: "review", p5: "no_priority", p6: "exclude_dnc",
    p7: "not_found", p8: "P1", p9: "invalid_input", p10: "review", p11: "review", p12: "P3" };
  assert.deepEqual(Object.fromEntries(Object.keys(want).map((k) => [k, rows[k].priority])), want);
  assert.equal(rows.p8.duplicate_of, "p1");
  assert.deepEqual(transport.unused(), []);
  assert.equal(transport.sent.filter((r) => r.method === "POST").length, 8);
});

test("every person shows why", async () => {
  const rows = byId((await run("happy"))[0]);
  assert.equal(rows.p11.reason, "Would be P1, but the Do Not Call status is unknown, which blocks P1.");
  assert.ok(rows.p10.reason.startsWith("Would be P1, but the mobile is on the Do Not Call register"));
  assert.ok(Object.values(rows).every((r: Json) => r.reason));
});

test("DNC exclusion uses reachable details as returned", async () => {
  const rows = byId((await run("happy"))[0]);
  assert.equal(rows.p6.deliverable_work_email, false);
  assert.equal(rows.p10.deliverable_work_email, true);
  assert.equal(rows.p12.deliverable_work_email, false);
  assert.equal(rows.p2.deliverable_work_email, null);
});

test("person not found is an outcome, not an error", async () => {
  const [result] = await run("happy");
  assert.equal(byId(result).p7.priority, "not_found");
  assert.deepEqual(result.errors, []);
  const [nf] = await run("not-found-404");
  assert.equal(nf.rows[0].priority, "not_found");
  assert.deepEqual(nf.errors, []);
});

test("decision maker is shown and does not change the priority", async () => {
  const [result] = await run("decision-maker");
  const rows = byId(result);
  assert.equal(rows.d1.priority, "P2");
  assert.equal(rows.d1.answers.decision_maker.outcome, "yes");
  assert.equal(rows.d2.priority, "review");
});

test("rules directly", () => {
  const cfg = { check_reachability: true, check_dnc: true, decision_maker: null };
  const blank = (o: string) => ({ outcome: o, answer: o, details: null, answer_error: null, entity_id: null });
  const a = (s: string, d: string, r = "yes", n = "no", details: Json = null) => {
    const out: Record<string, Json> = { seniority: blank(s), department: blank(d), reachable: blank(r), dnc: blank(n),
      decision_maker: blank("not_checked") };
    out.reachable.details = details;
    return out;
  };
  assert.equal(prioritise(a("yes", "yes"), cfg)[0], "P1");
  assert.equal(prioritise(a("no", "yes"), cfg)[0], "P3");
  assert.equal(prioritise(a("unknown", "no"), cfg)[0], "review");
  assert.equal(prioritise(a("no", "no"), cfg)[0], "no_priority");
  assert.equal(prioritise(a("yes", "yes", "no", "yes", { work_email_held: false }), cfg)[0], "exclude_dnc");
  assert.equal(prioritise(a("yes", "yes", "yes", "yes"), cfg)[0], "review");
  assert.equal(prioritise(a("yes", "error"), cfg)[0], "incomplete");
  assert.equal(prioritise(a("yes", "yes", "unknown", "unknown"), cfg)[0], "P2");
});

test("errors are recorded and 402 stops the run", async () => {
  const [result, transport] = await run("errors");
  const rows = byId(result);
  assert.equal(rows.q1.priority, "incomplete");
  assert.equal(rows.q1.answers.seniority.error.status, 500);
  assert.equal(rows.q2.answers.seniority.error.kind, "invalid_response");
  assert.equal(rows.q2.answers.department.error.kind, "insufficient_credits");
  assert.equal(rows.q3.priority, "not_processed");
  assert.equal(transport.sent.length, 6);
});

test("budget stops before the next paid call", async () => {
  const [result, transport] = await run("budget", { maxCredits: 1.1 });
  const rows = byId(result);
  assert.equal(rows.b1.priority, "P3");
  assert.equal(rows.b2.answers.seniority.error.kind, "budget_exceeded");
  assert.equal(transport.sent.length, 3);
});

test("bad tool and label stop before paid calls", async () => {
  const [result, transport] = await run("bad-tool");
  assert.deepEqual(result.rows.map((r: Json) => r.priority), ["not_processed"]);
  assert.ok(result.errors.map((e: Json) => e.message).join(" ").includes("accepted seniorities: Chief"));
  assert.deepEqual(transport.sent.map((r) => r.path), ["/decisions"]);
});

test("outputs are safe", async () => {
  const out = tmp();
  await run("happy", { out });
  const html = readFileSync(join(out, "report.html"), "utf-8");
  assert.ok(!html.includes("<b>Example</b>") && html.includes("&lt;b&gt;Example&lt;/b&gt;"));
  assert.ok(!readFileSync(join(out, "results.csv"), "utf-8").includes("alex.citizen@alpha.example"));
  assert.ok(!readFileSync(join(out, "results.json"), "utf-8").includes("fbl_dev_"));
});

test("plan counts unique valid people per tool", () => {
  const cfg = loadConfig(JSON.parse(readFileSync(join(F, "config.json"), "utf-8")));
  const rows = RECIPE.readInput(join(F, "happy.input.csv"));
  const calls = plan(rows, cfg);
  assert.deepEqual(calls.slice(1).map((c) => c.requests), [2, 2, 2, 2]);
});

const bad: [(c: Json) => void, string][] = [
  [(c) => { c.target_seniorities = []; }, "target_seniorities must be a list of 1 to 20 labels"],
  [(c) => { c.target_departments = ["Finance", "Finance"]; }, "the same label twice"],
  [(c) => { c.decision_maker = { buyer: "CFO" }; }, "decision_maker.seller must be text"],
  [(c) => { c.check_dnc = "yes"; }, "check_dnc must be true or false"],
  [(c) => { c.batch_size = 200; }, "batch_size must be a whole number from 1 to 100"],
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
  assert.equal(JSON.parse(readFileSync(join(out, "plan.json"), "utf-8")).published_estimate_upper_bound, 1.6);
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
  writeFileSync(join(d, "in.csv"), "name\nAlex Example\n");
  assert.equal(await cliMain(RECIPE, ["--input", join(d, "in.csv"), "--config", join(F, "config.json"), "--out", d]), 2);
});
