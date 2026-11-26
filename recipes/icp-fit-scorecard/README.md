# ICP fit scorecard

Asks Firmable whether each account fits one ideal customer profile (ICP), shows every criterion as met, not met or not shown, and sorts the accounts into the tiers you define.

## Business problem

Sales and marketing teams agree an ICP, then argue about which accounts fit it. A single fit score hides why an account was judged a fit, and an account Firmable knows little about can look like a poor fit when the facts are simply missing.

This recipe asks one ICP question per account, keeps the filters and criteria the answer reports, and applies written tier rules. An unknown answer stays visible as `needs_review` and never lands in a tier meant for a yes or a no.

It differs from gtm-starter-kit's account-qualification recipe, which asks separate yes or no checks and combines them. Here one model-judged ICP question returns a per-criterion breakdown.

## Inputs

**Input file** (CSV or JSON). One row per account. The accounts come from your file: the REST API has no general company search.

| Column | Required | Meaning |
| - | - | - |
| `domain` | One of `domain` or `company_id` | The company's website domain. A full URL also works. |
| `company_id` | One of `domain` or `company_id` | A Firmable company ID. Used before `domain` when both are given. |
| `row_id` | No | Your own row identifier. Defaults to `row-1`, `row-2` and so on. Must be unique. |
| `company_name` | No | Shown in the report and CSV as given. |
| `segment` | No | Shown in the report and CSV as given. |

**Configuration** (`config.example.json`).

| Key | Default | Meaning |
| - | - | - |
| `icp` | Required | The ICP sent to `is_icp_fit`, as in the tool's `$defs.ICP` schema. |
| `icp.min_staff`, `icp.max_staff` | None | Staff count range, worldwide unless `staff_in` names a market. |
| `icp.staff_in` | None | One of AU, NZ, SG, MY, ID, PH, HK, JP, VN, KR, TH, US, CA. |
| `icp.industries` | None | Industry names or ANZSIC code prefixes; any one matches. |
| `icp.countries` | None | Head office countries as ISO codes; any one matches. |
| `icp.revenue_bands` | None | Firmable revenue bands, such as `$10M - $50M`. |
| `icp.criteria` | None | Up to 10 checkable statements, 2,000 characters in all. The same criterion twice is rejected. |
| `with_reasoning` | `true` | Asks for the reason, source and refresh date behind each answer. Doubles the Decisions price. |
| `batch_size` | `100` | Accounts per `POST /decisions` request, from 1 to 100. |
| `tiers` | None | Up to 10 tiers, in order. Each has `id`, `label` and `when`. |
| `tiers[].when.fit` | None | `yes`, `no` or `unknown`: the answer must be exactly this. |
| `tiers[].when.min_criteria_met` | None | At least this many configured criteria must be shown as met. |

`icp.description` is rejected, because `is_icp_fit` does not accept it. Give `criteria` instead. The ICP must hold at least one filter or criterion.

## API calls

| Call | When | Cost |
| - | - | - |
| `GET /decisions` | Once per run, to check `is_icp_fit` accepts the ICP | Free |
| `POST /decisions?withReasoning=true` | Once per batch of up to `batch_size` unique accounts, with `question.records` | 0.08 credits per yes or no answer with reasoning, 0.04 without; unknown answers and rows with an error are free |

Duplicate accounts in the input reuse the earlier answer and are not requested again.

## Workflow

1. Read and validate the input and configuration.
2. Read the decision tool list and check `is_icp_fit` exists and accepts the ICP. Stop before paid calls if not.
3. Ask `is_icp_fit` about the unique valid accounts in batches. Each batch row carries an `external_id` (`subject-1`, `subject-2` and so on).
4. Place each configured criterion, keep the filters as returned, and assign the tier.
5. Write `report.html`, `results.csv` and `results.json`.

## Rules

**Status** comes from the answer:

| Status | Rule |
| - | - |
| `fit` | `is_icp_fit` answered yes. |
| `not_fit` | `is_icp_fit` answered no. |
| `needs_review` | `is_icp_fit` answered unknown. Firmable does not hold the facts to judge fit. |
| `not_found` | The batch row carried an error whose code ends in `not_found`. |
| `error` | The request failed, the row carried another error, or the response had no row for the account. |
| `invalid_input` | The `company_id` is not `f` followed by 12 digits, or the domain is not valid. |
| `not_processed` | The run stopped before the account was asked. |

**Criteria.** Each configured criterion is matched to an entry in `details.criteria` by its `criterion` text, ignoring case and repeated spaces.

- **met**: the entry has `"met": true`.
- **not_met**: the entry has `"met": false`.
- **not_shown**: there is no entry, or its `met` is anything else. `is_icp_fit` leaves out a criterion the company's record cannot show. Not shown is not a no.

Entries that match no configured criterion are kept as returned under `criteria_other`.

**Tiers.** The first tier whose conditions all hold is assigned. `fit` must equal the answer exactly, so an unknown answer never satisfies a tier that asks for yes or no. `min_criteria_met` counts criteria shown as met. An account with no answer (not found, error) gets no tier.

## Output

- `report.html`: status counts, tier counts, criteria counts across unique accounts, then accounts grouped by status. Each card shows the criteria with their results and returned entries, the filters as returned, and the reason.
- `results.csv`: one row per input row, in input order, with status, tier, fit answer, confidence, the met, not met and not shown criteria, the filters and the reason.
- `results.json`: everything, including the full answer with `confidence`, `details`, `reasoning`, `answered_at` and `credits`, and the request ledger.

## Estimated cost

For 100 unique accounts with reasoning: 8 credits, in one request. Without reasoning: 4 credits. Unknown answers are free. Run in plan mode to see the upper bound for your own file.

## Commands

Install first; see [Getting started](../../docs/getting-started.md).

```bash
# Python, plan mode (no API calls)
firmable-icp-fit-scorecard --input examples/input.csv --config config.example.json --out out

# Python, live
export FIRMABLE_API_KEY=fbl_dev_...
firmable-icp-fit-scorecard --input examples/input.csv --config config.example.json --out out --live --max-credits 5
```

```bash
# TypeScript, plan mode (no API calls)
node typescript/dist/src/cli.js --input examples/input.csv --config config.example.json --out out

# TypeScript, live
node typescript/dist/src/cli.js --input examples/input.csv --config config.example.json --out out --live --max-credits 5
```

The underlying requests are in [curl/requests.sh](curl/requests.sh).

## Errors, limitations and unknowns

- The accounts come from your input file. The REST API has no general company search.
- The shape of `details.criteria` and `details.filters` is not documented. This recipe reads the `criterion` and `met` keys of each criteria entry and keeps both objects as returned. If the shape differs, criteria show as not shown and the returned objects stay in `results.json`.
- `is_icp_fit` uses a decision model inside Firmable's service to judge criteria. A criterion that asks for a judgement, such as "leading" or "trusted", can be met from the company's own description. Write criteria as checkable facts.
- A fit answer reflects Firmable data as of the `last_refreshed` date. It is not proof of buying intent.
- The error code for a company Decisions cannot match is not documented. A row whose error code ends in `not_found` is treated as not found and kept as returned.
- A request that times out or gets a 5xx response may still have been charged. It is counted under "Requests with an uncertain charge".
- A bad key, no credits, a blocked redirect or reaching `--max-credits` stops the run. The account whose request was refused shows `error`; later accounts are `not_processed`.
- Nothing is retried automatically.
