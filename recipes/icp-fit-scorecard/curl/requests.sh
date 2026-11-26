#!/usr/bin/env bash
# The requests the icp-fit-scorecard recipe makes, for a batch of two companies.
# Reads the key from FIRMABLE_API_KEY. Nothing here runs on install.
# Listing decision tools is free; is_icp_fit answers spend credits.
set -euo pipefail
: "${FIRMABLE_API_KEY:?Set FIRMABLE_API_KEY to your developer API key}"
API="https://api.firmable.com"

echo "1. List the decision tools (free)"
curl -sS "$API/decisions" -H "Authorization: Bearer $FIRMABLE_API_KEY" | head -c 600; echo

echo "2. is_icp_fit for a batch, with reasoning (0.08 credits per yes or no answer; unknown and row errors are free)"
curl -sS -X POST "$API/decisions?withReasoning=true" \
  -H "Authorization: Bearer $FIRMABLE_API_KEY" -H "Content-Type: application/json" \
  -d '{
    "tool": "is_icp_fit",
    "question": {
      "icp": {
        "min_staff": 200, "staff_in": "AU", "countries": ["AU", "NZ"],
        "criteria": ["Sells to other businesses", "Has a sales team", "Sells a software product"]
      },
      "records": [
        { "domain": "canva.com", "external_id": "subject-1" },
        { "domain": "safetyculture.com", "external_id": "subject-2" }
      ]
    }
  }'
echo
