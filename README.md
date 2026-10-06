# GovernancePro Global V2

This is the upgraded source package for the live GovernancePro site.

## What changed from V1

- Global positioning and regional/currency selection.
- Global framework catalogue: ISO 27001, 9001, 22301, 20000, 45001, ITSM/ITIL, COBIT, IT Governance and GRC.
- Region-aware indicative pricing (planning estimates only; not live FX).
- Improved assessment result and recommendation.
- Consent checkbox before assessment submission.
- Cloudflare Worker API.
- Cloudflare D1 schema for real lead storage.
- API health endpoint.
- Browser localStorage is retained only as a development fallback when D1 is not configured.

## Cloudflare deployment

This project uses Workers Static Assets + a Worker API. Cloudflare recommends Workers Static Assets for new full-stack applications; Wrangler deploys the Worker and assets together.

1. Install Node.js and Wrangler.
2. Put your D1 database ID in `wrangler.json`.
3. Create the database, if you have not already:
   `npx wrangler d1 create governancepro`
4. Apply the schema:
   `npx wrangler d1 execute governancepro --remote --file=./schema.sql`
5. Deploy:
   `npx wrangler deploy`

## Important

Do NOT put API tokens, database credentials, payment secrets or email provider keys in browser JavaScript.

Before production use:
- add authentication and role-based admin access;
- protect `/api/leads` GET so public users cannot read leads;
- add rate limiting / bot protection;
- add a full privacy notice and retention/deletion process appropriate to each operating region;
- validate consent and data-minimisation requirements;
- connect transactional email/CRM;
- add verified consultant onboarding;
- add payment processing;
- perform security testing.

## Current architecture

Browser
  -> Cloudflare Worker
  -> D1 database
  -> static assets

Future integrations:
  -> CRM
  -> email
  -> WhatsApp
  -> payments
  -> consultant marketplace
  -> proposal/PDF service

## Pricing

The regional multipliers are deliberately static planning multipliers. They are NOT a live foreign-exchange feed. For production, either set region-specific commercial price books or connect a trusted FX service.

## Rollback

Cloudflare Workers creates versions for deployments. Keep the current live V1 deployment until V2 has been tested, then promote V2.
