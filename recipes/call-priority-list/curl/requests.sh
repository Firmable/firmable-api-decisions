#!/usr/bin/env bash
# The requests the call-priority-list recipe makes, for a batch of one contact.
# Reads the key from FIRMABLE_API_KEY. Nothing here runs on install.
# Listing decision tools is free; each yes or no answer spends credits (0.04, or 0.08 with reasoning).
set -euo pipefail
: "${FIRMABLE_API_KEY:?Set FIRMABLE_API_KEY to your developer API key}"
API="https://api.firmable.com"
EMAIL="${1:-jane.citizen@example.com}"
RECORDS="[{\"work_email\": \"$EMAIL\", \"external_id\": \"subject-1\"}]"

ask() {
  curl -sS -X POST "$API/decisions" \
    -H "Authorization: Bearer $FIRMABLE_API_KEY" -H "Content-Type: application/json" \
    -d "{\"tool\": \"$1\", \"question\": {$2\"records\": $RECORDS}}"
  echo
}

echo "1. List the decision tools (free)"
curl -sS "$API/decisions" -H "Authorization: Bearer $FIRMABLE_API_KEY" | head -c 600; echo

echo "2. Seniority match"
ask matches_seniority '"seniorities": ["C-Suite / Partner", "VP/Director / Head of"], '
echo "3. Department match"
ask matches_department '"departments": ["Finance", "Operations"], '
echo "4. Reachability"
ask is_reachable ''
echo "5. Mobile on the Australian Do Not Call register"
ask is_mobile_on_dnc ''
