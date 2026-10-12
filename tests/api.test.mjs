// End-to-end API tests for GovernancePro Global.
//   npm run dev                 (terminal 1: local Worker with a local database; needs .dev.vars — see .dev.vars.example)
//   npm run test:api            (terminal 2)
// Expects an EMPTY local database and creates leads. Never run against production.
// Usage: node tests/api.test.mjs [baseUrl]    ADMIN_PASSWORD=... node tests/api.test.mjs
const BASE = (process.argv[2] || 'http://localhost:8787').replace(/\/$/, '');
const PASS = process.env.ADMIN_PASSWORD || 'local-test-admin-pass';
const AUTH = 'Basic ' + Buffer.from(`admin:${PASS}`).toString('base64');
const results = [];
let n = 0;
const ip = () => `198.51.100.${(++n % 240) + 1}`; // every call comes from a different address unless a test pins one

function t(name, ok, detail = '') {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail ? `  [${detail}]` : ''}`);
}
async function req(method, path, { json, auth, address, raw, headers } = {}) {
  const h = { 'cf-connecting-ip': address || ip(), ...(headers || {}) };
  if (auth) h.Authorization = auth === true ? AUTH : auth;
  let body;
  if (raw !== undefined) { body = raw; h['content-type'] = 'application/json'; }
  else if (json !== undefined) { body = JSON.stringify(json); h['content-type'] = 'application/json'; }
  const res = await fetch(BASE + path, { method, headers: h, body, redirect: 'manual' });
  const text = await res.text();
  let data = null; try { data = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, data, text, headers: res.headers };
}
const A = { name: 'Thandi Dlamini', company: 'SmallCo', email: 'thandi@smallco.co.za', framework: 'ISO 27001', size: '26–50', region: 'ZA', consent: true, consent_version: '2026-10-12' };
const answers = (docs, support, timeline, need) => ({ docs, support, timeline, need });
const assess = (over = {}) => ({ type: 'assessment', ...A, answers: answers('Basic', 'Moderate', '12+ months', 'Implementation support'), ...over });

// ------------------------------------------------------------------------------------------ health
let r = await req('GET', '/api/health');
t('health: ok, version 3.1, database reachable', r.status === 200 && r.data.ok && r.data.version === '3.1' && r.data.database === 'ok', r.text);

// ------------------------------------------------------------------------------------------ public pages
for (const p of ['/saas', '/privacy', '/terms', '/site.css', '/sitemap.xml', '/robots.txt']) {
  r = await req('GET', p);
  t(`page ${p} is served`, r.status === 200 && r.text.length > 100, `status ${r.status}`);
}
r = await req('GET', '/saas');
t('SaaS page shows the four proposed prices and the report price', ['US$49', 'US$99', 'US$299', 'US$499', 'US$149'].every((x) => r.text.includes(x)));
t('SaaS page labels future plans as coming soon / planned and offers a waitlist', (r.text.match(/Coming soon/g) || []).length >= 2 && r.text.includes('Join the waitlist') && r.text.includes('Planned'));
t('SaaS page has no purchase, checkout or invented-proof wording', !/buy now|subscribe now|checkout|add to cart|pay now|testimonial|trusted by/i.test(r.text));
t('SaaS page does not claim certification outcomes', /not an independent audit/i.test(r.text) && /guarantee/i.test(r.text));
t('SaaS page links to privacy and terms', r.text.includes('href="/privacy"') && r.text.includes('href="/terms"'));
r = await req('GET', '/sitemap.xml');
t('sitemap lists the public pages (and not the admin area)', ['/saas', '/privacy', '/terms'].every((x) => r.text.includes(x)) && !r.text.includes('/admin'));
r = await req('GET', '/robots.txt');
t('robots.txt keeps /admin and /api out and points to the sitemap', /Disallow: \/admin/.test(r.text) && /Disallow: \/api\//.test(r.text) && /Sitemap:/.test(r.text));
r = await req('GET', '/');
const h = (k) => r.headers.get(k);
t('site sends CSP, framing, nosniff, referrer and HSTS headers', /default-src 'self'/.test(h('content-security-policy') || '') && /frame-ancestors 'none'/.test(h('content-security-policy') || '') && h('x-frame-options') === 'DENY' && h('x-content-type-options') === 'nosniff' && h('referrer-policy') && h('strict-transport-security'));
r = await req('GET', '/api/health');
t('API responses are never cached or sniffed', /no-store/.test(h('cache-control') || '') && h('x-content-type-options') === 'nosniff');

// ------------------------------------------------------------------------------------------ admin protection
for (const [m, p] of [['GET', '/admin'], ['GET', '/admin.html'], ['GET', '/api/leads'], ['GET', '/api/admin/leads'], ['GET', '/api/admin/leads.csv'], ['GET', '/api/admin/stats'], ['GET', '/api/admin/audit'], ['PATCH', '/api/admin/leads/x'], ['DELETE', '/api/admin/leads/x']]) {
  r = await req(m, p, m === 'PATCH' ? { json: { status: 'Won' } } : {});
  t(`${m} ${p} refuses anonymous visitors`, r.status === 401, `status ${r.status}`);
}
r = await req('GET', '/admin');
t('the admin page (a static file) is no longer public and challenges for credentials', r.status === 401 && /Basic/.test(h('www-authenticate') || ''));
r = await req('GET', '/api/admin/leads', { auth: 'Basic ' + Buffer.from('admin:wrong-password').toString('base64') });
t('wrong password is refused', r.status === 401);
r = await req('GET', '/api/admin/leads', { auth: 'Basic ' + Buffer.from(`root:${PASS}`).toString('base64') });
t('wrong username is refused', r.status === 401);
r = await req('GET', '/api/admin/leads', { auth: 'Bearer abc' });
t('a non-Basic Authorization header is refused', r.status === 401);
r = await req('GET', '/admin', { auth: true });
t('the admin page loads for the administrator', r.status === 200 && /Admin/.test(r.text) && /no-store/.test(h('cache-control') || ''));
r = await req('GET', '/admin.html', { auth: true });
t('/admin.html redirects to /admin (one address for the admin page)', r.status === 302 && /\/admin$/.test(h('location') || ''));

// ------------------------------------------------------------------------------------------ admin lockout
const lockIp = '203.0.113.50';
const wrong = 'Basic ' + Buffer.from('admin:nope').toString('base64');
const codes = [];
for (let i = 0; i < 6; i++) codes.push((await req('GET', '/api/admin/stats', { auth: wrong, address: lockIp })).status);
t('five wrong admin passwords lock the address (401 x5, then 429)', codes.join() === '401,401,401,401,401,429', codes.join());
r = await req('GET', '/api/admin/stats', { auth: true, address: lockIp });
t('...even the right password is refused from the locked address', r.status === 429 && h('retry-after'));
r = await req('GET', '/api/admin/stats', { auth: true, address: '203.0.113.51' });
t('...but the administrator from another address is unaffected', r.status === 200);
const before = (await req('GET', '/api/admin/leads', { auth: true })).data.total;
t('the database starts empty for this test run', before === 0, `found ${before} leads — use a fresh local database`);

// ------------------------------------------------------------------------------------------ validation
const bad = async (name, payload, expectStatus = 400, opts = {}) => {
  const res = await req('POST', '/api/leads', { json: payload, ...opts });
  t(`rejects: ${name}`, res.status === expectStatus && res.data && res.data.ok === false, `status ${res.status} ${res.text.slice(0, 80)}`);
  return res;
};
r = await req('POST', '/api/leads', { raw: '{not json' });
t('rejects: invalid JSON', r.status === 400 && r.data.ok === false);
await bad('a JSON array instead of an object', []);
await bad('unknown type', { type: 'hack' });
await bad('missing type', { name: 'x' });
await bad('assessment without consent', assess({ consent: undefined }));
await bad('assessment with consent=false', assess({ consent: false }));
await bad('assessment with consent as a string', assess({ consent: 'true' }));
await bad('invalid email', assess({ email: 'not-an-email' }));
await bad('invalid telephone number', assess({ phone: 'call me maybe' }));
await bad('unknown framework', assess({ framework: 'ISO 99999' }));
await bad('unknown organisation size', assess({ size: 'huge' }));
await bad('unknown region', assess({ region: 'MARS' }));
await bad('an answer outside the allowed list', assess({ answers: answers('Basic', 'Moderate', '12+ months', 'Make me rich') }));
await bad('assessment with no answers and no score', assess({ answers: undefined }));
await bad('assessment missing the company', assess({ company: undefined }));
await bad('name longer than 120 characters', assess({ name: 'x'.repeat(121) }));
await bad('message longer than 2000 characters', { type: 'enquiry', name: 'x', email: 'x@y.co', message: 'm'.repeat(2001), consent: true });
await bad('request body over 20 KB', { type: 'enquiry', name: 'x', email: 'x@y.co', message: 'm'.repeat(25000), consent: true }, 413);
await bad('quote with an unknown service', { type: 'quote', framework: 'ISO 27001', service: 'Free pizza', size: '1–25', maturity: 'Initial' });
await bad('waitlist without an interest', { type: 'waitlist', name: 'x', email: 'x@y.co', consent: true });
await bad('waitlist with an unknown interest', { type: 'waitlist', name: 'x', email: 'x@y.co', product_interest: 'saas_free', consent: true });
await bad('enquiry without consent', { type: 'enquiry', name: 'x', email: 'x@y.co' });
r = await req('POST', '/api/leads', { json: assess({ website: 'http://spam.example' }) });
t('spam trap: a filled hidden field looks like success but stores nothing', r.status === 201 && r.data.ok === true && !r.data.id);
t('...and nothing was stored by any rejected or trapped request', (await req('GET', '/api/admin/leads', { auth: true })).data.total === 0);
r = await req('POST', '/api/leads', { json: assess({ email: "x'); DROP TABLE leads;--@y.co" }) });
t('rejects: SQL text in the email field (and the table survives)', r.status === 400 && (await req('GET', '/api/admin/leads', { auth: true })).data.ok === true);

// ------------------------------------------------------------------------------------------ server-side scoring
// Expected values are calculated by hand from the scoring tables, not by calling the code under test.
const cases = [
  { a: answers('None / very limited', 'Low', 'Not decided', 'Assessment only'), score: 41, band: 'Defined', rec: 'Gap assessment + implementation roadmap', temp: 'Hot' },       // (15+20+60+70)/4 = 41.25
  { a: answers('Mature', 'Strong', '3–6 months', 'Roadmap'), score: 74, band: 'Managed', rec: 'Optimisation + governance advisory', temp: 'Nurture' },                  // (92+90+55+60)/4 = 74.25
  { a: answers('Basic', 'Moderate', '12+ months', 'Implementation support'), score: 50, band: 'Defined', rec: 'Readiness assessment + targeted improvement programme', temp: 'Warm' }, // (35+45+70+50)/4 = 50
  { a: answers('Mostly implemented', 'Good', '6–12 months', 'Full implementation'), score: 63, band: 'Managed', rec: 'Readiness assessment + targeted improvement programme', temp: 'Warm' }, // (75+70+65+40)/4 = 62.5 -> 63
];
let k = 0;
for (const c of cases) {
  r = await req('POST', '/api/leads', { json: assess({ email: `case${++k}@smallco.co.za`, answers: c.a, score: 99, band: 'Optimised', leadStatus: 'Won', estimateLow: 1, estimateHigh: 2, currency: 'XXX' }) });
  const res = r.data && r.data.result;
  t(`scoring case ${k}: server returns ${c.score}/${c.band}/${c.temp}, ignoring the client's own numbers`, r.status === 201 && res && res.score === c.score && res.band === c.band && res.recommendation === c.rec && res.temperature === c.temp, r.text);
}
let list = (await req('GET', '/api/admin/leads', { auth: true })).data;
const stored = list.leads.find((l) => l.email === 'case1@smallco.co.za');
t('stored record holds the SERVER score, status "New", temperature, and no client-supplied estimate or currency', stored.score === 41 && stored.band === 'Defined' && stored.lead_status === 'New' && stored.temperature === 'Hot' && stored.estimate_low === null && stored.currency === 'ZAR', JSON.stringify(stored));
t('stored record keeps consent, its wording version, its time and the answers', stored.consent === 1 && stored.consent_version === '2026-10-12' && !!stored.consent_at && JSON.parse(stored.answers).docs === 'None / very limited');
r = await req('POST', '/api/leads', { json: { type: 'assessment', name: 'Old Page', company: 'Cached Ltd', email: 'old@cached.co.za', framework: 'COBIT', score: 150, consent: true } });
t('a page cached from before this release (score only) is still accepted, clamped to 100', r.status === 201 && list.total >= 0 && (await req('GET', '/api/admin/leads?q=cached', { auth: true })).data.leads[0].score === 100);

