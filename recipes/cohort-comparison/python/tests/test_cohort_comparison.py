import csv
import json

import pytest

from cohort_comparison.recipe import RECIPE, load_config, md_escape, plan
from firmable_client.cli import main as cli_main
from firmable_client.errors import ConfigError, InputError
from firmable_client.testing import fixtures_dir, run_with_fixtures

F = fixtures_dir("cohort-comparison")


def run(name, config="config.json", max_credits=100.0, out=None, ext="csv"):
    return run_with_fixtures(RECIPE, input_path=F / f"{name}.input.{ext}", config_path=F / config,
                             scenario=F / f"{name}.scenario.json", max_credits=max_credits, out_dir=out)


def by_id(result):
    return {r["row_id"]: r for r in result["rows"]}


def answers(row):
    return {a["question_id"]: a for a in row["answers"]}


def question(result, qid):
    return next(q for q in result["summary"]["questions"] if q["id"] == qid)


def test_happy_path_rows_cohorts_and_batches():
    result, transport = run("happy")
    rows = by_id(result)
    assert rows["k07"]["status"] == "ignored" and rows["k11"]["status"] == "ignored"
    assert rows["k08"]["status"] == "invalid_input"
    assert rows["k01"]["in_both_cohorts"] is True and rows["k06"]["in_both_cohorts"] is True
    assert rows["k06"]["duplicate_of"] == "k01" and rows["k10"]["duplicate_of"] == "k02"
    assert rows["k09"]["status"] == "incomplete"
    s = result["summary"]
    assert s["cohort_sizes"] == {"customers": 3, "prospects": 4}
    assert s["companies_in_both"] == 1 and s["companies_asked_once"] == 6 and s["ignored_rows"] == 2
    assert s["ignored_cohort_values"] == [{"cohort": "partners", "rows": 1}, {"cohort": "", "rows": 1}]
    # A company in both cohorts is asked once: 6 companies, batches of 3, 2 questions.
    posts = [r for r in transport.sent if r.method == "POST"]
    assert len(posts) == 4 and transport.unused() == []


def test_difference_and_denominators():
    result, _ = run("happy")
    q = question(result, "b2b")
    a, b = (c["measure"] for c in q["cohorts"])
    assert a["yes_share"] == "3 of 3 answered (100.0%)"
    assert b["yes_share"] == "2 of 3 answered (66.7%)" and b["unknown_share"] == "1 of 4 asked (25.0%)"
    assert q["difference"] == {"comparable": True, "yes_share_difference_pp": 33.3,
                               "text": "+33.3 percentage points (customers minus prospects)"}


def test_too_few_answers_gives_no_difference():
    result, _ = run("happy")
    q = question(result, "staff_200")
    assert q["cohorts"][0]["measure"]["yes_share_pct"] is None
    assert q["difference"]["comparable"] is False and q["difference"]["yes_share_difference_pp"] is None
    assert q["difference"]["text"].startswith("too few answers to compare")


def test_unknown_and_row_errors_kept_distinct():
    result, _ = run("happy")
    rows = by_id(result)
    assert answers(rows["k02"])["staff_200"]["answer"] == "unknown"
    b3 = answers(rows["k09"])["staff_200"]
    assert b3["answer"] == "error" and b3["error"]["code"] == "upstream_error"
    m = question(result, "staff_200")["cohorts"][1]["measure"]
    assert (m["yes"], m["no"], m["unknown"], m["error"], m["answered"]) == (1, 2, 0, 1, 3)


def test_negative_difference_and_json_input():
    result, _ = run("comparable", config="comparable.config.json", ext="json")
    q = question(result, "b2b")
    assert q["difference"]["yes_share_difference_pp"] == -66.7
    assert q["difference"]["text"] == "-66.7 percentage points (2025 minus 2026)"


def test_errors_and_402_stop():
    result, transport = run("errors", config="errors.config.json")
    rows = by_id(result)
    assert answers(rows["row-1"])["b2b"]["error"]["status"] == 502
    assert answers(rows["row-3"])["b2b"]["error"]["kind"] == "invalid_response"
    assert answers(rows["row-1"])["staff_200"]["error"]["kind"] == "insufficient_credits"
    assert answers(rows["row-3"])["staff_200"]["answer"] == "not_asked"
    assert result["coverage"][0].startswith("The run stopped early")
    assert len(transport.sent) == 4


