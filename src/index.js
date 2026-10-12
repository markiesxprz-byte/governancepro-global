import { OPTIONS, REGIONS, LIMITS } from './lib/options.js';
import { maturityScore, band, recommendation, temperature, estimateZar } from './lib/scoring.js';
import { clientIp, hashKey, rateHit, rateCheck, rateClear, checkAdmin, json, BASE_HEADERS, csvCell } from './lib/security.js';
import { ensureSchema } from './lib/migrate.js';

const VERSION = '3.1';
const SERVICE = 'GovernancePro Global';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
      if (path === '/api/health') return await health(env);

      const needsApp = path.startsWith('/api/') || path === '/admin' || path === '/admin.html';
      if (!needsApp) return env.ASSETS.fetch(request);

      if (!env.DB) return json({ ok: false, error: 'Database binding not configured' }, 503);
      try { await ensureSchema(env.DB); }
      catch (e) { console.error('schema check failed:', e && e.message); return json({ ok: false, error: 'Service temporarily unavailable' }, 503); }
      const db = env.DB;

      // ---- Public: lead capture (assessments, calculator, waitlist, enquiries) ----
      if (path === '/api/leads' && method === 'POST') return await createLead(request, env, db);

      // ---- Everything below is administrator-only ----
      const isAdminPath = path === '/admin' || path === '/admin.html' || path === '/api/leads' || path.startsWith('/api/admin/');
      if (!isAdminPath) return json({ ok: false, error: 'Not found' }, 404);
      const denied = await requireAdmin(request, env, db);
      if (denied) return denied;

      if (path === '/admin.html') return Response.redirect(`${url.origin}/admin`, 302);
      if (path === '/admin') return await adminPage(request, env, url);

      if ((path === '/api/leads' || path === '/api/admin/leads') && method === 'GET') return await listLeads(db, url);
      if (path === '/api/admin/leads.csv' && method === 'GET') return await exportLeads(db, url);
      if (path === '/api/admin/stats' && method === 'GET') return await stats(db);
      if (path === '/api/admin/audit' && method === 'GET') return await auditLog(db, url);

      const m = path.match(/^\/api\/admin\/leads\/([A-Za-z0-9-]{1,64})$/);
      if (m && method === 'PATCH') return await updateLead(request, db, m[1]);
      if (m && method === 'DELETE') return await deleteLead(db, m[1]);

      return json({ ok: false, error: 'Not found' }, 404);
    } catch (e) {
      console.error('unhandled error:', e && e.message);
      return json({ ok: false, error: 'Something went wrong' }, 500);
    }
  },
};

// ---------------------------------------------------------------------------------------------------------------
async function health(env) {
  let database = 'not configured';
  if (env.DB) {
    try { await env.DB.prepare('SELECT 1').first(); database = 'ok'; } catch { database = 'unavailable'; }
  }
  return json({ ok: database === 'ok', service: SERVICE, version: VERSION, database }, database === 'ok' ? 200 : 503);
}

function unauthorized() {
  return json({ ok: false, error: 'Administrator authentication required' }, 401, { 'WWW-Authenticate': 'Basic realm="GovernancePro Global Admin"' });
}

// Wrong passwords are counted per client address; five in 15 minutes locks that address out for the rest of the window.
async function requireAdmin(request, env, db) {
  const key = `adminfail:${await hashKey(clientIp(request), env)}`;
  const lock = await rateCheck(db, key, 5, 900);
  if (lock.blocked) return json({ ok: false, error: 'Too many failed attempts. Please try again later.' }, 429, { 'Retry-After': String(lock.retryAfter) });
  const result = await checkAdmin(request, env);
  if (result === 'ok') { await rateClear(db, key); return null; }
  if (result === 'bad') await rateHit(db, key, 5, 900); // only attempts that actually sent credentials count
  return unauthorized();
}

async function audit(db, action, leadId, detail) {
  await db.prepare('INSERT INTO admin_audit (at, actor, action, lead_id, detail) VALUES (?, ?, ?, ?, ?)')
    .bind(new Date().toISOString(), 'admin', action, leadId || null, detail ? JSON.stringify(detail) : null).run();
}

// The admin page is a static file, but it must not be public, so the Worker serves it only after authentication.
async function adminPage(request, env, url) {
  const res = await env.ASSETS.fetch(new Request(`${url.origin}/admin`, { method: 'GET' }));
  const headers = new Headers(res.headers);
  headers.set('Cache-Control', 'no-store');
  headers.set('X-Robots-Tag', 'noindex, nofollow');
  for (const [k, v] of Object.entries(BASE_HEADERS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, headers });
}

// ---------------------------------------------------------------------------------------------------------------
// PUBLIC LEAD CAPTURE
// ---------------------------------------------------------------------------------------------------------------
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE = /^[0-9+()\-.\s]{5,40}$/;
const bad = (message, status = 400) => json({ ok: false, error: message }, status);