// ------------------------------------------------------------------------------------------ estimates and currency
r = await req('POST', '/api/leads', { json: { type: 'quote', framework: 'ISO 27001', service: 'Readiness / Gap Analysis', size: '51–100', maturity: 'Developing', region: 'US', estimateLow: 5, estimateHigh: 6 } });
t('calculator: 15,000 x 1.35 x 1.15 = 23,288 to 33,767 (ZAR), computed on the server', r.status === 201 && r.data.result.estimateZar.low === 23288 && r.data.result.estimateZar.high === 33767, r.text);
r = await req('POST', '/api/leads', { json: { type: 'quote', framework: 'COBIT', service: 'Readiness / Gap Analysis', size: '51–100', maturity: 'Developing', region: 'GB' } });
t('calculator: governance frameworks start from R25,000 (38,813 to 56,278)', r.data.result.estimateZar.low === 38813 && r.data.result.estimateZar.high === 56278, r.text);
r = await req('POST', '/api/leads', { json: { type: 'quote', framework: 'ISO 9001', service: 'Ongoing Advisory', size: '1–25', maturity: 'Optimised', region: 'ZA' } });
t('calculator: smallest case 1,500 x 1 x 0.8 = 1,200 to 1,740', r.data.result.estimateZar.low === 1200 && r.data.result.estimateZar.high === 1740, r.text);
list = (await req('GET', '/api/admin/leads?type=quote', { auth: true })).data;
const q1 = list.leads.find((l) => l.estimate_low === 23288);
t('estimates are stored in ZAR and labelled ZAR, while the visitor\'s display currency is kept separately (USD)', q1.estimate_currency === 'ZAR' && q1.currency === 'USD' && q1.region === 'US');
t('an anonymous calculator use stores no contact details and no consent claim', q1.name === null && q1.email === null && q1.consent === 0);

