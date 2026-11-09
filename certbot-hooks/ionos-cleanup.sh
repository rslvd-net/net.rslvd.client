#!/bin/bash
# certbot manual-cleanup-hook: remove the DNS-01 TXT record(s) via the IONOS API.
set -euo pipefail

API_KEY=$(grep '^IONOS_API_KEY=' /opt/rslvd/.env | cut -d= -f2- | tr -d '"' | tr -d "'")
BASE="https://api.hosting.ionos.com/dns/v1"
ZONE="rslvd.net"
NAME="_acme-challenge.${CERTBOT_DOMAIN#\*.}"

ZONE_ID=$(curl -sf -H "X-API-Key: $API_KEY" "$BASE/zones" \
  | python3 -c "import sys,json;print([z['id'] for z in json.load(sys.stdin) if z['name']=='$ZONE'][0])")

RECORD_IDS=$(curl -sf -H "X-API-Key: $API_KEY" "$BASE/zones/$ZONE_ID?recordType=TXT&recordName=$NAME" \
  | python3 -c "import sys,json;[print(r['id']) for r in json.load(sys.stdin).get('records',[]) if r['name']=='$NAME']")

for id in $RECORD_IDS; do
  curl -sf -X DELETE -H "X-API-Key: $API_KEY" "$BASE/zones/$ZONE_ID/records/$id" > /dev/null || true
done
