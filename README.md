# rslvd.net

**Dynamic DNS and CGNAT tunneling — reachable from anywhere.**

[![Licence: AGPL-3.0](https://img.shields.io/badge/Licence-AGPL--3.0-blue.svg)](LICENCE.md)
[![Node.js](https://img.shields.io/badge/Node.js-22+-green.svg)](https://nodejs.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-15+-336791.svg)](https://www.postgresql.org/)
[![Android](https://img.shields.io/badge/Android-3.7-3DDC84.svg)](rslvd-android/)

**Live service:** <https://rslvd.net> · **Status, terms and downloads:** <https://rslvd.net>

rslvd.net gives you a permanent hostname and a working TCP tunnel from a network you do not
control — a home lab behind CGNAT, a lab machine at work, a phone on mobile data. The service is
donation-funded: every donation buys 90 days of donor access, and there are no subscriptions.

---

## Features

- **Dynamic DNS** — permanent `<name>.rslvd.net` subdomains, updated by any DynDNS-style client.
- **HTTP(S) tunnels** — expose a local web service through the tunnel proxy, WebSockets included.
- **Raw TCP/UDP tunnels** — arbitrary protocols, not just HTTP.
- **SSH and ADB remote access** (donor) — a real public port (`20000-29999`) wired straight through,
  so `ssh -p 21234 you@lab.rslvd.net` and `adb connect phone.rslvd.net:21235` just work.
- **Nested subdomains** (donor) — `api.ownerbase.rslvd.net`, with per-host certificates.
- **Automatic TLS** — Let's Encrypt wildcard via DNS-01, plus per-tunnel certificates.
- **Web dashboard and PWA** — hosts, tunnels, DDNS auto-updater, donation status, admin tools.
- **Android client** — Kotlin/Compose app for on-device tunnels and DDNS (see `rslvd-android/`).
- **Donations, not subscriptions** — Square payments, one-off, no recurring charge to cancel.

Free accounts get 2 hostnames and 2 tunnels. Any donation raises the account to donor access for 90
days: unlimited hostnames and tunnels, SSH/ADB remote access, nested subdomains. Donations start at
$1.

---

## Architecture

```
                    ┌──────────────────────────── rslvd.net server ────────────────────────────┐
  browser ──443──▶  │ nginx ──▶ Node/Express (3001)  ──▶ PostgreSQL                            │
                    │   │            │  auth, hosts, tunnels, billing, admin, support           │
                    │   │            └──▶ tunnel proxy  (control 7000/7001, HTTP 8080, UDP 7100) │
  *.rslvd.net ─443─▶│   └──▶ tunnel proxy ──▶ per-tunnel TCP port (20000-29999) ──▶ your device  │
                    │ certbot + IONOS DNS API (DNS-01)      systemd: rslvd                      │
                    └─────────────────────────────────────────────────────────────────────────┘
```

| Component | Role |
|---|---|
| `app/server.js` | Express 5 API, serves the SPA, runs migrations, starts the tunnel proxy |
| `app/lib/tunnel-proxy.js` | tunnel broker: control/data channels, HTTP proxy, raw public ports |
| `app/public/app2.js` | the whole dashboard SPA — plain `React.createElement`, no build step |
| `tunnel-client/` | Go client, cross-compiled into `app/public/dl/` |
| `rslvd-android/` | Android client |
| nginx | TLS termination, wildcard vhosts, per-FQDN HTTP fallback |
| certbot + `certbot-hooks/` | wildcard and per-tunnel certificates via IONOS DNS-01 |

---

## Requirements

| | |
|---|---|
| OS | Debian/Ubuntu (systemd, nginx, certbot) |
| Node.js | 22 or newer |
| PostgreSQL | 15 or newer |
| nginx | any current packaged version |
| Go | 1.21+ — only to build the tunnel client |
| Android build | SDK 36, JDK 17 — only for the app |
| Accounts | IONOS DNS API key (DNS + certificates), Square (donations, optional), SMTP (email, optional) |

Ports: `80`, `443`, `7000-7001/tcp` (tunnel control), `7100-7101/udp`, `20000-29999/tcp` (raw
tunnels). `8080` is the local HTTP tunnel proxy and should stay bound to localhost.

---

## Quick start

One guided script does everything the old `deploy.sh`, `setup-owner.sh`, `add-nginx-map.sh` and
`build-tunnel.sh` did — user, database, `.env`, nginx, certificates, systemd, owner account, and
optionally the client binaries. It is idempotent, so it doubles as the upgrade path.

```bash
git clone https://github.com/igaret/rslvd.net.git
cd rslvd.net

sudo ./setup.sh                      # prompts for domain, email, IONOS key, owner account
sudo ./setup.sh --dry-run            # show every action without changing anything
sudo ./setup.sh --help               # all flags
```

Useful invocations:

```bash
sudo ./setup.sh --upgrade                       # push the current tree and restart
sudo ./setup.sh --build-client                  # cross-compile the Go client into public/dl
sudo ./setup.sh --no-ssl --no-nginx             # app + database + systemd only
./setup.sh --dev                                # local development, no root, no nginx
```

Before running it, point DNS at the server — an `A` record for the domain, and the IONOS zone must
exist. With an IONOS key the script issues a `*.domain` wildcard certificate via DNS-01; without one
it falls back to HTTP-01 for the bare domain (nested tunnel certificates then need the key).

What it writes:

| Path | Contents |
|---|---|
| `/opt/rslvd` | application (`--app-dir` to change), `owner-credentials.txt` |
| `/opt/rslvd/.env` | generated configuration, mode `600` |
| `/etc/nginx/sites-available/<domain>` | generated vhost (map, main site, wildcard, nested HTTP) |
| `/etc/systemd/system/rslvd.service` | the service unit |
| `/etc/sudoers.d/rslvd-ssl` | NOPASSWD for the per-tunnel certificate scripts |
| `/etc/letsencrypt/renewal-hooks/deploy/` | nginx reload after renewal |

`setup.sh` regenerates the vhost, unit and `.env` on every run. Do not hand-edit them — edit the
script, or keep local overrides in a separate nginx file.

---

## Configuration

`/opt/rslvd/.env` (generated, mode `600`). Re-run `sudo ./setup.sh --upgrade` after changing values
the script owns.

| Variable | Purpose |
|---|---|
| `PORT` | port the Node app listens on (default `3001`) |
| `APP_URL` | public base URL, e.g. `https://rslvd.net` |
| `BASE_DOMAIN` | the zone subdomains are issued in |
| `SERVER_IP` | public address advertised in the UI/docs |
| `DATABASE_URL` | `postgres://user:pass@127.0.0.1:5432/rslvd` |
| `JWT_SECRET` | signs session tokens; rotating it logs everyone out |
| `ADMIN_EMAIL` | recipient of admin notifications |
| `IONOS_API_KEY` | DNS records and DNS-01 certificates |
| `SQUARE_ACCESS_TOKEN`, `SQUARE_APPLICATION_ID`, `SQUARE_LOCATION_ID` | donations |
| `SQUARE_WEBHOOK_SIGNATURE_KEY`, `SQUARE_WEBHOOK_URL` | donation webhook verification |
| `SQUARE_ENVIRONMENT` | `sandbox` or `production` |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | verification, reset and support mail |
| `NTFY_*`, `TWILIO_*`, `ADMIN_PHONE` | optional admin alerting |
| `SUPPORT_AI`, `OLLAMA_URL`, `SUPPORT_AI_MODEL` | optional support assistant |

Limits live in code, not in the database: `app/lib/plans.js` holds the free tier (2 hosts, 2
tunnels), the donation term (90 days), and the donor-only protocols (`ssh`, `adb`) and nesting.

---

## Operations

```bash
sudo systemctl status rslvd           # is it up
sudo journalctl -u rslvd -f           # application log (includes tunnel proxy)
sudo tail -f /var/log/nginx/error.log # proxy log
sudo nginx -t && sudo systemctl reload nginx
```

Upgrading:

```bash
git pull
sudo ./setup.sh --upgrade             # copies code, reinstalls deps, migrates, restarts
```

`.env`, the database and `public/dl` are preserved. Schema changes are applied on start by
`app/db/migrate.js`; every statement is `IF NOT EXISTS`/`ADD COLUMN`, so old databases upgrade in
place.

Backups: `scripts/full-backup.sh` dumps the database and code; restoration is covered in
`scripts/RESTORE.md`. Certificates renew through the packaged certbot timer — verify with
`sudo certbot renew --dry-run`.

Firewall (if you enable ufw): `sudo ./setup.sh --firewall` opens `80`, `443`, `7000-7001/tcp`,
`7100-7101/udp` and `20000-29999/tcp`. It deliberately does not touch SSH.

---

## Forking and rebranding

The code is AGPL-3.0: run it, change it, host it for others. The **name and domain are reserved**, so
rebrand before you publish.

```bash
./fork.sh example.com          # rewrite every rslvd.net reference in the tree
./fork.sh example.com --dry-run
./fork.sh --check              # list anything still pointing at rslvd.net
```

`fork.sh` rewrites the plain domain, the escaped form used in nginx/`grep -E` patterns
(`rslvd\.net`) and the uppercase form, in every tracked text file, and leaves `LICENCE.md` and binary
assets alone. Then:

1. Replace the logo and icons (`app/public/img`, `app/public/icons`, `rslvd-android/.../res`).
2. Edit the marketing copy in `index.html`, `app2.js` and the SEO landing pages.
3. Change the Android `applicationId`, app name and package folders if you ship an app.
4. Rename the service user, `/opt/rslvd`, `rslvd.service` and the Go binary names if you want a clean
   break — `setup.sh --service` and `--app-dir` cover the installed side.
5. Keep the AGPL notices and the original copyright line in `LICENCE.md`.

A fork is responsible for its own users, certificates, DNS zone, payments and legal pages.

---

## API

All endpoints are under `/api`. Authenticated calls use `Authorization: Bearer <jwt>`.

| Area | Endpoints |
|---|---|
| Auth | `POST /auth/register`, `POST /auth/login`, `GET /auth/me`, `PATCH /auth/profile`, `POST /auth/change-password`, `POST /auth/forgot-password`, `POST /auth/reset-password`, `GET /auth/verify-email`, `POST /auth/2fa/setup|verify|disable`, `GET /auth/activity`, `POST /auth/accept-legal` |
| Hosts | `GET/POST /hosts`, `PATCH /hosts/:id`, `PATCH /hosts/:id/https`, `POST /hosts/:id/regenerate-key`, `DELETE /hosts/:id` |
| DDNS update | `GET|POST /update?key=<update_key>&ip=<addr>` (DynDNS compatible), `GET /ip` |
| Tunnels | `GET/POST /tunnels`, `GET /tunnels/:id`, `PATCH /tunnels/:id`, `PATCH /tunnels/:id/https`, `POST /tunnels/:id/regenerate-token`, `GET /tunnels/remote-access`, `DELETE /tunnels/:id` |
| Client | `GET /tunnels/connect/:token` — control-channel handshake used by the Go client |
| Billing | `GET /billing/goal`, `GET /billing/config`, `POST /billing/donate`, `POST /billing/update-payment`, `POST /webhook` (Square) |
| Account | `POST /account/delete` (password-confirmed, tears down hosts and tunnels) |
| Support | `GET/POST /support`, `GET /support/:id`, `POST /support/:id/reply|escalate` |
| Admin | `GET /admin/stats|users|hosts|tunnels|activity|config`, `PATCH /admin/users/:id`, `DELETE /admin/users/:id`, reserved-subdomain management, `GET /admin/backup` |
| Misc | `POST /track/pageview`, `GET /beta/status`, `POST /beta/signup`, `GET /dns-changes`, `GET /dns-changes/export` |

Tunnel protocols: `tcp`, `udp`, `ssh`, `adb`. `ssh` and `adb` create a raw public port
(`tunnel_port`, `20000-29999`); the other two are proxied through the tunnel broker.

---

## Tunnel client

```bash
sudo ./setup.sh --build-client        # builds every target into app/public/dl
```

Targets: `linux-amd64`, `linux-arm64`, `linux-arm` (armv7), `linux-mips`, `linux-mipsle`,
`darwin-amd64`, `darwin-arm64`, `windows-amd64`. Binaries are served from `/dl/`; the router and
Termux installers are `app/public/install.sh`, `install-openwrt.sh` and `install-ddwrt.sh`.

Typical use:

```bash
rslvd-tunnel -token <tunnel-token>            # HTTP tunnel
rslvd-tunnel -token <token> -ssh              # raw SSH tunnel (donor)
rslvd-tunnel -token <token> -adb              # raw ADB tunnel (donor)
```

---

## Development

```bash
./setup.sh --dev          # .env, dependencies, schema against a local database
cd app && npm run dev     # http://localhost:3001
```

The dashboard has **no build step**: edit `app/public/app2.js`, disable the service worker in
DevTools, reload. Bump the cache name in `app/public/sw.js` when you ship a change, or users keep the
old file.

```bash
node --check app/public/app2.js
node --check app/routes/<file>.js
bash -n setup.sh fork.sh scripts/*.sh
cd rslvd-android && ./gradlew compileDebugKotlin
cd tunnel-client && go vet ./... && go build ./...
```

---

## Documentation

| File | Covers |
|---|---|
| [CONTRIBUTING.md](CONTRIBUTING.md) | workflow, coding conventions, sign-off, review |
| [SECURITY.md](SECURITY.md) | how to report a vulnerability, scope, safe harbour |
| [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) | expected behaviour and enforcement |
| [LICENCE.md](LICENCE.md) | AGPL-3.0, trademark terms, contribution licensing |
| [rslvd-android/README.md](rslvd-android/README.md), [BUILD.md](rslvd-android/BUILD.md), [PLAY_STORE.md](rslvd-android/PLAY_STORE.md) | Android app, build and store notes |
| [scripts/RESTORE.md](scripts/RESTORE.md) | restoring from a backup |
| [scripts/shell-repo/README.md](scripts/shell-repo/README.md) | apt repo for the shell installers |

---

## Community

- **Bugs and features:** [GitHub Issues](https://github.com/igaret/rslvd.net/issues)
- **Security:** security@rslvd.net — never a public issue
- **Support:** support@rslvd.net
- **Conduct:** conduct@rslvd.net
- **Licensing and trademark:** legal@rslvd.net

---

## Licence

AGPL-3.0-or-later — see [LICENCE.md](LICENCE.md). The code is free to run, modify and self-host; the
"rslvd" name, logo and domain are reserved, so [fork and rebrand](#forking-and-rebranding) rather
than deploy under this name. No warranty, no SLA — the service is funded by donations and run by
volunteers.
