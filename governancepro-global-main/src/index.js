import { OPTIONS, REGIONS, LIMITS } from './lib/options.js';
import { maturityScore, band, recommendation, temperature, estimateZar } from './lib/scoring.js';
import { clientIp, hashKey, rateHit, rateCheck, rateClear, checkAdmin, json, BASE_HEADERS, csvCell } from './lib/security.js';
import { ensureSchema } from './lib/migrate.js';

const VERSION = '3.3';
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

      // ---- Public: lead capture and business problem assessment ----
      if (path === '/api/leads' && method === 'POST') return await createLead(request, env, db);
      if (path === '/api/business-assessments' && method === 'POST') return await createBusinessAssessment(request, env, db);

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
      if (path === '/api/admin/business-assessments' && method === 'GET') return await listBusinessAssessments(db, url);

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
// BUSINESS PROBLEM ASSESSMENT — non-ITSM diagnostic intake
// ---------------------------------------------------------------------------------------------------------------
const BUSINESS_CATEGORIES = [
  'Business strategy and planning', 'Financial management and cash flow', 'Sales, revenue and profitability',
  'Marketing and customer acquisition', 'Operations and productivity', 'Human resources and workforce performance',
  'Procurement and supplier management', 'Governance, internal controls and compliance',
  'Customer experience and retention', 'Business development and market expansion',
  'Project and programme delivery', 'Administration and management processes',
  'Digital transformation and business automation', 'Enterprise risk and business continuity',
  'Tendering, subcontracting and commercial opportunities', 'Technology, systems and IT reliability',
  'Other business challenge'
];
const IMPACT_FIELDS = ['impact_financial', 'impact_operations', 'impact_customers', 'impact_people', 'impact_compliance'];
const BUSINESS_TEXT_FIELDS = [
  ['problem', 2500, true], ['organisation', 160, false], ['industry', 120, false], ['region', 40, false],
  ['size', 40, false], ['started_when', 120, false], ['frequency', 120, false], ['desired_outcome', 1200, false],
  ['affected_areas', 800, false], ['previous_actions', 1200, false], ['evidence', 1800, false],
  ['constraints', 1200, false], ['name', 120, false], ['email', 254, false]
];
function businessRecommendations(category, severity, themes) {
  const common = [
    { priority: 'Immediate', action: 'Confirm the problem statement and appoint one accountable business owner.', timeframe: 'Within 2 business days', measure: 'Named owner and agreed problem statement' },
    { priority: 'High', action: 'Collect baseline evidence, quantify impact and validate the leading root-cause hypotheses before committing to a major solution.', timeframe: 'Within 7 days', measure: 'Baseline and evidence log approved by the owner' },
    { priority: 'High', action: 'Create a corrective-action plan with responsibilities, dependencies, cost estimates and review dates.', timeframe: 'Within 10 business days', measure: 'Approved action register with owners and due dates' },
    { priority: 'Medium', action: 'Review outcomes and adjust the plan based on measured results.', timeframe: 'Every 2–4 weeks', measure: 'KPI review shows progress against an agreed baseline' }
  ];
  const specific = {
    'Business strategy and planning': 'Review the target market, value proposition, strategic objectives and alignment between plans, budgets and accountable owners.',
    'Financial management and cash flow': 'Build a short-term cash-flow forecast, review receivables and payables, and separate recurring cost issues from timing-related cash pressure.',
    'Sales, revenue and profitability': 'Map the sales funnel, conversion rates, average deal value, gross margin and lost opportunities to locate the main revenue constraint.',
    'Marketing and customer acquisition': 'Audit target segments, channel performance, lead quality, conversion tracking and cost per qualified opportunity.',
    'Operations and productivity': 'Map the end-to-end process, identify bottlenecks, hand-offs, rework and unnecessary approvals, then pilot a controlled improvement.',
    'Human resources and workforce performance': 'Clarify role ownership, workload, capability gaps, performance expectations and the need for appropriate employee consultation.',
    'Procurement and supplier management': 'Review supplier performance, total cost, delivery reliability, contract obligations and viable alternative supply options.',
    'Governance, internal controls and compliance': 'Identify applicable obligations, accountable control owners, evidence gaps and control failures; obtain qualified advice where needed.',
    'Customer experience and retention': 'Analyse complaint themes, customer journey friction, resolution times and churn or repeat-purchase data.',
    'Business development and market expansion': 'Validate customer demand, market access, partner capability, commercial assumptions and the cost of entering the proposed market.',
    'Project and programme delivery': 'Reconfirm scope, schedule, dependencies, decision rights, resourcing and change control; establish a realistic recovery baseline.',
    'Administration and management processes': 'Inventory repetitive administrative work, approval delays, duplicate records and reporting needs before redesigning the workflow.',
    'Digital transformation and business automation': 'Document the current process and controls first, then assess whether process redesign, automation or a simple tool is the best fit.',
    'Enterprise risk and business continuity': 'Document the key disruption scenarios, critical activities, dependencies, controls and practical recovery priorities.',
    'Tendering, subcontracting and commercial opportunities': 'Check eligibility, mandatory documents, bid capacity, delivery risk, pricing assumptions, partner responsibilities and commercial margin.',
    'Technology, systems and IT reliability': 'Establish an incident log for the failing systems, identify the most frequent failure points and agree service targets with whoever runs them (internal team or vendor).',
    'Other business challenge': 'Break the problem into observable symptoms, affected processes, evidence gaps and testable root-cause hypotheses.'
  };
  const themed = (themes || []).map((t) => ({ priority: t.timeframe === 'Immediate' || (severity === 'Critical' && /48 hours|this week|1 week/.test(t.timeframe)) ? 'Immediate' : 'High',
    action: t.action, timeframe: t.timeframe, measure: t.measure, basis: `Based on what you described: ${t.label.toLowerCase()}` }));
  const categoryStep = { priority: severity === 'Critical' ? 'Immediate' : 'High', action: specific[category] || specific['Other business challenge'], timeframe: severity === 'Critical' ? 'Within 48 hours' : 'Within 10 business days', measure: 'Category-specific findings documented and validated against evidence', basis: `Standard step for: ${category}` };
  // Owner first, then what the user described, then the category step, then the generic governance steps.
  // Keep the plan to 7 steps or fewer: when 3+ themes were found, drop the generic baseline step (the themed steps carry their own measures).
  const generic = themed.length >= 3 ? common.slice(2) : common.slice(1);
  // Skip the category step when a themed step already covers the same ground (avoids two near-identical steps).
  const covered = (themes || []).some((t) => (t.covers || []).includes(category));
  const middle = [...themed, ...(covered ? [] : [categoryStep])].sort((x, y) => (x.priority === 'Immediate' ? 0 : 1) - (y.priority === 'Immediate' ? 0 : 1));
  return [common[0], ...middle, ...generic];
}

