#!/bin/bash
# certbot manual-auth-hook: create the DNS-01 TXT record via the IONOS API.
# certbot provides CERTBOT_DOMAIN and CERTBOT_VALIDATION.
set -euo pipefail

API_KEY=$(grep '^IONOS_API_KEY=' /opt/rslvd/.env | cut -d= -f2- | tr -d '"' | tr -d "'")
BASE="https://api.hosting.ionos.com/dns/v1"
ZONE="rslvd.net"
NAME="_acme-challenge.${CERTBOT_DOMAIN#\*.}"

ZONE_ID=$(curl -sf -H "X-API-Key: $API_KEY" "$BASE/zones" \
  | python3 -c "import sys,json;print([z['id'] for z in json.load(sys.stdin) if z['name']=='$ZONE'][0])")

curl -sf -X POST -H "X-API-Key: $API_KEY" -H 'Content-Type: application/json' \
  -d "[{\"name\":\"$NAME\",\"type\":\"TXT\",\"content\":\"$CERTBOT_VALIDATION\",\"ttl\":60,\"prio\":0,\"disabled\":false}]" \
  "$BASE/zones/$ZONE_ID/records" > /dev/null

# wait for DNS propagation
sleep 90
