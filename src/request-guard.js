'use strict';

const net = require('node:net');
const config = require('./config');

// ---------------------------------------------------------------------------
// Did this request come from a page MeghXL itself served?
//
// Admin access is decided from the TCP peer (admin-auth.js). Another machine
// cannot fake that, but a website can *borrow* it: a page open in a browser on
// the host PC makes that browser send requests to 127.0.0.1, and they arrive
// from loopback like any other. Two attacks follow from that, and one check
// closes each.
//
//   DNS rebinding — the attacker re-points their domain at 127.0.0.1, so their
//   page counts as same-origin with MeghXL and can read responses. Every such
//   request still names the attacker's domain in Host. → isAllowedHost()
//
//   CSRF — a cross-site <form> or fetch fires a request whose response the page
//   cannot read, but whose side effect still happens. Browsers label these with
//   Origin and Sec-Fetch-Site. → isSameOrigin(), on anything that changes state.
// ---------------------------------------------------------------------------

// Name suffixes no public DNS server answers for. A rebinding attacker needs a
// name they can publish in public DNS, so a name under one of these can never
// be theirs. (.local is mDNS; .localhost/.test are reserved by RFC 6761;
// .internal and .home.arpa are reserved for private use; .home/.corp are
// withheld by ICANN; .lan and .localdomain are undelegated router defaults.)
const PRIVATE_SUFFIXES = [
  'localhost', 'local', 'test', 'internal', 'home.arpa',
  'home', 'corp', 'lan', 'localdomain',
];

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * The lower-cased hostname from a Host header value — "host", "host:port",
 * "[v6]" or "[v6]:port" — or null if it is malformed. A trailing dot is
 * dropped, since "meghxl.local." and "meghxl.local" are the same name.
 */
function hostnameOf(value) {
  if (typeof value !== 'string') return null;
  let h = value.trim().toLowerCase();
  if (!h || /[\s@/\\,?#]/.test(h)) return null;

  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    if (end === -1) return null;
    const rest = h.slice(end + 1);
    if (rest && !/^:\d{1,5}$/.test(rest)) return null;
    const v6 = h.slice(1, end);
    return net.isIPv6(v6) ? v6 : null;
  }

  // More than one colon and no brackets: only valid as a bare IPv6 literal.
  if ((h.match(/:/g) || []).length > 1) return net.isIPv6(h) ? h : null;

  const colon = h.indexOf(':');
  if (colon !== -1) {
    if (!/^\d{1,5}$/.test(h.slice(colon + 1))) return null;
    h = h.slice(0, colon);
  }
  if (h.endsWith('.')) h = h.slice(0, -1);
  return h || null;
}

// Hostnames the operator has told us about: PUBLIC_BASE_URL (already required
// for links and QR codes behind a proxy) plus anything in ALLOWED_HOSTS.
const explicitHosts = (() => {
  const set = new Set();
  if (config.publicBaseUrl) {
    try { set.add(new URL(config.publicBaseUrl).hostname.toLowerCase()); } catch { /* ignore */ }
  }
  for (const entry of (process.env.ALLOWED_HOSTS || '').split(',')) {
    const h = hostnameOf(entry.trim());
    if (h) set.add(h);
  }
  return set;
})();

/**
 * True when a request naming this hostname cannot be a DNS-rebinding attack.
 *
 * IP literals always pass: rebinding needs a domain name, so a Host that is an
 * address was never produced by one. (This is also why Docker and port-forward
 * setups, where the browser's address is not one of this machine's own, keep
 * working.) Single-label names and names under PRIVATE_SUFFIXES resolve only
 * on the local network, never from an attacker's public DNS.
 */
function isAllowedHost(hostname) {
  if (!hostname) return false;
  if (net.isIP(hostname)) return true;
  if (!hostname.includes('.')) return true;
  if (PRIVATE_SUFFIXES.some((s) => hostname === s || hostname.endsWith('.' + s))) return true;
  return explicitHosts.has(hostname);
}

/**
 * True when a request was sent by a page from this same server, or by a client
 * that isn't a browser at all.
 *
 * Our own dashboard is always same-origin, so anything a browser labels
 * cross-site or same-site (another port or service on this machine) is refused,
 * as is Origin "null" (sandboxed frames, data: and file: pages). A request with
 * neither Origin nor Sec-Fetch-Site comes from curl, a script, or a browser too
 * old to send them — the same trust as any other device on the LAN.
 */
function isSameOrigin(req) {
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return false;

  const origin = req.headers.origin;
  if (origin === undefined) return true;

  let parsed;
  try { parsed = new URL(origin); } catch { return false; }
  if (parsed.origin === 'null') return false;

  // Compare against the raw Host header, never X-Forwarded-Host: a rebound
  // page can set X-Forwarded-* on its own requests.
  if (parsed.host === String(req.headers.host || '').toLowerCase()) return true;
  // Behind a proxy that rewrites Host, the browser's origin is the proxy's
  // public name — accept it only if the operator named it.
  return explicitHosts.has(parsed.hostname.toLowerCase());
}

/** Express middleware: refuse rebinding on every route, and CSRF on writes. */
function requestGuard(req, res, next) {
  if (!isAllowedHost(hostnameOf(req.headers.host))) {
    return res
      .status(403)
      .type('text/plain')
      .send('Unrecognised host. If you reach MeghXL through a hostname of your own, add it to ALLOWED_HOSTS.');
  }
  if (STATE_CHANGING.has(req.method) && !isSameOrigin(req)) {
    return res.status(403).json({ error: 'Cross-site request refused.' });
  }
  next();
}

/** The same two checks for a WebSocket handshake, which bypasses Express. */
function isAllowedUpgrade(req) {
  return isAllowedHost(hostnameOf(req.headers.host)) && isSameOrigin(req);
}

module.exports = { requestGuard, isAllowedUpgrade, isAllowedHost, isSameOrigin, hostnameOf };
