# Company fact brief

Writes a Markdown brief for each company you name: the profile facts Firmable holds, and the answers to a fixed set of yes or no questions, each with the reason, source and dates the API returned.

## Business problem

A strategy, partnerships or product analyst preparing for a meeting or a market review needs to know what Firmable holds about a company. A summary written from memory or by a language model mixes facts with guesses, and nobody can check which is which.

This recipe states each fact once, beside the API field or the question it came from. A fact Firmable does not hold is listed as unknown, separately from a no. The only prose in the brief is fixed text in this recipe.

## Inputs

**Input file** (CSV or JSON). One row per company, up to 25 rows. The companies come from your file: the REST API has no general company search.

| Column | Required | Meaning |
| - | - | - |
| `domain` | One of `domain` or `company_id` | The company's website domain. A full URL also works; the scheme, `www.` and path are removed. |
| `company_id` | One of `domain` or `company_id` | A Firmable company ID, such as `f000002437529`. Used before `domain` when both are given. |
| `row_id` | No | Your own row identifier. Defaults to `row-1`, `row-2` and so on. Must be unique. Names the brief file. |
| `company_name`, `segment` and any other column | No | Kept with the row in `results.json`. |

**Configuration** (`config.example.json`).

| Key | Default | Meaning |
| - | - | - |
| `questions` | Required | 1 to 10 questions, asked in this order. |
| `questions[].id` | Required | A short identifier: lower-case letters, digits and underscores. Becomes the CSV column `q_<id>`. |
| `questions[].label` | The id | The question as shown in the brief. |
| `questions[].tool` | Required | A company decision tool from `GET /decisions`. A tool whose subject is `person` is rejected. |
| `questions[].inputs` | `{}` | The tool's own inputs, such as `{"min_staff": 200}`. The company is added by the recipe. |
| `with_reasoning` | `true` | Asks for the reason, source, fact date and last refreshed date behind each answer. Doubles the Decisions price. |
| `fetch_company` | `true` | Fetches each profile first (`GET /company`) for the profile facts, and asks the questions by Firmable company ID. When false, questions are asked by the identifier in the file and the brief has no profile facts. |
| `batch_size` | `100` | Companies per `POST /decisions` request, from 1 to 100. |

The example asks eight questions: `is_b2b`, `is_multinational`, `has_multiple_sites`, `is_publicly_listed`, `is_public_sector_or_nonprofit`, `claims_rd_tax_incentive`, `has_company_phone` and `matches_company_size` with `min_staff` 200. Tool names and inputs are checked against the live tool list before any paid call.

## API calls

| Call | When | Cost |
| - | - | - |
| `GET /decisions` | Once per run, to check the configured questions | Free |
| `GET /company?fqdn=` or `?id=` | Once per unique valid company, when `fetch_company` is true | Up to 1 credit per new profile |
| `POST /decisions?withReasoning=true` | Once per question per batch of up to `batch_size` companies, with `question.records` | 0.08 credits per yes or no answer with reasoning, 0.04 without; unknown answers and rows with an error are free |

Duplicate companies in the input reuse the earlier responses and are not requested again.

## Workflow

1. Read and validate the input and configuration.
2. Read the decision tool list and check every question's tool, subject and inputs. Stop before paid calls if any is wrong.
3. Fetch each unique company's profile.
4. Ask each question about the companies in batches. Each batch row carries an `external_id` (`subject-1`, `subject-2` and so on) so answers are matched back to the right company.
5. Write one brief per company, then `report.html`, `results.csv` and `results.json`.

## Rules

Each answer has one outcome:

- **yes** or **no**: Firmable's answer, as returned.
- **unknown**: Firmable does not hold the fact. This is not a no.
- **not_found**: the batch row came back with an error whose code ends in `not_found`, so Firmable did not match the company for that question.
- **error**: the request failed, the batch row carried another error, or the response had no row for the company.
- **not_asked**: the run stopped before the question was asked.

