import csv
import json
import re

import pytest

from cohort_question_radar.recipe import ASSET, RECIPE, load_config, plan
from firmable_client.cli import main as cli_main
from firmable_client.errors import ConfigError
from firmable_client.testing import fixtures_dir, run_with_fixtures

F = fixtures_dir("cohort-question-radar")


def run(name, config="config.json", max_credits=100.0, out=None, ext="csv"):
    return run_with_fixtures(RECIPE, input_path=F / f"{name}.input.{ext}", config_path=F / config,
                             scenario=F / f"{name}.scenario.json", max_credits=max_credits, out_dir=out)


def by_id(result):
    return {r["row_id"]: r for r in result["rows"]}


def answers(row):
    return {a["question_id"]: a for a in row["answers"]}


def question(result, qid):
    return next(q for q in result["summary"]["questions"] if q["id"] == qid)


def test_happy_path_statuses_and_batches():
    result, transport = run("happy")
    rows = by_id(result)
    assert rows["r01"]["status"] == "answered"
    assert rows["r04"]["duplicate_of"] == "r01" and rows["r04"]["status"] == "answered"
    assert rows["r05"]["status"] == "invalid_input"
    assert rows["r10"]["status"] == "invalid_input" and "f123" in rows["r10"]["status_reason"]
    assert rows["r06"]["firmable_id"] == "f900000000006"
    assert rows["r07"]["status"] == "not_found"
    assert rows["r11"]["status"] == "incomplete"
    assert transport.unused() == []
    # 7 unique companies, batches of 4: two requests per question, plus the tool list.
    posts = [r for r in transport.sent if r.method == "POST"]
    assert len(posts) == 8 and len(transport.sent) == 9
    assert all(len(r.json_body["question"]["records"]) <= 4 for r in posts)
    assert result["summary"]["companies_in_cohort"] == 7


def test_measure_block_states_denominators():
    result, _ = run("happy")
    b = question(result, "b2b")["measure"]
    assert (b["companies_in_cohort"], b["companies_asked"], b["yes"], b["no"], b["unknown"], b["error"],
            b["not_found"]) == (7, 7, 3, 1, 1, 1, 1)
    assert b["answered"] == 4 and b["yes_share_pct"] == 75.0
    assert b["yes_share"] == "3 of 4 answered (75.0%)"
    assert b["unknown_share"] == "1 of 7 asked (14.3%)"


def test_unknown_is_never_no_and_row_errors_are_isolated():
    result, _ = run("happy")
    rows = by_id(result)
    assert answers(rows["r08"])["b2b"]["answer"] == "unknown"
    eta = answers(rows["r11"])
    assert eta["b2b"]["answer"] == "error" and eta["b2b"]["error"]["code"] == "upstream_error"
    assert eta["staff_200"]["answer"] == "unknown"
    assert answers(rows["r07"])["b2b"]["answer"] == "not_found"
    assert any(e["kind"] == "answer_error" and e["question_id"] == "b2b" for e in result["errors"])
    assert not any(e.get("code") == "company_not_found" for e in result["errors"])


def test_groups_and_too_few_answers():
    result, _ = run("happy")
    groups = {g["group"]: g["measure"] for g in question(result, "b2b")["groups"]}
    assert list(groups) == ["Software", "Payments", "Logistics", "(no value)"]
    assert groups["Software"]["companies_in_cohort"] == 3     # alpha, beta, eta
    assert groups["Software"]["yes_share_pct"] is None
    assert groups["Software"]["yes_share"] == "too few answers to compare (2 answered, minimum 3)"
    assert groups["Payments"]["companies_in_cohort"] == 3     # gamma, zeta and beta again
    assert any("more than one group" in c for c in result["coverage"])


def test_equivalent_questions_kept_as_returned_and_id_conflict_surfaced():
    result, _ = run("happy")
    gamma = answers(by_id(result)["r03"])
    assert gamma["au_code"]["answer"] == "yes" and gamma["au_name"]["answer"] == "unknown"
    assert by_id(result)["r03"]["firmable_ids_differ"] is True
    assert any("different Firmable IDs" in c and "gamma.example" in c for c in result["coverage"])


def test_reasoning_is_preserved():
    result, _ = run("happy")
    a = answers(by_id(result)["r01"])["b2b"]
    assert a["reasoning"]["source"] == "Firmable company data" and a["reasoning"]["last_refreshed"] == "2026-11-18"
    assert a["details"] == {"sells_to": "businesses"} and a["credits"] == 0.08


