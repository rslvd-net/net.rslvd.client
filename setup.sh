#!/bin/bash
# setup.sh — the only installer rslvd.net needs.
#
# One guided script replaces the old deploy.sh, setup-owner.sh, add-nginx-map.sh
# and build-tunnel.sh. It is idempotent: re-run it to upgrade in place.
#
#   sudo ./setup.sh                     guided install
#   sudo ./setup.sh --upgrade           push code changes and restart
#   ./setup.sh --dev                    local dev environment, no root
#   sudo ./setup.sh --build-client      cross-compile the Go tunnel client
#
# See --help for every flag. Nothing is written until you confirm the summary.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODE="install"

# ── Defaults (overridable by flag, env or prompt) ────────────────────────────
DOMAIN="${DOMAIN:-}"
EMAIL="${EMAIL:-}"
APP_DIR="${APP_DIR:-/opt/rslvd}"
SVC="${SVC:-rslvd}"
DB_NAME="${DB_NAME:-rslvd}"
DB_USER="${DB_USER:-rslvd}"
DB_PASS="${DB_PASS:-}"
PORT="${PORT:-3001}"
IONOS_KEY="${IONOS_KEY:-}"
OWNER_EMAIL="${OWNER_EMAIL:-}"
OWNER_PASS="${OWNER_PASS:-}"
ASSUME_YES="${ASSUME_YES:-0}"
DRY_RUN=0
WITH_SSL=1
WITH_NGINX=1
WITH_FIREWALL=0
WITH_CLIENT=0
INSTALL_DEPS=0

# ── Output helpers ───────────────────────────────────────────────────────────
if [ -t 1 ]; then C_OK=$'\033[32m'; C_WARN=$'\033[33m'; C_ERR=$'\033[31m'; C_DIM=$'\033[2m'; C_END=$'\033[0m'
else C_OK=""; C_WARN=""; C_ERR=""; C_DIM=""; C_END=""; fi

step()  { printf '\n%s==> %s%s\n' "$C_OK" "$*" "$C_END"; }
info()  { printf '    %s\n' "$*"; }
warn()  { printf '%s  ! %s%s\n' "$C_WARN" "$*" "$C_END"; }
die()   { printf '%s  ✗ %s%s\n' "$C_ERR" "$*" "$C_END" >&2; exit 1; }
have()  { command -v "$1" >/dev/null 2>&1; }

as_root() {
  if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo "$@"; fi
}

as_user() { # run as an unprivileged account, root or not
  local u="$1"; shift
  if [ "$(id -u)" -eq 0 ]; then runuser -u "$u" -- "$@"; else sudo -u "$u" "$@"; fi
}

as_pg() { # run as the postgres superuser
  if [ "$(id -u)" -eq 0 ]; then runuser -u postgres -- "$@"; else sudo -u postgres "$@"; fi
}

usage() {
  cat <<'EOF'
Usage: sudo ./setup.sh [options]

What to install
  --domain <fqdn>        Public domain, e.g. example.com (default: from app/.env, else prompt)
  --email <address>      Contact address for Let's Encrypt and the owner account
  --app-dir <path>       Install directory (default /opt/rslvd)
  --service <name>       systemd unit and service user name (default rslvd)
  --port <n>             Port the Node app listens on (default 3001)
  --db-name <name>       PostgreSQL database (default rslvd)
  --db-user <name>       PostgreSQL role (default rslvd)
  --db-pass <password>   Role password (default: generated)
  --ionos-key <key>      IONOS DNS API key; enables the *.domain wildcard cert via DNS-01
  --owner-email <email>  Site-owner account to create or update
  --owner-pass <pass>    Password for that account (default: generated)

What to skip
  --no-ssl               Do not run certbot; install an HTTP-only vhost
  --no-nginx             Leave nginx alone; only install the app, database and service
  --no-firewall          Do not open ports in ufw, even if it is active
  --firewall             Open 80/443, the tunnel control ports and 20000-29999 in ufw
  --with-client          Also cross-compile the Go tunnel client into app/public/dl

Other modes
  --dev                  Local development: write app/.env, install deps, migrate, no root
  --upgrade              Copy the current tree over APP_DIR and restart (keeps .env and data)
  --build-client         Only rebuild the Go client binaries
  --install-deps         apt-get install nodejs nginx postgresql certbot if missing
  --dry-run, -n          Print every action, change nothing
  --yes, -y              Accept the summary without prompting
  --help, -h             This text
EOF
}

