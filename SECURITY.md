# Security Policy

rslvd.net is a Dynamic DNS and tunneling service. Users point real hostnames at their own machines and
push real traffic through our proxies, so security reports are genuinely welcome and are handled
seriously.

**Please report privately and give us a chance to fix it before you publish.**

## Reporting a vulnerability

- **Email:** [security@rslvd.net](mailto:security@rslvd.net)
- **Subject line:** `[SECURITY] <short description>`
- Encrypted mail is supported — ask for our PGP key in your first message and we will send a
  fingerprint and key before you disclose details.
- **Do not** open a public GitHub issue, pull request, discussion or social-media post about an
  unfixed vulnerability.

### What to include

1. A description of the issue and the component affected (`rslvd.net` web app, API, tunnel proxy, Go
   client, Android app, DNS/TLS handling, a specific nginx/script file).
2. Reproduction steps — request/response pairs, a curl command, or a small proof of concept.
3. The impact you believe it has, and whether you have seen evidence of exploitation.
4. Your name/handle and a link, if you want credit.

Do not include real user data, other people's credentials or traffic captured from tunnels you do not
own. Use accounts and hosts you created yourself.

## What to expect

| Stage | Target |
|---|---|
| Acknowledgement of your report | within 3 business days |
| Initial assessment (severity, whether it is in scope) | within 7 business days |
| Fix or mitigation for critical/high findings | as fast as we can, usually within 14 days |
| Coordinated public disclosure | by agreement, normally 90 days after the report |

We will tell you if we do not consider something a vulnerability, and why. If we disagree about
disclosure timing, we will not ask you to stay silent indefinitely — 90 days is the default.

We do not currently run a paid bounty. We will credit you in the release notes or on the project page
if you want, unless you ask us not to.

## Scope

In scope:

- `https://rslvd.net` and its API (`/api/*`), including authentication, sessions, password reset,
  email verification and admin endpoints.
- The tunnel broker and proxy (HTTP/HTTPS on `*.rslvd.net`, raw TCP/UDP tunnels, control channels on
  7000/7001 and 7100/7101, public port range 20000–29999).
- Hostname/DNS management, including subdomain and nested-subdomain handling, update keys and
  wildcard/per-host TLS provisioning.
- The Go tunnel client (`tunnel-client/`) and the Android client (`rslvd-android/`), including token
  handling and local storage.
- Payment and donation handling, in as much as it touches our code. Card data never reaches our
  servers — it is handled by Square.
- The deployment surface in this repository (nginx configs, certbot hooks, `scripts/`, `setup.sh`).

Out of scope:

- Denial of service, volumetric or resource-exhaustion testing, including flooding tunnels, the
  control ports or the public port range.
- Spam, phishing or bulk mail through the service; brute force, password spraying or credential
  stuffing against accounts you do not own.
- Social engineering of rslvd.net users or staff, physical access, or attacks on our upstream
  providers (IONOS, Square, our hosting provider) — report those to the provider directly.
- Traffic or content hosted behind another user's tunnel. We proxy it; we do not own it.
- Reports that need a rooted/jailbroken device, a compromised user's machine, or an already
  authenticated admin session to be interesting.
- Best-practice findings with no demonstrated impact: missing security headers on static assets,
  SPF/DMARC/CT configuration, TLS version/cipher preferences, `autocomplete` attributes, self-XSS,
  clickjacking on pages with no state-changing action, open redirects to the same origin, username or
  email enumeration through registration/verification timing, or rate-limit observations without a
  bypass.
- Automated scanner output with no analysis.

If you are unsure whether something is in scope, email and ask. We would rather triage a
questionable report than miss a real one.

## Safe harbour

If you make a good-faith effort to follow this policy, we will:

- consider your research authorised, and not pursue or support legal action against you for it;
- work with you to understand and resolve the issue quickly;
- not ask you to take down or delete your own test data beyond what is needed to clean up.

This assurance does not cover: extortion or "pay me or I publish", accessing, modifying or exfiltrating
other users' data, degrading the service for other users, or any activity that breaks the law
independently of this policy. It also does not bind any third party. If a third party brings a claim
against you, we will make it clear that your research was authorised under this policy.

## For forks and self-hosted instances

This policy covers the service operated at **rslvd.net** only. If you run this code yourself, you are
the operator of your own instance and you are responsible for your own security contact, disclosure
process and legal obligations. Do not send reports about your own deployment to security@rslvd.net.

## Related documents

- [Terms of Service](https://rslvd.net/terms) — acceptable use, including what is prohibited on tunnels.
- [Privacy Policy](https://rslvd.net/privacy) — what we collect, how long we keep it, who we share it with.
- [LICENCE.md](LICENCE.md) — the software licence and the warranty disclaimer.
- [CONTRIBUTING.md](CONTRIBUTING.md) — how to send a fix once a report is triaged.
