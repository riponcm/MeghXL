'use strict';

const crypto = require('node:crypto');
const store = require('./store');

// ---------------------------------------------------------------------------
// Private mode: only invited devices can use the hub.
//
// Off by default — at home everyone on the Wi-Fi is welcome. On a shared
// network (café, office, hotel) the host switches it on, and a device must
// first join with either:
//   - the invite link / QR code, which carries a 128-bit secret in the URL
//     *fragment* (#join=…) — fragments are never sent to a server, so it stays
//     out of logs and proxies; the page posts it once and drops it, or
//   - a 6-digit code typed by hand, with attempts rate-limited per IP.
// Joining sets an HttpOnly, SameSite=Strict cookie. The host computer never
// needs to join, and /d/ download links keep working without it — their
// 128-bit token is already the permission.
//
// Limits, stated plainly: this keeps strangers out; it does not encrypt
// anything. Over plain HTTP someone able to intercept traffic on the network
// could still copy a cookie. "New code" revokes every device at once.
// ---------------------------------------------------------------------------

const COOKIE = 'meghxl_join';
const MAX_SESSIONS = 500;
const COOKIE_MAX_AGE = 365 * 24 * 60 * 60;

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function fresh() {
  return {
    secret: crypto.randomBytes(16).toString('base64url'),
    code: String(crypto.randomInt(0, 1000000)).padStart(6, '0'),
    sessions: {}, // sha256(session token) -> issued at
  };
}

function current() {
  let j = store.getJoin();
  if (!j || typeof j.secret !== 'string' || typeof j.code !== 'string') {
    j = fresh();
    store.setJoin(j);
  }
  if (!j.sessions || typeof j.sessions !== 'object') j.sessions = {};
  return j;
}

const isEnabled = () => store.getSettings().privateMode === true;

function equal(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** True when `secret` (from an invite link) or `code` (typed) is right. */
function check({ secret, code }) {
  const j = current();
  if (typeof secret === 'string' && secret) return equal(secret, j.secret);
  if (typeof code === 'string' && code) return equal(code.replace(/\s+/g, ''), j.code);
  return false;
}

/** Issue a session and return its Set-Cookie value. */
function issueSession(secure) {
  const j = current();
  const tokenValue = crypto.randomBytes(32).toString('base64url');
  j.sessions[sha(tokenValue)] = Date.now();
  const keys = Object.keys(j.sessions);
  if (keys.length > MAX_SESSIONS) {
    keys.sort((a, b) => j.sessions[a] - j.sessions[b]);
    for (const k of keys.slice(0, keys.length - MAX_SESSIONS)) delete j.sessions[k];
  }
  store.setJoin(j);
  return `${COOKIE}=${tokenValue}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE}${secure ? '; Secure' : ''}`;
}

function cookieValue(req) {
  const header = String(req.headers.cookie || '');
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i !== -1 && part.slice(0, i).trim() === COOKIE) return part.slice(i + 1).trim();
  }
  return null;
}

/** Does this request carry a valid session? */
function hasSession(req) {
  const v = cookieValue(req);
  if (!v) return false;
  return Object.prototype.hasOwnProperty.call(current().sessions, sha(v));
}

/** New secret and code; every device that joined before must join again. */
function rotate() {
  const j = fresh();
  store.setJoin(j);
  return j;
}

// Requests a device may make before it has joined: the page itself and its
// assets (so it can show the join screen), joining, health, the admin-only
// API (which checks admin on its own), and /d/ links (capabilities already).
const OPEN_API = new Set(['/api/health', '/api/join', '/api/join/status', '/api/admin/whoami']);
function isOpenPath(req) {
  const p = req.path;
  if (p.startsWith('/d/') || p.startsWith('/api/admin/') || OPEN_API.has(p)) return true;
  return req.method === 'GET' && !p.startsWith('/api/');
}

/**
 * Express middleware, after the request guard. In private mode, everything
 * else needs a session — or the host. `isAdmin` is passed in to keep this
 * module free of the admin code.
 */
function gate(isAdmin) {
  return (req, res, next) => {
    if (!isEnabled() || isOpenPath(req) || hasSession(req) || isAdmin(req)) return next();
    res.status(401).json({ error: 'This hub is private. Scan the host\'s invite QR code or enter its code to join.', join: true });
  };
}

module.exports = { COOKIE, isEnabled, check, issueSession, hasSession, rotate, current, gate };
