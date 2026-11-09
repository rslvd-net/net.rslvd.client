#!/bin/bash
# fork.sh — rebrand this repository for your own domain.
#
#   ./fork.sh example.com            rewrite rslvd.net -> example.com
#   ./fork.sh example.com --dry-run  show what would change, write nothing
#   ./fork.sh --check                report remaining rslvd.net references
#
# Rewrites the literal domain, the shell/nginx-escaped form (rslvd\.net) and the
# uppercase form (RSLVD.NET) in every tracked text file. Binary files, the
# licence and this script are left alone.
set -euo pipefail

SELF="$(basename "$0")"
DRY_RUN=0
ASSUME_YES=0
CHECK_ONLY=0
NEW_DOMAIN=""

usage() {
  cat <<EOF
Usage: ./$SELF <your-domain> [options]

  <your-domain>     The fully qualified domain you will run this fork on,
                    e.g. example.com or ddns.example.org. Lowercase ASCII only.
  --dry-run, -n     Show which files and how many matches, change nothing.
  --yes, -y         Skip the confirmation prompt.
  --check           Do not change anything; just list remaining rslvd.net
                    references (useful after a partial manual rename).
  --help, -h        This text.

Examples:
  ./$SELF tun.example.com
  ./$SELF --dry-run tun.example.com
  ./$SELF --check

What it does not do: rename the project's code name (the "rslvd" user, the
/opt/rslvd install path, the rslvd.service unit, the rslvd-android package id,
the logo). Those are brand, not domain. Everything you must edit by hand is
printed at the end.
EOF
}

die() { printf 'fork.sh: %s\n' "$*" >&2; exit 1; }

# ── Arguments ────────────────────────────────────────────────────────────────
for arg in "$@"; do
  case "$arg" in
    --dry-run|-n) DRY_RUN=1 ;;
    --yes|-y)     ASSUME_YES=1 ;;
    --check)      CHECK_ONLY=1 ;;
    --help|-h)    usage; exit 0 ;;
    -*)           die "unknown option: $arg (try --help)" ;;
    *)
      [ -z "$NEW_DOMAIN" ] || die "more than one domain given: '$NEW_DOMAIN' and '$arg'"
      NEW_DOMAIN="$arg"
      ;;
  esac
done

# The repo root is wherever this script lives.
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
command -v git >/dev/null || die "git is required"
git rev-parse --git-dir >/dev/null 2>&1 || die "$PWD is not a git repository"

# Files we never rewrite: the licence keeps its original attribution, and this
# script has to keep recognising the old domain to be useful.
is_excluded() {
  case "$1" in
    LICENCE.md|LICENSE.md|"$SELF") return 0 ;;
    *) return 1 ;;
  esac
}

list_refs() {
  # Tracked text files that still mention the old domain.
  git grep -Il -e 'rslvd\.net' -e 'rslvd\\\.net' -e 'RSLVD\.NET' -- . 2>/dev/null || true
}

count_hits() {
  grep -Io -e 'rslvd\.net' -e 'rslvd\\\.net' -e 'RSLVD\.NET' "$1" 2>/dev/null | wc -l | tr -d ' '
}

if [ "$CHECK_ONLY" -eq 1 ]; then
  refs="$(list_refs | while IFS= read -r f; do is_excluded "$f" || printf '%s\n' "$f"; done)"
  if [ -z "$refs" ]; then
    echo "✓ No rslvd.net references left in tracked files."
    exit 0
  fi
  echo "Remaining rslvd.net references:"
  printf '%s\n' "$refs" | while IFS= read -r f; do
    printf '  %-52s %s\n' "$f" "$(count_hits "$f")"
  done
  exit 1
fi

[ -n "$NEW_DOMAIN" ] || { usage; exit 1; }
NEW_DOMAIN="$(printf '%s' "$NEW_DOMAIN" | tr '[:upper:]' '[:lower:]')"

# ── Validate the new domain ──────────────────────────────────────────────────
[ "$NEW_DOMAIN" != "rslvd.net" ] || die "that is already the domain of this repo; nothing to do"

if ! printf '%s' "$NEW_DOMAIN" | grep -qE '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'; then
  die "'$NEW_DOMAIN' is not a valid fully qualified domain (try example.com)"
