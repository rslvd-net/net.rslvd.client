#!/bin/bash
echo "--- install.sh (first 3 lines) ---"
curl -sf https://rslvd.net/install.sh | head -3

echo ""
echo "--- rslvd-tunnel (first 2 lines) ---"
curl -sf https://rslvd.net/rslvd-tunnel | head -2

echo ""
echo "--- Activity log endpoint ---"
TOKEN=$(echo '{"email":"garet@email.com","password":"impfa6bAQm!xRhfQrilR"}' | curl -sf -X POST https://rslvd.net/api/auth/login -H 'Content-Type: application/json' -d @- | python3 -c 'import sys,json; print(json.load(sys.stdin)["token"])')
echo "Token: ${TOKEN:0:20}..."

ROWS=$(curl -sf "https://rslvd.net/api/admin/activity" -H "Authorization: Bearer $TOKEN")
COUNT=$(echo "$ROWS" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))")
echo "$COUNT activity rows"
echo "$ROWS" | python3 -c "
import sys,json
rows=json.load(sys.stdin)
for r in rows[:5]:
    print(f\"  {r['event']:30} {r.get('email','—'):25} {r['created_at'][:19]}\")
"

echo ""
echo "--- Token lookup endpoint (public) ---"
# Create a test tunnel first and check lookup
curl -sf "https://rslvd.net/api/tunnels/connect/badtoken123" && echo "" || echo "404 as expected for bad token"
