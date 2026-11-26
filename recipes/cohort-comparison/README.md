# Cohort comparison

Asks the same Firmable Decisions company questions of two cohorts you supply, and shows both cohorts' answers side by side. Where both cohorts have enough yes or no answers, it gives the difference in yes share in percentage points.

## Business problem

A strategy, market research, partnerships or product team wants to know how two groups of companies differ on the same facts. Examples are customers against prospects, or this year's sign-ups against last year's. A bare difference between two percentages hides how many companies each side could answer for, and a small cohort can produce a large difference by chance.

This recipe asks each question once per company, counts yes, no, unknown, error and not found per cohort, and shows a difference only when both cohorts have at least `min_answered` yes or no answers. It makes no significance claim. The differences describe these two cohorts only.

## Inputs

**The cohorts are your input file.** The REST API has no general company search and no reverse lookup by decision, so the recipe cannot find or add companies.

**Input file** (CSV or JSON). One row per company per cohort.

| Column | Required | Meaning |
| - | - | - |
| `cohort` | Yes, as a column | The cohort the row belongs to. Rows whose value is not one of the two configured cohorts, including empty values, are ignored and counted. |
| `company_id` | One of `company_id` or `domain` | A Firmable company ID, `f` followed by 12 digits. Used in preference to `domain` when both are filled. |
| `domain` | One of `company_id` or `domain` | The company's website domain. A full URL also works; the scheme, `www.` and path are removed. |
| `row_id` | No | Your own row identifier. Defaults to `row-1`, `row-2` and so on. Must be unique. |
| `company_name` | No | Shown in the report and CSV as given. Not sent to the API. |
| Any other column | No | Kept with the row in `results.json`. |

A company can appear in both cohorts. It is asked once and counted in both.

**Configuration** (`config.example.json`).

| Key | Default | Meaning |
| - | - | - |
| `cohorts` | Required | The two `cohort` values to compare, as text, for example `["customers", "prospects"]`. The difference is the first minus the second. |
| `questions` | Required | 1 to 10 questions, asked in this order. |
| `questions[].id` | Required | A short identifier, lower-case letters, digits and underscores. It becomes a CSV column, so it cannot be one of the fixed column names. |
| `questions[].label` | The id | The name shown in the report and in `comparison.md`. |
| `questions[].tool` | Required | A company decision tool from `GET /decisions`. Its `subject` must be `company` or `company or person`. |
| `questions[].inputs` | `{}` | The tool's own inputs, such as `{"min_staff": 200}`. The recipe adds each company. |
| `with_reasoning` | `false` | Asks for the reason, source and refresh date behind each answer. Doubles the Decisions price. |
| `batch_size` | `100` | Companies per request, from 1 to 100. |
| `min_answered` | `5` | The fewest yes or no answers each cohort needs before its yes share and the difference are shown. |

Tool names and inputs are checked against the live tool list before any paid call.

## API calls

| Call | When | Cost |
| - | - | - |
| `GET /decisions` | Once per run, to check the configured tools and inputs | Free |
| `POST /decisions` with `question.records` | Once per question per batch of up to `batch_size` companies from both cohorts together | 0.04 credits per yes or no answer, 0.08 with reasoning; unknown answers and rows with an error are free |

## Workflow

1. Read and check the input and configuration.
2. Set aside rows whose cohort is not one of the two configured cohorts.
3. Read the decision tool list and check every question. Stop before paid calls if any is wrong.
4. For each question, send the unique valid companies of both cohorts in batches. Each record carries an `external_id` (`c-1`, `c-2` and so on) that matches the answer back to the company.
5. Count the outcomes per question and per cohort, and work out the difference where both cohorts have enough answers.
6. Write `report.html`, `comparison.md`, `results.csv` and `results.json`.

## Rules

Each answer is one of `yes`, `no`, `unknown`, `error`, `not_found` or `not_asked`, with the same meaning as in [cohort-question-radar](../cohort-question-radar/README.md#rules). Unknown is never counted as a no. A batch row with an error whose code ends in `not_found` is `not_found`; the code is recorded as returned.

Each question gets one measure block per cohort:

| Field | Rule |
| - | - |
| `companies_in_cohort` | Unique valid companies in the cohort. |
| `companies_asked` | Companies in the cohort minus `not_asked`. |
| `yes`, `no`, `unknown`, `error`, `not_found`, `not_asked` | Companies with each outcome. |
| `answered` | `yes` plus `no`. |
| `yes_share` | `yes` over `answered`, with that denominator. Below `min_answered` it reads "too few answers to compare" and no percentage is given. |
| `unknown_share` | `unknown` over `companies_asked`, with that denominator. |

The difference rule:

| Field | Rule |
| - | - |
| `comparable` | `true` only when both cohorts have at least `min_answered` yes or no answers. |
| `yes_share_difference_pp` | The first cohort's yes share minus the second's, in percentage points, worked out from the exact shares and rounded half away from zero to one decimal. `null` when not comparable. |
| `text` | For example `+33.3 percentage points (customers minus prospects)`, or "too few answers to compare" with each cohort's answered count. |

No significance test is made. A fixed note in the report and in `comparison.md` says the differences describe these two cohorts only.

Each input row gets a status: `answered`, `incomplete`, `not_found`, `invalid_input` or `not_processed` as in cohort-question-radar, or `ignored` when its cohort is not one of the two configured cohorts.

## Output

- `report.html`: both cohorts' measure blocks side by side for each question, with the difference beneath, then every input row, coverage, credits and every raw request and response.
- `comparison.md`: the same tables in Markdown, with a fixed "How to read this" section and the coverage notes. Text from the input, configuration and API is escaped for Markdown.
- `results.csv`: one row per input row, in input order, with the cohort, whether the company is in both cohorts, the status and one column per question id holding the outcome.
- `results.json`: everything, including each answer's `confidence`, `details`, `reasoning`, `entity_id` and `credits`, the measure blocks and differences, and the request ledger.

## Estimated cost

The example file has 10 companies, 5 per cohort, and 3 questions without reasoning. That is up to 30 answers at 0.04 credits, 1.2 credits in total, in 3 requests. With `with_reasoning` set to true it is up to 2.4 credits. Unknown answers and rows with an error are free. Run in plan mode to see the upper bound for your own file.

## Commands

Install first; see the repository README.

```bash
# Python, plan mode (no API calls)
cd recipes/cohort-comparison
firmable-cohort-comparison --input examples/input.csv --config config.example.json --out out

# Python, live
export FIRMABLE_API_KEY=fbl_dev_...
firmable-cohort-comparison --input examples/input.csv --config config.example.json --out out --live --max-credits 5
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
- The differences describe these two cohorts only. They are not tested for statistical significance and do not describe a market, sector or population.
- A small `min_answered` lets large differences come from very few companies. The default of 5 is a floor, not a guarantee.
- Duplicates are matched on the identifier as given. The same company entered once by domain and once by company ID is asked twice and counted twice.
- Some decision tools use a decision model inside Firmable's service. The report names them. This code adds no model of its own and only counts the answers.
- Answers reflect Firmable data as of the `last_refreshed` date in the reasoning, not a live check.
