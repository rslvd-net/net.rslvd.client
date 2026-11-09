#!/bin/bash
TOKEN=$(echo '{"email":"garet@email.com","password":"impfa6bAQm!xRhfQrilR"}' | curl -sf -X POST https://rslvd.net/api/auth/login -H 'Content-Type: application/json' -d @- | python3 -c 'import sys,json; print(json.load(sys.stdin)["token"])')
echo "Token: ${TOKEN:0:20}..."

echo ""
echo "--- /me (totpEnabled + displayName) ---"
curl -sf https://rslvd.net/api/auth/me -H "Authorization: Bearer $TOKEN" | python3 -c 'import sys,json; u=json.load(sys.stdin); print(f"totpEnabled={u[\"totpEnabled\"]}, displayName={u[\"displayName\"]}")'

echo ""
echo "--- PATCH /profile ---"
curl -sf -X PATCH https://rslvd.net/api/auth/profile \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"displayName":"Garet (owner)"}'

echo ""
echo "--- Verify displayName saved ---"
curl -sf https://rslvd.net/api/auth/me -H "Authorization: Bearer $TOKEN" | python3 -c 'import sys,json; u=json.load(sys.stdin); print(f"displayName={u[\"displayName\"]}")'

echo ""
echo "--- POST /2fa/setup ---"
SETUP=$(curl -sf -X POST https://rslvd.net/api/auth/2fa/setup -H "Authorization: Bearer $TOKEN")
echo "$SETUP" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(f"secret={d[\"secret\"][:12]}...\notpauth_url ok={'otpauth' in d['otpauth_url']}")'

echo ""
echo "--- GET /activity ---"
curl -sf https://rslvd.net/api/auth/activity -H "Authorization: Bearer $TOKEN" | python3 -c '
import sys,json
rows=json.load(sys.stdin)
print(f"{len(rows)} events")
for r in rows[:5]:
    print(f"  {r[\"event\"]:30} {r[\"created_at\"][:19]}")
'

echo ""
echo "--- 2FA not yet enabled on login ---"
RESULT=$(echo '{"email":"garet@email.com","password":"impfa6bAQm!xRhfQrilR"}' | curl -sf -X POST https://rslvd.net/api/auth/login -H 'Content-Type: application/json' -d @-)
echo "$RESULT" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(f"requireTotp={d.get(\"requireTotp\", False)}, hasToken={\"token\" in d}")'
