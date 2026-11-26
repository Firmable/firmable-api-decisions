# Cohort question radar

Asks the same Firmable Decisions company questions across a cohort of companies you supply, and shows how the answers come out. Every count is shown beside its denominator. The report includes an explorer page with a question-by-company matrix.

## Business problem

A strategy, market research, partnerships or product team has a list of companies and wants to know how they answer a set of yes or no questions. Examples are "does it sell to businesses", "is it publicly listed" and "does it have 200 or more staff". Asking one company at a time is slow. A single percentage without its denominator hides how many companies Firmable could answer for.

This recipe asks each question about every company in batches, keeps every answer with its details and reasoning as returned, and counts yes, no, unknown, error and not found separately. It describes the companies in your file only. It does not describe a market, sector or population.

## Inputs

**The cohort is your input file.** The REST API has no general company search and no reverse lookup by decision, so the recipe cannot find or add companies.

**Input file** (CSV or JSON). One row per company.

| Column | Required | Meaning |
| - | - | - |
| `company_id` | One of `company_id` or `domain` | A Firmable company ID, `f` followed by 12 digits. Used in preference to `domain` when both are filled. |
| `domain` | One of `company_id` or `domain` | The company's website domain. A full URL also works; the scheme, `www.` and path are removed. |
| `row_id` | No | Your own row identifier. Defaults to `row-1`, `row-2` and so on. Must be unique. |
| `company_name` | No | Shown in the report and CSV as given. Not sent to the API. |
| `segment` or any other column | No | Kept with the row. A column named in `group_by` splits the counts into groups. |

**Configuration** (`config.example.json`).

| Key | Default | Meaning |
| - | - | - |
| `questions` | Required | 1 to 10 questions, asked in this order. |
| `questions[].id` | Required | A short identifier, lower-case letters, digits and underscores. It becomes a CSV column, so it cannot be one of the fixed column names. |
| `questions[].label` | The id | The name shown in the report. |
| `questions[].tool` | Required | A company decision tool from `GET /decisions`. Its `subject` must be `company` or `company or person`. |
| `questions[].inputs` | `{}` | The tool's own inputs, such as `{"min_staff": 200}`. The recipe adds each company. |
| `with_reasoning` | `false` | Asks for the reason, source and refresh date behind each answer. Doubles the Decisions price. |
| `batch_size` | `100` | Companies per request, from 1 to 100. |
| `min_answered` | `5` | The fewest yes or no answers a question needs before its yes share is shown. |
| `group_by` | none | An input column, such as `segment`. Each group gets its own counts. |

Tool names and inputs are checked against the live tool list before any paid call. An unknown tool, a person-only tool, an input the tool does not accept or a missing required input stops the run before any answer is bought.

## API calls

| Call | When | Cost |
| - | - | - |
| `GET /decisions` | Once per run, to check the configured tools and inputs | Free |
| `POST /decisions` with `question.records` | Once per question per batch of up to `batch_size` companies | 0.04 credits per yes or no answer, 0.08 with reasoning; unknown answers and rows with an error are free |

Rows that name the same company reuse its answers. The company is asked once.

## Workflow

1. Read and check the input and configuration.
2. Read the decision tool list and check every question. Stop before paid calls if any is wrong.
3. For each question, send the unique valid companies in batches. Each record carries an `external_id` (`c-1`, `c-2` and so on) that matches the answer back to the company.
4. Classify every answer and count the outcomes per question and per group.
5. Write `report.html`, `results.csv` and `results.json`.

## Rules

Each answer is one of:

- **yes** or **no**: the answer as returned.
- **unknown**: Firmable does not hold the fact. It is never counted as a no.
- **not_found**: the batch row came back with an error whose code ends in `not_found`. The API documents no company not-found code, so the code is recorded as returned.
- **error**: the request failed, the response was malformed, the batch row had another error, or the batch had no answer for the company.
- **not_asked**: the run stopped before this question was asked for the company, for example at the credit limit.

