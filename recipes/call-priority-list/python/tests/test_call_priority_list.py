import csv
import json

import pytest

from call_priority_list.recipe import RECIPE, _blank, load_config, plan, prioritise
from firmable_client.cli import main as cli_main
from firmable_client.errors import ConfigError
from firmable_client.testing import fixtures_dir, run_with_fixtures

F = fixtures_dir("call-priority-list")


def run(name, max_credits=100.0, out=None):
    cfg = F / f"{name}.config.json"
    return run_with_fixtures(RECIPE, input_path=F / f"{name}.input.csv",
                             config_path=cfg if cfg.exists() else F / "config.json",
                             scenario=F / f"{name}.scenario.json", max_credits=max_credits, out_dir=out)


def by_id(result):
    return {r["row_id"]: r for r in result["rows"]}


def test_happy_path_priorities():
    result, transport = run("happy")
    rows = by_id(result)
    want = {"p1": "P1", "p2": "P2", "p3": "P3", "p4": "review", "p5": "no_priority", "p6": "exclude_dnc",
            "p7": "not_found", "p8": "P1", "p9": "invalid_input", "p10": "review", "p11": "review", "p12": "P3"}
    assert {k: rows[k]["priority"] for k in want} == want
    assert rows["p8"]["duplicate_of"] == "p1"
    assert transport.unused() == []
    posts = [r for r in transport.sent if r.method == "POST"]
    assert len(posts) == 8   # 4 tools x 2 batches of 5 people
    assert posts[0].json_body["question"]["records"][1] == {"work_email": "alex.citizen@alpha.example",
                                                            "external_id": "subject-2"}


def test_every_person_shows_why():
    rows = by_id(run("happy")[0])
    assert rows["p2"]["reason"].startswith("Seniority and department match; reachability is unknown.")
    assert rows["p4"]["reason"] == ("The seniority matches; the department is unknown, which blocks a higher "
                                    "priority.")
    assert rows["p10"]["reason"].startswith("Would be P1, but the mobile is on the Do Not Call register")
    assert rows["p11"]["reason"] == "Would be P1, but the Do Not Call status is unknown, which blocks P1."
    assert rows["p12"]["reason"].startswith("Seniority and department match, but Firmable holds no reachable channel.")
    assert all(r.get("reason") for r in rows.values())


def test_dnc_exclusion_uses_reachable_details_as_returned():
    rows = by_id(run("happy")[0])
    assert rows["p6"]["deliverable_work_email"] is False
    assert rows["p6"]["answers"]["reachable"]["details"]["work_email_held"] is False
    assert rows["p10"]["deliverable_work_email"] is True        # on DNC but emailable: review, not excluded
    assert rows["p12"]["deliverable_work_email"] is False       # grade Unsure is not deliverable
    assert rows["p2"]["deliverable_work_email"] is None


def test_person_not_found_is_an_outcome_not_an_error():
    result, _ = run("happy")
    p7 = by_id(result)["p7"]
    assert p7["answers"]["seniority"]["outcome"] == "not_found"
    assert p7["reason"] == "Firmable did not find this person (person_not_found)."
    assert result["errors"] == []
    result, _ = run("not-found-404")
    assert result["rows"][0]["priority"] == "not_found" and result["errors"] == []


def test_decision_maker_is_shown_and_does_not_change_priority():
    result, transport = run("decision-maker")
    rows = by_id(result)
    assert rows["d1"]["priority"] == "P2" and rows["d1"]["answers"]["decision_maker"]["outcome"] == "yes"
    assert "reachability was not checked" in rows["d1"]["reason"]
    assert rows["d2"]["priority"] == "review"
    assert rows["d2"]["answers"]["reachable"]["outcome"] == "not_checked"
    dm_call = [r for r in transport.sent if r.json_body and r.json_body["tool"] == "is_decision_maker"][0]
    assert dm_call.json_body["question"]["seller"].startswith("A finance automation platform")
    assert any("does not change the priority" in c for c in result["coverage"])


def test_rules_directly():
    cfg = {"check_reachability": True, "check_dnc": True, "decision_maker": None}

    def a(s, d, r="yes", n="no", details=None):
        out = {k: _blank("not_checked") for k in ("seniority", "department", "reachable", "dnc", "decision_maker")}
        for k, v in (("seniority", s), ("department", d), ("reachable", r), ("dnc", n)):
            out[k] = {**_blank(v), "answer": v}
        out["reachable"]["details"] = details
        return out

    assert prioritise(a("yes", "yes"), cfg)[0] == "P1"
    assert prioritise(a("no", "yes"), cfg)[0] == "P3"
    assert prioritise(a("unknown", "no"), cfg)[0] == "review"
    assert prioritise(a("no", "no"), cfg)[0] == "no_priority"
    assert prioritise(a("yes", "yes", "no", "yes", {"work_email_held": False}), cfg)[0] == "exclude_dnc"
    assert prioritise(a("yes", "yes", "yes", "yes", None), cfg)[0] == "review"   # email not known: not excluded
    assert prioritise(a("yes", "error"), cfg)[0] == "incomplete"
    assert prioritise(a("yes", "yes", "unknown", "unknown"), cfg)[0] == "P2"     # DNC unknown blocks P1 only


