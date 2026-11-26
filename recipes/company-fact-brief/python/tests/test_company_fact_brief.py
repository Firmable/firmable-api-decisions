import csv
import json

import pytest

from company_fact_brief.recipe import RECIPE, load_config, md, plan
from firmable_client.cli import main as cli_main
from firmable_client.errors import ConfigError, InputError
from firmable_client.testing import fixtures_dir, run_with_fixtures

F = fixtures_dir("company-fact-brief")


def run(name, max_credits=100.0, out=None):
    cfg = F / f"{name}.config.json"
    return run_with_fixtures(RECIPE, input_path=F / f"{name}.input.csv",
                             config_path=cfg if cfg.exists() else F / "config.json",
                             scenario=F / f"{name}.scenario.json", max_credits=max_credits, out_dir=out)


def by_id(result):
    return {r["row_id"]: r for r in result["rows"]}


def answers(row):
    return {a["question_id"]: a for a in row["answers"]}


def test_happy_path_statuses_and_batches(tmp_path):
    result, transport = run("happy", out=tmp_path)
    rows = by_id(result)
    assert rows["r1"]["status"] == "brief_ready"
    assert rows["r2"]["status"] == "partial"
    assert rows["r3"]["status"] == "brief_ready" and rows["r3"]["duplicate_of"] == "r1"
    assert rows["r3"]["brief_file"] == "brief-r1.md"
    assert rows["r4"]["status"] == "invalid_input"
    assert rows["r5"]["status"] == "company_not_found" and rows["r5"]["answers"] == []
    assert rows["r6"]["status"] == "brief_ready"
    assert transport.unused() == []
    assert len([r for r in transport.sent if r.path == "/company"]) == 4
    decision_calls = [r for r in transport.sent if r.path == "/decisions" and r.method == "POST"]
    assert len(decision_calls) == 8   # 4 questions x 2 batches of up to 2 companies
    assert len(decision_calls[0].json_body["question"]["records"]) == 2
    assert sorted(p.name for p in tmp_path.glob("*.md")) == ["brief-r1.md", "brief-r2.md", "brief-r6.md"]


def test_answers_are_kept_as_returned():
    result, _ = run("happy")
    a = answers(by_id(result)["r1"])
    assert a["b2b"]["outcome"] == "yes"
    assert a["b2b"]["reasoning"]["reason"] == "Sells *to* businesses | per [site](javascript:alert(1))"
    assert a["size_200"]["details"] == {"counted": "worldwide", "staff_band": "201 - 500", "staff_count": 320}
    assert a["size_200"]["inputs"] == {"min_staff": 200}


def test_unknown_is_not_no_and_row_errors_are_not_answers(tmp_path):
    result, _ = run("happy", out=tmp_path)
    a = answers(by_id(result)["r2"])
    assert a["listed"]["outcome"] == "unknown" and a["listed"]["answer"] == "unknown"
    assert a["rd_tax"]["outcome"] == "error" and a["rd_tax"]["answer_error"]["code"] == "upstream_error"
    brief = (tmp_path / "brief-r2.md").read_text()
    unknown_part = brief.split("## What is unknown")[1].split("##")[0]
    assert "Publicly listed: Firmable does not hold this fact." in unknown_part
    assert "Sells to other businesses" not in unknown_part
    assert "## Not answered" in brief and "The decision service did not answer this row." in brief
    assert result["summary"]["question_counts"]["rd_tax"] == {
        "yes": 0, "no": 1, "unknown": 1, "not_found": 0, "error": 1, "not_asked": 0}


def test_conflicting_profile_facts_are_flagged_not_corrected(tmp_path):
    result, _ = run("happy", out=tmp_path)
    r6 = by_id(result)["r6"]
    assert r6["company"]["year_founded"] == 2031
    assert len(r6["conflicts"]) == 2
    assert "year_founded is 2031" in r6["conflicts"][0]
    assert "company_type is \"Privately Held\"" in r6["conflicts"][1]
    brief = (tmp_path / "brief-r6.md").read_text()
    assert "## Possible conflicts" in brief and "does not correct them" in brief
    assert by_id(result)["r1"]["conflicts"] == []


def test_markdown_is_escaped_and_deterministic(tmp_path):
    run("happy", out=tmp_path)
    brief = (tmp_path / "brief-r1.md").read_text()
    assert brief.startswith("# Company fact brief: Alpha \\*Example\\* \\<b\\>Pty\\</b\\>")
    assert "Sells \\*to\\* businesses \\| per \\[site\\](javascript:alert(1))" in brief
    assert "[https://www.alpha.example](https://www.alpha.example)" in brief
    assert "| year\\_founded | 2011 |" in brief
    assert brief.rstrip().endswith("is a returned value or fixed text.")
    assert md("# heading") == "\\# heading" and md(None) == "not returned" and md(["a", "b"]) == "a, b"
    other = tmp_path / "again"
    run("happy", out=other)
    assert (other / "brief-r1.md").read_text() == brief


