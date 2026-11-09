#!/bin/bash
# Register a normal user and try to grab a reserved subdomain
echo '{"email":"blocktest@rslvd.net","password":"TestPass123!"}' > /tmp/reg2.json
RESP=$(curl -s -X POST https://rslvd.net/api/auth/register -H "Content-Type: application/json" -d @/tmp/reg2.json)
TOKEN=$(echo $RESP | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))" 2>/dev/null)
echo "Normal user token: ${TOKEN:0:20}..."

echo "Trying to register 'api' (reserved):"
curl -s -X POST https://rslvd.net/api/hosts -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"hostname":"api"}'
echo ""

echo "Trying to register 'www' (reserved):"
curl -s -X POST https://rslvd.net/api/hosts -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"hostname":"www"}'
echo ""

echo "Trying to register 'myhome' (not reserved - should succeed):"
curl -s -X POST https://rslvd.net/api/hosts -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"hostname":"myhome"}'
echo ""
