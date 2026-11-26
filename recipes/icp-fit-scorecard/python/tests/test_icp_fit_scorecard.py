import csv
import json

import pytest

from firmable_client.cli import main as cli_main
from firmable_client.errors import ConfigError
from firmable_client.testing import fixtures_dir, run_with_fixtures
from icp_fit_scorecard.recipe import RECIPE, load_config, plan

F = fixtures_dir("icp-fit-scorecard")


def run(name, max_credits=100.0, out=None):
    cfg = F / f"{name}.config.json"
    return run_with_fixtures(RECIPE, input_path=F / f"{name}.input.csv",
                             config_path=cfg if cfg.exists() else F / "config.json",
                             scenario=F / f"{name}.scenario.json", max_credits=max_credits, out_dir=out)


def by_id(result):
    return {r["row_id"]: r for r in result["rows"]}


def test_happy_path_statuses_tiers_and_batches():
    result, transport = run("happy")
    rows = by_id(result)
    assert [rows[k]["status"] for k in ("a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8")] == [
        "fit", "fit", "not_fit", "needs_review", "fit", "invalid_input", "not_found", "error"]
    assert [rows[k]["tier"] for k in ("a1", "a2", "a3", "a4")] == ["tier_1", "tier_2", None, "check"]
    assert rows["a3"]["tier_reason"] == "No tier matched."
    assert rows["a5"]["duplicate_of"] == "a1" and rows["a5"]["tier"] == "tier_1"
    assert rows["a7"]["tier"] is None and rows["a7"]["tier_reason"] == "No tier: there is no answer."
    assert transport.unused() == []
    calls = [r for r in transport.sent if r.method == "POST"]
    assert len(calls) == 2 and [len(c.json_body["question"]["records"]) for c in calls] == [3, 3]
    assert calls[0].json_body["question"]["icp"]["criteria"][0] == "Sells to other businesses"


def test_criteria_are_met_not_met_or_not_shown():
    rows = by_id(run("happy")[0])
    assert rows["a1"]["criteria_met"] == ["Sells to other businesses", "Has a sales team",
                                          "Operates warehouses in Australia"]   # matched ignoring case and spacing
    assert rows["a2"]["criteria_met"] == ["Sells to other businesses"]
    assert rows["a2"]["criteria_not_shown"] == ["Has a sales team", "Operates warehouses in Australia"]
    assert rows["a2"]["criteria"][1]["returned"] == {"criterion": "Has a sales team", "met": None}
    assert rows["a3"]["criteria_not_met"] == ["Has a sales team"]
    assert rows["a3"]["criteria_other"] == [{"criterion": "Runs its own truck fleet", "met": False}]
    assert rows["a3"]["filters"] == {"countries": "met", "min_staff": "not_met"}


def test_unknown_never_satisfies_yes_or_no():
    rows = by_id(run("happy")[0])
    assert rows["a4"]["answer"]["answer"] == "unknown"
    assert rows["a4"]["status"] == "needs_review" and "Unknown is not a no." in rows["a4"]["status_reason"]
    assert rows["a4"]["tier"] == "check"   # only the tier that asks for unknown


def test_summary_counts():
    s = run("happy")[0]["summary"]
    assert s["status_counts"] == {"fit": 3, "not_fit": 1, "needs_review": 1, "invalid_input": 1, "not_found": 1,
                                  "error": 1}
    assert s["tier_counts"] == {"tier_1": 2, "tier_2": 1, "no_tier": 1, "check": 1}
    assert s["criteria_counts"]["Has a sales team"] == {"met": 1, "not_met": 1, "not_shown": 2}


def test_no_tiers_and_criteria_not_a_list():
    result, transport = run("no-tiers")
    r = result["rows"][0]
    assert r["status"] == "fit" and r["tier"] is None and r["tier_reason"] is None
    assert r["criteria_not_shown"] == ["Sells to other businesses", "Has a sales team",
                                       "Operates warehouses in Australia"]
    assert transport.sent[1].query == {}


def test_errors_are_recorded_and_402_stops_the_run():
    result, transport = run("errors")
    rows = by_id(result)
    assert rows["e1"]["answer"]["error"]["kind"] == "invalid_response"
    assert rows["e2"]["answer"]["error"]["kind"] == "timeout"
    assert rows["e3"]["answer"]["error"]["status"] == 502
    assert rows["e4"]["answer"]["error"]["kind"] == "insufficient_credits"
    assert [rows[k]["status"] for k in ("e1", "e2", "e3", "e4")] == ["error"] * 4
    assert rows["e5"]["status"] == "not_processed"
    assert result["coverage"][0].startswith("The run stopped early")
    assert result["credits"]["requests_with_uncertain_charge"] == 3
    assert len(transport.sent) == 5


