# Contributing to rslvd.net

Thanks for wanting to help. rslvd.net is a small, self-funded service (it runs on donations), so the
most useful contributions are focused bug fixes, security fixes and documentation improvements.

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md), and by opening a pull request
you accept the contribution terms in [LICENCE.md](LICENCE.md#contributions).

## Before you start

- **Security issues go to [security@rslvd.net](mailto:security@rslvd.net)** — never a public issue. See
  [SECURITY.md](SECURITY.md).
- **Open an issue first** for anything larger than a bug fix or a typo: new features, new
  dependencies, schema changes, protocol changes, UI redesigns. rslvd.net intentionally runs with a
  very small dependency surface, and a PR that adds a package without prior discussion will usually be
  declined.
- **Do not include secrets.** No `.env` files, API keys, tunnel tokens, certificates, keystores or
  production database dumps. `setup.sh` generates local credentials for you.

## Repository layout

| Path | What it is |
|---|---|
| `app/` | Express 5 API + dashboard server. `app/server.js` is the entry point; it runs migrations and starts the tunnel proxy. |
| `app/routes/` | One router per API area (`auth`, `hosts`, `tunnels`, `billing`, `admin`, `account`, `support`, …). |
| `app/lib/` | Domain logic: `plans.js` (limits and donor rules), `tunnel-proxy.js` (broker, proxy, raw ports), `ionos.js` (DNS), `tunnel-cert.js` (per-host TLS), `payments.js`, `mailer.js`. |
| `app/public/` | The web app. `app2.js` is the whole SPA — no build step, plain `React.createElement`. `index.html` is the landing page. `sw.js` is the service worker. |
| `rslvd-android/` | Kotlin/Compose Android client (`net.rslvd.client`). |
| `tunnel-client/` | Go tunnel client, cross-compiled into `app/public/dl/`. |
| `scripts/` | Runtime ops scripts: per-tunnel certificate provisioning, HTTP fallback, backups. |
| `certbot-hooks/` | certbot DNS-01 hooks used for the wildcard and per-tunnel certificates. |
| `setup.sh` | The single guided installer. Replaces the old scattered `deploy.sh`, `setup-owner.sh`, `add-nginx-map.sh` and `build-tunnel.sh`. |
| `fork.sh` | Rebrands the tree for your own domain. |

## Getting a development environment

Requirements: Node.js 22+, PostgreSQL 14+, and — only if you touch those parts — Go 1.21+ and
Android SDK 36 with JDK 17.

```bash
git clone https://github.com/<you>/net.rslvd.client.git
cd net.rslvd.client
./setup.sh --dev          # prompts for a local domain/DB, writes app/.env, installs deps, migrates
cd app && npm run dev     # http://localhost:3001 (node --watch)
```

`--dev` does not touch nginx, certbot, systemd or the tunnel proxy's public ports, and it points the
app at `http://localhost:3001`. Set `IONOS_API_KEY` only if you want to exercise DNS writes; otherwise
create hosts and tunnels through the UI and they will fail at the provider step, which is fine for UI
work.

Postgres for local work:

```bash
sudo -u postgres createuser --pwprompt rslvd_dev
sudo -u postgres createdb -O rslvd_dev rslvd_dev
# DATABASE_URL=postgres://rslvd_dev:<pw>@localhost:5432/rslvd_dev
```

The schema is applied automatically on boot by `db/migrate.js`. It is additive (`CREATE TABLE IF NOT
EXISTS`, `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`); when you need a new column, add it there with the
same idempotent pattern so existing deployments upgrade cleanly.

## Coding conventions

**Node / Express**

- Express 5. Async route handlers with `try/catch`; return the error shape the rest of the API uses,
  `res.status(4xx).json({ error: '...' })`.
- **Always parameterise SQL.** `pool.query('... WHERE id = $1', [id])` — never template a value into
  the string. Placeholder arithmetic like `` `col = $${i++}` `` is fine, but get the `$` right; that
  exact typo is what broke admin user edits once.
- Limits and entitlement checks live in `app/lib/plans.js` (`limitsFor`, `hasRemoteAccess`, `canNest`).
  Do not re-implement them in a route; call them, so free/donor/owner behaviour stays consistent.
- No new runtime dependency without discussion. If you must, pin a caret range and update
  `package-lock.json` in the same commit.

**Web dashboard (`app/public/app2.js`)**

- No build step, no JSX, no bundler. Plain `React.createElement` and the existing `Section` / `P`
  helpers on legal pages.
- Keep styling inline or in the existing CSS variables (`var(--text2)`, `var(--accent2)`, …) instead of
  adding a stylesheet.
- If you add a route, register it in the route table *and* the known-paths list used by the 404 check,
  and link it from the nav or footer.
- Bump the cache name in `sw.js` when you change `app2.js`, otherwise existing users keep the old file.

**Android (`rslvd-android/`)**

- Kotlin + Jetpack Compose, Material 3. `./gradlew compileDebugKotlin` must pass.
- Network models live in `data/Models.kt` and the Retrofit interface in `data/ApiService.kt`; if an
  endpoint changes, update both plus `Repository.kt` and the view model.
- Everything the user sees for entitlements must come from `/api/auth/me`, not from a second source of
  truth in the app.

**Go client (`tunnel-client/`)**

- `gofmt` clean, `go vet ./...` clean.
- The client must keep working on routers and older kernels: keep the binary small, avoid cgo, and
  keep flag names backwards compatible.

**Shell**

- `#!/bin/bash` with `set -euo pipefail`, `shellcheck` clean where practical, quote your variables, and
  prefer `--dry-run` for anything destructive.

## Tests and checks

There is no full test suite; verify the part you changed.

```bash
node --check app/public/app2.js            # SPA syntax (it is served raw)
node --check app/routes/<route>.js         # any JS you touched
bash -n setup.sh fork.sh scripts/*.sh      # shell syntax
cd rslvd-android && ./gradlew compileDebugKotlin
cd tunnel-client && go vet ./... && go build ./...
```

For API changes, run the server against a scratch database and exercise the endpoint with `curl`
before and after. For UI changes, load the page with the service worker disabled (DevTools → Application
→ Service workers → Update on reload) so you are not looking at a cached `app2.js`.

Describe what you ran in the PR. "Compiles" and "tested" are different claims.

## Commits and pull requests

- One logical change per commit; messages in the imperative, sentence case, describing *why*:
  `Fix tunnel cards overflowing on narrow screens`.
- Sign off every commit: `git commit -s`. This is the Developer Certificate of Origin — it is how you
  certify you wrote the code or have the right to submit it. PRs without sign-off cannot be merged.
- Keep the diff tight. Reformatting, renames and unrelated fixes belong in their own PR.
- Rebase on `main` rather than merging `main` into your branch.
- In the PR body: what changed, why, how you verified it, and any migration or deployment step the
  operator must take (schema, nginx, env vars, certificates).
- Do not bump the version code/name in `rslvd-android/app/build.gradle` or the release in this repo —
  cutting a release is done by a maintainer.

## Licensing of contributions

Contributions are accepted under AGPL-3.0-or-later, and you grant the rslvd.net authors the right to
use and relicense them as part of this project, including for the hosted service at rslvd.net. See
[LICENCE.md](LICENCE.md#contributions). If you are contributing on behalf of an employer, make sure you
have permission first.

## What happens after you open a PR

A maintainer will review, usually within a week or two — this is a volunteer-run project. Small, tested,
well-described PRs get merged quickly; large unreviewed rewrites rarely do. If a PR goes quiet, a single
polite ping on the thread is welcome.

## Contact

- General and contribution questions: **support@rslvd.net**
- Security: **security@rslvd.net** ([SECURITY.md](SECURITY.md))
- Conduct concerns: **conduct@rslvd.net** ([CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md))
- Licensing and trademark: **legal@rslvd.net** ([LICENCE.md](LICENCE.md))