// ------------------------------------------------------------------------------------------ duplicates
const dupBody = { type: 'enquiry', name: 'Dup Person', email: 'dup@smallco.co.za', product_interest: 'consulting', consent: true };
const d1 = await req('POST', '/api/leads', { json: dupBody });
const d2 = await req('POST', '/api/leads', { json: { ...dupBody, email: 'DUP@smallco.co.za' } });
t('an identical request sent twice is stored once (second reply: 200, duplicate, same id)', d1.status === 201 && d2.status === 200 && d2.data.duplicate === true && d2.data.id === d1.data.id, `${d1.status}/${d2.status}`);
t('...and the lead count rose by one, not two', (await req('GET', '/api/admin/leads?q=dup%40smallco', { auth: true })).data.total === 1);

// ------------------------------------------------------------------------------------------ waitlist
r = await req('POST', '/api/leads', { json: { type: 'waitlist', name: 'Wait Lister', email: 'wait@msp.co.za', company: 'MSP Co', product_interest: 'saas_msp', message: 'We run 12 client networks.', consent: true, consent_version: '2026-10-12' } });
t('waitlist sign-up is stored (201)', r.status === 201 && r.data.ok);
const wl = (await req('GET', '/api/admin/leads?type=waitlist', { auth: true })).data.leads[0];
t('...with its interest, message, consent and wording version', wl.product_interest === 'saas_msp' && wl.message === 'We run 12 client networks.' && wl.consent === 1 && wl.consent_version === '2026-10-12');

