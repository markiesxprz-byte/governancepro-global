-- 0002 — SaaS foundation (v3.1). ADDITIVE: no table is dropped or recreated and no row is deleted.
--
-- You normally do NOT need to run this by hand: the Worker applies the same changes automatically, once, the first
-- time it handles a request after deployment (src/lib/migrate.js), and it is safe to repeat. This file exists so the
-- change is reviewable and can be applied manually if you prefer:
--   npx wrangler d1 execute governancepro --remote --file migrations/0002_saas_foundation.sql
--
-- RUN THIS FILE ONCE. SQLite has no "ADD COLUMN IF NOT EXISTS", so a second run stops at the first ALTER with
-- "duplicate column name" and the statements after it do NOT run (tested). If you see that error, the migration has
-- already been applied: do not re-run it. The Worker's own automatic migration (src/lib/migrate.js) checks each column
-- first, so IT is safe to repeat (also tested: stop and restart on an upgraded database changes nothing).

ALTER TABLE leads ADD COLUMN message TEXT;             -- the visitor's optional message
ALTER TABLE leads ADD COLUMN product_interest TEXT;    -- waitlist / enquiry: which plan, report or service
ALTER TABLE leads ADD COLUMN consent_at TEXT;          -- when consent to be contacted was given
ALTER TABLE leads ADD COLUMN consent_version TEXT;     -- which wording the visitor saw
ALTER TABLE leads ADD COLUMN source TEXT;              -- 'web' for records created by this release onwards
ALTER TABLE leads ADD COLUMN updated_at TEXT;
ALTER TABLE leads ADD COLUMN temperature TEXT;         -- Hot / Warm / Nurture, from the assessment score
ALTER TABLE leads ADD COLUMN estimate_currency TEXT;   -- currency of estimate_low/high (always ZAR)
ALTER TABLE leads ADD COLUMN answers TEXT;             -- the four assessment answers, as JSON

CREATE TABLE IF NOT EXISTS rate_limits (               -- short-lived counters; keys are salted hashes, cleared within a day
  key TEXT PRIMARY KEY, count INTEGER NOT NULL, window_start INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS admin_audit (               -- who did what, never any personal data
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, lead_id TEXT, detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_leads_email ON leads(email);
CREATE INDEX IF NOT EXISTS idx_leads_type ON leads(type);

-- DATA CHANGE 1 (information is kept, not lost): older pages stored HOT / WARM / NURTURE in the *status* column, which
-- the admin screen's status list (New, Warm, Qualified, Proposal, Won, Lost) does not contain. Move that value into
-- "temperature" and give those leads the normal starting status. Rows already using an admin status are untouched.
UPDATE leads
   SET temperature = CASE lead_status WHEN 'HOT' THEN 'Hot' WHEN 'WARM' THEN 'Warm' WHEN 'NURTURE' THEN 'Nurture' END,
       lead_status = 'New'
 WHERE lead_status IN ('HOT', 'WARM', 'NURTURE') AND temperature IS NULL;

-- DATA CHANGE 2 (label only): estimates were always ZAR amounts stored beside the visitor's DISPLAY currency.
UPDATE leads SET estimate_currency = 'ZAR' WHERE estimate_low IS NOT NULL AND estimate_currency IS NULL;

CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO schema_meta (key, value) VALUES ('version', '2') ON CONFLICT(key) DO UPDATE SET value = excluded.value;