def test_errors_and_402_stop():
    result, transport = run("errors", config="errors.config.json")
    rows = by_id(result)
    e1 = answers(rows["e1"])
    assert e1["b2b"]["answer"] == "error" and e1["b2b"]["error"]["status"] == 502
    assert e1["staff_200"]["error"]["kind"] == "timeout"
    assert answers(rows["e3"])["b2b"]["error"]["kind"] == "invalid_response"
    assert answers(rows["e5"])["b2b"]["answer"] == "yes"
    assert "external_id 'c-6'" in answers(rows["e6"])["b2b"]["error"]["message"]
    assert answers(rows["e4"])["staff_200"]["answer"] == "unknown"
    assert answers(rows["e5"])["staff_200"]["error"]["kind"] == "insufficient_credits"
    assert all(answers(r)["au_code"]["answer"] == "not_asked" for r in result["rows"])
    assert result["coverage"][0].startswith("The run stopped early")
    assert result["credits"]["requests_with_uncertain_charge"] == 3
    assert len(transport.sent) == 7


def test_budget_stops_before_next_batch():
    result, transport = run("budget", config="budget.config.json", max_credits=1.1)
    rows = by_id(result)
    assert rows["row-1"]["status"] == "answered" and rows["row-3"]["status"] == "not_processed"
    assert answers(rows["row-3"])["b2b"]["answer"] == "not_asked"
    assert result["errors"][0]["kind"] == "budget_exceeded"
    assert len(transport.sent) == 2


def test_bad_tools_stop_before_paid_calls():
    result, transport = run("bad-tool", config="bad-tool.config.json")
    assert [r["status"] for r in result["rows"]] == ["not_processed"]
    msgs = " ".join(e["message"] for e in result["errors"])
    assert "is_imaginary" in msgs and "not a company" in msgs and "colour" in msgs and "service" in msgs
    assert [r.path for r in transport.sent] == ["/decisions"]


def test_json_input_no_reasoning_missing_group_column_and_position_match():
    result, transport = run("single", config="single.config.json", ext="json")
    rows = by_id(result)
    assert answers(rows["s2"])["multinational"]["answer"] == "no"
    assert transport.sent[1].query == {}
    assert question(result, "multinational")["groups"][0]["group"] == "(no value)"
    assert any("group_by column 'region'" in c for c in result["coverage"])


def test_outputs_csv_html_and_explorer(tmp_path):
    run("happy", out=tmp_path)
    rows = list(csv.DictReader((tmp_path / "results.csv").open()))
    assert [r["row_id"] for r in rows][:3] == ["r01", "r02", "r03"]
    assert rows[0]["b2b"] == "yes" and rows[2]["au_name"] == "unknown" and rows[4]["b2b"] == ""
    html = (tmp_path / "report.html").read_text()
    assert "<b>Eps</b>" not in html and "<script>alert" not in html
    assert 'href="javascript' not in html
    assert 'id="radar-data"' in html and "script-src 'sha256-" in html
    assert "fbl_dev_" not in (tmp_path / "results.json").read_text()


def test_explorer_script_has_no_unsafe_sinks():
    js = ASSET.read_text()
    for sink in ("innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "fetch(",
                 "XMLHttpRequest", "</script"):
        assert sink not in js
    assert "textContent" in js and "createElement" in js
    assert re.search(r'indexOf\("https://"\) === 0', js)


def test_plan_counts_batches_and_answers():
    cfg = load_config(json.loads((F / "config.json").read_text()))
    rows = RECIPE.read_input(F / "happy.input.csv")
    calls = {c.endpoint: c for c in plan(rows, cfg)}
    assert calls["POST /decisions"].requests == 8          # 4 questions x 2 batches of up to 4
    assert calls["POST /decisions"].to_dict()["published_estimate_upper_bound"] == 2.24   # 28 answers x 0.08


@pytest.mark.parametrize("mutate,message", [
    (lambda c: c.update(questions=[]), "questions must be a list of 1 to 10"),
    (lambda c: c.update(questions=c["questions"] * 3), "questions must be a list of 1 to 10"),
    (lambda c: c["questions"][1].update(id="b2b"), "used twice"),
    (lambda c: c["questions"][0].update(id="status"), "reserved for an output column"),
    (lambda c: c["questions"][0].update(inputs={"domain": "x.example"}), "must not include domain"),
    (lambda c: c["questions"][0].update(want="yes"), "unknown key"),
    (lambda c: c.update(batch_size=101), "batch_size must be a whole number from 1 to 100"),
    (lambda c: c.update(batch_size=0), "batch_size must be a whole number from 1 to 100"),
    (lambda c: c.update(min_answered=0), "min_answered must be a whole number"),
    (lambda c: c.update(with_reasoning="yes"), "with_reasoning must be true or false"),
    (lambda c: c.update(group_by=""), "group_by must be the name"),
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
    plan_json = json.loads((tmp_path / "plan.json").read_text())
    assert plan_json["published_estimate_upper_bound"] == 2.24
    assert plan_json["requests_upper_bound"] == 9
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