// ------------------------------------------------------------------------------------------ public replies leak nothing
r = await req('POST', '/api/leads', { json: assess({ email: 'leak@smallco.co.za' }) });
t('the public reply contains only the id and the result, never any stored record', Object.keys(r.data).sort().join() === 'id,ok,result' && !/@/.test(r.text));
r = await req('POST', '/api/leads', { json: assess({ email: 'bad-email' }) });
t('error replies do not echo the submitted data back', !/bad-email/.test(r.text));

// ------------------------------------------------------------------------------------------ rate limiting
const rlIp = '203.0.113.77';
const rl = [];
for (let i = 0; i < 11; i++) rl.push((await req('POST', '/api/leads', { json: assess({ email: `rl${i}@smallco.co.za`, framework: i % 2 ? 'ISO 9001' : 'ITSM' }), address: rlIp })).status);
t('contact forms: 10 per hour per address, the 11th is refused with 429', rl.slice(0, 10).every((s) => s === 201) && rl[10] === 429, rl.join());
r = await req('POST', '/api/leads', { json: assess({ email: 'other@smallco.co.za' }), address: '203.0.113.78' });
t('...while a different visitor is unaffected', r.status === 201);

// ------------------------------------------------------------------------------------------ admin features
list = (await req('GET', '/api/admin/leads', { auth: true })).data;
t('admin list reports a total, a limit and an offset', list.ok && typeof list.total === 'number' && list.limit === 200 && list.offset === 0 && list.leads.length === list.total);
let p1 = (await req('GET', '/api/admin/leads?limit=3&offset=0', { auth: true })).data;
let p2 = (await req('GET', '/api/admin/leads?limit=3&offset=3', { auth: true })).data;
t('pagination: limit=3 returns 3 rows, the next page returns different rows, total is the same', p1.leads.length === 3 && p2.leads.length === 3 && !p1.leads.some((a) => p2.leads.some((b) => b.id === a.id)) && p1.total === p2.total && p1.total === list.total);
t('pagination: nonsense limits fall back safely', (await req('GET', '/api/admin/leads?limit=abc&offset=-5', { auth: true })).data.leads.length === list.total);
const byType = (type) => req('GET', `/api/admin/leads?type=${type}`, { auth: true });
t('filter by type returns only that type', (await byType('waitlist')).data.leads.every((l) => l.type === 'waitlist') && (await byType('quote')).data.leads.every((l) => l.type === 'quote') && (await byType('waitlist')).data.total === 1);
t('search finds by name fragment, company and email, case-insensitively', (await req('GET', '/api/admin/leads?q=THANDI', { auth: true })).data.total >= 4 && (await req('GET', '/api/admin/leads?q=msp%20co', { auth: true })).data.total === 1 && (await req('GET', '/api/admin/leads?q=wait%40msp', { auth: true })).data.total === 1);
t('search treats SQL and wildcard characters as plain text', (await req('GET', "/api/admin/leads?q=' OR 1=1 --", { auth: true })).data.total === 0 && (await req('GET', '/api/admin/leads?q=%25', { auth: true })).data.total === 0);
const today = new Date().toISOString().slice(0, 10), tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10), lastYear = `${new Date().getUTCFullYear() - 1}-01-01`;
t('date range: today..today includes today\'s leads; a future-only range finds none', (await req('GET', `/api/admin/leads?from=${today}&to=${today}`, { auth: true })).data.total === list.total && (await req('GET', `/api/admin/leads?from=${tomorrow}`, { auth: true })).data.total === 0 && (await req('GET', `/api/admin/leads?from=${lastYear}&to=${lastYear}`, { auth: true })).data.total === 0);
t('filter by framework works', (await req('GET', '/api/admin/leads?framework=COBIT', { auth: true })).data.leads.every((l) => l.framework === 'COBIT'));

