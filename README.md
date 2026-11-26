# firmable-decisions

Examples that call the [Firmable Decisions API](https://docs.firmable.com/api-reference/decisions.md) directly. Decisions answers fixed yes or no questions about a company or a person, such as whether a company is multinational or claims the Australian R&D tax incentive. Each answer is `yes`, `no` or `unknown`, and with reasoning it carries the reason, its source and when Firmable last refreshed the fact.

**Who it is for:** Strategy, market research and partnerships teams who want checkable facts across a list of companies, and sales teams who want to qualify accounts and prioritise contacts.

Every example has a Python and a TypeScript implementation that produce the same results. The examples call Firmable's REST endpoints (`GET /decisions`, `POST /decisions` and `GET /company`) with an API key and apply rules you can read and change in each configuration file.

**This is API code with no LLM integration.** The examples do not call OpenAI, Anthropic or any other model provider, and use no agent framework. They do not use MCP. For sales workflows across several Firmable APIs, see [gtm-starter-kit](https://github.com/Firmable/gtm-starter-kit).

## Examples

| Example | For | What it does |
| - | - | - |
| [cohort-question-radar](recipes/cohort-question-radar) | Flagship, research | Asks the same questions across your company list and shows the answers in an interactive explorer, with counts and denominators |
| [company-fact-brief](recipes/company-fact-brief) | Research | Writes a Markdown fact brief for a company: each answer with its reason, source and date, and unknowns listed separately |
| [cohort-comparison](recipes/cohort-comparison) | Research | Compares two cohorts on the same questions, with sample sizes and the denominator behind every percentage |
| [icp-fit-scorecard](recipes/icp-fit-scorecard) | Sales | Checks accounts against your ideal customer profile and shows each criterion as met, not met or not shown |
| [call-priority-list](recipes/call-priority-list) | Sales | Sorts a contact list into call priorities from seniority, department, reachability and Do Not Call answers |

Each example folder has a README with its question, inputs, the endpoints and fields it uses, rules, cost and commands, plus `python/README.md` and `typescript/README.md`.

## Quick start

Requires Python 3.11 to 3.13 or Node.js 22 or 24.

```bash
git clone https://github.com/Firmable/firmable-decisions.git && cd firmable-decisions

# Python
python -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt

# TypeScript
npm ci && npm run build
```

## Plan mode and live mode

Every run is plan mode unless you add `--live`. There is no demo mode with sample data.

| | Plan mode (default) | Live mode |
| - | - | - |
| Calls the API | No | Yes |
| Needs a key | No | `FIRMABLE_API_KEY` |
| Spends credits | No | Up to `--max-credits` |
| Writes | `plan.json`: the calls and the most credits they could use | `report.html`, `results.csv`, `results.json`, and Markdown files for the briefs |

Plan the flagship:

```bash
cd recipes/cohort-question-radar
firmable-cohort-question-radar --input examples/input.csv --config config.example.json --out out
node typescript/dist/src/cli.js --input examples/input.csv --config config.example.json --out out
```

Run it live:

1. Create a developer key at [platform.firmable.com](https://platform.firmable.com). See [docs/authentication.md](docs/authentication.md).
2. `export FIRMABLE_API_KEY=fbl_dev_...` (or copy `.env.example` to `.env` and load it in your shell; never commit it).
3. Add `--live --max-credits N`, using the upper bound plan mode printed:

```bash
firmable-cohort-question-radar --input examples/input.csv --config config.example.json --out out --live --max-credits 10
```

Open `out/report.html` in a browser. Replace `examples/input.csv` with your own list of companies.

## Interpreting the results

- Live runs spend developer credits. See [docs/credits-and-pricing.md](docs/credits-and-pricing.md).
- `--max-credits` is a limit enforced by this code before each request. It is not a cap on your Firmable account.
- A timeout or server error on a paid call may still have been charged. Reports count these separately. Nothing is retried automatically.
- Every count and percentage applies to the companies in your input file. It does not describe a market, sector or population.
- `unknown` means Firmable does not hold the fact. It is never treated as no.
- Not observed in the retrieved data does not mean it does not exist.
- Recipes flag data problems they can detect. They do not correct upstream data.
- The REST API has no general company search, so every cohort is the list of companies you supply.
- Some decision tools use a decision model inside Firmable's service. Each report names those tools. This code adds no model of its own.

## Documentation

- [Getting started](docs/getting-started.md)
- [Authentication](docs/authentication.md)
- [Credits and pricing](docs/credits-and-pricing.md)
- [API reference](docs/api-reference.md)
- [Understanding results](docs/understanding-results.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Architecture](docs/architecture.md)
- [Testing](docs/testing.md)

## Supported versions

| Runtime | Versions tested in CI |
| - | - |
| Python | 3.11, 3.12, 3.13 |
| Node.js | 22, 24 |

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).