def test_budget_stops_before_the_next_paid_call():
    result, transport = run("budget", max_credits=1.1)
    rows = by_id(result)
    assert rows["row-1"]["status"] == "fit"
    assert rows["row-2"]["status"] == "error" and rows["row-2"]["answer"]["error"]["kind"] == "budget_exceeded"
    assert len(transport.sent) == 2


def test_missing_tool_stops_before_paid_calls():
    result, transport = run("bad-tool")
    assert [r["status"] for r in result["rows"]] == ["not_processed"]
    assert "'is_icp_fit' is not in the current tool list" in result["errors"][0]["message"]
    assert [r.path for r in transport.sent] == ["/decisions"]


def test_outputs_are_safe(tmp_path):
    run("happy", out=tmp_path)
    html = (tmp_path / "report.html").read_text()
    assert "<b>Example</b>" not in html and "&lt;b&gt;Example&lt;/b&gt;" in html
    assert "<b>as listed</b>" not in html
    rows = list(csv.DictReader((tmp_path / "results.csv").open()))
    assert [r["row_id"] for r in rows] == ["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8"]
    assert rows[1]["criteria_not_shown"] == "Has a sales team; Operates warehouses in Australia"
    assert rows[2]["filters"] == '{"countries":"met","min_staff":"not_met"}'
    assert "fbl_dev_" not in (tmp_path / "results.json").read_text()


def test_plan_counts_unique_valid_accounts_in_batches():
    cfg = load_config(json.loads((F / "config.json").read_text()))
    rows = RECIPE.read_input(F / "happy.input.csv")
    calls = {c.endpoint: c for c in plan(rows, cfg)}
    assert calls["POST /decisions"].requests == 2          # 6 unique valid accounts, batches of 3
    assert calls["POST /decisions"].to_dict()["published_estimate_upper_bound"] == 0.48


@pytest.mark.parametrize("mutate,message", [
    (lambda c: c.pop("icp"), "icp is required"),
    (lambda c: c["icp"].update(description="Mid-size B2B"), "icp.description is not accepted"),
    (lambda c: c["icp"].update(criteria=[]), "icp.criteria must be a list of 1 to 10"),
    (lambda c: c["icp"].update(criteria=["Has a team", "has a  TEAM"]), "the same criterion twice"),
    (lambda c: c["icp"].update(staff_in="UK"), "icp.staff_in must be one of"),
    (lambda c: c["icp"].update(revenue_bands=["$2M"]), "not a Firmable revenue band"),
    (lambda c: c["icp"].update(min_staff=500, max_staff=10), "more than icp.max_staff"),
    (lambda c: c["tiers"][0]["when"].update(fit="maybe"), "when.fit must be yes, no or unknown"),
    (lambda c: c["tiers"][0]["when"].update(min_criteria_met=4), "icp.criteria has 3 criteria"),
    (lambda c: c["tiers"][1].update(id="tier_1"), "used twice"),
    (lambda c: c["tiers"][2].update(when={}), "at least one condition"),
    (lambda c: c.update(batch_size=0), "batch_size must be a whole number from 1 to 100"),
    (lambda c: c.update(colour="orange"), "Unknown configuration key"),
])
def test_invalid_config(mutate, message):
    cfg = json.loads((F / "config.json").read_text())
    mutate(cfg)
    with pytest.raises(ConfigError, match=message):
        load_config(cfg)


def test_cli_plan_mode_makes_no_calls(tmp_path, capsys, monkeypatch):
    monkeypatch.delenv("FIRMABLE_API_KEY", raising=False)
    code = cli_main(RECIPE, ["--input", str(F / "happy.input.csv"), "--config", str(F / "config.json"),
                             "--out", str(tmp_path)])
    assert code == 0
    assert json.loads((tmp_path / "plan.json").read_text())["published_estimate_upper_bound"] == 0.48
    assert "no API calls were made" in capsys.readouterr().out


def test_cli_live_needs_limit_and_key(tmp_path, monkeypatch):
    args = ["--input", str(F / "happy.input.csv"), "--config", str(F / "config.json"), "--out", str(tmp_path)]
    assert cli_main(RECIPE, args + ["--live"]) == 2
    monkeypatch.delenv("FIRMABLE_API_KEY", raising=False)
    assert cli_main(RECIPE, args + ["--live", "--max-credits", "5"]) == 2


def test_cli_rejects_bad_input(tmp_path):
    bad = tmp_path / "in.csv"
    bad.write_text("name\nAcme\n")
    assert cli_main(RECIPE, ["--input", str(bad), "--config", str(F / "config.json"), "--out", str(tmp_path)]) == 2
