#!/usr/bin/env bash
# The requests the cohort-question-radar recipe makes, for one question over a small batch.
# Reads the key from FIRMABLE_API_KEY. Nothing here runs on install.
# Listing decision tools is free. Each yes or no answer costs 0.04 credits (0.08 with reasoning);
# unknown answers and rows with an error are free.
set -euo pipefail
: "${FIRMABLE_API_KEY:?Set FIRMABLE_API_KEY to your developer API key}"
API="https://api.firmable.com"

echo "1. List the decision tools (free)"
curl -sS "$API/decisions" -H "Authorization: Bearer $FIRMABLE_API_KEY" | head -c 600; echo

echo "2. One question over a batch of three companies (up to 0.12 credits)"
curl -sS -X POST "$API/decisions" \
  -H "Authorization: Bearer $FIRMABLE_API_KEY" -H "Content-Type: application/json" \
  -d '{
    "tool": "matches_company_size",
    "question": {
      "min_staff": 200,
      "records": [
        { "domain": "canva.com", "external_id": "c-1" },
        { "domain": "xero.com", "external_id": "c-2" },
        { "domain": "linfox.com", "external_id": "c-3" }
      ]
    }
  }'
echo

echo "3. The same batch with reasoning (up to 0.24 credits)"
curl -sS -X POST "$API/decisions?withReasoning=true" \
  -H "Authorization: Bearer $FIRMABLE_API_KEY" -H "Content-Type: application/json" \
  -d '{"tool": "is_b2b", "question": {"records": [{"domain": "canva.com", "external_id": "c-1"}, {"domain": "xero.com", "external_id": "c-2"}, {"domain": "linfox.com", "external_id": "c-3"}]}}'
echo
