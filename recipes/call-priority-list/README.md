# Call priority list

Ranks a contact list for calling. Each person gets a priority from fixed rules, using Firmable's answers on seniority, department, reachability and the Australian Do Not Call register, and the reason for that priority.

## Business problem

A sales rep has a list of contacts and limited time. Calling in list order wastes the first hours on people who are the wrong level, in the wrong team, unreachable, or on the Do Not Call register. Ranking by gut feel is not repeatable, and treating missing information as a no drops people who may be the right call.

This recipe asks Firmable the same questions about everyone, applies written rules, and shows every person's reason. An unknown answer that could change the priority sends the person to `review` instead of a guess.

It differs from gtm-starter-kit's contact-health-check recipe: it ranks a call list and does not check employment.

## Inputs

**Input file** (CSV or JSON). One row per contact. Use obviously fake identifiers when testing.

| Column | Required | Meaning |
| - | - | - |
| `person_id` | One of the three | A Firmable person ID (`fp` followed by 12 digits). Used first when present. |
| `work_email` | One of the three | The person's work email. Used to find them only; Firmable does not store or echo it. |
| `linkedin_url` | One of the three | A LinkedIn profile URL (`linkedin.com/in/...`). A record can carry someone else's link, so prefer `person_id`. |
| `row_id` | No | Your own row identifier. Defaults to `row-1`, `row-2` and so on. Must be unique. |
| `name`, `company` | No | Shown in the report and CSV as given. Not sent to the API. |

The recipe uses the first identifier present, in the order `person_id`, `work_email`, `linkedin_url`. An identifier that does not match its documented pattern makes the row `invalid_input`.

**Configuration** (`config.example.json`).

| Key | Default | Meaning |
| - | - | - |
| `target_seniorities` | Required | 1 to 20 labels for `matches_seniority`, from the tool list's accepted seniorities, such as `C-Suite / Partner`. |
| `target_departments` | Required | 1 to 20 labels for `matches_department`, from the tool list's accepted departments, such as `Finance`. |
| `check_reachability` | `true` | Asks `is_reachable`. |
| `check_dnc` | `true` | Asks `is_mobile_on_dnc`. |
| `decision_maker` | Off | `{"seller": "...", "buyer": "..."}` asks `is_decision_maker`. `seller` is 3 to 2,000 characters; `buyer` is optional. |
| `with_reasoning` | `false` | Asks for the reason, source and refresh date behind each answer. Doubles the Decisions price. |
| `batch_size` | `100` | People per `POST /decisions` request, from 1 to 100. |

Labels are checked against the accepted values in `GET /decisions` before any paid call.

## API calls

| Call | When | Cost |
| - | - | - |
| `GET /decisions` | Once per run, to check tools, inputs and labels | Free |
| `POST /decisions` with `matches_seniority` | Once per batch | 0.04 credits per yes or no answer, 0.08 with reasoning |
| `POST /decisions` with `matches_department` | Once per batch | As above |
| `POST /decisions` with `is_reachable` | Once per batch, when `check_reachability` is true | As above |
| `POST /decisions` with `is_mobile_on_dnc` | Once per batch, when `check_dnc` is true | As above |
| `POST /decisions` with `is_decision_maker` | Once per batch, when `decision_maker` is set | As above |

Unknown answers and rows with an error are free. Duplicate people reuse the earlier answers.

## Workflow

1. Read and validate the input and configuration.
2. Read the decision tool list. Check every tool, input and label. Stop before paid calls if any is wrong.
3. For each batch of up to `batch_size` unique people, ask each tool in the order above. Each batch row carries an `external_id` (`subject-1`, `subject-2` and so on).
4. Apply the priority rules.
5. Write `report.html`, `results.csv` and `results.json`.

## Rules

Each answer is `yes`, `no`, `unknown`, `not_found`, `error`, `not_asked` (the run stopped first) or `not_checked` (switched off). Unknown is never a no.