Each company gets the first status that applies:

| Status | Rule |
| - | - |
| `invalid_input` | The `company_id` is not `f` followed by 12 digits, or the domain is not a valid domain. |
| `company_not_found` | `GET /company` answered 404, or, without profiles, every question came back not found. No brief is written. |
| `error` | The profile request failed. No questions were asked and no brief is written. |
| `not_processed` | The run stopped before any question was asked for this company. |
| `brief_ready` | Every question answered yes, no or unknown. |
| `partial` | At least one question has no answer. The brief lists those questions under "Not answered". |

**Possible conflicts.** The brief lists a conflict when one of these deterministic checks finds one, and never corrects the data:

- the profile's `year_founded` is later than the year in the answers' `answered_at`;
- `is_publicly_listed` answered yes and the profile's `company_type` contains "private", or answered no and `company_type` contains "public company".

## Output

- `brief-<row_id>.md`: one per unique company with status `brief_ready` or `partial`, named after the first row for that company. Sections: Profile facts (the fields `id`, `name`, `website`, `fqdn`, `hq_country`, `company_size`, `industries`, `year_founded`, `company_type`, under their API names), Answers (question, tool, answer, reason as returned, source, fact date, last refreshed), Details as returned, What is unknown, Not answered, Possible conflicts, and a fixed Interpretation. Returned text is escaped so it cannot add Markdown formatting or links; a link is kept only for an http or https website.
- `report.html`: the same content per company, with status badges.
- `results.csv`: one row per input row, in input order, with the status, counts of yes, no, unknown and missing answers, the brief file name, and one `q_<id>` column per question.
- `results.json`: everything, including each answer's `confidence`, `details`, `reasoning`, `answered_at`, `credits`, `request_id` and the request ledger.

In the brief, a reasoning field the API sent as `null` shows as "none"; a field it did not send shows as "not returned"; without `with_reasoning` it shows as "not requested".

## Estimated cost

For one company and the eight example questions with reasoning: up to 1 credit for the profile and 0.64 credits for answers. For 25 companies: up to 25 credits for profiles and 16 credits for answers, 41 credits in total. Profiles your organisation already paid for are free, and unknown answers are free. Run in plan mode to see the upper bound for your own file.

## Commands

Install first; see [Getting started](../../docs/getting-started.md).

```bash
# Python, plan mode (no API calls)
firmable-company-fact-brief --input examples/input.csv --config config.example.json --out out

# Python, live
export FIRMABLE_API_KEY=fbl_dev_...
firmable-company-fact-brief --input examples/input.csv --config config.example.json --out out --live --max-credits 10
```

```bash
# TypeScript, plan mode (no API calls)
node typescript/dist/src/cli.js --input examples/input.csv --config config.example.json --out out

# TypeScript, live
node typescript/dist/src/cli.js --input examples/input.csv --config config.example.json --out out --live --max-credits 10
```

The underlying requests are in [curl/requests.sh](curl/requests.sh).

## Errors, limitations and unknowns

- The companies come from your input file. The REST API has no general company search and no reverse lookup by answer.
- A request that times out or gets a 5xx response may still have been charged. It is counted under "Requests with an uncertain charge".
- A bad key, no credits, a blocked redirect or reaching `--max-credits` stops the run. Results so far are written. Questions not yet asked are marked not asked, and companies with no question asked are `not_processed`.
- Nothing is retried automatically.
- The error code for a company Decisions cannot match is not documented. A batch row whose error code ends in `not_found` is treated as not found and its error is kept as returned.
- Some decision tools use a decision model inside Firmable's service; the report names them. This code adds no model of its own and writes no narrative.
- Answers reflect Firmable data as of the `last_refreshed` date in the reasoning. They are not a live check.
- The conflict checks cover two patterns only. Other inconsistencies in Firmable data are not detected.