# ── Argument parsing ─────────────────────────────────────────────────────────
while [ $# -gt 0 ]; do
  case "$1" in
    --domain)       DOMAIN="${2:?--domain needs a value}"; shift 2 ;;
    --email)        EMAIL="${2:?--email needs a value}"; shift 2 ;;
    --app-dir)      APP_DIR="${2:?--app-dir needs a value}"; shift 2 ;;
    --service)      SVC="${2:?--service needs a value}"; shift 2 ;;
    --port)         PORT="${2:?--port needs a value}"; shift 2 ;;
    --db-name)      DB_NAME="${2:?--db-name needs a value}"; shift 2 ;;
    --db-user)      DB_USER="${2:?--db-user needs a value}"; shift 2 ;;
    --db-pass)      DB_PASS="${2:?--db-pass needs a value}"; shift 2 ;;
    --ionos-key)    IONOS_KEY="${2:?--ionos-key needs a value}"; shift 2 ;;
    --owner-email)  OWNER_EMAIL="${2:?--owner-email needs a value}"; shift 2 ;;
    --owner-pass)   OWNER_PASS="${2:?--owner-pass needs a value}"; shift 2 ;;
    --no-ssl)       WITH_SSL=0; shift ;;
    --no-nginx)     WITH_NGINX=0; shift ;;
    --firewall)     WITH_FIREWALL=1; shift ;;
    --no-firewall)  WITH_FIREWALL=0; shift ;;
    --with-client)  WITH_CLIENT=1; shift ;;
    --dev)          MODE="dev"; shift ;;
    --upgrade)      MODE="upgrade"; shift ;;
    --build-client) MODE="client"; shift ;;
    --install-deps) INSTALL_DEPS=1; shift ;;
    --dry-run|-n)   DRY_RUN=1; shift ;;
    --yes|-y)       ASSUME_YES=1; shift ;;
    --help|-h)      usage; exit 0 ;;
    *)              die "unknown option: $1 (try --help)" ;;
  esac
done

# ── Small utilities ──────────────────────────────────────────────────────────
gen_secret() {
  if have openssl; then openssl rand -hex 32
  else head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; fi
}
gen_password() {
  if have openssl; then openssl rand -base64 24 | tr -d '/+=' | cut -c1-20
  else head -c 24 /dev/urandom | base64 | tr -d '/+=' | cut -c1-20; fi
}
prompt() { # prompt <var-name> <question> [default]
  local __var="$1" __q="$2" __def="${3:-}" __ans=""
  if [ "$ASSUME_YES" -eq 1 ] || [ ! -t 0 ]; then
    printf -v "$__var" '%s' "$__def"
    return 0
  fi
  if [ -n "$__def" ]; then printf '%s [%s]: ' "$__q" "$__def"; else printf '%s: ' "$__q"; fi
  read -r __ans
  [ -n "$__ans" ] || __ans="$__def"
  printf -v "$__var" '%s' "$__ans"
}
run() { # run <command...> — respects --dry-run
  if [ "$DRY_RUN" -eq 1 ]; then printf '    %s[dry-run]%s %s\n' "$C_DIM" "$C_END" "$*"; return 0; fi
  printf '    %s\n' "$*"
  "$@"
}
run_root() {
  if [ "$DRY_RUN" -eq 1 ]; then printf '    %s[dry-run]%s sudo %s\n' "$C_DIM" "$C_END" "$*"; return 0; fi
  printf '    sudo %s\n' "$*"
  as_root "$@"
}

run_as_user() { # run_as_user <user> <command...>
  local u="$1"; shift
  if [ "$DRY_RUN" -eq 1 ]; then printf '    %s[dry-run]%s (as %s) %s\n' "$C_DIM" "$C_END" "$u" "$*"; return 0; fi
  printf '    (as %s) %s\n' "$u" "$*"
  as_user "$u" "$@"
}
detect_public_ip() {
  curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null \
    || curl -fsS --max-time 5 https://ifconfig.me 2>/dev/null \
    || hostname -I 2>/dev/null | awk '{print $1}' || true
}
validate_domain() {
  printf '%s' "$1" | grep -qE '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$' \
    || die "'$1' is not a valid fully qualified domain"
}

# Read a value from an existing .env without sourcing it.
env_get() {
  local key="$1" file="$APP_DIR/.env"
  [ -f "$file" ] || return 0
  grep -E "^${key}=" "$file" 2>/dev/null | tail -n1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' || true
}

# ── Mode: build the Go tunnel client only ────────────────────────────────────
build_client() {
  need_go="tunnel-client"
  [ -d "$REPO_DIR/$need_go" ] || die "tunnel-client/ not found — is this the repo root?"
  have go || die "go is not installed (https://go.dev/dl/)"
  local out="$REPO_DIR/app/public/dl"
  mkdir -p "$out"
  step "Building tunnel client into $out"
  ( cd "$REPO_DIR/tunnel-client"
    info "linux/amd64";   run env GOOS=linux   GOARCH=amd64               go build -trimpath -ldflags="-s -w" -o "$out/rslvd-tunnel-linux-amd64" .
    info "linux/arm64";   run env GOOS=linux   GOARCH=arm64               go build -trimpath -ldflags="-s -w" -o "$out/rslvd-tunnel-linux-arm64" .
    info "linux/armv7";   run env GOOS=linux   GOARCH=arm GOARM=7         go build -trimpath -ldflags="-s -w" -o "$out/rslvd-tunnel-linux-arm" .
    info "linux/mips";    run env GOOS=linux   GOARCH=mips  GOMIPS=softfloat   go build -trimpath -ldflags="-s -w" -o "$out/rslvd-tunnel-linux-mips" .
    info "linux/mipsle";  run env GOOS=linux   GOARCH=mipsle GOMIPS=softfloat go build -trimpath -ldflags="-s -w" -o "$out/rslvd-tunnel-linux-mipsle" .
    info "darwin/amd64";  run env GOOS=darwin  GOARCH=amd64               go build -trimpath -ldflags="-s -w" -o "$out/rslvd-tunnel-darwin-amd64" .
    info "darwin/arm64";  run env GOOS=darwin  GOARCH=arm64               go build -trimpath -ldflags="-s -w" -o "$out/rslvd-tunnel-darwin-arm64" .
    info "windows/amd64"; run env GOOS=windows GOARCH=amd64               go build -trimpath -ldflags="-s -w" -o "$out/rslvd-tunnel-windows-amd64.exe" .
  )
  chmod +x "$out"/rslvd-tunnel-* 2>/dev/null || true
  step "Client binaries"
  ls -lh "$out" | sed 's/^/    /'
}

