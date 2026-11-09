#!/bin/bash
echo '{"email":"garet@email.com","password":"impfa6bAQm!xRhfQrilR"}' > /tmp/owner-login.json
RESP=$(curl -s -X POST https://rslvd.net/api/auth/login -H "Content-Type: application/json" -d @/tmp/owner-login.json)
echo "LOGIN: $RESP" | python3 -c "import sys,json; d=json.load(open('/dev/stdin')); u=d.get('user',{}); print(f'role={u.get(\"role\")} isSiteOwner={u.get(\"isSiteOwner\")} plan={u.get(\"plan\")} maxHosts={u.get(\"maxHosts\")} maxTunnels={u.get(\"maxTunnels\")}')" 2>/dev/null || echo "$RESP"

TOKEN=$(echo $RESP | python3 -c "import sys,json; print(json.load(sys.stdin).get('token','NO_TOKEN'))" 2>/dev/null)
echo "Token: ${TOKEN:0:40}..."

echo ""
echo "GET /admin/stats:"
curl -s https://rslvd.net/api/admin/stats -H "Authorization: Bearer $TOKEN" | python3 -m json.tool 2>/dev/null

echo ""
echo "GET /admin/users:"
curl -s https://rslvd.net/api/admin/users -H "Authorization: Bearer $TOKEN" | python3 -c "import sys,json; users=json.load(sys.stdin); [print(f'  {u[\"email\"]} | {u[\"plan\"]} | {u[\"subscription_status\"]} | siteOwner={u[\"is_site_owner\"]}') for u in users]" 2>/dev/null
