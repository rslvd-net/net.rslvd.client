#!/bin/bash
set -e

echo "==> Creating app user and directory"
id -u rslvd &>/dev/null || sudo useradd -r -s /bin/false rslvd
sudo mkdir -p /opt/rslvd/public
sudo chown -R rslvd:rslvd /opt/rslvd

echo "==> Copying app files"
sudo cp -r /tmp/rslvd-app/server.js /opt/rslvd/
sudo cp -r /tmp/rslvd-app/package.json /opt/rslvd/
sudo cp -r /tmp/rslvd-app/.env /opt/rslvd/
sudo cp -r /tmp/rslvd-app/routes /opt/rslvd/
sudo cp -r /tmp/rslvd-app/db /opt/rslvd/
sudo cp -r /tmp/rslvd-app/lib /opt/rslvd/
sudo cp -r /tmp/rslvd-app/middleware /opt/rslvd/
sudo cp -r /tmp/rslvd-app/public/* /opt/rslvd/public/

echo "==> Installing certbot hooks"
sudo mkdir -p /opt/rslvd/certbot-hooks
sudo cp /tmp/rslvd-app/../certbot-hooks/* /opt/rslvd/certbot-hooks/
sudo chmod +x /opt/rslvd/certbot-hooks/*.sh

echo "==> Installing per-tunnel cert provisioning scripts"
sudo mkdir -p /opt/rslvd/scripts
sudo cp /tmp/rslvd-app/../scripts/*.sh /opt/rslvd/scripts/
sudo chmod +x /opt/rslvd/scripts/*.sh

echo "==> Installing npm dependencies"
cd /opt/rslvd
sudo -u rslvd npm install --production --silent

echo "==> Installing systemd service"
sudo cp /tmp/rslvd-app/rslvd.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable rslvd
sudo systemctl restart rslvd

echo "==> Configuring nginx"
sudo mkdir -p /etc/nginx/conf.d/rslvd-http
sudo cp /tmp/rslvd-app/nginx-http.conf /etc/nginx/sites-available/rslvd.privatedns.org
sudo ln -sf /etc/nginx/sites-available/rslvd.privatedns.org /etc/nginx/sites-enabled/rslvd.privatedns.org
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx

echo "==> Requesting wildcard SSL certificate (DNS-01 via IONOS)"
sudo certbot certonly --manual --preferred-challenges=dns \
  --manual-auth-hook=/opt/rslvd/certbot-hooks/ionos-auth.sh \
  --manual-cleanup-hook=/opt/rslvd/certbot-hooks/ionos-cleanup.sh \
  -d "rslvd.privatedns.org" -d "*.rslvd.privatedns.org" \
  --non-interactive --agree-tos --email admin@rslvd.privatedns.org \
  --cert-name rslvd.privatedns.org \
  --deploy-hook=/opt/rslvd/certbot-hooks/renew-deploy.sh \
  || echo "Wildcard cert already exists or failed - check manually"

echo "==> Updating nginx with full SSL config"
sudo cp /tmp/rslvd-nginx/nginx-rslvd.conf /etc/nginx/sites-available/rslvd.privatedns.org
sudo nginx -t && sudo systemctl reload nginx

echo "==> Setting up certbot renewal timer"
# certbot auto-renewal is typically handled by the certbot package's systemd
# timer or cron. Ensure deploy hook runs on renewal:
sudo mkdir -p /etc/letsencrypt/renewal-hooks/deploy
sudo ln -sf /opt/rslvd/certbot-hooks/renew-deploy.sh /etc/letsencrypt/renewal-hooks/deploy/rslvd-reload-nginx.sh

echo "==> Granting rslvd user cert provisioning permissions"
# tunnel-cert.js runs the provision/deprovision scripts as: sudo /opt/rslvd/scripts/<script>.sh <fqdn>
# The scripts run as root and handle certbot, nginx -t, and systemctl reload internally,
# so the service user only needs NOPASSWD for the two scripts themselves.
SUDOERS_FILE="/etc/sudoers.d/rslvd-ssl"
cat <<EOF | sudo tee "$SUDOERS_FILE" > /dev/null
# Allow rslvd service to provision/deprovision per-tunnel SSL certs
rslvd ALL=(ALL) NOPASSWD: /opt/rslvd/scripts/provision-tunnel-cert.sh *
rslvd ALL=(ALL) NOPASSWD: /opt/rslvd/scripts/deprovision-tunnel-cert.sh *
rslvd ALL=(ALL) NOPASSWD: /opt/rslvd/scripts/enable-http-fallback.sh *
rslvd ALL=(ALL) NOPASSWD: /opt/rslvd/scripts/disable-http-fallback.sh *
EOF
sudo chmod 440 "$SUDOERS_FILE"
sudo visudo -cf "$SUDOERS_FILE"

echo "==> Checking service status"
sleep 2
sudo systemctl status rslvd --no-pager

echo ""
echo "✓ Deployment complete! https://rslvd.privatedns.org"
echo "  Nested subdomains will auto-provision SSL certs via DNS-01."
echo "  HTTP fallback active for nested subdomains while certs provision."