// statistics (the shape the admin page reads, plus the original nested shape)
r = await req('GET', '/api/admin/stats', { auth: true });
const s = r.data;
t('stats: headline figures are at the top level as numbers', typeof s.total === 'number' && s.total === list.total && typeof s.avgScore === 'number' && s.avgScore > 0 && s.pipelineCurrency === 'ZAR');
t('stats: breakdowns are { name: count } maps (what the admin page renders)', s.byRegion && !Array.isArray(s.byRegion) && s.byRegion.US === 1 && s.byRegion.ZA >= 1 && s.byStatus.New >= 1 && s.byType.quote === 3 && s.byFramework['ISO 27001'] >= 1);
t('stats: the pipeline adds only server-computed ZAR estimates (23,288 + 38,813 + 1,200 = 63,301)', s.pipelineLow === 63301 && s.pipelineHigh === 33767 + 56278 + 1740, `${s.pipelineLow}/${s.pipelineHigh}`);
t('stats: the original nested shape is still there', Array.isArray(s.stats.regions) && s.stats.total === s.total);

// status changes
const target = (await req('GET', '/api/admin/leads?q=wait%40msp', { auth: true })).data.leads[0];
r = await req('PATCH', `/api/admin/leads/${target.id}`, { auth: true, json: { lead_status: 'Qualified' } });
t('status change using the admin page\'s own payload ({lead_status}) works', r.status === 200 && r.data.status === 'Qualified', r.text);
let after = (await req('GET', '/api/admin/leads?q=wait%40msp', { auth: true })).data.leads[0];
t('...and is kept, with an updated timestamp', after.lead_status === 'Qualified' && !!after.updated_at && after.updated_at >= target.updated_at);
r = await req('PATCH', `/api/admin/leads/${target.id}`, { auth: true, json: { status: 'Won' } });
t('the older {status} payload is still accepted', r.status === 200 && r.data.status === 'Won');
t('status filter finds it', (await req('GET', '/api/admin/leads?status=Won', { auth: true })).data.total === 1);
r = await req('PATCH', `/api/admin/leads/${target.id}`, { auth: true, json: { lead_status: 'Banana' } });
t('an invalid status is refused (400)', r.status === 400);
r = await req('PATCH', '/api/admin/leads/does-not-exist', { auth: true, json: { lead_status: 'Won' } });
t('a status change for a lead that does not exist reports 404, not false success', r.status === 404 && r.data.ok === false);
r = await req('PATCH', `/api/admin/leads/${target.id}`, { auth: true, raw: 'nope' });
t('a status change with a broken body is refused (400)', r.status === 400);

