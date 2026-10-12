// Versioned, ADDITIVE migrations applied automatically the first time the Worker runs after a deploy, so deploying
// needs no manual database step. Nothing here drops or recreates a table, and every step is safe to repeat.
// The same changes are written out as plain SQL in /migrations for anyone who prefers to apply them by hand.
let verified = false;

const BASELINE = [
  `CREATE TABLE IF NOT EXISTS leads (
    id TEXT PRIMARY KEY, created_at TEXT NOT NULL, type TEXT NOT NULL, name TEXT, company TEXT, email TEXT, phone TEXT,
    framework TEXT, score INTEGER, band TEXT, lead_status TEXT, challenge TEXT, region TEXT, currency TEXT, service TEXT,
    size TEXT, maturity TEXT, estimate_low INTEGER, estimate_high INTEGER, consent INTEGER NOT NULL DEFAULT 0
  )`,
  'CREATE INDEX IF NOT EXISTS idx_leads_created ON leads(created_at)',
  'CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(lead_status)',
  'CREATE INDEX IF NOT EXISTS idx_leads_framework ON leads(framework)',
];

const NEW_COLUMNS = [
  ['message', 'TEXT'], ['product_interest', 'TEXT'], ['consent_at', 'TEXT'], ['consent_version', 'TEXT'], ['source', 'TEXT'],
  ['updated_at', 'TEXT'], ['temperature', 'TEXT'], ['estimate_currency', 'TEXT'], ['answers', 'TEXT'],
];

export async function ensureSchema(db) {
  if (verified) return;
  await db.prepare('CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)').run();
  const row = await db.prepare("SELECT value FROM schema_meta WHERE key = 'version'").first();
  const version = row ? Number(row.value) : 0;

  if (version < 2) {
    await db.batch(BASELINE.map((s) => db.prepare(s)));
    for (const [col, type] of NEW_COLUMNS) {
      const has = await db.prepare("SELECT COUNT(*) AS c FROM pragma_table_info('leads') WHERE name = ?").bind(col).first();
      if (has.c) continue;
      try { await db.prepare(`ALTER TABLE leads ADD COLUMN ${col} ${type}`).run(); }
      catch (e) { if (!/duplicate column/i.test(String(e && e.message))) throw e; } // another instance got there first
    }
    await db.batch([
      db.prepare('CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, window_start INTEGER NOT NULL)'),
      db.prepare(`CREATE TABLE IF NOT EXISTS admin_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, lead_id TEXT, detail TEXT)`),
      db.prepare('CREATE INDEX IF NOT EXISTS idx_leads_email ON leads(email)'),
      db.prepare('CREATE INDEX IF NOT EXISTS idx_leads_type ON leads(type)'),
      // The old page sent HOT / WARM / NURTURE as the *status*, which the admin screen's own status list does not contain.
      // Keep that information (as "temperature") and give those leads the normal starting status.
      db.prepare(`UPDATE leads SET temperature = CASE lead_status WHEN 'HOT' THEN 'Hot' WHEN 'WARM' THEN 'Warm' WHEN 'NURTURE' THEN 'Nurture' END,
                    lead_status = 'New' WHERE lead_status IN ('HOT', 'WARM', 'NURTURE') AND temperature IS NULL`),
      // Old estimates were always ZAR amounts stored beside the visitor's *display* currency. Say so explicitly.
      db.prepare("UPDATE leads SET estimate_currency = 'ZAR' WHERE estimate_low IS NOT NULL AND estimate_currency IS NULL"),
      db.prepare("INSERT INTO schema_meta (key, value) VALUES ('version', '2') ON CONFLICT(key) DO UPDATE SET value = excluded.value"),
    ]);
  }
  verified = true;
}