function textError(b, name, max) {
  const v = b[name];
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string') return `${name} must be text`;
  return v.length > max ? `${name} must be at most ${max} characters` : null;
}
const oneOf = (name, v, list) => (list.includes(v) ? null : `${name} must be one of: ${list.join(', ')}`);

async function createLead(request, env, db) {
  const raw = await request.text();
  if (raw.length > LIMITS.body) return bad('Request is too large', 413);
  let b;
  try { b = JSON.parse(raw); } catch { return bad('Request body must be valid JSON'); }
  if (!b || typeof b !== 'object' || Array.isArray(b)) return bad('Request body must be a JSON object');

  // Hidden form field that people never see: a bot filling it in is dropped, but told it worked.
  if (typeof b.website === 'string' && b.website.trim() !== '') return json({ ok: true }, 201);

  const type = b.type;
  if (!OPTIONS.type.includes(type)) return bad(`type must be one of: ${OPTIONS.type.join(', ')}`);

  for (const [name, max] of [['name', LIMITS.name], ['company', LIMITS.company], ['email', LIMITS.email], ['phone', LIMITS.phone],
    ['challenge', LIMITS.text], ['message', LIMITS.text], ['consent_version', LIMITS.version]]) {
    const e = textError(b, name, max);
    if (e) return bad(e);
  }
  const email = b.email ? String(b.email).trim() : null;
  if (email && !EMAIL.test(email)) return bad('email must be a valid email address');
  if (b.phone && !PHONE.test(b.phone)) return bad('phone must look like a telephone number');

  let region = null;
  if (b.region !== undefined && b.region !== null && b.region !== '') {
    if (!REGIONS[b.region]) return bad(`region must be one of: ${Object.keys(REGIONS).join(', ')}`);
    region = b.region;
  }
  if (b.size && oneOf('size', b.size, OPTIONS.size)) return bad(oneOf('size', b.size, OPTIONS.size));
  if (b.framework && oneOf('framework', b.framework, OPTIONS.framework)) return bad(oneOf('framework', b.framework, OPTIONS.framework));

  const hasContact = !!(email || b.name || b.company || b.phone);
  let result = null, score = null, bandName = null, temp = null, estLow = null, estHigh = null, answers = null;

  if (type === 'assessment') {
    if (!b.name || !b.company || !email) return bad('Please enter your name, company and email.');
    if (!b.framework) return bad('framework is required');
    const a = b.answers && typeof b.answers === 'object' ? b.answers : null;
    if (a) {
      const e = oneOf('docs', a.docs, OPTIONS.docs) || oneOf('support', a.support, OPTIONS.support)
        || oneOf('timeline', a.timeline, OPTIONS.timeline) || oneOf('need', a.need, OPTIONS.need);
      if (e) return bad(e);
      score = maturityScore(a);
      answers = JSON.stringify({ docs: a.docs, support: a.support, timeline: a.timeline, need: a.need });
    } else if (Number.isInteger(b.score)) {
      // Pages cached from before this release send only a score. Accept it, but never beyond the valid range.
      score = Math.min(100, Math.max(0, b.score));
    } else {
      return bad('answers are required');
    }
    bandName = band(score); temp = temperature(score);
    result = { score, band: bandName, recommendation: recommendation(score), temperature: temp };
  } else if (type === 'quote') {
    const e = (!b.framework && 'framework is required') || oneOf('service', b.service, OPTIONS.service)
      || oneOf('size', b.size, OPTIONS.size) || oneOf('maturity', b.maturity, OPTIONS.maturity);
    if (e) return bad(e);
    const est = estimateZar({ service: b.service, size: b.size, maturity: b.maturity, framework: b.framework });
    estLow = est.low; estHigh = est.high;
    result = { estimateZar: est };
  } else if (type === 'waitlist') {
    if (!b.name || !email) return bad('Please enter your name and email.');
    const e = oneOf('product_interest', b.product_interest, OPTIONS.interest);
    if (e) return bad(e);
  } else if (type === 'enquiry') {
    if (!b.name || !email) return bad('Please enter your name and email.');
    if (b.product_interest && oneOf('product_interest', b.product_interest, OPTIONS.interest)) return bad(oneOf('product_interest', b.product_interest, OPTIONS.interest));
  }

  // Anyone whose contact details we keep must have said we may contact them. (An anonymous cost calculation has no contact details.)
  if (hasContact && b.consent !== true) return bad('Please confirm that you agree to be contacted. We cannot save your details without it.');

  const ip = await hashKey(clientIp(request), env);
  const limit = hasContact ? 10 : 40; // calculator use is anonymous and frequent; forms that collect contact details are not
  const rl = await rateHit(db, `${hasContact ? 'lead' : 'calc'}:${ip}`, limit, 3600);
  if (rl.blocked) return json({ ok: false, error: 'Too many submissions. Please try again later.' }, 429, { 'Retry-After': String(rl.retryAfter) });

  try {
    // The same person sending the same thing twice (double-click, retry) must not create two leads.
    if (email) {
      const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const dup = await db.prepare(
        `SELECT id FROM leads WHERE lower(email) = lower(?) AND type = ? AND COALESCE(framework, '') = ? AND COALESCE(product_interest, '') = ? AND created_at > ?`
      ).bind(email, type, b.framework || '', b.product_interest || '', since).first();
      if (dup) return json({ ok: true, id: dup.id, duplicate: true, ...(result ? { result } : {}) }, 200);
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await db.prepare(
      `INSERT INTO leads (id, created_at, type, name, company, email, phone, framework, score, band, lead_status, challenge, region, currency,
         service, size, maturity, estimate_low, estimate_high, consent, message, product_interest, consent_at, consent_version, source,
         updated_at, temperature, estimate_currency, answers)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'New', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'web', ?, ?, ?, ?)`
    ).bind(
      id, now, type, b.name || null, b.company || null, email, b.phone || null, b.framework || null, score, bandName,
      b.challenge || null, region, region ? REGIONS[region] : null,
      b.service || null, b.size || null, b.maturity || null, estLow, estHigh, hasContact ? 1 : 0,
      b.message || null, b.product_interest || null, hasContact ? now : null, hasContact ? (b.consent_version || null) : null,
      now, temp, estLow !== null ? 'ZAR' : null, answers
    ).run();
    return json({ ok: true, id, ...(result ? { result } : {}) }, 201);
  } catch (e) {
    console.error('lead insert failed:', e && e.message); // never log the lead itself
    return bad('We could not save your request just now. Please try again in a few minutes.', 503);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// ADMIN
// ---------------------------------------------------------------------------------------------------------------
function nextDay(iso) {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
}

function filters(url) {
  const p = url.searchParams;
  const where = [], args = [];
  const q = (p.get('q') || '').trim().slice(0, 100).toLowerCase();
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push("(lower(COALESCE(name,'')) LIKE ? ESCAPE '\\' OR lower(COALESCE(company,'')) LIKE ? ESCAPE '\\' OR lower(COALESCE(email,'')) LIKE ? ESCAPE '\\')");
    args.push(like, like, like);
  }
  const status = p.get('status');
  if (status && OPTIONS.status.includes(status)) { where.push("COALESCE(NULLIF(lead_status,''),'New') = ?"); args.push(status); }
  const type = p.get('type');
  if (type && OPTIONS.type.includes(type)) { where.push('type = ?'); args.push(type); }
  const framework = p.get('framework');
  if (framework && OPTIONS.framework.includes(framework)) { where.push('framework = ?'); args.push(framework); }
  const from = p.get('from'), to = p.get('to');
  if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) { where.push('created_at >= ?'); args.push(`${from}T00:00:00.000Z`); }
  if (to && /^\d{4}-\d{2}-\d{2}$/.test(to)) { where.push('created_at < ?'); args.push(nextDay(to)); }
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', args };
}

async function listLeads(db, url) {
  const f = filters(url);
  const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get('limit') || '200', 10) || 200));
  const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
  try {
    const total = (await db.prepare(`SELECT COUNT(*) AS c FROM leads ${f.sql}`).bind(...f.args).first()).c;
    const rows = await db.prepare(`SELECT * FROM leads ${f.sql} ORDER BY created_at DESC LIMIT ? OFFSET ?`).bind(...f.args, limit, offset).all();
    return json({ ok: true, leads: rows.results || [], total, limit, offset });
  } catch (e) {
    console.error('list failed:', e && e.message);
    return json({ ok: false, error: 'Unable to load leads' }, 500);
  }
}

