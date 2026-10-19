#!/bin/bash
set -e

# Generate a secure random password
OWNER_PASS=$(python3 -c "import secrets,string; print(''.join(secrets.choice(string.ascii_letters+string.digits+'!@#$%') for _ in range(20)))")

# Store it to /opt/rslvd/owner-credentials.txt
sudo tee /opt/rslvd/owner-credentials.txt > /dev/null << EOF
# rslvd.privatedns.org Site Owner Credentials
# Generated: $(date)
email: garet@email.com
password: $OWNER_PASS
role: site_owner
EOF
sudo chmod 600 /opt/rslvd/owner-credentials.txt
sudo chown rslvd:rslvd /opt/rslvd/owner-credentials.txt

echo "Credentials saved to /opt/rslvd/owner-credentials.txt"

# Hash the password and insert/update the user via API
HASH=$(python3 -c "
import subprocess, sys
result = subprocess.run(['node', '-e', '''
require(\"/opt/rslvd/node_modules/bcryptjs\").hash(process.argv[1], 12, (e,h) => { process.stdout.write(h); });
''', sys.argv[1]], capture_output=True, text=True, cwd='/opt/rslvd')
print(result.stdout.strip())
" "$OWNER_PASS")

sudo -u postgres psql rslvd << SQLEOF
INSERT INTO users (email, password_hash, plan, max_hosts, max_tunnels, subscription_status, is_admin, is_site_owner)
VALUES ('garet@email.com', '$HASH', 'annual', 999, 999, 'active', TRUE, TRUE)
ON CONFLICT (email) DO UPDATE SET
  password_hash = EXCLUDED.password_hash,
  plan = 'annual',
  max_hosts = 999,
  max_tunnels = 999,
  subscription_status = 'active',
  is_admin = TRUE,
  is_site_owner = TRUE,
  updated_at = NOW();
\q
SQLEOF

echo ""
echo "============================================"
echo "  Site Owner Account Created"
echo "  Email:    garet@email.com"
echo "  Password: $OWNER_PASS"
echo "  File:     /opt/rslvd/owner-credentials.txt"
echo "============================================"
