# Cohort question radar: TypeScript

Requires Node.js 22 or later. This package depends on the shared client in [`shared/typescript`](../../../shared/typescript) through npm workspaces, so install and build from the repository root.

```bash
# from the repository root
npm ci
npm run build
```

Run from the recipe folder:

```bash
cd recipes/cohort-question-radar
node typescript/dist/src/cli.js --input examples/input.csv --config config.example.json --out out
```

Add `--live --max-credits N` with `FIRMABLE_API_KEY` set to call the API. See the [recipe README](../README.md) for inputs, rules and costs.

The explorer script is read from `../assets/explorer.js`, shared with the Python package.

Tests use synthetic responses from `tests/fixtures/cohort-question-radar/` and make no network calls:

```bash
npx tsc -b recipes/cohort-question-radar/typescript
node --test "recipes/cohort-question-radar/typescript/dist/tests/**/*.test.js"
```
