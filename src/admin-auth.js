'use strict';

const crypto = require('node:crypto');
const config = require('./config');
const runtime = require('./runtime');
const { localAddresses } = require('./network');
const { hostnameOf, isAdminHost } = require('./request-guard');

// True ONLY for a request that originates from the machine running the server —
// a raw loopback or own-interface connection with NO forwarding header. Every
// browser ON the host PC passes; any other device (its source IP isn't one of
// ours) does not. A proxied/forwarded request always carries such a header, so
// it can never satisfy this check. localAddresses() is read fresh each call so a
// DHCP/IP change can't lock out the host mid-run.
function isLoopbackHost(req) {
  if (req.headers['x-forwarded-for'] || req.headers['cf-connecting-ip']) return false;
  const raw = req.socket && req.socket.remoteAddress;
  if (!raw) return false;
  const bare = raw.replace(/^::ffff:/, '').replace(/%.*$/, '');
  if (bare === '127.0.0.1' || bare === '::1') return true;
  const local = localAddresses();
  return local.has(raw) || local.has(bare);
}

// The client's TCP peer IP. NOTE: behind a proxy this is the proxy, not the real
// client — used for diagnostics and device records only, never as the sole
// admin identity beyond an explicit ADMIN_IP match.
function clientIp(req) {
  const raw = (req.socket && req.socket.remoteAddress) || '';
  return raw.replace(/^::ffff:/, '').replace(/%.*$/, '');
}

// Constant-time comparison, so the key can't be recovered by timing responses.
function keyMatches(given) {
  if (!runtime.adminKey || typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(runtime.adminKey);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Wrong keys are counted per address; after MAX_KEY_FAILURES in the window,
// that address can't use a key at all until the window passes — even the
// right one. The key is long enough that guessing is hopeless anyway; this
// makes trying visible and pointless.
const MAX_KEY_FAILURES = 10;
const KEY_WINDOW_MS = 15 * 60 * 1000;
const keyFailures = new Map(); // ip -> { n, since }

function keyLocked(ip) {
  const f = keyFailures.get(ip);
  if (!f) return false;
  if (Date.now() - f.since > KEY_WINDOW_MS) { keyFailures.delete(ip); return false; }
  return f.n >= MAX_KEY_FAILURES;
}
function noteKeyFailure(ip) {
  const f = keyFailures.get(ip);
  if (!f || Date.now() - f.since > KEY_WINDOW_MS) keyFailures.set(ip, { n: 1, since: Date.now() });
  else if (++f.n === MAX_KEY_FAILURES) {
    require('./activity').log('key-locked', `${MAX_KEY_FAILURES} wrong admin keys — key login paused for 15 minutes from this address`, { ip });
  }
  if (keyFailures.size > 10000) keyFailures.clear(); // bounded, whatever happens
}

function keyGrants(req) {
  const given = req.headers['x-admin-key'];
  if (typeof given !== 'string' || !given) return false;
  const ip = clientIp(req);
  if (keyLocked(ip)) return false;
  if (keyMatches(given)) return true;
  noteKeyFailure(ip);
  return false;
}

// Admin = the machine running MeghXL (every browser on it), OR a PC designated
// by ADMIN_IP, OR a request carrying the ADMIN_KEY header.
//
// The loopback test only proves which *machine* sent a request, not which
// *page*: a website open on the host PC can make its browser call us too. The
// request guard (request-guard.js) rules those out before this runs — foreign
// Host headers (DNS rebinding), cross-site writes (CSRF) and framing
// (clickjacking). The IP-based grants below also require the hub to be named by
// an address or this machine's own name, so a LAN device answering mDNS for
// some other .local name can't rebind that name onto the host's trust.
//
// The key is read from a header only, never the query string, which would leave
// it in browser history, proxy logs and Referer headers. (The console still
// accepts /admin?key=… — admin.js moves it into a header and off the URL.)
function isAdmin(req) {
  // Several checks ask per request; answer once, so a wrong key counts once.
  if (req.meghxlAdmin === undefined) req.meghxlAdmin = decideAdmin(req);
  return req.meghxlAdmin;
}
function decideAdmin(req) {
  const namedByUs = isAdminHost(hostnameOf(req.headers.host));
  if (namedByUs && isLoopbackHost(req)) return true;
  if (namedByUs && config.adminIps.length && config.adminIps.includes(clientIp(req))) return true;
  // Read from headers directly: WebSocket upgrade requests aren't Express
  // requests, and this runs for those too.
  return keyGrants(req);
}

// A header only our own script sets. A browser can't attach a custom header to
// a cross-origin request without a CORS preflight, which this server never
// approves — so requiring it on admin writes blocks CSRF even from a browser
// that sends neither Origin nor Sec-Fetch-Site.
const ADMIN_WRITE_HEADER = 'x-meghxl-request';
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function requireAdmin(req, res, next) {
  if (WRITE_METHODS.has(req.method) && req.get(ADMIN_WRITE_HEADER) !== '1') {
    return res.status(403).json({ error: `Admin writes must send the ${ADMIN_WRITE_HEADER} header.` });
  }
  if (isAdmin(req)) return next();
  return res.status(403).json({
    error: 'This action is restricted to the host computer (or an ADMIN_IP device / the admin key).',
    yourIp: clientIp(req),
  });
}

module.exports = { isLoopbackHost, clientIp, isAdmin, requireAdmin, ADMIN_WRITE_HEADER };