A **deliverable work email** means `is_reachable` details show `work_email_held` true and a `work_email_grade` of Highly likely or Likely, the grades `is_email_valid` treats as yes. `work_email_held` false, or a lower grade, means no deliverable work email. Anything else means it is not known.

The first rule that applies sets the priority:

| Priority | Rule |
| - | - |
| `not_found` | Any answer came back with `person_not_found` (or another code ending in `not_found`). |
| `exclude_dnc` | `is_mobile_on_dnc` answered yes and there is no deliverable work email. |
| `incomplete` | Seniority, department, or a switched-on reachability or Do Not Call check has no answer (error or not asked). |
| `P1` | Seniority yes, department yes, reachable yes, and the mobile not on the register (Do Not Call no, or not checked). |
| `P2` | Seniority yes and department yes; reachability unknown or not checked. |
| `P3` | Seniority yes and department yes but reachable no, or one of seniority and department yes and the other no. |
| `review` | Seniority or department is unknown. An unknown answer blocks a higher priority. |
| `no_priority` | Seniority no and department no. |

Two overrides apply after these rules:

- A P1, P2 or P3 person whose mobile is on the register, and who has a deliverable work email or one that is not known, becomes `review`. Check the channel before calling.
- A P1 person whose Do Not Call status is unknown becomes `review`.

Other priorities: `invalid_input` (the identifier does not match its pattern) and `not_processed` (the run stopped before any question about this person).

`is_decision_maker` is shown beside the priority and does not change it.

## Output

- `report.html`: priority counts, the rule table, then people grouped by priority, each with the reason and every answer with its details as returned.
- `results.csv`: one row per input row, in input order, with `priority`, `reason`, each answer, the seniority and department Firmable holds, the email grade, the deliverability rule's result and the Do Not Call status. Input emails and LinkedIn URLs are not repeated in the CSV.
- `results.json`: everything, including each answer's `confidence`, `details`, `reasoning` and `credits`, and the request ledger.

## Estimated cost

For 100 unique people with all four default checks and no reasoning: 16 credits at most. With reasoning: 32 credits. With `decision_maker`: 4 more without reasoning. Unknown answers are free. Run in plan mode to see the upper bound for your own file.

## Commands

Install first; see [Getting started](../../docs/getting-started.md).

```bash
# Python, plan mode (no API calls)
firmable-call-priority-list --input examples/input.csv --config config.example.json --out out

# Python, live
export FIRMABLE_API_KEY=fbl_dev_...
firmable-call-priority-list --input examples/input.csv --config config.example.json --out out --live --max-credits 5
```

```bash
# TypeScript, plan mode (no API calls)
node typescript/dist/src/cli.js --input examples/input.csv --config config.example.json --out out

# TypeScript, live
node typescript/dist/src/cli.js --input examples/input.csv --config config.example.json --out out --live --max-credits 5
```

The underlying requests are in [curl/requests.sh](curl/requests.sh).

## Errors, limitations and unknowns

- The people come from your input file. This recipe does not search for people.
- Person answers are advisory. Each is a fact to check, as at Firmable's last refresh.
- The Do Not Call check covers Australian mobiles on the register as at Firmable's last refresh. It is not a live register check and does not replace your own compliance process. Mobiles outside Australia answer unknown.
- `matches_seniority`, `matches_department` and `is_decision_maker` use a decision model inside Firmable's service; the report names them. This code adds no model of its own.
- The deliverable-email rule reads `work_email_held` and `work_email_grade` from `is_reachable` details. The grade values come from the `is_email_valid` documentation; a new grade is treated as not deliverable.
- Names and companies in the input are not sent, so a name mismatch cannot turn an answer into unknown. A LinkedIn URL can match the wrong person.
- A request that times out or gets a 5xx response may still have been charged. It is counted under "Requests with an uncertain charge".
- A bad key, no credits, a blocked redirect or reaching `--max-credits` stops the run. People with some answers become `incomplete`; people with none are `not_processed`.
- Nothing is retried automatically.