const CSV_COLUMNS = [
  ['created_at', 'Received'], ['type', 'Type'], ['lead_status', 'Status'], ['temperature', 'Temperature'], ['name', 'Name'], ['company', 'Company'],
  ['email', 'Email'], ['phone', 'Phone'], ['framework', 'Framework'], ['score', 'Score'], ['band', 'Band'], ['product_interest', 'Interest'],
  ['service', 'Service'], ['size', 'Size'], ['maturity', 'Maturity'], ['region', 'Region'], ['estimate_low', 'Estimate low (ZAR)'],
  ['estimate_high', 'Estimate high (ZAR)'], ['challenge', 'Challenge'], ['message', 'Message'], ['consent', 'Consent given'],
  ['consent_at', 'Consent recorded'], ['consent_version', 'Consent wording version'],
];

async function exportLeads(db, url) {
  const f = filters(url);
  try {
    const rows = (await db.prepare(`SELECT * FROM leads ${f.sql} ORDER BY created_at DESC LIMIT 5000`).bind(...f.args).all()).results || [];
    const lines = [CSV_COLUMNS.map(([, label]) => csvCell(label)).join(',')];
    for (const r of rows) lines.push(CSV_COLUMNS.map(([k]) => csvCell(r[k])).join(','));
    await audit(db, 'export_csv', null, { rows: rows.length });
    return new Response(lines.join('\r\n'), {
      headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="governancepro-leads.csv"', 'cache-control': 'no-store', ...BASE_HEADERS },
    });
  } catch (e) {
    console.error('export failed:', e && e.message);
    return json({ ok: false, error: 'Unable to export leads' }, 500);
  }
}

