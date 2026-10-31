CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  type TEXT NOT NULL,
  name TEXT,
  company TEXT,
  email TEXT,
  phone TEXT,
  framework TEXT,
  score INTEGER,
  band TEXT,
  lead_status TEXT,
  challenge TEXT,
  region TEXT,
  currency TEXT,
  service TEXT,
  size TEXT,
  maturity TEXT,
  estimate_low INTEGER,
  estimate_high INTEGER,
  consent INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_leads_created ON leads(created_at);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(lead_status);
CREATE INDEX IF NOT EXISTS idx_leads_framework ON leads(framework);
