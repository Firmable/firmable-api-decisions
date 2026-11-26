#!/usr/bin/env bash
# The requests the cohort-comparison recipe makes, for one question over companies from both cohorts.
# Reads the key from FIRMABLE_API_KEY. Nothing here runs on install.
# Listing decision tools is free. Each yes or no answer costs 0.04 credits (0.08 with reasoning);
# unknown answers and rows with an error are free. Cohorts are not sent to the API: the recipe
# asks each company once and splits the answers by the cohort column in your file.
set -euo pipefail
: "${FIRMABLE_API_KEY:?Set FIRMABLE_API_KEY to your developer API key}"
API="https://api.firmable.com"

echo "1. List the decision tools (free)"
curl -sS "$API/decisions" -H "Authorization: Bearer $FIRMABLE_API_KEY" | head -c 600; echo

echo "2. One question over four companies, two from each cohort (up to 0.16 credits)"
curl -sS -X POST "$API/decisions" \
  -H "Authorization: Bearer $FIRMABLE_API_KEY" -H "Content-Type: application/json" \
  -d '{
    "tool": "is_multinational",
    "question": {
      "records": [
        { "domain": "canva.com", "external_id": "c-1" },
        { "domain": "xero.com", "external_id": "c-2" },
        { "domain": "afterpay.com", "external_id": "c-3" },
        { "domain": "linfox.com", "external_id": "c-4" }
      ]
    }
  }'
echo
