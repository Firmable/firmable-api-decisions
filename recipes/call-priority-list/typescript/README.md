# Call priority list: TypeScript

Requires Node.js 22 or later. This package depends on the shared client in [`shared/typescript`](../../../shared/typescript) through npm workspaces, so install and build from the repository root.

```bash
# from the repository root
npm ci
npm run build
```

Run from the recipe folder:

```bash
cd recipes/call-priority-list
node typescript/dist/src/cli.js --input examples/input.csv --config config.example.json --out out
```

Add `--live --max-credits N` with `FIRMABLE_API_KEY` set to call the API. See the [recipe README](../README.md) for inputs, rules and costs.

Tests use synthetic responses from `tests/fixtures/call-priority-list/` and make no network calls:

```bash
npx tsc -b recipes/call-priority-list/typescript
node --test "recipes/call-priority-list/typescript/dist/tests/**/*.test.js"
```