def test_budget_stops_before_next_batch():
    result, transport = run("budget", config="budget.config.json", max_credits=1.1)
    rows = by_id(result)
    assert rows["row-3"]["status"] == "not_processed"
    assert question(result, "b2b")["cohorts"][1]["measure"]["not_asked"] == 1
    assert result["errors"][0]["kind"] == "budget_exceeded" and len(transport.sent) == 2


def test_bad_tools_stop_before_paid_calls():
    result, transport = run("bad-tool", config="bad-tool.config.json")
    assert [r["status"] for r in result["rows"]] == ["not_processed"]
    msgs = " ".join(e["message"] for e in result["errors"])
    assert "not a company" in msgs and "staff" in msgs
    assert [r.path for r in transport.sent] == ["/decisions"]


def test_markdown_and_outputs(tmp_path):
    run("happy", out=tmp_path)
    md = (tmp_path / "comparison.md").read_text()
    assert md.startswith("# Cohort comparison: customers and prospects\n")
    assert "| Yes share of answered | 3 of 3 answered (100.0%) | 2 of 3 answered (66.7%) |" in md
    assert "Difference in yes share: +33.3 percentage points (customers minus prospects)." in md
    assert "not tested for statistical significance" in md
    assert "Tool: matches\\_company\\_size" in md
    rows = list(csv.DictReader((tmp_path / "results.csv").open()))
    assert [r["row_id"] for r in rows][:2] == ["k01", "k02"]
    assert rows[0]["b2b"] == "yes" and rows[0]["in_both_cohorts"] == "true" and rows[6]["status"] == "ignored"
    html = (tmp_path / "report.html").read_text()
    assert "<b>A3</b>" not in html and "&lt;b&gt;A3&lt;/b&gt;" in html
    assert "fbl_dev_" not in (tmp_path / "results.json").read_text()


def test_md_escape():
    assert md_escape("a|b *c* _d_ [e](f) <g> `h` \\") == "a\\|b \\*c\\* \\_d\\_ \\[e\\](f) \\<g\\> \\`h\\` \\\\"
    assert md_escape("# heading") == "\\# heading"
    assert md_escape("line\nbreak") == "line break"


def test_plan_counts_companies_once():
    cfg = load_config(json.loads((F / "config.json").read_text()))
    rows = RECIPE.read_input(F / "happy.input.csv")
    calls = {c.endpoint: c for c in plan(rows, cfg)}
    assert calls["POST /decisions"].requests == 4                 # 6 companies, 2 batches, 2 questions
    assert calls["POST /decisions"].to_dict()["published_estimate_upper_bound"] == 0.96   # 12 answers x 0.08


def test_input_needs_cohort_column(tmp_path):
    p = tmp_path / "in.csv"
    p.write_text("domain\na.example\n")
    with pytest.raises(InputError, match="missing column"):
        RECIPE.read_input(p)


@pytest.mark.parametrize("mutate,message", [
    (lambda c: c.update(cohorts=["customers"]), "exactly two cohort values"),
    (lambda c: c.update(cohorts=["a", 2]), "exactly two cohort values"),
    (lambda c: c.update(cohorts=["a", " a "]), "two different values"),
    (lambda c: c.update(questions=[]), "questions must be a list of 1 to 10"),
    (lambda c: c["questions"][1].update(id="b2b"), "used twice"),
    (lambda c: c["questions"][0].update(id="cohort"), "reserved for an output column"),
    (lambda c: c["questions"][0].update(inputs={"company_id": "f900000000001"}), "must not include company_id"),
    (lambda c: c.update(batch_size=150), "batch_size must be a whole number from 1 to 100"),
    (lambda c: c.update(min_answered=-1), "min_answered must be a whole number"),
    (lambda c: c.update(group_by="segment"), "Unknown configuration key"),
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
    assert json.loads((tmp_path / "plan.json").read_text())["requests_upper_bound"] == 5
    assert "no API calls were made" in capsys.readouterr().out


def test_cli_live_needs_limit_and_key(tmp_path, monkeypatch):
    args = ["--input", str(F / "happy.input.csv"), "--config", str(F / "config.json"), "--out", str(tmp_path)]
    assert cli_main(RECIPE, args + ["--live"]) == 2
    monkeypatch.delenv("FIRMABLE_API_KEY", raising=False)
    assert cli_main(RECIPE, args + ["--live", "--max-credits", "5"]) == 2


def test_cli_rejects_bad_input(tmp_path):
    bad = tmp_path / "in.csv"
    bad.write_text("name,cohort\nAcme,customers\n")
    assert cli_main(RECIPE, ["--input", str(bad), "--config", str(F / "config.json"), "--out", str(tmp_path)]) == 2
