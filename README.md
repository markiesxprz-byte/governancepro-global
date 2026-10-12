# GovernancePro Global

Governance, risk, compliance and ISO readiness: a free self-assessment, an indicative consulting cost calculator, a
SaaS Solutions page (proposed plans and a waitlist), and a protected administration area for the leads. Cloudflare
Workers + Static Assets + D1.

**Live:** https://governancepro-global.markiesxprz.workers.dev/ · **Health:** `/api/health` (reports version and database)

## What is and is not available
| | Status |
|---|---|
| Free readiness self-assessment (9 frameworks), maturity score, band, recommended next step | **Live** |
| Indicative consulting cost calculator (8 regional currencies, fixed indicative rates) | **Live** |
| Waitlist and enquiry forms (saved with consent) | **Live** |
| Admin area: filters, pagination, status changes, CSV export, erasure, audit trail | **Live** |
| SaaS plans: Starter US$49, Professional US$99, MSP/Partner US$299, Enterprise from US$499 | **Proposed only** — shown with a waitlist, cannot be bought |
| Paid readiness report, from US$149 | **Not built** — waitlist only |
| Customer accounts, saved history, action tracking, partner features, payments | **Planned** |

The site never claims certification outcomes, never shows a checkout, and shows no testimonials or customer logos.

## Structure
```
src/index.js          Worker: public lead capture + admin API + gated admin page
src/lib/              options (allowed values), scoring (single source of truth), security, migrate
public/               index.html (home), saas.html, privacy.html, terms.html, admin.html, site.css, _headers, robots.txt, sitemap.xml
migrations/           0001 baseline, 0002 SaaS foundation, 0002 rollback (plain SQL; the Worker also applies 0002 itself)
tests/                api.test.mjs, browser-checks.py, migration-check.sh
docs/                 LAUNCH_90_DAYS.md
```

## Configuration
| Name | Kind | Required | Purpose |
|---|---|---|---|
| `ADMIN_PASSWORD` | Cloudflare **secret** | yes | Password for the admin area. Already set in production. |
| `RATE_LIMIT_SALT` | Cloudflare **secret** | recommended | Random string mixed into the hashes of client addresses. `npx wrangler secret put RATE_LIMIT_SALT` |
| `ADMIN_USERNAME` | variable | no | Admin user name (default `admin`). |
| `DB` | D1 binding | yes | `governancepro` (id in `wrangler.json`). |

Local development: copy `.dev.vars.example` to `.dev.vars` (git-ignored), `npm install`, `npm run dev`.
**Never commit real secrets.**

## How leads work
- `POST /api/leads` is the only public write. The server validates every field against allow-lists, requires explicit
  consent whenever contact details are present, refuses more than 10 contact submissions per hour per address (40 for the
  anonymous calculator), drops submissions that fill a hidden spam-trap field, and ignores an identical request from the
  same email within 10 minutes. **The score, band, recommendation and cost estimate are computed on the server from the
  answers**; whatever numbers a browser sends are ignored. The visitor sees "saved" only after the server confirms it.
- Estimates are always **ZAR**; the visitor's display currency is stored separately. The admin pipeline total is in ZAR.
- Admin: `/admin` and every `/api/admin/*` route require HTTP Basic credentials. Five wrong passwords lock the address
  for the rest of a 15-minute window. Status changes, exports and deletions are written to `admin_audit` (no personal data).
- Retention: records are kept only as long as needed, reviewed at least yearly. **Erasure on request:** admin → Delete.

## Deploying
1. **Before anything else:** record a restore point and export the database (see below).
2. Add the `RATE_LIMIT_SALT` secret. Commit and push; Cloudflare builds and deploys.
3. **No manual database step.** The first request applies migration 0002 automatically.
4. Check: `/api/health` → `"version":"3.1","database":"ok"`; `/admin` asks for a password; `/saas` loads.
5. Run `npm run test:api` and `python3 tests/browser-checks.py` against a **local** Worker, never production.

## Backup, restore and rollback
- **Restore point (non-destructive):** Cloudflare dashboard → D1 → `governancepro` → Time Travel → *Get current Bookmark ID*. Time Travel keeps 7 days.
- **Export:** `npx wrangler d1 export governancepro --remote --output governancepro-backup.sql`; keep it encrypted, off Cloudflare.
- **Roll back the code:** Workers & Pages → `governancepro-global` → Deployments → select the previous version → rollback. Nothing else is needed: the migration is additive.
- **Restore data (destructive, last resort):** Time Travel → restore to the saved bookmark, or import the export into a new D1 database and point the binding at it.
- If you rolled back the code and want old pages to see the original HOT/WARM/NURTURE statuses, run `migrations/0002_rollback.sql`.
- The hand-run SQL files are **single-use**: re-running `0002_saas_foundation.sql` stops at the first `duplicate column name` error and skips the rest. Prefer the Worker's automatic migration, which is safe to repeat. **Re-applying the data conversion after a rollback is not covered by a tested procedure**, so treat the rollback as final for that data change unless you have help.

## Known limitations
- Admin access is still one shared password (rate-limited, with an audit trail). Putting the admin area behind Cloudflare Access would give named users and MFA.
- The cost-calculator currency factors are fixed, indicative numbers, not live exchange rates.
- Pages use inline scripts, so the Content-Security-Policy must allow `'unsafe-inline'` for scripts.
- No customer accounts, payments, report generation or email sending exist yet.
- The privacy notice and terms are plain-language statements that have **not had legal review**.
