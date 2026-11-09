#!/bin/bash
# Test nested subdomain feature
TOKEN=$(echo '{"email":"garet@email.com","password":"impfa6bAQm!xRhfQrilR"}' | curl -sf -X POST https://rslvd.net/api/auth/login -H 'Content-Type: application/json' -d @- | python3 -c 'import sys,json; print(json.load(sys.stdin)["token"])')
echo "Owner token: ${TOKEN:0:20}..."

echo ""
echo "1. Create top-level host 'ownerbase':"
RESP=$(curl -sf -X POST https://rslvd.net/api/hosts -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"hostname":"ownerbase"}')
echo "$RESP"
PARENT_ID=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
echo "Parent ID: $PARENT_ID"

echo ""
echo "2. Create nested host 'dev.ownerbase.rslvd.net':"
curl -sf -X POST https://rslvd.net/api/hosts -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "{\"hostname\":\"dev\",\"parent_id\":\"$PARENT_ID\"}"
echo ""

echo ""
echo "3. Create nested host 'staging.ownerbase.rslvd.net':"
curl -sf -X POST https://rslvd.net/api/hosts -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "{\"hostname\":\"staging\",\"parent_id\":\"$PARENT_ID\"}"
echo ""

echo ""
echo "4. Try double-nesting (should fail):"
DEV_ID=$(curl -sf https://rslvd.net/api/hosts -H "Authorization: Bearer $TOKEN" | python3 -c "import sys,json; rows=json.load(sys.stdin); [print(r['id']) for r in rows if 'dev' in r.get('hostname','') and r.get('parent_host_id')]" 2>/dev/null | head -1)
curl -sf -X POST https://rslvd.net/api/hosts -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "{\"hostname\":\"deep\",\"parent_id\":\"$DEV_ID\"}"
echo ""

echo ""
echo "5. Regular user can't nest:"
REG_TOKEN=$(echo '{"email":"blocktest@rslvd.net","password":"TestPass123!"}' | curl -sf -X POST https://rslvd.net/api/auth/login -H 'Content-Type: application/json' -d @-)
REG_TOK=$(echo "$REG_TOKEN" | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))" 2>/dev/null)
curl -sf -X POST https://rslvd.net/api/hosts -H "Authorization: Bearer $REG_TOK" -H 'Content-Type: application/json' -d "{\"hostname\":\"dev\",\"parent_id\":\"$PARENT_ID\"}"
echo ""

echo ""
echo "6. List all owner hosts (should show tree):"
curl -sf https://rslvd.net/api/hosts -H "Authorization: Bearer $TOKEN" | python3 -c "
import sys,json
rows=json.load(sys.stdin)
for r in rows:
    indent = '  └─ ' if r.get('parent_host_id') else ''
    print(f\"{indent}{r['fqdn']} (parent={r.get('parent_host_id','—')[:8] if r.get('parent_host_id') else '—'})\")
"