// CSV export
await req('POST', '/api/leads', { json: assess({ name: '=HYPERLINK("http://evil.example","click")', email: 'csv@smallco.co.za', framework: 'GRC' }) });
r = await req('GET', '/api/admin/leads.csv', { auth: true });
const lines = r.text.split('\r\n');
t('CSV export: downloads as text/csv with a header row including consent columns', r.status === 200 && /text\/csv/.test(h('content-type') || '') && /attachment/.test(h('content-disposition') || '') && lines[0].includes('Consent given') && lines[0].includes('Estimate low (ZAR)'));
t('CSV export: one row per lead', lines.length - 1 === (await req('GET', '/api/admin/leads', { auth: true })).data.total);
t('CSV export: spreadsheet formulas are neutralised (cell starts with an apostrophe)', r.text.includes(`"'=HYPERLINK(`) || r.text.includes("'=HYPERLINK("));
r = await req('GET', '/api/admin/leads.csv?type=quote', { auth: true });
t('CSV export honours the filters', r.text.split('\r\n').length - 1 === 3);

// erasure
const gone = (await req('GET', '/api/admin/leads?q=csv%40smallco', { auth: true })).data.leads[0];
r = await req('DELETE', `/api/admin/leads/${gone.id}`, { auth: true });
t('erasure: a lead can be permanently deleted', r.status === 200 && r.data.ok);
t('...it is gone from the list', (await req('GET', '/api/admin/leads?q=csv%40smallco', { auth: true })).data.total === 0);
r = await req('DELETE', `/api/admin/leads/${gone.id}`, { auth: true });
t('...and deleting it again reports 404', r.status === 404);

// audit trail
r = await req('GET', '/api/admin/audit', { auth: true });
const acts = r.data.entries.map((e) => e.action);
t('audit trail records status changes, the export and the deletion', ['status_change', 'export_csv', 'delete'].every((a) => acts.includes(a)), acts.join());
t('audit entries contain no personal data (names, emails)', !/@|Thandi|HYPERLINK/.test(JSON.stringify(r.data.entries)));

const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed} passed, ${failed} failed, ${results.length} checks`);
process.exit(failed ? 1 : 0);
