-- GovernancePro Global v3: non-ITSM business problem assessments.
-- Additive migration. Safe for existing lead records.
CREATE TABLE IF NOT EXISTS business_assessments (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  category TEXT NOT NULL,
  organisation TEXT,
  industry TEXT,
  region TEXT,
  size TEXT,
  problem TEXT NOT NULL,
  started_when TEXT,
  frequency TEXT,
  desired_outcome TEXT,
  affected_areas TEXT,
  previous_actions TEXT,
  impact_financial INTEGER NOT NULL,
  impact_operations INTEGER NOT NULL,
  impact_customers INTEGER NOT NULL,
  impact_people INTEGER NOT NULL,
  impact_compliance INTEGER NOT NULL,
  urgency INTEGER NOT NULL,
  recurrence INTEGER NOT NULL,
  evidence TEXT,
  constraints TEXT,
  name TEXT,
  email TEXT,
  consent INTEGER NOT NULL DEFAULT 0,
  severity TEXT NOT NULL,
  score INTEGER NOT NULL,
  confidence TEXT NOT NULL,
  recommendations TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'New'
);
CREATE INDEX IF NOT EXISTS idx_business_assessments_created ON business_assessments(created_at);
CREATE INDEX IF NOT EXISTS idx_business_assessments_priority ON business_assessments(severity, status);