// Theme detection — reads what the user actually wrote so the plan reflects their situation, not just the category.
// Each theme: id, label, patterns (tested against problem/affected/evidence/constraints/previous actions), and an action.
const BUSINESS_THEMES = [
  { id: 'change_control', weight: 80, covers: ['Technology, systems and IT reliability'], label: 'Uncontrolled changes', re: /\b(untested|without testing|no testing|push(ed|es)? (changes|updates)|deploy(ment|ed|s)?|release[sd]?|change (process|control|management))\b/i,
    action: 'Introduce a basic change-control gate: every change to production (including vendor changes) needs a scheduled window, a test sign-off and a rollback plan.', timeframe: 'Within 2 weeks', measure: 'No unapproved changes in production for 30 days' },
  { id: 'detection', weight: 75, label: 'Failures detected late', re: /\b(learn(s|ed)? about|find out|found out|calling in|phone(s|d)? in|users? (report|tell|complain)|not (aware|notified)|no (monitoring|alerts?))\b/i,
    action: 'Put monitoring and alerting on the failing process so the team finds out before users or customers do.', timeframe: 'Within 2 weeks', measure: 'Majority of failures detected by the team before the first user report' },
  { id: 'vendor', weight: 60, label: 'Vendor / supplier dependency', re: /\b(vendors?|service providers?|third[- ]part(y|ies)|outsourc\w*|managed service|msp|(supplier|vendor) (contract|sla|performance|failed|failing|delays?))\b/i,
    action: 'Review the vendor or supplier contract for service levels, change obligations and penalties, and hold a formal performance review backed by your incident or delivery data.', timeframe: 'Within 3 weeks', measure: 'Documented performance review with agreed corrective actions and dates' },
  { id: 'integration', weight: 70, label: 'Data or system sync problems', re: /\b(sync\w*|out of sync|integration|interface|batch (run|job)|reconcil\w*|mismatch\w*|duplicate records?)\b/i,
    action: 'Add a daily reconciliation check between the connected systems with a named owner for exceptions, and log every sync failure with its cause.', timeframe: 'Within 1 week', measure: 'Daily reconciliation completed with exceptions cleared within one business day' },
  { id: 'manual', weight: 45, label: 'Manual / spreadsheet processes', re: /\b(manual(ly)?|spreadsheets?|excel|paper[- ]based|by hand|re-?keying|re-?captur\w*)\b/i,
    action: 'Document the manual steps, then remove the highest-volume or highest-error step first, with a template, a simple tool or a system you already own, before buying anything new.', timeframe: 'Within 30 days', measure: 'Cycle time or error rate of the targeted step reduced against baseline' },
  { id: 'receivables', weight: 74, label: 'Slow collections / debtors', re: /\b(debtors?|receivables?|late pay\w*|pay(s|ing)? (at|after) \d+|overdue|age analysis|credit control|collections?|\d+\s*-\s*\d+\s*days)\b/i,
    action: 'Set up weekly credit control: work the age analysis from oldest and largest down, escalate disputed invoices, and test whether invoice discounting or supply-chain finance is available for slow-paying clients.', timeframe: 'Start this week', measure: 'Debtor days and the over-90-day balance reduced month on month' },
  { id: 'invoicing', weight: 68, label: 'Invoicing delays', re: /\b(invoic\w*)\b[^.]{0,80}\b(late|delay\w*|weeks? after|days? after|behind|backlog)\b|\b(late|delay\w*)\b[^.]{0,40}\binvoic\w*/i,
    action: 'Invoice within 48 hours of job sign-off: make the sign-off document the trigger and track the time from completion to invoice weekly.', timeframe: 'Within 2 weeks', measure: 'Average time from completion to invoice under 2 business days' },
  { id: 'liquidity', weight: 95, covers: ['Financial management and cash flow'], label: 'Liquidity pressure', re: /\b(overdraft|facility|cannot pay|can't pay|unable to pay|cash (shortfall|crunch|squeeze)|run(ning)? out of cash)\b/i,
    action: 'Build a 13-week rolling cash-flow forecast, prioritise payments (payroll, statutory, critical suppliers) and speak to key suppliers early about terms before payments are missed.', timeframe: 'Within 48 hours', measure: 'Weekly cash forecast in use and no unplanned missed payments' },
  { id: 'payroll', weight: 100, label: 'Payroll / statutory payment risk', re: /\b(salar(y|ies)|payroll|wages?)\b[^.]{0,60}\b(late|delay\w*|miss\w*)\b|\b(delay\w*|late|miss\w*)\b[^.]{0,40}\b(salar(y|ies)|payroll|wages?)\b|\b(tax|vat|paye|uif|sars)\b[^.]{0,40}\b(late|arrears|behind|penalt\w*)\b/i,
    action: 'Treat late salaries or statutory payments as a priority legal and people risk: ring-fence those payments in the forecast and get qualified labour or tax advice before it happens again.', timeframe: 'Immediate', measure: 'Payroll and statutory payments made on time every cycle' },
  { id: 'capacity', weight: 50, label: 'Capacity / key-person dependency', re: /\b(only (one|1|two|2)|one (admin|person)|single person|team of [1-3]\b|short[- ]staffed|understaffed|overloaded|no capacity|key person)\b/i,
    action: 'Reduce key-person risk: document the critical tasks, cross-train a backup and free capacity by stopping or deferring low-value work.', timeframe: 'Within 30 days', measure: 'Each critical task has a documented procedure and a trained backup' },
  { id: 'stock', weight: 55, label: 'Stock accuracy', re: /\b(stock[- ]?outs?|stock levels?|inventory|over-?order\w*|write-?offs?|shrinkage)\b/i,
    action: 'Run cycle counts on the fast-moving lines and track stock accuracy weekly, so the cost of the problem is measured rather than estimated.', timeframe: 'Within 2 weeks', measure: 'Stock accuracy measured weekly on top lines against an agreed target' },
  { id: 'complaints', weight: 55, covers: ['Customer experience and retention'], label: 'Customer complaints', re: /\b(complain\w*|churn\w*|cancel\w*|refunds?|bad reviews?|customer (loss|losing))\b/i,
    action: 'Log and categorise every complaint for 4 weeks to find the top two themes, then fix the process behind them.', timeframe: 'Start this week', measure: 'Top complaint themes identified with an owner and fix date' },
  { id: 'compliance', weight: 90, covers: ['Governance, internal controls and compliance'], label: 'Regulatory exposure', re: /\b(regulator|audit (finding|issue)s?|non-?complian\w*|popia|gdpr|licen[cs]e condition|fine[sd]?|penalt\w*)\b/i,
    action: 'List the specific obligations at risk, map each to a control owner and evidence, and get qualified advice on any reporting duties.', timeframe: 'Within 2 weeks', measure: 'Obligations register with owners and evidence for each control' }
];
const MONEY_OR_METRIC = /(\bR\s?\d|\$\s?\d|£\s?\d|€\s?\d|\d+(\.\d+)?\s?(%|percent|m\b|k\b|million|days|hours|per (week|month|day)|times))/i;
function detectThemes(b) {
  const text = ['problem', 'affected_areas', 'evidence', 'constraints', 'previous_actions', 'desired_outcome']
    .map((f) => (typeof b[f] === 'string' ? b[f] : '')).join(' \n ');
  return BUSINESS_THEMES.filter((t) => t.re.test(text)).sort((x, y) => y.weight - x.weight).slice(0, 4);
}
function scoreDrivers(b) {
  const parts = [
    ['Financial impact', b.impact_financial, 0.30 * 65], ['Operational impact', b.impact_operations, 0.25 * 65],
    ['Customer impact', b.impact_customers, 0.15 * 65], ['People impact', b.impact_people, 0.15 * 65],
    ['Compliance / reputation impact', b.impact_compliance, 0.15 * 65], ['Urgency', b.urgency, 25], ['Recurrence', b.recurrence, 10]
  ];
  return parts.map(([label, rating, max]) => ({ label, rating, points: Math.round((rating - 1) / 4 * max * 10) / 10, max: Math.round(max * 10) / 10 }))
    .sort((x, y) => y.points - x.points);
}
function assessConfidence(b) {
  const evidence = (b.evidence || '').trim();
  const quantified = MONEY_OR_METRIC.test(`${b.problem || ''} ${evidence}`);
  if (evidence.length >= 40 && quantified) return 'Moderate — evidence and figures supplied, but self-reported and not independently verified';
  if (evidence.length >= 40 || quantified) return 'Low to moderate — some evidence or figures supplied; validate before acting on estimates';
  return 'Low — based on ratings only; further evidence required';
}
async function createBusinessAssessment(request, env, db) {
  const raw = await request.text();
  if (raw.length > 12000) return bad('Request is too large', 413);
  let b;
  try { b = JSON.parse(raw); } catch { return bad('Request body must be valid JSON'); }
  if (!b || typeof b !== 'object' || Array.isArray(b)) return bad('Request body must be a JSON object');
  if (typeof b.website === 'string' && b.website.trim()) return json({ ok: true }, 201);
  if (!BUSINESS_CATEGORIES.includes(b.category)) return bad('Select a valid business problem category.');
  for (const [name, max, required] of BUSINESS_TEXT_FIELDS) {
    if (b[name] !== undefined && b[name] !== null && typeof b[name] !== 'string') return bad(`${name} must be text`);
    if (typeof b[name] === 'string' && b[name].length > max) return bad(`${name} must be at most ${max} characters`);
    if (required && !(typeof b[name] === 'string' && b[name].trim())) return bad(`${name} is required`);
  }
  const email = b.email ? b.email.trim() : null;
  if (email && !EMAIL.test(email)) return bad('Enter a valid email address.');
  for (const field of [...IMPACT_FIELDS, 'urgency', 'recurrence']) {
    if (!Number.isInteger(b[field]) || b[field] < 1 || b[field] > 5) return bad(`${field} must be a whole number from 1 to 5`);
  }
  const hasContact = !!(b.name?.trim() || email);
  if (hasContact && b.consent !== true) return bad('Please consent to being contacted before submitting contact details.');
  const ip = await hashKey(clientIp(request), env);
  const rl = await rateHit(db, `business:${ip}`, 8, 3600);
  if (rl.blocked) return json({ ok: false, error: 'Too many submissions. Please try again later.' }, 429, { 'Retry-After': String(rl.retryAfter) });

  const impact = IMPACT_FIELDS.reduce((sum, field, i) => sum + b[field] * [0.30, 0.25, 0.15, 0.15, 0.15][i], 0);
  const rawScore = (impact - 1) / 4 * 65 + (b.urgency - 1) / 4 * 25 + (b.recurrence - 1) / 4 * 10;
  const score = Math.max(0, Math.min(100, Math.round(rawScore)));
  const severity = score >= 75 ? 'Critical' : score >= 55 ? 'High' : score >= 30 ? 'Medium' : 'Low';
  const confidence = assessConfidence(b);
  const themes = detectThemes(b);
  const drivers = scoreDrivers(b);
  const recommendations = businessRecommendations(b.category, severity, themes);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  try {
    await db.prepare(`INSERT INTO business_assessments
      (id, created_at, updated_at, category, organisation, industry, region, size, problem, started_when, frequency,
       desired_outcome, affected_areas, previous_actions, impact_financial, impact_operations, impact_customers, impact_people,
       impact_compliance, urgency, recurrence, evidence, constraints, name, email, consent, severity, score, confidence, recommendations, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'New')`)
      .bind(id, now, now, b.category, b.organisation?.trim() || null, b.industry?.trim() || null, b.region?.trim() || null,
        b.size?.trim() || null, b.problem.trim(), b.started_when?.trim() || null, b.frequency?.trim() || null,
        b.desired_outcome?.trim() || null, b.affected_areas?.trim() || null, b.previous_actions?.trim() || null,
        b.impact_financial, b.impact_operations, b.impact_customers, b.impact_people, b.impact_compliance,
        b.urgency, b.recurrence, b.evidence?.trim() || null, b.constraints?.trim() || null,
        b.name?.trim() || null, email, hasContact ? 1 : 0, severity, score, confidence, JSON.stringify(recommendations)).run();
    return json({ ok: true, id, created_at: now, score, severity, confidence, recommendations, drivers,
      themes: themes.map((t) => t.label), previous_actions: b.previous_actions?.trim() || null,
      note: 'This is an initial rules-based triage, not a verified diagnosis. Validate causes and estimates with evidence.' }, 201);
  } catch (e) {
    console.error('business assessment save failed:', e && e.message);
    return json({ ok: false, error: 'We could not save your assessment. Please try again shortly.' }, 503);
  }
}
async function listBusinessAssessments(db, url) {
  const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get('limit') || '100', 10) || 100));
  try {
    const total = (await db.prepare('SELECT COUNT(*) AS c FROM business_assessments').first()).c;
    const rows = await db.prepare(`SELECT id, created_at, category, organisation, industry, region, size, problem, desired_outcome,
      name, email, severity, score, confidence, recommendations, status FROM business_assessments ORDER BY created_at DESC LIMIT ?`)
      .bind(limit).all();
    return json({ ok: true, assessments: rows.results || [], total, limit });
  } catch (e) {
    console.error('business assessment list failed:', e && e.message);
    return json({ ok: false, error: 'Unable to load business assessments' }, 500);
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