if [ "$MODE" = "client" ]; then
  build_client
  exit 0
fi

# ── Mode: local development, no root ────────────────────────────────────────
if [ "$MODE" = "dev" ]; then
  step "Local development setup"
  [ -d "$REPO_DIR/app" ] || die "app/ not found — run this from the repo root"
  have node || die "node is not installed (Node 22+ recommended)"
  have npm || die "npm is not installed"

  DOMAIN="${DOMAIN:-localhost}"
  PORT="${PORT:-3001}"
  DB_NAME="${DB_NAME:-rslvd_dev}"
  DB_USER="${DB_USER:-rslvd_dev}"
  DB_PASS="${DB_PASS:-$(gen_password)}"

  prompt DB_NAME "Local database name" "$DB_NAME"
  prompt DB_USER "Local database user" "$DB_USER"
  prompt DB_PASS "Local database password" "$DB_PASS"
  prompt PORT "Port for the app" "$PORT"
  local_db_url="postgres://${DB_USER}:${DB_PASS}@127.0.0.1:5432/${DB_NAME}"

  step "Writing app/.env"
  if [ -f "$REPO_DIR/app/.env" ] && [ "$ASSUME_YES" -eq 0 ] && [ "$DRY_RUN" -eq 0 ]; then
    printf '    app/.env exists. Overwrite? [y/N]: '; read -r ow
    case "$ow" in y|Y) ;; *) info "keeping existing app/.env"; local_db_url="$(env_get DATABASE_URL)" ;; esac
  fi
  if [ "$DRY_RUN" -eq 0 ]; then
    cat > "$REPO_DIR/app/.env" <<ENVEOF
NODE_ENV=development
PORT=$PORT
APP_URL=http://localhost:$PORT
BASE_DOMAIN=localhost
DATABASE_URL=$local_db_url
JWT_SECRET=$(gen_secret)
# Optional: DNS writes, payments, mail
IONOS_API_KEY=
SQUARE_ENVIRONMENT=sandbox
SQUARE_ACCESS_TOKEN=
SQUARE_APPLICATION_ID=
SQUARE_LOCATION_ID=
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
ENVEOF
    chmod 600 "$REPO_DIR/app/.env"
    info "wrote app/.env (mode 600)"
  else
    info "[dry-run] would write app/.env"
  fi

  step "Installing dependencies"
  ( cd "$REPO_DIR/app" && run npm install --no-audit --no-fund )

  step "Applying database schema"
  if [ "$DRY_RUN" -eq 0 ]; then
    ( cd "$REPO_DIR/app" && node -e "require('./db/migrate').run().then(()=>{console.log('schema up to date');process.exit(0)}).catch(e=>{console.error(e.message);process.exit(1)})" ) \
      || warn "migration failed — is PostgreSQL running and DATABASE_URL correct?"
  fi

  step "Done"
  cat <<EOF
    Start the app:   cd app && npm run dev
    Open:            http://localhost:$PORT
    Endpoints that need a real DNS provider (hosts, tunnels) will fail at
    the IONOS step without an IONOS_API_KEY. That is fine for UI work.
EOF
  exit 0
fi

# ── Install / upgrade ───────────────────────────────────────────────────────
if [ "$DRY_RUN" -eq 0 ]; then
  have sudo || [ "$(id -u)" -eq 0 ] || die "sudo is required (or run as root)"
fi

# Reuse what is already installed unless the operator overrides it.
if [ -f "$APP_DIR/.env" ]; then
  DOMAIN="${DOMAIN:-$(env_get BASE_DOMAIN)}"
  EMAIL="${EMAIL:-$(env_get ADMIN_EMAIL)}"
  PORT="${PORT:-$(env_get PORT)}"
  IONOS_KEY="${IONOS_KEY:-$(env_get IONOS_API_KEY)}"
  # Keep third-party credentials across upgrades instead of blanking them.
  SQUARE_ACCESS_TOKEN="${SQUARE_ACCESS_TOKEN:-$(env_get SQUARE_ACCESS_TOKEN)}"
  SQUARE_APPLICATION_ID="${SQUARE_APPLICATION_ID:-$(env_get SQUARE_APPLICATION_ID)}"
  SQUARE_LOCATION_ID="${SQUARE_LOCATION_ID:-$(env_get SQUARE_LOCATION_ID)}"
  SQUARE_WEBHOOK_SIGNATURE_KEY="${SQUARE_WEBHOOK_SIGNATURE_KEY:-$(env_get SQUARE_WEBHOOK_SIGNATURE_KEY)}"
  SQUARE_ENVIRONMENT="${SQUARE_ENVIRONMENT:-$(env_get SQUARE_ENVIRONMENT)}"
  SMTP_HOST="${SMTP_HOST:-$(env_get SMTP_HOST)}"
  SMTP_PORT="${SMTP_PORT:-$(env_get SMTP_PORT)}"
  SMTP_USER="${SMTP_USER:-$(env_get SMTP_USER)}"
  SMTP_PASS="${SMTP_PASS:-$(env_get SMTP_PASS)}"
  SMTP_FROM="${SMTP_FROM:-$(env_get SMTP_FROM)}"
  OWNER_EMAIL="${OWNER_EMAIL:-$(env_get ADMIN_EMAIL)}"
