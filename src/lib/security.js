// Request hygiene: client address handling, rate limiting, constant-time admin authentication, response headers.
const enc = new TextEncoder();

export const clientIp = (request) => request.headers.get('cf-connecting-ip') || 'unknown';

// Addresses are stored only as a salted hash, in short-lived counters (cleared within a day).
export async function hashKey(value, env) {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(`${env.RATE_LIMIT_SALT || ''}|${value}`));
  return [...new Uint8Array(buf)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Fixed-window counter in D1. Counts this attempt, then reports whether the limit has been exceeded.
export async function rateHit(db, key, limit, windowSec) {
  const now = Math.floor(Date.now() / 1000);
  await db.prepare(
    `INSERT INTO rate_limits (key, count, window_start) VALUES (?1, 1, ?2)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN ?2 - window_start >= ?3 THEN 1 ELSE count + 1 END,
       window_start = CASE WHEN ?2 - window_start >= ?3 THEN ?2 ELSE window_start END`
  ).bind(key, now, windowSec).run();
  const row = await db.prepare('SELECT count, window_start FROM rate_limits WHERE key = ?').bind(key).first();
  await db.prepare('DELETE FROM rate_limits WHERE window_start < ?').bind(now - 86400).run();
  return { blocked: row.count > limit, retryAfter: Math.max(1, windowSec - (now - row.window_start)) };
}

export const rateCheck = async (db, key, limit, windowSec) => {
  const now = Math.floor(Date.now() / 1000);
  const row = await db.prepare('SELECT count, window_start FROM rate_limits WHERE key = ?').bind(key).first();
  if (!row || now - row.window_start >= windowSec || row.count < limit) return { blocked: false };
  return { blocked: true, retryAfter: Math.max(1, windowSec - (now - row.window_start)) };
};
export const rateClear = (db, key) => db.prepare('DELETE FROM rate_limits WHERE key = ?').bind(key).run();

// Compare two strings without leaking, through timing, how much of them matched.
async function safeEqual(a, b) {
  const [ha, hb] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  const x = new Uint8Array(ha), y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

// Returns 'none' (no credentials sent), 'bad', or 'ok'.
export async function checkAdmin(request, env) {
  const auth = request.headers.get('Authorization');
  if (!auth || !auth.startsWith('Basic ')) return 'none';
  if (!env.ADMIN_PASSWORD) return 'bad';
  try {
    const decoded = atob(auth.slice(6));
    const i = decoded.indexOf(':');
    if (i === -1) return 'bad';
    const userOk = await safeEqual(decoded.slice(0, i), env.ADMIN_USERNAME || 'admin');
    const passOk = await safeEqual(decoded.slice(i + 1), env.ADMIN_PASSWORD);
    return userOk && passOk ? 'ok' : 'bad';
  } catch { return 'bad'; }
}

export const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

export function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...BASE_HEADERS, ...extra },
  });
}

// CSV cells that start with = + - @ are treated as formulas by spreadsheet programs; neutralise them.
export function csvCell(v) {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