def test_errors_are_recorded_and_402_stops_the_run():
    result, transport = run("errors")
    rows = by_id(result)
    assert rows["q1"]["priority"] == "incomplete"
    assert rows["q1"]["answers"]["seniority"]["error"]["status"] == 500
    assert rows["q2"]["answers"]["seniority"]["error"]["kind"] == "invalid_response"
    assert rows["q2"]["answers"]["department"]["error"]["kind"] == "insufficient_credits"
    assert rows["q2"]["answers"]["reachable"]["outcome"] == "not_asked"
    assert rows["q3"]["priority"] == "not_processed"
    assert result["coverage"][0].startswith("The run stopped early")
    assert len(transport.sent) == 6


def test_budget_stops_before_the_next_paid_call():
    result, transport = run("budget", max_credits=1.1)
    rows = by_id(result)
    assert rows["b1"]["priority"] == "P3"
    assert rows["b2"]["priority"] == "incomplete"
    assert rows["b2"]["answers"]["seniority"]["error"]["kind"] == "budget_exceeded"
    assert len(transport.sent) == 3


def test_bad_tool_and_label_stop_before_paid_calls():
    result, transport = run("bad-tool")
    assert [r["priority"] for r in result["rows"]] == ["not_processed"]
    msgs = " ".join(e["message"] for e in result["errors"])
    assert "'is_decision_maker' is not in the current tool list" in msgs
    assert "accepted seniorities: Chief" in msgs
    assert [r.path for r in transport.sent] == ["/decisions"]


def test_outputs_are_safe_and_in_input_order(tmp_path):
    run("happy", out=tmp_path)
    html = (tmp_path / "report.html").read_text()
    assert "<b>Example</b>" not in html and "&lt;b&gt;Example&lt;/b&gt;" in html
    rows = list(csv.DictReader((tmp_path / "results.csv").open()))
    assert [r["row_id"] for r in rows] == [f"p{i}" for i in range(1, 13)]
    assert rows[0]["priority"] == "P1" and rows[0]["work_email_grade"] == "Highly likely"
    assert rows[5]["dnc_status"] == "registered"
    text = (tmp_path / "results.csv").read_text()
    assert "alex.citizen@alpha.example" not in text
    assert "fbl_dev_" not in (tmp_path / "results.json").read_text()


def test_plan_counts_unique_valid_people_per_tool():
    cfg = load_config(json.loads((F / "config.json").read_text()))
    rows = RECIPE.read_input(F / "happy.input.csv")
    calls = plan(rows, cfg)
    assert [c.endpoint for c in calls] == ["GET /decisions"] + ["POST /decisions"] * 4
    assert [c.requests for c in calls[1:]] == [2, 2, 2, 2]   # 10 unique valid people, batches of 5
    assert calls[1].to_dict()["published_estimate_upper_bound"] == 0.4


@pytest.mark.parametrize("mutate,message", [
    (lambda c: c.update(target_seniorities=[]), "target_seniorities must be a list of 1 to 20 labels"),
    (lambda c: c.update(target_departments=["Finance", "Finance"]), "the same label twice"),
    (lambda c: c.update(decision_maker={"buyer": "CFO"}), "decision_maker.seller must be text"),
    (lambda c: c.update(decision_maker={"seller": "Payroll", "budget": 5}), "decision_maker has unknown key"),
    (lambda c: c.update(check_dnc="yes"), "check_dnc must be true or false"),
    (lambda c: c.update(batch_size=200), "batch_size must be a whole number from 1 to 100"),
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
    assert json.loads((tmp_path / "plan.json").read_text())["published_estimate_upper_bound"] == 1.6
    assert "no API calls were made" in capsys.readouterr().out


def test_cli_live_needs_limit_and_key(tmp_path, monkeypatch):
    args = ["--input", str(F / "happy.input.csv"), "--config", str(F / "config.json"), "--out", str(tmp_path)]
    assert cli_main(RECIPE, args + ["--live"]) == 2
    monkeypatch.delenv("FIRMABLE_API_KEY", raising=False)
    assert cli_main(RECIPE, args + ["--live", "--max-credits", "5"]) == 2


def test_cli_rejects_bad_input(tmp_path):
    bad = tmp_path / "in.csv"
    bad.write_text("name\nAlex Example\n")
    assert cli_main(RECIPE, ["--input", str(bad), "--config", str(F / "config.json"), "--out", str(tmp_path)]) == 2