fi

if [ "$MODE" = "upgrade" ]; then
  [ -n "$DOMAIN" ] || die "--upgrade needs an existing $APP_DIR/.env with BASE_DOMAIN"
else
  prompt DOMAIN "Public domain for this instance" "${DOMAIN:-}"
  validate_domain "$DOMAIN"
  prompt EMAIL "Contact email (Let's Encrypt expiry notices)" "${EMAIL:-admin@$DOMAIN}"
  prompt APP_DIR "Install directory" "$APP_DIR"
  prompt PORT "App port" "$PORT"
  prompt OWNER_EMAIL "Site-owner email" "${OWNER_EMAIL:-$EMAIL}"
  [ -n "$IONOS_KEY" ] || prompt IONOS_KEY "IONOS DNS API key (blank = no wildcard cert)" ""
fi

[ -d "$REPO_DIR/app" ] || die "app/ not found — run this from the repo root"
[ -f "$REPO_DIR/app/server.js" ] || die "app/server.js not found"

DOMAIN_REGEX="$(printf '%s' "$DOMAIN" | sed 's/\./\\./g')"
if [ -z "$DB_PASS" ]; then
  DB_PASS="$(env_get DATABASE_URL | sed -n 's|.*://[^:]*:\([^@]*\)@.*|\1|p')"
fi
[ -n "$DB_PASS" ] || DB_PASS="$(gen_password)"
# Only set an owner password when asked to; an upgrade must not reset it.
OWNER_PASS_EXPLICIT=0
if [ -n "$OWNER_PASS" ]; then OWNER_PASS_EXPLICIT=1; fi
JWT_SECRET="${JWT_SECRET:-$(env_get JWT_SECRET)}"
[ -n "$JWT_SECRET" ] || JWT_SECRET="$(gen_secret)"
SERVER_IP="${SERVER_IP:-$(detect_public_ip)}"

if [ "$WITH_SSL" -eq 0 ] || [ "$WITH_NGINX" -eq 0 ]; then
  WILDCARD_DESC="skipped"
elif [ -n "$IONOS_KEY" ]; then
  WILDCARD_DESC="yes — DNS-01 wildcard for $DOMAIN and *.$DOMAIN"
else
  WILDCARD_DESC="no wildcard — HTTP-01 for $DOMAIN only"
fi

step "Plan"
cat <<EOF
    mode            $MODE
    domain          $DOMAIN
    install dir     $APP_DIR
    service         $SVC  (port $PORT)
    database        $DB_NAME as $DB_USER@127.0.0.1
    wildcard TLS    $WILDCARD_DESC
    nginx           $([ "$WITH_NGINX" -eq 1 ] && echo "install vhost for $DOMAIN" || echo "skipped")
    firewall        $([ "$WITH_FIREWALL" -eq 1 ] && echo "open ports in ufw" || echo "left alone")
    owner account   ${OWNER_EMAIL:-(none)}
    public IP       ${SERVER_IP:-unknown}
EOF

if [ "$DRY_RUN" -eq 0 ] && [ "$ASSUME_YES" -eq 0 ]; then
  printf '\n    Proceed? [y/N]: '; read -r ok
  case "$ok" in y|Y) ;; *) die "aborted" ;; esac
fi

# ── 1. Dependencies ─────────────────────────────────────────────────────────
if [ "$INSTALL_DEPS" -eq 1 ]; then
  step "Installing system packages"
  run_root apt-get update
  run_root apt-get install -y nodejs npm nginx postgresql certbot python3-certbot-nginx curl rsync
fi

missing=""
for c in node npm psql nginx; do have "$c" || missing="$missing $c"; done
[ -z "$missing" ] || warn "missing commands:$missing — rerun with --install-deps or install them first"
have node && info "node $(node --version), npm $(npm --version)"

# ── 2. Service user and directories ─────────────────────────────────────────
step "Service user and directories"
if id -u "$SVC" >/dev/null 2>&1; then
  info "user $SVC already exists"
else
  run_root useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$SVC" || \
    run_root useradd -r -s /bin/false "$SVC"
fi
run_root mkdir -p "$APP_DIR/public" "$APP_DIR/certbot-hooks" "$APP_DIR/scripts"
run_root chown -R "$SVC:$SVC" "$APP_DIR"

# ── 3. Application files ────────────────────────────────────────────────────
step "Copying application files"
# public/dl holds generated client binaries — never delete those on upgrade.
copy_tree() { # copy_tree <src> <dest> [rsync-exclude]
  local excl="${3:-}"
  if have rsync && [ -n "$excl" ]; then
    run_root rsync -a --delete --exclude "$excl" "$1/" "$2/"
  elif have rsync; then
    run_root rsync -a --delete "$1/" "$2/"
  else
    run_root mkdir -p "$2"; run_root cp -a "$1/." "$2/"
  fi
}
for d in routes db lib middleware; do
  copy_tree "$REPO_DIR/app/$d" "$APP_DIR/$d"
