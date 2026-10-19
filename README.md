# **Running a home lab behind CGNAT?**
 
###### If you've ever tried to access a service running at home from outside your network, you know how frustrating networking limitations can be.
 
###### I'm working on **RSLVD.net**, a project focused on Dynamic DNS and CGNAT tunneling.
 
*** I'm looking to connect with home-lab enthusiasts, self-hosters, and developers who want to make their services reachable.
 
I'd love to hear:
 
- What are you running at home?
- What is your biggest remote-access challenge?
- What would make a tool like this genuinely useful to you?

Check it out: https://rslvd.privatedns.org/

# RSLVD.NET

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-22+-green.svg)](https://nodejs.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-17+-blue.svg)](https://www.postgresql.org/)

> Dynamic DNS & CGNAT Tunnel SaaS - Free subdomains, automatic IP updates, and TCP tunnels that punch through carrier-grade NAT.

**Live:** https://rslvd.privatedns.org

---

## Table of Contents

- [Features](#features)
- [Architecture](#architecture)
- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Installation](#installation)
- [Configuration](#configuration)
- [Deployment](#deployment)
- [Building Tunnel Client](#building-tunnel-client)
- [API Reference](#api-reference)
- [Development](#development)
- [Testing](#testing)
- [Troubleshooting](#troubleshooting)
- [License](#license)

---

## Features

- **🌐 Dynamic DNS** - Automatic IP updates via HTTP API, compatible with any DynDNS client
- **🚇 CGNAT Tunnels** - TCP tunnels that work behind carrier-grade NAT without port forwarding
- **🔒 Free SSL Certificates** - Automatic Let's Encrypt integration
- **💳 Subscription Billing** - Square integration with multiple pricing tiers
- **📱 Multi-Platform** - Tunnel client binaries for Linux, macOS, Windows, Android (Termux), and routers
- **🛡️ Admin Dashboard** - Built-in user management and activity logging
- **⚡ WebSocket Support** - Full WebSocket and binary protocol support through tunnels

---

## Architecture

```
┌─────────────┐     ┌─────────────┐     ┌─────────────────┐
│   Router    │────▶│  example.com  │────▶│  IONOS DNS API  │
│  (DDNS)     │     │   (Node.js) │     │                 │
└─────────────┘     └─────────────┘     └─────────────────┘
                           │
                           ▼
                    ┌─────────────┐
                    │  PostgreSQL │
                    │    Redis    │
                    └─────────────┘
                           │
                           ▼
                    ┌─────────────┐
                    │ Tunnel Proxy│◀────┐
                    │  (ports     │     │
                    │  7000/7001) │     │
                    └─────────────┘     │
                                        │
                              ┌─────────┘
                              ▼
                    ┌─────────────────┐
                    │ rslvd-tunnel CLI│
                    │  (user's device)│
                    └─────────────────┘
```

**Components:**
- **Node.js API** - Express server handling auth, DNS updates, billing, admin
- **PostgreSQL** - User accounts, hosts, tunnels, subscriptions
- **Redis** - Session caching (optional)
- **Tunnel Proxy** - Built-in TCP tunnel server (ports 7000/7001)
- **Tunnel Client** - Go binary for establishing reverse tunnels
- **Nginx** - Reverse proxy and SSL termination
- **Certbot** - Automatic SSL certificate management

---

## Prerequisites

### Server Requirements

- **OS:** Debian 12+ / Ubuntu 22.04+ (recommended)
- **RAM:** 1GB minimum, 2GB recommended
- **CPU:** 1 core minimum
- **Disk:** 10GB minimum
- **Network:** Public IP, ports 80, 443, 7000, 7001 open

### Software Dependencies

```bash
# System packages
sudo apt update
sudo apt install -y nodejs npm postgresql redis-server nginx git curl

# Go (for building tunnel client)
sudo apt install -y golang-go

# Certbot
sudo apt install -y certbot python3-certbot-nginx
```

### External Services

| Service | Purpose | Setup Required |
|---------|---------|----------------|
| IONOS DNS | DNS record management | [Get API Key](https://developer.hosting.ionos.com/) |
| Square | Payment processing | [Square Developer Dashboard](https://developer.squareup.com/apps) |
| Domain | Your domain name | Configure nameservers to IONOS |

---

## Quick Start

```bash
# 1. Clone repository
git clone https://github.com/igaret/rslvd.privatedns.org.git
cd rslvd.privatedns.org

# 2. Copy and configure environment
cp app/.env.example app/.env
# Edit app/.env with your credentials

# 3. Run deployment script
./deploy.sh
```

---

## Installation

### Step 1: Server Setup

```bash
# Create app user
sudo useradd -r -s /bin/false rslvd

# Create directories
sudo mkdir -p /opt/rslvd/public/dl
sudo chown -R rslvd:rslvd /opt/rslvd

# Install Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```

### Step 2: Database Setup

```bash
# Switch to postgres user
sudo -u postgres psql

# Create database and user
CREATE USER rslvd WITH PASSWORD 'your_secure_password';
CREATE DATABASE rslvd OWNER rslvd;
\q

# Set environment variable in ~/.bashrc or service file
export DATABASE_URL="postgresql://rslvd:your_secure_password@localhost:5432/rslvd"
```

### Step 3: Application Deployment

```bash
# Copy application files
sudo cp -r app/* /opt/rslvd/
sudo chown -R rslvd:rslvd /opt/rslvd

# Install dependencies
cd /opt/rslvd
sudo -u rslvd npm install --production

# Run database migrations
sudo -u rslvd node -e "require('./db/migrate').run()"
```

### Step 4: Nginx Configuration

```bash
# Copy nginx config
sudo cp app/nginx.conf /etc/nginx/sites-available/example.com
sudo ln -sf /etc/nginx/sites-available/example.com /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default

# Test and reload
sudo nginx -t
sudo systemctl reload nginx
```

### Step 5: SSL Certificate

```bash
# Obtain certificate
sudo certbot --nginx -d example.com -d www.example.com \
  --email admin@example.com --agree-tos --non-interactive

# Auto-renewal is set up automatically
```

### Step 6: Systemd Service

```bash
# Copy service file
sudo cp app/rslvd.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable rslvd
sudo systemctl start rslvd

# Check status
sudo systemctl status rslvd
```

---

## Configuration

### Environment Variables

Create `app/.env`:

```env
NODE_ENV=production
PORT=3001

# Database
DATABASE_URL=postgresql://rslvd:password@localhost:5432/rslvd

# Redis (optional)
REDIS_URL=redis://localhost:6379

# JWT Secret (generate random string)
JWT_SECRET=your_random_jwt_secret_here

# IONOS DNS API
IONOS_API_KEY=your_ionos_api_key_here

# Square
SQUARE_ACCESS_TOKEN=EAAA...
SQUARE_APPLICATION_ID=sq0idp-...
SQUARE_LOCATION_ID=L...
SQUARE_ENVIRONMENT=production
SQUARE_WEBHOOK_SIGNATURE_KEY=...

# Domain
BASE_DOMAIN=example.com
APP_URL=https://example.com
SERVER_IP=your_server_ip
```

### Site Admin Account

```bash
# Run setup script
./setup-admin.sh

# Or manually create admin user in database
sudo -u rslvd psql rslvd -c "
INSERT INTO users (email, password_hash, role, is_admin, is_site_owner, plan, subscription_status, max_hosts, max_tunnels)
VALUES ('admin@example.com', '\$2a\$10\$...', 'site_owner', true, true, 'annual', 'active', 999, 999);
"
```

---

## Deployment

### Automated Deployment

The `deploy.sh` script handles full deployment:

```bash
# On local machine
scp -r app/ user@server:/tmp/rslvd-app
ssh user@server 'cd /tmp/rslvd-app && sudo ./deploy.sh'
```

### Manual Deployment Steps

1. **Upload files** to `/tmp/rslvd-app/`
2. **Run deploy script** which:
   - Creates `rslvd` user
   - Copies application files to `/opt/rslvd/`
   - Installs npm dependencies
   - Sets up systemd service
   - Configures nginx
   - Requests SSL certificate
   - Starts services

### Updating the Application

```bash
# Quick update (frontend only)
scp app/public/app.js rslvd@server:/opt/rslvd/public/
ssh rslvd@server 'sudo systemctl restart rslvd'

# Full update
./deploy.sh
```

---

## Building Tunnel Client

The tunnel client is a Go binary that establishes reverse TCP tunnels.

### Build All Platforms

```bash
# Run build script
sudo ./build-tunnel.sh

# Or build manually
cd tunnel-client

go build -ldflags="-s -w" -o rslvd-tunnel-linux-amd64 .
GOOS=darwin GOARCH=arm64 go build -ldflags="-s -w" -o rslvd-tunnel-darwin-arm64 .
# ... etc for other platforms
```

### Supported Platforms

| Platform | Binary Name |
|----------|-------------|
| Linux AMD64 | `rslvd-tunnel-linux-amd64` |
| Linux ARM64 | `rslvd-tunnel-linux-arm64` |
| Linux ARM | `rslvd-tunnel-linux-arm` |
| Linux MIPS | `rslvd-tunnel-linux-mips` |
| Linux MIPSLE | `rslvd-tunnel-linux-mipsle` |
| Linux MIPS64 | `rslvd-tunnel-linux-mips64` |
| macOS Intel | `rslvd-tunnel-darwin-amd64` |
| macOS Apple Silicon | `rslvd-tunnel-darwin-arm64` |
| Windows | `rslvd-tunnel-windows-amd64.exe` |

### Installation Script

Create `/opt/rslvd/public/install.sh`:

```bash
#!/bin/bash
# Auto-detect platform and install
# (See repository for full install script)
```

---

## API Reference

### Authentication

```bash
# Login
POST /api/auth/login
{ "email": "user@example.com", "password": "secret" }

# Response: { "token": "jwt_token_here" }
# Include token in header: Authorization: Bearer <token>
```

### Hosts (Dynamic DNS)

```bash
# List hosts
GET /api/hosts

# Create host
POST /api/hosts
{ "fqdn": "myhost.example.com" }

# Update IP (DynDNS compatible)
GET /api/update?key=<update_key>&ip=1.2.3.4

# Regenerate key
POST /api/hosts/:id/regenerate-key
```

### Tunnels

```bash
# List tunnels
GET /api/tunnels

# Create tunnel
POST /api/tunnels
{ "name": "mytunnel", "target_port": 8080 }

# Delete tunnel
DELETE /api/tunnels/:id
```

### Billing

```bash
# Get plans
GET /api/billing/plans

# Checkout
POST /api/billing/checkout
{ "plan": "annual" }

# Customer portal
POST /api/billing/portal

# Cancel subscription
POST /api/billing/cancel
```

### Admin (Site Owner Only)

```bash
GET /api/admin/stats
GET /api/admin/users
GET /api/admin/hosts
GET /api/admin/tunnels
GET /api/admin/activity
PATCH /api/admin/users/:id
DELETE /api/admin/users/:id
```

---

## Development

### Local Setup

```bash
cd app
npm install
npm run dev
```

### Database Migrations

```bash
# Run migrations
node -e "require('./db/migrate').run()"

# Migrations are in db/migrate.js
# Auto-run on server start
```

### Frontend Development

The frontend is a single-page React app in `app/public/app.js`:

```javascript
// Built with React.createElement (no build step required)
// Edit app/public/app.js directly
```

### Testing Scripts

```bash
./test.sh              # Run all tests
./test-account.sh      # Test user registration
./test-block.sh        # Test subscription blocking
./test-nested.sh       # Test nested subdomains
./test-tcp-tunnel.sh   # Test tunnel functionality
./verify-activity.sh   # Test activity logging
```

---

## Troubleshooting

### Common Issues

**App won't start:**
```bash
# Check logs
sudo journalctl -u rslvd -f

# Verify database connection
sudo -u rslvd psql $DATABASE_URL -c "SELECT 1"
```

**SSL certificate issues:**
```bash
# Renew manually
sudo certbot renew --force-renewal

# Check nginx config
sudo nginx -t
```

**Tunnel connection fails:**
```bash
# Check ports are open
sudo netstat -tlnp | grep -E '7000|7001'

# Test DNS resolution
nslookup example.com 8.8.8.8
```

**IONOS DNS errors:**
```bash
# Test IONOS API
./certbot-hooks/test-ionos.sh
```

### Logs

```bash
# Application logs
sudo journalctl -u rslvd -n 100 --no-pager

# Nginx logs
sudo tail -f /var/log/nginx/example.com-error.log

# Tunnel proxy logs (in app logs)
sudo journalctl -u rslvd | grep "TUNNEL"
```

### Firewall Configuration

```bash
# UFW
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 7000/tcp
sudo ufw allow 7001/tcp

# iptables
sudo iptables -A INPUT -p tcp --dport 80 -j ACCEPT
sudo iptables -A INPUT -p tcp --dport 443 -j ACCEPT
sudo iptables -A INPUT -p tcp --dport 7000 -j ACCEPT
sudo iptables -A INPUT -p tcp --dport 7001 -j ACCEPT
```

---

## Security Considerations

1. **Change default passwords** - Update all secrets in `.env`
2. **Enable firewall** - Only expose necessary ports
3. **Regular updates** - Keep Node.js, PostgreSQL, and system packages updated
4. **Backup database** - Automated backups recommended
5. **Monitor logs** - Watch for suspicious activity
6. **Rate limiting** - Built-in on API endpoints
7. **JWT expiration** - Tokens expire after 24 hours

---

## License

MIT License - See [LICENSE](LICENSE) file

---

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

---

## Support

- **Issues:** [GitHub Issues](https://github.com/igaret/rslvd.privatedns.org/issues)
- **Email:** garet@rslvd.privatedns.org
- **Documentation:** This README and inline code comments

---

**Built with ❤️ by igaret** 
                              ▼
                    ┌─────────────────┐
                    │ rslvd-tunnel CLI│
                    │  (user's device)│
                    └─────────────────┘
```

**Components:**
- **Node.js API** - Express server handling auth, DNS updates, billing, admin
- **PostgreSQL** - User accounts, hosts, tunnels, subscriptions
- **Redis** - Session caching (optional)
- **Tunnel Proxy** - Built-in TCP tunnel server (ports 7000/7001)
- **Tunnel Client** - Go binary for establishing reverse tunnels
- **Nginx** - Reverse proxy and SSL termination
- **Certbot** - Automatic SSL certificate management

---

## Prerequisites

### Server Requirements

- **OS:** Debian 12+ / Ubuntu 22.04+ (recommended)
- **RAM:** 1GB minimum, 2GB recommended
- **CPU:** 1 core minimum
- **Disk:** 10GB minimum
- **Network:** Public IP, ports 80, 443, 7000, 7001 open

### Software Dependencies

```bash
# System packages
sudo apt update
sudo apt install -y nodejs npm postgresql redis-server nginx git curl

# Go (for building tunnel client)
sudo apt install -y golang-go

# Certbot
sudo apt install -y certbot python3-certbot-nginx
```

### External Services

| Service | Purpose | Setup Required |
|---------|---------|----------------|
| IONOS DNS | DNS record management | [Get API Key](https://developer.hosting.ionos.com/) |
| Square | Payment processing | [Square Developer Dashboard](https://developer.squareup.com/apps) |
| Domain | Your domain name | Configure nameservers to IONOS |

---

## Quick Start

```bash
# 1. Clone repository
git clone https://github.com/yourusername/rslvd.privatedns.org.git
cd rslvd.privatedns.org

# 2. Copy and configure environment
cp app/.env.example app/.env
# Edit app/.env with your credentials

# 3. Run deployment script
./deploy.sh
```

---

## Installation

### Step 1: Server Setup

```bash
# Create app user
sudo useradd -r -s /bin/false rslvd

# Create directories
sudo mkdir -p /opt/rslvd/public/dl
sudo chown -R rslvd:rslvd /opt/rslvd

# Install Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```

### Step 2: Database Setup

```bash
# Switch to postgres user
sudo -u postgres psql

# Create database and user
CREATE USER rslvd WITH PASSWORD 'your_secure_password';
CREATE DATABASE rslvd OWNER rslvd;
\q

# Set environment variable in ~/.bashrc or service file
export DATABASE_URL="postgresql://rslvd:your_secure_password@localhost:5432/rslvd"
```

### Step 3: Application Deployment

```bash
# Copy application files
sudo cp -r app/* /opt/rslvd/
sudo chown -R rslvd:rslvd /opt/rslvd

# Install dependencies
cd /opt/rslvd
sudo -u rslvd npm install --production

# Run database migrations
sudo -u rslvd node -e "require('./db/migrate').run()"
```

### Step 4: Nginx Configuration

```bash
# Copy nginx config
sudo cp app/nginx.conf /etc/nginx/sites-available/rslvd.privatedns.org
sudo ln -sf /etc/nginx/sites-available/rslvd.privatedns.org /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default

# Test and reload
sudo nginx -t
sudo systemctl reload nginx
```

### Step 5: SSL Certificate

```bash
# Obtain certificate
sudo certbot --nginx -d rslvd.privatedns.org -d www.rslvd.privatedns.org \
  --email admin@rslvd.privatedns.org --agree-tos --non-interactive

# Auto-renewal is set up automatically
```

### Step 6: Systemd Service

```bash
# Copy service file
sudo cp app/rslvd.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable rslvd
sudo systemctl start rslvd

# Check status
sudo systemctl status rslvd
```

---

## Configuration

### Environment Variables

Create `app/.env`:

```env
NODE_ENV=production
PORT=3001

# Database
DATABASE_URL=postgresql://rslvd:password@localhost:5432/rslvd

# Redis (optional)
REDIS_URL=redis://localhost:6379

# JWT Secret (generate random string)
JWT_SECRET=your_random_jwt_secret_here

# IONOS DNS API
IONOS_API_KEY=your_ionos_api_key_here

# Square
SQUARE_ACCESS_TOKEN=EAAA...
SQUARE_APPLICATION_ID=sq0idp-...
SQUARE_LOCATION_ID=L...
SQUARE_ENVIRONMENT=production
SQUARE_WEBHOOK_SIGNATURE_KEY=...

# Domain
BASE_DOMAIN=rslvd.privatedns.org
APP_URL=https://rslvd.privatedns.org
SERVER_IP=your_server_ip
```

### Pricing Plans

Plans are defined in `app/lib/plans.js` and charged via the Square Payments API:

| Plan | Price | Hosts | Tunnels |
|------|-------|-------|---------|
| Free | $0 | 1 | 1 |
| Monthly | $0.99/mo | 3 | 3 |
| Quarterly | $1.99/3mo | 5 | 5 |
| Semi-Annual | $4.99/6mo | 10 | 10 |
| Annual | $8.99/yr | 25 | 25 |

### Site Owner Account

```bash
# Run setup script
./setup-owner.sh

# Or manually create admin user in database
sudo -u rslvd psql rslvd -c "
INSERT INTO users (email, password_hash, role, is_admin, is_site_owner, plan, subscription_status, max_hosts, max_tunnels)
VALUES ('admin@yourdomain.com', '\$2a\$10\$...', 'site_owner', true, true, 'annual', 'active', 999, 999);
"
```

---

## Deployment

### Automated Deployment

The `deploy.sh` script handles full deployment:

```bash
# On local machine
scp -r app/ user@server:/tmp/rslvd-app
ssh user@server 'cd /tmp/rslvd-app && sudo ./deploy.sh'
```

### Manual Deployment Steps

1. **Upload files** to `/tmp/rslvd-app/`
2. **Run deploy script** which:
   - Creates `rslvd` user
   - Copies application files to `/opt/rslvd/`
   - Installs npm dependencies
   - Sets up systemd service
   - Configures nginx
   - Requests SSL certificate
   - Starts services

### Updating the Application

```bash
# Quick update (frontend only)
scp app/public/app.js rslvd@server:/opt/rslvd/public/
ssh rslvd@server 'sudo systemctl restart rslvd'

# Full update
./deploy.sh
```

---

## Building Tunnel Client

The tunnel client is a Go binary that establishes reverse TCP tunnels.

### Build All Platforms

```bash
# Run build script
sudo ./build-tunnel.sh

# Or build manually
cd tunnel-client

go build -ldflags="-s -w" -o rslvd-tunnel-linux-amd64 .
GOOS=darwin GOARCH=arm64 go build -ldflags="-s -w" -o rslvd-tunnel-darwin-arm64 .
# ... etc for other platforms
```

### Supported Platforms

| Platform | Binary Name |
|----------|-------------|
| Linux AMD64 | `rslvd-tunnel-linux-amd64` |
| Linux ARM64 | `rslvd-tunnel-linux-arm64` |
| Linux ARM | `rslvd-tunnel-linux-arm` |
| Linux MIPS | `rslvd-tunnel-linux-mips` |
| Linux MIPSLE | `rslvd-tunnel-linux-mipsle` |
| Linux MIPS64 | `rslvd-tunnel-linux-mips64` |
| macOS Intel | `rslvd-tunnel-darwin-amd64` |
| macOS Apple Silicon | `rslvd-tunnel-darwin-arm64` |
| Windows | `rslvd-tunnel-windows-amd64.exe` |

### Installation Script

Create `/opt/rslvd/public/install.sh`:

```bash
#!/bin/bash
# Auto-detect platform and install
# (See repository for full install script)
```

---

## API Reference

### Authentication

```bash
# Login
POST /api/auth/login
{ "email": "user@example.com", "password": "secret" }

# Response: { "token": "jwt_token_here" }
# Include token in header: Authorization: Bearer <token>
```

### Hosts (Dynamic DNS)

```bash
# List hosts
GET /api/hosts

# Create host
POST /api/hosts
{ "fqdn": "myhost.rslvd.privatedns.org" }

# Update IP (DynDNS compatible)
GET /api/update?key=<update_key>&ip=1.2.3.4

# Regenerate key
POST /api/hosts/:id/regenerate-key
```

### Tunnels

```bash
# List tunnels
GET /api/tunnels

# Create tunnel
POST /api/tunnels
{ "name": "mytunnel", "target_port": 8080 }

# Delete tunnel
DELETE /api/tunnels/:id
```

### Billing

```bash
# Get plans
GET /api/billing/plans

# Checkout
POST /api/billing/checkout
{ "plan": "annual" }

# Customer portal
POST /api/billing/portal

# Cancel subscription
POST /api/billing/cancel
```

### Admin (Site Owner Only)

```bash
GET /api/admin/stats
GET /api/admin/users
GET /api/admin/hosts
GET /api/admin/tunnels
GET /api/admin/activity
PATCH /api/admin/users/:id
DELETE /api/admin/users/:id
```

---

## Development

### Local Setup

```bash
cd app
npm install
npm run dev
```

### Database Migrations

```bash
# Run migrations
node -e "require('./db/migrate').run()"

# Migrations are in db/migrate.js
# Auto-run on server start
```

### Frontend Development

The frontend is a single-page React app in `app/public/app.js`:

```javascript
// Built with React.createElement (no build step required)
// Edit app/public/app.js directly
```

### Testing Scripts

```bash
./test.sh              # Run all tests
./test-account.sh      # Test user registration
./test-block.sh        # Test subscription blocking
./test-nested.sh       # Test nested subdomains
./test-tcp-tunnel.sh   # Test tunnel functionality
./verify-activity.sh   # Test activity logging
```

---

## Troubleshooting

### Common Issues

**App won't start:**
```bash
# Check logs
sudo journalctl -u rslvd -f

# Verify database connection
sudo -u rslvd psql $DATABASE_URL -c "SELECT 1"
```

**SSL certificate issues:**
```bash
# Renew manually
sudo certbot renew --force-renewal

# Check nginx config
sudo nginx -t
```

**Tunnel connection fails:**
```bash
# Check ports are open
sudo netstat -tlnp | grep -E '7000|7001'

# Test DNS resolution
nslookup rslvd.privatedns.org 8.8.8.8
```

**IONOS DNS errors:**
```bash
# Test IONOS API
./certbot-hooks/test-ionos.sh
```

### Logs

```bash
# Application logs
sudo journalctl -u rslvd -n 100 --no-pager

# Nginx logs
sudo tail -f /var/log/nginx/rslvd.privatedns.org-error.log

# Tunnel proxy logs (in app logs)
sudo journalctl -u rslvd | grep "TUNNEL"
```

### Firewall Configuration

```bash
# UFW
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 7000/tcp
sudo ufw allow 7001/tcp

# iptables
sudo iptables -A INPUT -p tcp --dport 80 -j ACCEPT
sudo iptables -A INPUT -p tcp --dport 443 -j ACCEPT
sudo iptables -A INPUT -p tcp --dport 7000 -j ACCEPT
sudo iptables -A INPUT -p tcp --dport 7001 -j ACCEPT
```

---

## Security Considerations

1. **Change default passwords** - Update all secrets in `.env`
2. **Enable firewall** - Only expose necessary ports
3. **Regular updates** - Keep Node.js, PostgreSQL, and system packages updated
4. **Backup database** - Automated backups recommended
5. **Monitor logs** - Watch for suspicious activity
6. **Rate limiting** - Built-in on API endpoints
7. **JWT expiration** - Tokens expire after 24 hours

---

## License

MIT License - See [LICENSE](LICENSE) file

---

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

---

## Support

- **Issues:** [GitHub Issues](https://github.com/yourusername/rslvd.privatedns.org/issues)
- **Email:** admin@rslvd.privatedns.org support@rslvd.privatedns.org *@rslvd.privatedns.org

- **Documentation:** This README and inline code comments

---

**Built with ❤️ by the rslvd.privatedns.org team** 