def test_errors_are_recorded_and_402_stops_the_run():
    result, transport = run("errors")
    rows = by_id(result)
    assert rows["e1"]["status"] == "error" and rows["e1"]["error"]["status"] == 500
    a = answers(rows["e2"])
    assert a["b2b"]["error"]["kind"] == "timeout"
    assert a["listed"]["error"]["kind"] == "invalid_response"
    assert a["size_200"]["error"]["kind"] == "insufficient_credits"
    assert a["rd_tax"]["outcome"] == "not_asked"
    assert rows["e2"]["status"] == "partial"
    assert rows["e3"]["status"] == "not_processed"
    assert result["coverage"][0].startswith("The run stopped early")
    assert result["credits"]["requests_with_uncertain_charge"] == 3
    assert len(transport.sent) == 7


def test_budget_stops_before_the_next_paid_call():
    result, transport = run("budget", max_credits=3.2)
    rows = by_id(result)
    assert [rows[k]["status"] for k in ("row-1", "row-2")] == ["partial", "partial"]
    assert answers(rows["row-1"])["b2b"]["outcome"] == "yes"
    assert answers(rows["row-1"])["listed"]["error"]["kind"] == "budget_exceeded"
    assert answers(rows["row-1"])["size_200"]["outcome"] == "not_asked"
    assert len(transport.sent) == 4


def test_bad_tool_stops_before_paid_calls():
    result, transport = run("bad-tool")
    assert [r["status"] for r in result["rows"]] == ["not_processed"]
    msgs = " ".join(e["message"] for e in result["errors"])
    assert "'is_imaginary' is not in the current tool list" in msgs
    assert "'works_at_company' answers about person" in msgs
    assert "does not accept input(s): colour" in msgs and "needs input(s): types" in msgs
    assert [r.path for r in transport.sent] == ["/decisions"]


def test_not_fetched_asks_by_domain_and_keeps_not_found():
    result, transport = run("not-fetched")
    rows = by_id(result)
    assert rows["n1"]["status"] == "brief_ready" and rows["n1"]["company"] is None
    assert rows["n2"]["status"] == "company_not_found"
    assert answers(rows["n2"])["b2b"]["answer_error"]["code"] == "company_not_found"
    assert all(r.query == {} for r in transport.sent)
    assert "/company" not in [r.path for r in transport.sent]


def test_outputs_are_safe(tmp_path):
    run("happy", out=tmp_path)
    html = (tmp_path / "report.html").read_text()
    assert "<b>Pty</b>" not in html and "&lt;b&gt;Pty&lt;/b&gt;" in html
    assert 'href="javascript' not in html
    rows = list(csv.DictReader((tmp_path / "results.csv").open()))
    assert [r["row_id"] for r in rows] == ["r1", "r2", "r3", "r4", "r5", "r6"]
    assert rows[0]["q_b2b"] == "yes" and rows[1]["q_rd_tax"] == "error"
    assert "fbl_dev_" not in (tmp_path / "results.json").read_text()


def test_plan_counts_unique_valid_companies_and_batches():
    cfg = load_config(json.loads((F / "config.json").read_text()))
    rows = RECIPE.read_input(F / "happy.input.csv")
    calls = {c.endpoint: c for c in plan(rows, cfg)}
    assert calls["GET /company"].requests == 4       # 6 rows, 1 duplicate, 1 invalid
    assert calls["POST /decisions"].requests == 8    # 4 questions x 2 batches
    assert calls["POST /decisions"].to_dict()["published_estimate_upper_bound"] == 1.28


@pytest.mark.parametrize("mutate,message", [
    (lambda c: c.update(questions=[]), "questions must be a list of 1 to 10"),
    (lambda c: c.update(questions=c["questions"] * 3), "questions must be a list of 1 to 10"),
    (lambda c: c["questions"][1].update(id="b2b"), "used twice"),
    (lambda c: c["questions"][0].update(want="yes"), "unknown key"),
    (lambda c: c.update(batch_size=101), "batch_size must be a whole number from 1 to 100"),
    (lambda c: c.update(with_reasoning="yes"), "with_reasoning must be true or false"),
    (lambda c: c.update(colour="orange"), "Unknown configuration key"),
])
def test_invalid_config(mutate, message):
    cfg = json.loads((F / "config.json").read_text())
    mutate(cfg)
    with pytest.raises(ConfigError, match=message):
        load_config(cfg)


def test_more_than_25_companies_is_rejected(tmp_path):
    p = tmp_path / "many.csv"
    p.write_text("domain\n" + "".join(f"c{i}.example\n" for i in range(26)))
    with pytest.raises(InputError, match="up to 25 companies"):
        RECIPE.read_input(p)


def test_cli_plan_mode_makes_no_calls(tmp_path, capsys, monkeypatch):
    monkeypatch.delenv("FIRMABLE_API_KEY", raising=False)
    code = cli_main(RECIPE, ["--input", str(F / "happy.input.csv"), "--config", str(F / "config.json"),
                             "--out", str(tmp_path)])
    assert code == 0
    plan_json = json.loads((tmp_path / "plan.json").read_text())
    assert plan_json["published_estimate_upper_bound"] == 5.28   # 4 profiles + 16 answers with reasoning
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
