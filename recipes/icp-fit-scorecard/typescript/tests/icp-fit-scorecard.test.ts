import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, main as cliMain, Json } from "firmable-api-client";
import { fixturesDir, runWithFixtures } from "firmable-api-client/testing";
import { RECIPE, loadConfig, plan } from "../src/recipe.js";

const F = fixturesDir("icp-fit-scorecard");
const tmp = () => mkdtempSync(join(tmpdir(), "icp-"));

function run(name: string, o: { maxCredits?: number; out?: string } = {}) {
  const cfg = join(F, `${name}.config.json`);
  return runWithFixtures(RECIPE, {
    inputPath: join(F, `${name}.input.csv`), configPath: existsSync(cfg) ? cfg : join(F, "config.json"),
    scenario: join(F, `${name}.scenario.json`), maxCredits: o.maxCredits ?? 100, outDir: o.out,
  });
}
const byId = (result: Json): Record<string, Json> => Object.fromEntries(result.rows.map((r: Json) => [r.row_id, r]));

test("happy path statuses, tiers and batches", async () => {
  const [result, transport] = await run("happy");
  const rows = byId(result);
  assert.deepEqual(["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8"].map((k) => rows[k].status),
    ["fit", "fit", "not_fit", "needs_review", "fit", "invalid_input", "not_found", "error"]);
  assert.deepEqual(["a1", "a2", "a3", "a4"].map((k) => rows[k].tier), ["tier_1", "tier_2", null, "check"]);
  assert.equal(rows.a5.duplicate_of, "a1");
  assert.deepEqual(transport.unused(), []);
  assert.equal(transport.sent.filter((r) => r.method === "POST").length, 2);
});

test("criteria are met, not met or not shown", async () => {
  const rows = byId((await run("happy"))[0]);
  assert.equal(rows.a1.criteria_met.length, 3);
  assert.deepEqual(rows.a2.criteria_not_shown, ["Has a sales team", "Operates warehouses in Australia"]);
  assert.deepEqual(rows.a3.criteria_not_met, ["Has a sales team"]);
  assert.deepEqual(rows.a3.criteria_other, [{ criterion: "Runs its own truck fleet", met: false }]);
  assert.deepEqual(rows.a3.filters, { countries: "met", min_staff: "not_met" });
});

test("unknown never satisfies yes or no", async () => {
  const rows = byId((await run("happy"))[0]);
  assert.equal(rows.a4.status, "needs_review");
  assert.equal(rows.a4.tier, "check");
});

test("no tiers and criteria that are not a list", async () => {
  const [result] = await run("no-tiers");
  const r = result.rows[0];
  assert.equal(r.status, "fit");
  assert.equal(r.tier, null);
  assert.equal(r.criteria_not_shown.length, 3);
});

test("errors are recorded and 402 stops the run", async () => {
  const [result, transport] = await run("errors");
  const rows = byId(result);
  assert.equal(rows.e1.answer.error.kind, "invalid_response");
  assert.equal(rows.e2.answer.error.kind, "timeout");
  assert.equal(rows.e3.answer.error.status, 502);
  assert.equal(rows.e4.answer.error.kind, "insufficient_credits");
  assert.equal(rows.e5.status, "not_processed");
  assert.equal(result.credits.requests_with_uncertain_charge, 3);
  assert.equal(transport.sent.length, 5);
});

test("budget stops before the next paid call", async () => {
  const [result, transport] = await run("budget", { maxCredits: 1.1 });
  const rows = byId(result);
  assert.equal(rows["row-1"].status, "fit");
  assert.equal(rows["row-2"].answer.error.kind, "budget_exceeded");
  assert.equal(transport.sent.length, 2);
});

test("missing tool stops before paid calls", async () => {
  const [result, transport] = await run("bad-tool");
  assert.deepEqual(result.rows.map((r: Json) => r.status), ["not_processed"]);
  assert.deepEqual(transport.sent.map((r) => r.path), ["/decisions"]);
});

test("outputs are safe", async () => {
  const out = tmp();
  await run("happy", { out });
  const html = readFileSync(join(out, "report.html"), "utf-8");
  assert.ok(!html.includes("<b>Example</b>") && html.includes("&lt;b&gt;Example&lt;/b&gt;"));
  assert.ok(!html.includes("<b>as listed</b>"));
  assert.ok(!readFileSync(join(out, "results.json"), "utf-8").includes("fbl_dev_"));
});

test("plan counts unique valid accounts in batches", () => {
  const cfg = loadConfig(JSON.parse(readFileSync(join(F, "config.json"), "utf-8")));
  const rows = RECIPE.readInput(join(F, "happy.input.csv"));
  const calls = Object.fromEntries(plan(rows, cfg).map((c) => [c.endpoint, c]));
  assert.equal(calls["POST /decisions"].requests, 2);
});

const bad: [(c: Json) => void, string][] = [
  [(c) => { delete c.icp; }, "icp is required"],
  [(c) => { c.icp.description = "Mid-size B2B"; }, "icp.description is not accepted"],
  [(c) => { c.icp.criteria = ["Has a team", "has a  TEAM"]; }, "the same criterion twice"],
  [(c) => { c.icp.staff_in = "UK"; }, "icp.staff_in must be one of"],
  [(c) => { c.tiers[0].when.fit = "maybe"; }, "when.fit must be yes, no or unknown"],
  [(c) => { c.tiers[0].when.min_criteria_met = 4; }, "icp.criteria has 3 criteria"],
  [(c) => { c.tiers[1].id = "tier_1"; }, "used twice"],
  [(c) => { c.batch_size = 0; }, "batch_size must be a whole number from 1 to 100"],
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
  assert.equal(JSON.parse(readFileSync(join(out, "plan.json"), "utf-8")).published_estimate_upper_bound, 0.48);
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