done
copy_tree "$REPO_DIR/app/public" "$APP_DIR/public" dl
run_root cp -f "$REPO_DIR/app/server.js" "$APP_DIR/server.js"
run_root cp -f "$REPO_DIR/app/package.json" "$APP_DIR/package.json"
[ -f "$REPO_DIR/app/package-lock.json" ] && run_root cp -f "$REPO_DIR/app/package-lock.json" "$APP_DIR/package-lock.json"
for h in ionos-auth.sh ionos-cleanup.sh renew-deploy.sh; do
  [ -f "$REPO_DIR/certbot-hooks/$h" ] && run_root cp -f "$REPO_DIR/certbot-hooks/$h" "$APP_DIR/certbot-hooks/$h"
done
run_root cp -f "$REPO_DIR"/scripts/*.sh "$APP_DIR/scripts/" 2>/dev/null || true
run_root chmod +x "$APP_DIR"/certbot-hooks/*.sh "$APP_DIR"/scripts/*.sh 2>/dev/null || true
# The hooks and cert scripts hardcode the upstream install path and domain.
if [ "$DRY_RUN" -eq 0 ]; then
  as_root sed -i -e "s|/opt/rslvd|$APP_DIR|g" -e "s/rslvd\.net/$DOMAIN/g" \
    "$APP_DIR"/certbot-hooks/*.sh "$APP_DIR"/scripts/*.sh 2>/dev/null || true
fi
run_root chown -R "$SVC:$SVC" "$APP_DIR"

# ── 4. Database ─────────────────────────────────────────────────────────────
step "PostgreSQL"
if [ "$DRY_RUN" -eq 0 ] && have psql; then
  as_pg psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'" 2>/dev/null | grep -q 1 \
    || as_pg psql -c "CREATE ROLE \"$DB_USER\" LOGIN PASSWORD '$DB_PASS'" >/dev/null
  as_pg psql -tAc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" 2>/dev/null | grep -q 1 \
    || as_pg createdb -O "$DB_USER" "$DB_NAME"
  as_pg psql -c "ALTER ROLE \"$DB_USER\" WITH PASSWORD '$DB_PASS'" >/dev/null
  as_pg psql -d "$DB_NAME" -c "GRANT ALL ON SCHEMA public TO \"$DB_USER\"" >/dev/null
  info "database $DB_NAME ready for $DB_USER"
else
  info "[dry-run] ensure role $DB_USER and database $DB_NAME exist"
fi

# ── 5. .env ─────────────────────────────────────────────────────────────────
step "Environment file"
if [ "$DRY_RUN" -eq 0 ]; then
  if [ -f "$APP_DIR/.env" ]; then
    as_root cp -a "$APP_DIR/.env" "$APP_DIR/.env.bak.$(date +%s)"
    info "backed up existing .env"
  fi
  umask 077
  cat > /tmp/"$SVC".env.new <<ENVEOF
NODE_ENV=production
PORT=$PORT
APP_URL=https://$DOMAIN
BASE_DOMAIN=$DOMAIN
SERVER_IP=$SERVER_IP
DATABASE_URL=postgres://$DB_USER:$DB_PASS@127.0.0.1:5432/$DB_NAME
JWT_SECRET=$JWT_SECRET
ADMIN_EMAIL=$OWNER_EMAIL
IONOS_API_KEY=$IONOS_KEY
SQUARE_ENVIRONMENT=${SQUARE_ENVIRONMENT:-production}
SQUARE_ACCESS_TOKEN=${SQUARE_ACCESS_TOKEN:-}
SQUARE_APPLICATION_ID=${SQUARE_APPLICATION_ID:-}
SQUARE_LOCATION_ID=${SQUARE_LOCATION_ID:-}
SQUARE_WEBHOOK_SIGNATURE_KEY=${SQUARE_WEBHOOK_SIGNATURE_KEY:-}
SQUARE_WEBHOOK_URL=${SQUARE_WEBHOOK_URL:-https://$DOMAIN/api/webhook/square}
SMTP_HOST=${SMTP_HOST:-}
SMTP_PORT=${SMTP_PORT:-587}
SMTP_SECURE=${SMTP_SECURE:-false}
SMTP_USER=${SMTP_USER:-}
SMTP_PASS=${SMTP_PASS:-}
SMTP_FROM=${SMTP_FROM:-"$DOMAIN" <noreply@$DOMAIN>}
ENVEOF
  as_root mv /tmp/"$SVC".env.new "$APP_DIR/.env"
  as_root chown "$SVC:$SVC" "$APP_DIR/.env"
  as_root chmod 600 "$APP_DIR/.env"
  info "wrote $APP_DIR/.env (mode 600)"
else
  info "[dry-run] would write $APP_DIR/.env"
fi

# ── 6. Dependencies and schema ──────────────────────────────────────────────
step "Installing npm dependencies"
if [ "$DRY_RUN" -eq 0 ]; then
  if [ -f "$APP_DIR/package-lock.json" ]; then
    ( cd "$APP_DIR" && run_as_user "$SVC" npm ci --omit=dev --no-audit --no-fund )
  else
    ( cd "$APP_DIR" && run_as_user "$SVC" npm install --omit=dev --no-audit --no-fund )
  fi
else
  info "[dry-run] npm ci --omit=dev in $APP_DIR"
fi

step "Applying database schema"
if [ "$DRY_RUN" -eq 0 ]; then
  if as_user "$SVC" bash -lc "cd '$APP_DIR' && node -e \"require('./db/migrate').run().then(()=>{console.log('schema up to date');process.exit(0)}).catch(e=>{console.error(e.message);process.exit(1)})\""; then
    info "schema up to date"
  else
    die "migration failed — check DATABASE_URL in $APP_DIR/.env"
  fi
else
  info "[dry-run] run db/migrate.js against $DB_NAME"
fi

# ── 7. nginx ────────────────────────────────────────────────────────────────
write_nginx() {
  local tmp; tmp="$(mktemp)"
  cat > "$tmp" <<'NGINXEOF'
# Managed by setup.sh — regenerated on every run. Do not edit by hand.
map $http_upgrade $connection_upgrade {
    default upgrade;
    ""      close;
}

# Per-FQDN HTTP fallback vhosts written by the tunnel cert scripts.
include /etc/nginx/conf.d/__SVC__-http/*.conf;

server {
    listen 80;
    server_name __DOMAIN__ www.__DOMAIN__;

    location /.well-known/acme-challenge/ { root /var/www/html; }

    location / { return 301 https://$host$request_uri; }
}

server {
    listen 443 ssl;
    server_name __DOMAIN__ www.__DOMAIN__;

    ssl_certificate     /etc/letsencrypt/live/__DOMAIN__/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/__DOMAIN__/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Frame-Options SAMEORIGIN;
    add_header X-Content-Type-Options nosniff;

    client_max_body_size 10m;

    location /dl/ {
        alias __APP_DIR__/public/dl/;
        try_files $uri =404;
        default_type application/octet-stream;
    }

    location / {
        proxy_pass http://127.0.0.1:__PORT__;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }
}

# Single-level subdomains (*.domain) are tunnel traffic.
server {
    listen 443 ssl;
    server_name *.__DOMAIN__;

    ssl_certificate     /etc/letsencrypt/live/__DOMAIN__/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/__DOMAIN__/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    client_max_body_size 0;
    proxy_request_buffering off;
    proxy_buffering off;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}

# Nested subdomains (*.*.domain) are HTTP-only and must match before the
# redirect block below.
server {
    listen 80;
    server_name ~^.+\.__DOMAIN_REGEX__$;

    client_max_body_size 0;
    proxy_request_buffering off;
    proxy_buffering off;
    add_header X-Frame-Options SAMEORIGIN always;
    add_header X-Content-Type-Options nosniff always;

    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}

server {
    listen 80;
    server_name __DOMAIN__ www.__DOMAIN__ ~^[^.]+\.__DOMAIN_REGEX__$;

    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 301 https://$host$request_uri; }
}
NGINXEOF

  # HTTP-only variant for --no-ssl.
  local tmp_http; tmp_http="$(mktemp)"
  cat > "$tmp_http" <<'NGINXEOF'
# Managed by setup.sh (HTTP only: TLS was skipped) — regenerated on every run.
map $http_upgrade $connection_upgrade {
    default upgrade;
    ""      close;
}

include /etc/nginx/conf.d/__SVC__-http/*.conf;

server {
    listen 80;
    server_name __DOMAIN__ www.__DOMAIN__;

    client_max_body_size 10m;

    location /.well-known/acme-challenge/ { root /var/www/html; }

    location /dl/ {
        alias __APP_DIR__/public/dl/;
        try_files $uri =404;
        default_type application/octet-stream;
    }

    location / {
        proxy_pass http://127.0.0.1:__PORT__;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

server {
    listen 80;
    server_name *.__DOMAIN__ ~^.+\.__DOMAIN_REGEX__$;

    client_max_body_size 0;
    proxy_request_buffering off;
    proxy_buffering off;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
NGINXEOF

  local src="$tmp"
  [ "$WITH_SSL" -eq 0 ] && src="$tmp_http"
  sed -e "s|__DOMAIN_REGEX__|$DOMAIN_REGEX|g" \
      -e "s|__DOMAIN__|$DOMAIN|g" \
      -e "s|__APP_DIR__|$APP_DIR|g" \
      -e "s|__SVC__|$SVC|g" \
      -e "s|__PORT__|$PORT|g" "$src" > /tmp/"$SVC".vhost.conf
  rm -f "$tmp" "$tmp_http"
}

if [ "$WITH_NGINX" -eq 1 ]; then
  step "nginx"
  if [ "$DRY_RUN" -eq 0 ]; then
    write_nginx
    as_root mkdir -p /etc/nginx/conf.d/"$SVC"-http
    as_root mv /tmp/"$SVC".vhost.conf /etc/nginx/sites-available/"$DOMAIN"
    as_root ln -sf /etc/nginx/sites-available/"$DOMAIN" /etc/nginx/sites-enabled/"$DOMAIN"
    as_root rm -f /etc/nginx/sites-enabled/default
    as_root mkdir -p /var/www/html
    as_root nginx -t
    as_root systemctl reload nginx 2>/dev/null || as_root nginx -s reload
    info "vhost installed: /etc/nginx/sites-available/$DOMAIN"
  else
    info "[dry-run] write vhost for $DOMAIN, nginx -t, reload"
  fi
else
  step "nginx (skipped)"
fi

# ── 8. TLS ──────────────────────────────────────────────────────────────────
if [ "$WITH_SSL" -eq 1 ] && [ "$WITH_NGINX" -eq 1 ]; then
  step "TLS certificate"
  if [ -n "$IONOS_KEY" ]; then
    info "DNS-01 wildcard for $DOMAIN and *.$DOMAIN via IONOS"
    run_root certbot certonly --manual --preferred-challenges dns \
      --manual-auth-hook "$APP_DIR/certbot-hooks/ionos-auth.sh" \
      --manual-cleanup-hook "$APP_DIR/certbot-hooks/ionos-cleanup.sh" \
      -d "$DOMAIN" -d "*.$DOMAIN" \
      --cert-name "$DOMAIN" \
      --non-interactive --agree-tos --email "$EMAIL" \
      --deploy-hook "$APP_DIR/certbot-hooks/renew-deploy.sh" \
      || warn "certificate request failed — check the IONOS key and DNS zone, then re-run"
  else
    info "HTTP-01 for $DOMAIN (no wildcard; nested tunnel certs are provisioned per host)"
    run_root certbot certonly --webroot -w /var/www/html \
      -d "$DOMAIN" --cert-name "$DOMAIN" \
      --non-interactive --agree-tos --email "$EMAIL" \
      --deploy-hook "$APP_DIR/certbot-hooks/renew-deploy.sh" \
      || warn "certificate request failed — make sure $DOMAIN resolves here and port 80 is open"
  fi

  step "Renewal hook"
  if [ "$DRY_RUN" -eq 0 ]; then
    as_root mkdir -p /etc/letsencrypt/renewal-hooks/deploy
    as_root ln -sf "$APP_DIR/certbot-hooks/renew-deploy.sh" /etc/letsencrypt/renewal-hooks/deploy/"$SVC"-reload-nginx.sh
    info "certbot will reload nginx after renewal"
  fi
fi

# ── 9. systemd ──────────────────────────────────────────────────────────────
step "systemd unit"
if [ "$DRY_RUN" -eq 1 ]; then
  info "[dry-run] write /etc/systemd/system/$SVC.service, enable and restart"
fi
if [ "$DRY_RUN" -eq 0 ]; then
  as_root tee /etc/systemd/system/"$SVC".service > /dev/null <<UNITEOF
[Unit]
Description=$DOMAIN — Dynamic DNS and tunnel service
After=network.target postgresql.service redis-server.service

[Service]
Type=simple
User=$SVC
WorkingDirectory=$APP_DIR
ExecStart=$(command -v node || echo /usr/bin/node) server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
EnvironmentFile=$APP_DIR/.env
StandardOutput=journal
StandardError=journal
SyslogIdentifier=$SVC
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNITEOF
  as_root systemctl daemon-reload
  as_root systemctl enable "$SVC" >/dev/null 2>&1 || true
  as_root systemctl restart "$SVC"
  sleep 2
  if as_root systemctl is-active --quiet "$SVC"; then
    info "service $SVC is running"
  else
    warn "service $SVC failed to start — journalctl -u $SVC -n 50"
  fi
fi

# ── 10. Per-tunnel certificate permissions ──────────────────────────────────
# tunnel-cert.js runs these as: sudo <APP_DIR>/scripts/<script>.sh <fqdn>
step "Certificate script permissions"
if [ "$DRY_RUN" -eq 1 ]; then
  info "[dry-run] write /etc/sudoers.d/$SVC-ssl for the per-tunnel cert scripts"
fi
if [ "$DRY_RUN" -eq 0 ]; then
  SUDOERS_FILE="/etc/sudoers.d/$SVC-ssl"
  as_root tee "$SUDOERS_FILE" > /dev/null <<SUDOEOF
# Allow the $SVC service to provision and deprovision per-tunnel certificates
$SVC ALL=(ALL) NOPASSWD: $APP_DIR/scripts/provision-tunnel-cert.sh *
$SVC ALL=(ALL) NOPASSWD: $APP_DIR/scripts/deprovision-tunnel-cert.sh *
$SVC ALL=(ALL) NOPASSWD: $APP_DIR/scripts/enable-http-fallback.sh *
$SVC ALL=(ALL) NOPASSWD: $APP_DIR/scripts/disable-http-fallback.sh *
SUDOEOF
  as_root chmod 440 "$SUDOERS_FILE"
  if as_root visudo -cf "$SUDOERS_FILE" >/dev/null; then
    info "sudoers entry installed: $SUDOERS_FILE"
  else
    as_root rm -f "$SUDOERS_FILE"
    warn "sudoers validation failed — per-tunnel certificates will not provision"
  fi
fi

# ── 11. Owner account ───────────────────────────────────────────────────────
if [ -n "$OWNER_EMAIL" ]; then
  step "Site-owner account ($OWNER_EMAIL)"
  if [ "$DRY_RUN" -eq 1 ]; then
    info "[dry-run] create or update the site-owner account"
  fi
  if [ "$DRY_RUN" -eq 0 ]; then
    exists="$(as_pg psql -tA -d "$DB_NAME" -c "SELECT count(*) FROM users WHERE email = '$OWNER_EMAIL'" 2>/dev/null | tr -d '[:space:]')"
    create_owner=0
    if [ "${exists:-0}" = "0" ]; then
      [ -n "$OWNER_PASS" ] || OWNER_PASS="$(gen_password)"
      create_owner=1
    elif [ "$OWNER_PASS_EXPLICIT" -eq 1 ]; then
      create_owner=1
    else
      info "account already exists — password left unchanged (use --owner-pass to reset)"
    fi

    if [ "$create_owner" -eq 1 ]; then
      HASH="$(cd "$APP_DIR" && node -e "
        const bcrypt = require('bcryptjs');
        process.stdout.write(bcrypt.hashSync(process.argv[1], 12));
      " "$OWNER_PASS")"
      if as_pg psql -d "$DB_NAME" -v ON_ERROR_STOP=1 >/dev/null <<SQLEOF
INSERT INTO users (email, password_hash, plan, max_hosts, max_tunnels, is_admin, is_site_owner, email_verified, bonus_expires_at)
VALUES ('$OWNER_EMAIL', '$HASH', 'free', 999999, 999999, TRUE, TRUE, TRUE, NOW() + INTERVAL '100 years')
ON CONFLICT (email) DO UPDATE SET
  password_hash = EXCLUDED.password_hash,
  is_admin = TRUE,
  is_site_owner = TRUE,
  email_verified = TRUE,
  plan = 'free',
  max_hosts = 999999,
  max_tunnels = 999999,
  bonus_expires_at = NOW() + INTERVAL '100 years',
  updated_at = NOW();
SQLEOF
      then
        umask 077
        printf 'email: %s\npassword: %s\nrole: site_owner\ncreated: %s\n' \
          "$OWNER_EMAIL" "$OWNER_PASS" "$(date -Is)" > /tmp/"$SVC".owner
        as_root mv /tmp/"$SVC".owner "$APP_DIR/owner-credentials.txt"
        as_root chown "$SVC:$SVC" "$APP_DIR/owner-credentials.txt"
        as_root chmod 600 "$APP_DIR/owner-credentials.txt"
        info "credentials written to $APP_DIR/owner-credentials.txt (mode 600)"
        info "sign in at https://$DOMAIN/login, then delete that file"
      else
        warn "could not create the owner account — is the schema migrated?"
      fi
    fi
  fi
fi

# ── 12. Firewall ────────────────────────────────────────────────────────────
if [ "$WITH_FIREWALL" -eq 1 ]; then
  step "ufw"
  if have ufw; then
    run_root ufw allow 80/tcp
    run_root ufw allow 443/tcp
    run_root ufw allow 7000:7001/tcp
    run_root ufw allow 7100:7101/udp
    run_root ufw allow 20000:29999/tcp
    info "opened 80, 443, 7000-7001, 7100-7101/udp, 20000-29999"
    warn "SSH is not opened by this script — make sure your SSH port is allowed before enabling ufw"
  else
    warn "ufw is not installed — open 80, 443, 7000-7001/tcp, 7100-7101/udp and 20000-29999/tcp yourself"
  fi
fi

# ── 13. Tunnel client ───────────────────────────────────────────────────────
if [ "$WITH_CLIENT" -eq 1 ]; then
  step "Tunnel client"
  build_client || warn "client build failed — install Go and re-run with --build-client"
  [ "$DRY_RUN" -eq 0 ] && run_root chown -R "$SVC:$SVC" "$APP_DIR/public/dl"
fi

# ── 14. Health check ────────────────────────────────────────────────────────
step "Health check"
if [ "$DRY_RUN" -eq 1 ]; then
  info "[dry-run] curl http://127.0.0.1:$PORT/api/ip"
else
  ok=0
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if curl -fsS --max-time 3 "http://127.0.0.1:$PORT/api/ip" >/dev/null 2>&1; then ok=1; break; fi
    sleep 2
  done
  if [ "$ok" -eq 1 ]; then
    info "app responds on 127.0.0.1:$PORT"
  else
    warn "app is not responding on port $PORT yet — journalctl -u $SVC -n 50"
  fi
  if [ "$WITH_NGINX" -eq 1 ] && [ "$WITH_SSL" -eq 1 ]; then
    if curl -fsS --max-time 8 "https://$DOMAIN/" >/dev/null 2>&1; then
      info "https://$DOMAIN/ answers"
    else
      warn "https://$DOMAIN/ does not answer yet — DNS, certificate or firewall"
    fi
  fi
fi

step "Done"
cat <<EOF
    Site:      $( [ "$WITH_SSL" -eq 1 ] && echo "https://$DOMAIN" || echo "http://$DOMAIN" )
    Service:   systemctl status $SVC     logs: journalctl -u $SVC -f
    Env:       $APP_DIR/.env (re-run setup.sh to change it)
    Upgrade:   git pull && sudo ./setup.sh --upgrade
    Client:    sudo ./setup.sh --build-client

    Optional integrations, set in $APP_DIR/.env and restart:
      IONOS_API_KEY        DNS records and wildcard/per-host certificates
      SQUARE_*             donations (billing is donation-only, no subscriptions)
      SMTP_*               verification, reset and support email
EOF
