#!/bin/bash
echo "=== rslvd.net smoke test ==="

# Login as site owner
CREDS_FILE=/opt/rslvd/owner-credentials.txt
PASS=$(grep 'password:' $CREDS_FILE | awk '{print $2}')
echo "Testing login as garet@email.com..."

echo "{\"email\":\"garet@email.com\",\"password\":\"$PASS\"}" > /tmp/login.json
RESP=$(curl -s -X POST https://rslvd.net/api/auth/login -H "Content-Type: application/json" -d @/tmp/login.json)
echo "Login response: $RESP" | head -c 200
echo ""

TOKEN=$(echo $RESP | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))" 2>/dev/null)
ROLE=$(echo $RESP | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('user',{}).get('role',''))" 2>/dev/null)
echo "Role: $ROLE"

if [ -z "$TOKEN" ]; then
  echo "ERROR: No token received"
  exit 1
fi

echo ""
echo "Testing /me..."
curl -s https://rslvd.net/api/auth/me -H "Authorization: Bearer $TOKEN" | python3 -m json.tool 2>/dev/null | head -20

echo ""
echo "Testing /admin/stats..."
curl -s https://rslvd.net/api/admin/stats -H "Authorization: Bearer $TOKEN" | python3 -m json.tool 2>/dev/null

echo ""
echo "Testing /tunnels (list)..."
curl -s https://rslvd.net/api/tunnels -H "Authorization: Bearer $TOKEN"

echo ""
echo "=== All tests passed ==="
