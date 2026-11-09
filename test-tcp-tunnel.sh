#!/bin/bash
set -e

echo "=== TCP Tunnel End-to-End Test ==="

# Get auth token
TOKEN=$(curl -sf -X POST https://rslvd.net/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"garet@email.com","password":"impfa6bAQm!xRhfQrilR"}' \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["token"])')
echo "Auth OK"

# Create a tunnel
TUNNEL=$(curl -sf -X POST https://rslvd.net/api/tunnels \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"tcptest","target_port":9999}')
echo "Tunnel created: $TUNNEL" | python3 -c '
import sys
data = sys.stdin.read()
# just print it
print(data[:200])
'

TTOKEN=$(echo "$TUNNEL" | python3 -c 'import sys,json; print(json.load(sys.stdin)["token"])')
TPORT=$(echo "$TUNNEL" | python3 -c 'import sys,json; print(json.load(sys.stdin)["tunnel_port"])')
echo "Tunnel token: ${TTOKEN:0:12}..."
echo "Public port:  $TPORT"

# Spin up a tiny echo server on port 9999
echo "Starting local echo server on :9999..."
socat TCP-LISTEN:9999,fork EXEC:'echo HELLO_FROM_LOCAL' &
SOCAT_PID=$!
sleep 1

# Connect the rslvd-tunnel binary
echo "Starting rslvd-tunnel..."
/opt/rslvd/public/dl/rslvd-tunnel-linux-amd64 "$TTOKEN" 9999 &
TUNNEL_PID=$!
sleep 2

# Test: connect to public port and see if we get HELLO_FROM_LOCAL
echo "Testing public port $TPORT..."
RESULT=$(echo "" | nc -w 3 127.0.0.1 $TPORT 2>/dev/null || echo "FAILED")
echo "Got: $RESULT"

if echo "$RESULT" | grep -q "HELLO_FROM_LOCAL"; then
  echo ""
  echo "✓ TCP tunnel works end-to-end!"
else
  echo ""
  echo "✗ Did not get expected response (may need a moment to connect)"
fi

# Cleanup
kill $TUNNEL_PID 2>/dev/null || true
kill $SOCAT_PID 2>/dev/null || true

# Cleanup tunnel in DB
TID=$(echo "$TUNNEL" | python3 -c 'import sys,json; print(json.load(sys.stdin)["id"])')
curl -sf -X DELETE "https://rslvd.net/api/tunnels/$TID" -H "Authorization: Bearer $TOKEN" > /dev/null
echo "Tunnel cleaned up."
