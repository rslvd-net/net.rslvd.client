---
name: testing-rslvd-frontend
description: Test the rslvd.net frontend (React SPA) locally or on production. Use when verifying UI changes to registration, dashboard, pricing, tutorials, or any SPA route.
---

# Testing rslvd.net Frontend

## Overview

rslvd.net is a no-build React SPA (`app/public/app2.js`) using raw `React.createElement` calls. The frontend is served by an Express backend (`app/server.js`) with PostgreSQL + Redis.

## Devin Secrets Needed

***DEPRACATED: THIS SETTINGS HAS BEEN MODDED BY ME ****- `SSH_KEY` — SSH key for production access (`~/.ssh/oracle.key`, user `ubuntu@129.146.61.187`)
- `SMTP_*` — SMTP credentials for email verification testing (in production env vars)

## Quick Start — Local Static Testing

For UI-only tests (layout, routing, component rendering) that don't need a backend:

```bash
cd /home/ubuntu/repos/rslvd.net/app/public
python3 -m http.server 3333
```

Then navigate to `http://localhost:3333` in the browser. This works for verifying:
- Component rendering (forms, modals, buttons)
- Client-side routing (`/register`, `/login`, `/verify-email`, `/inbox`, `/webmail`, etc.)
- 404 pages for removed routes
- CSS/layout changes

**Limitation:** API calls will fail (no backend). Login, registration submission, data fetching won't work.

## Production Testing

For full end-to-end tests, use `https://rslvd.net` directly. The site is deployed via SCP to `/opt/rslvd/` on the production server.

### SSH Access
```bash
ssh -o StrictHostKeyChecking=no garet@129.146.61.187
password: 4425
```

### Service Management
```bash
sudo systemctl restart rslvd
sudo systemctl status rslvd
```

### Database Queries
```bash
sudo -u postgres psql -d rslvd -c "SELECT ..."
```

## Common Test Patterns

### Registration Form Tests
- Navigate to `/register`
- Verify form fields: Email, Password, Confirm password, TOS checkbox
- Test TOS enforcement: submit without checking → expect error "You must accept the Terms of Service to create an account"
- Test successful registration: fill all fields + check TOS → expect redirect to `/dashboard`

### Route Removal Tests
- Navigate to the removed route (e.g., `/inbox`, `/webmail`)
- Expect: "404" heading, "Page not found" text, "Go home" button

### Email Verification Page
- Navigate to `/verify-email` (no token) → expect "Verification Failed" + "No verification token provided."
- Navigate to `/verify-email?token=invalid` → expect "Verification Failed" + error from API

### Nav Bar Tests (requires login)
- Register a test user or log in as existing user
- Check nav buttons: should show Dashboard, Account, Sign out
- Verify removed buttons (e.g., Mail) are NOT present

### DDNS Auto-Updater Card Tests (dashboard host card)
- Create a host, scroll to the "DDNS Auto-Updater" card under it.
- In a plain browser (no Capacitor), the card shows the **non-native** copy ("works in the background when the app is installed") and must NOT show "● Native background updates active" (that line only renders inside the Android app).
- Enable the toggle → host selector + "Update now" appear ("Update now" is disabled until a host is checked).
- Enable state + selected hosts persist in **localStorage** (`ddns-auto-update`, `ddns-auto-hosts`), not server-side — they survive reload but are per-browser.
- Clicking "Update now" calls `/api/ip` then `/api/update?key=...&ip=...`. The host card's IP/timestamp may NOT refresh immediately due to service-worker caching — verify the real result via `/api/hosts` (needs `Authorization: Bearer <localStorage token>`) or a hard refresh (Ctrl+Shift+R). After cache bust the card shows the IP + "Last update" and Active IPs increments.

### Delete Account Tab Tests (`/account` → "🗑️ Delete account")
- The Account Settings page (`AccountPage` in `app2.js`) has tabs: Profile, Security, Login history, **Delete account**.
- The Delete account tab (`DeleteAccountTab`) renders a red-bordered card. The "Permanently delete my account" button is gated: `canDelete = !isOwner && password.length > 0 && confirm === 'DELETE'`.
- Adversarial check: with the password filled but the "Type DELETE to confirm" field EMPTY, focus the password input and press Enter. The `submit` handler early-returns `if (!canDelete)`, so the account must NOT be deleted (you stay on `/account`). A regression here would log you out / delete the account.
- Endpoint is `POST /api/account/delete` (`routes/account.js`) — password-confirmed; disables the Square card on file, tears down hosts/tunnels (IONOS records, certs, HTTP fallback), then `DELETE FROM users` (cascades). Site-owner (`role === 'site_owner'`) accounts are blocked and show an alert instead of the form.
- Verify deletion out-of-band: old JWT → `GET /api/auth/me` returns 401, and `SELECT count(*) FROM users WHERE email='...'` returns 0. On success the UI logs out and navigates to `/`.
- Quick API smoke (no UI): register a throwaway account, then `POST /api/account/delete` with no auth → 401, wrong password → 401 `Incorrect password`, correct password → 200 `{success:true}`.

### Legal Wall Tests
- The `LegalWall` component blocks the app if `user.tos_version_accepted !== CURRENT_LEGAL_VERSION`
- To test: modify `CURRENT_LEGAL_VERSION` in `auth.js` to a new date, deploy, and verify the wall appears

## Cleanup

Always delete test users after testing:
```bash
ssh -i ~/.ssh/oracle.key ubuntu@129.146.61.187 \
  "sudo -u postgres psql -d rslvd -c \"DELETE FROM users WHERE email = 'test@example.com';\""
```

## Service Worker Caching

After deploying new `app2.js` to production, users (and your test browser) may need to hard refresh (`Ctrl+Shift+R`) to bypass the service worker cache. The service worker (`sw.js`) caches `app2.js` aggressively.

## Tips

- The frontend uses no build step — changes to `app2.js` are live immediately after deployment
- `app2.js` is a single large file (~3000+ lines) containing all React components
- When testing removed features, check both the route AND the nav bar for any lingering links/buttons
- For billing tests, use the Square sandbox credentials (SQUARE_ENVIRONMENT=sandbox; test card 4111 1111 1111 1111, any future expiry, CVV 111)
- Production nginx config is at `/etc/nginx/sites-available/rslvd.net` — relevant for SSL, proxy, and redirect tests