fi
case "$NEW_DOMAIN" in
  *.local|*.localhost|*.invalid|*.test|*.example) die "'$NEW_DOMAIN' is a reserved name — use a domain you actually control" ;;
esac

NEW_ESCAPED="$(printf '%s' "$NEW_DOMAIN" | sed 's/\./\\./g')"
NEW_UPPER="$(printf '%s' "$NEW_DOMAIN" | tr '[:lower:]' '[:upper:]')"

# ── Safety checks ────────────────────────────────────────────────────────────
if [ -n "$(git status --porcelain)" ] && [ "$DRY_RUN" -eq 0 ] && [ "$ASSUME_YES" -eq 0 ]; then
  echo "Working tree has uncommitted changes:"
  git status --short | sed 's/^/  /'
  echo
  echo "Commit or stash them first, so this rewrite is a reviewable commit of its own."
  echo "Re-run with --yes to rewrite anyway."
  exit 1
fi

files="$(list_refs | while IFS= read -r f; do is_excluded "$f" || printf '%s\n' "$f"; done)"

if [ -z "$files" ]; then
  echo "✓ Nothing to do — no rslvd.net references found."
  exit 0
fi

total_files=$(printf '%s\n' "$files" | wc -l | tr -d ' ')
total_hits=$(printf '%s\n' "$files" | while IFS= read -r f; do count_hits "$f"; done | awk '{s+=$1} END {print s+0}')

echo "Rewriting rslvd.net -> $NEW_DOMAIN"
echo "  files: $total_files    matches: $total_hits"
echo

if [ "$DRY_RUN" -eq 1 ]; then
  printf '%s\n' "$files" | while IFS= read -r f; do
    printf '  %-56s %s\n' "$f" "$(count_hits "$f")"
  done
  echo
  echo "Dry run — nothing written."
  exit 0
fi

if [ "$ASSUME_YES" -eq 0 ]; then
  printf 'This rewrites tracked files in place. Type the new domain to continue: '
  read -r confirm
  [ "$confirm" = "$NEW_DOMAIN" ] || die "aborted"
fi

# ── Rewrite ──────────────────────────────────────────────────────────────────
# Order matters: the escaped form first, so the literal rule cannot touch it.
printf '%s\n' "$files" | while IFS= read -r f; do
  sed -i \
    -e "s/rslvd\\\\\.net/${NEW_ESCAPED//\//\\/}/g" \
    -e "s/RSLVD\.NET/${NEW_UPPER//\//\\/}/g" \
    -e "s/rslvd\.net/${NEW_DOMAIN//\//\\/}/g" \
    "$f"
done

echo "✓ Rewrote $total_files files."
echo

# ── Verify ───────────────────────────────────────────────────────────────────
leftover="$(list_refs | while IFS= read -r f; do is_excluded "$f" || printf '%s\n' "$f"; done)"
if [ -n "$leftover" ]; then
  echo "⚠ These files still mention the old domain — check them by hand:"
  printf '%s\n' "$leftover" | sed 's/^/    /'
  echo
fi

cat <<EOF
Next steps
----------
1. Review the change:        git diff --stat && git diff
2. Re-run the installer:     ./setup.sh --domain $NEW_DOMAIN
   (it rewrites app/.env, the nginx vhost, certbot hooks and the systemd unit)
3. Replace the branding that is not a domain string — the ones setup.sh cannot guess:
     • logo and icons:   app/public/img/, app/public/icons/, rslvd-android/app/src/main/res/
     • page copy:        app/public/index.html, app/public/app2.js, the SEO pages
     • Android identity: applicationId "net.rslvd.client", app_name, package folders
     • install paths:    the "rslvd" service user, /opt/rslvd, rslvd.service, the Go binary names
     • legal contacts:   legal@, security@, conduct@, abuse@ in *.md and the legal pages
4. Keep LICENCE.md as it is: the AGPL requires the original notices, and the "rslvd"
   marks stay reserved. Rebrand the product; do not claim to be rslvd.net.
5. Deploy: ./setup.sh on the server, then verify https://$NEW_DOMAIN/ and a test tunnel.
EOF