Each question gets a measure block for the cohort, and for each group when `group_by` is set:

| Field | Rule |
| - | - |
| `companies_in_cohort` | Unique valid companies in the cohort or group. |
| `companies_asked` | Companies in the cohort or group minus `not_asked`. |
| `yes`, `no`, `unknown`, `error`, `not_found`, `not_asked` | Companies with each outcome. |
| `answered` | `yes` plus `no`. |
| `yes_share` | `yes` over `answered`, with that denominator, for example `3 of 4 answered (75.0%)`. |
| `unknown_share` | `unknown` over `companies_asked`, with that denominator. |
| `enough_answers` | `false` when `answered` is below `min_answered`. The yes share then reads "too few answers to compare" and no percentage is given. |

Percentages are rounded half up to one decimal. No score or index is calculated.

Each input row gets a status:

| Status | Rule |
| - | - |
| `answered` | Every question answered yes, no or unknown. |
| `incomplete` | At least one question has error, not_found or not_asked. |
| `not_found` | Every question came back not_found. |
| `invalid_input` | The row has no valid `company_id` or domain. |
| `not_processed` | No question was asked for the company, because the run stopped or the configuration was rejected. |

A company that appears in several groups is counted once in each group. A company that different questions match to different Firmable IDs is listed in `coverage`; its answers are shown as returned.

## Output

- `report.html`: the counts per question and per group, then the explorer, then every input row, coverage, credits and every raw request and response. The explorer has filters for question, answer and group, a bar of counts per question, a question-by-company matrix and a panel with one company's answers, reasons and sources as returned. It is plain JavaScript embedded in the page, allowed by its hash in the page's Content Security Policy, with no network calls. Without JavaScript the tables still show every answer.
- `results.csv`: one row per input row, in input order, with the status and one column per question id holding the outcome.
- `results.json`: everything, including each answer's `confidence`, `details`, `reasoning`, `entity_id` and `credits`, the measure blocks, and the request ledger.

## Estimated cost

The example file has 10 companies and 5 questions without reasoning. That is up to 50 answers at 0.04 credits, 2 credits in total, in 5 requests. With `with_reasoning` set to true it is up to 4 credits. Unknown answers and rows with an error are free. Run in plan mode to see the upper bound for your own file.

## Commands

Install first; see the repository README.

```bash
# Python, plan mode (no API calls)
cd recipes/cohort-question-radar
firmable-cohort-question-radar --input examples/input.csv --config config.example.json --out out

# Python, live
export FIRMABLE_API_KEY=fbl_dev_...
firmable-cohort-question-radar --input examples/input.csv --config config.example.json --out out --live --max-credits 5
```

```bash
# TypeScript, plan mode (no API calls)
node typescript/dist/src/cli.js --input examples/input.csv --config config.example.json --out out

# TypeScript, live
node typescript/dist/src/cli.js --input examples/input.csv --config config.example.json --out out --live --max-credits 5
```

The underlying requests are in [curl/requests.sh](curl/requests.sh).

## Errors, limitations and unknowns

- A request that times out or gets a 5xx response may still have been charged. It is counted under "Requests with an uncertain charge", and every company in that batch gets an error for that question.
- A bad key, no credits, a blocked redirect or reaching `--max-credits` stops the run. Answers so far are kept. Later batches are not sent and their companies show `not_asked`.
- Nothing is retried automatically.
- The answers describe the companies in your file only. A yes share for a cohort is not a rate for a market, sector or population.
- Duplicates are matched on the identifier as given. The same company entered once by domain and once by company ID is asked twice and counted twice.
- Some decision tools use a decision model inside Firmable's service. The report names them. This code adds no model of its own and only counts the answers.
- Two questions that look equivalent, such as `is_located_in` with `AU` and with `Australia`, can answer differently. The recipe shows both as returned and does not reconcile them.
- Answers reflect Firmable data as of the `last_refreshed` date in the reasoning, not a live check.