async function stats(db) {
  try {
    const one = (sql) => db.prepare(sql).first();
    const total = await one('SELECT COUNT(*) AS total FROM leads');
    const scores = await one('SELECT AVG(score) AS average_score FROM leads WHERE score IS NOT NULL');
    // Estimates are always ZAR (older rows were migrated to say so), so this total is in one currency.
    const pipeline = await one('SELECT COALESCE(SUM(estimate_low),0) AS pipeline_low, COALESCE(SUM(estimate_high),0) AS pipeline_high FROM leads WHERE estimate_low IS NOT NULL OR estimate_high IS NOT NULL');
    const group = (col, fallback) => db.prepare(`SELECT COALESCE(NULLIF(${col}, ''), '${fallback}') AS k, COUNT(*) AS total FROM leads GROUP BY 1 ORDER BY total DESC`).all();
    const [regions, statuses, frameworks, types] = await Promise.all([group('region', 'Unknown'), group('lead_status', 'New'), group('framework', 'Unknown'), group('type', 'Unknown')]);
    const rename = (res, key) => (res.results || []).map((r) => ({ [key]: r.k, total: r.total }));
    const asMap = (res) => Object.fromEntries((res.results || []).map((r) => [r.k, r.total]));
    const avg = Number(scores?.average_score || 0);
    const flat = {
      total: Number(total?.total || 0), avgScore: avg, averageScore: avg,
      pipelineLow: Number(pipeline?.pipeline_low || 0), pipelineHigh: Number(pipeline?.pipeline_high || 0), pipelineCurrency: 'ZAR',
    };
    return json({
      ok: true,
      // What the admin page reads: figures at the top level, breakdowns as { name: count } maps.
      ...flat,
      byRegion: asMap(regions), byStatus: asMap(statuses), byFramework: asMap(frameworks), byType: asMap(types),
      // The original nested shape (lists of { name, total }), kept so nothing that used it breaks.
      stats: { ...flat, regions: rename(regions, 'region'), statuses: rename(statuses, 'status'), frameworks: rename(frameworks, 'framework'), types: rename(types, 'type') },
    });
  } catch (e) {
    console.error('stats failed:', e && e.message);
    return json({ ok: false, error: 'Unable to load statistics' }, 500);
  }
}

async function updateLead(request, db, id) {
  let b;
  try { b = await request.json(); } catch { return bad('Request body must be valid JSON'); }
  // The admin page sends "lead_status"; older clients sent "status". Accept both.
  const status = b && (b.lead_status ?? b.status);
  if (!OPTIONS.status.includes(status)) return bad(`Invalid lead status. Use one of: ${OPTIONS.status.join(', ')}`);
  try {
    const r = await db.prepare('UPDATE leads SET lead_status = ?, updated_at = ? WHERE id = ?').bind(status, new Date().toISOString(), id).run();
    if (!r.meta.changes) return bad('Lead not found', 404);
    await audit(db, 'status_change', id, { status });
    return json({ ok: true, id, status });
  } catch (e) {
    console.error('update failed:', e && e.message);
    return json({ ok: false, error: 'Unable to update lead' }, 500);
  }
}

// Erasure: remove a person's record when they ask (and note, without personal data, that it happened).
async function deleteLead(db, id) {
  try {
    const r = await db.prepare('DELETE FROM leads WHERE id = ?').bind(id).run();
    if (!r.meta.changes) return bad('Lead not found', 404);
    await audit(db, 'delete', id, null);
    return json({ ok: true, id });
  } catch (e) {
    console.error('delete failed:', e && e.message);
    return json({ ok: false, error: 'Unable to delete lead' }, 500);
  }
}

async function auditLog(db, url) {
  const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get('limit') || '50', 10) || 50));
  const rows = await db.prepare('SELECT id, at, actor, action, lead_id, detail FROM admin_audit ORDER BY id DESC LIMIT ?').bind(limit).all();
  return json({ ok: true, entries: rows.results || [] });
}
