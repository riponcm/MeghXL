'use strict';

const os = require('node:os');
const net = require('node:net');
const config = require('./config');

// ---------------------------------------------------------------------------
// Did this request come from a page MeghXL itself served?
//
// Admin access is decided from the TCP peer (admin-auth.js). Another machine
// cannot fake that, but a website can *borrow* it: a page open in a browser on
// the host PC makes that browser send requests to 127.0.0.1, and they arrive
// from loopback like any other. Three attacks follow from that:
//
//   DNS rebinding — the attacker re-points their domain at 127.0.0.1, so their
//   page counts as same-origin with MeghXL and can read responses. Every such
//   request still names the attacker's domain in Host. → isAllowedHost()
//
//   CSRF — a cross-site <form> or fetch fires a request whose response the page
//   cannot read, but whose side effect still happens. Browsers label these with
//   Origin and Sec-Fetch-Site. → isSameOrigin(), on anything that changes state.
//
//   Clickjacking — the attacker frames MeghXL's own console and tricks a click;
//   the click runs our own same-origin script, so the checks above can't see it.
//   → every response forbids framing.
//
// Admin additionally requires the hub to be named by an address or one of this
// machine's own names (isAdminHost): a device on the LAN can answer mDNS/LLMNR
// for arbitrary .local or single-label names, so those are fine for the public
// board but must not reach the console.
// ---------------------------------------------------------------------------

// Name suffixes no public DNS server answers for. A rebinding attacker on the
// internet needs a name they can publish in public DNS, so a name under one of
// these can never be theirs. (.local is mDNS; .localhost/.test are reserved by
// RFC 6761; .internal and .home.arpa are reserved for private use; .home/.corp
// are withheld by ICANN; .lan and .localdomain are undelegated router defaults.)
// Deliberately NOT here: .ts.net, .fritz.box, mshome.net and similar — those
// are real, registered domains, and listing them would reopen rebinding.
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

/** A configured host: a bare name ("hub.example.com:8443") or a full URL. */
function parseConfiguredHost(entry) {
  const s = String(entry || '').trim();
  if (!s) return null;
  if (s.includes('://')) {
    try { return hostnameOf(new URL(s).hostname); } catch { return null; }
  }
  return hostnameOf(s);
}

// Hostnames the operator has told us about: PUBLIC_BASE_URL (already required
// for links and QR codes behind a proxy) plus anything in ALLOWED_HOSTS.
// Entries that don't parse are reported at startup rather than silently dropped.
const explicitHosts = (() => {
  const set = new Set();
  const add = (source, value) => {
    const h = parseConfiguredHost(value);
    if (h) set.add(h);
    else console.warn(`[meghxl] Ignoring ${source} entry ${JSON.stringify(value)}: not a host name or URL.`);
  };
  if (config.publicBaseUrl) add('PUBLIC_BASE_URL', config.publicBaseUrl);
  for (const entry of (process.env.ALLOWED_HOSTS || '').split(',')) {
    if (entry.trim()) add('ALLOWED_HOSTS', entry.trim());
  }
  return set;
})();

/**
 * True when a request naming this hostname cannot be a DNS-rebinding attack
 * from the internet. Used for every route.
 *
 * IP literals always pass: rebinding needs a domain name, so a Host that is an
 * address was never produced by one. (This is also why Docker and port-forward
 * setups, where the browser's address is not one of this machine's own, keep
 * working.) Single-label names and names under PRIVATE_SUFFIXES resolve only on
 * the local network, never from an attacker's public DNS.
 */
function isAllowedHost(hostname) {
  if (!hostname) return false;
  if (net.isIP(hostname)) return true;
  if (!hostname.includes('.')) return true;
  if (PRIVATE_SUFFIXES.some((s) => hostname === s || hostname.endsWith('.' + s))) return true;
  return explicitHosts.has(hostname);
}

/** This machine's own names, read fresh (DHCP can rename a Mac mid-run). */
function ownNames() {
  const names = new Set();
  if (config.mdnsName) names.add(`${config.mdnsName}.local`);
  const full = hostnameOf(os.hostname());
  if (full) {
    const short = full.split('.')[0];
    names.add(full);
    names.add(short);
    names.add(`${short}.local`);
  }
  return names;
}

/**
 * Stricter than isAllowedHost, for the IP-based admin grants: the hub must be
 * named by an address, localhost, or one of this machine's own names.
 *
 * Other LAN devices can answer mDNS/LLMNR lookups for arbitrary .local or
 * single-label names, so they could otherwise rebind such a name to this
 * machine and ride the host browser's loopback trust. They can't answer for
 * `*.localhost` (browsers resolve it to loopback themselves) or for this
 * machine's own name as seen from this machine. PUBLIC_BASE_URL and
 * ALLOWED_HOSTS are deliberately excluded: a request arriving through a proxy
 * under its public name is a remote user, whatever socket it came in on.
 */
function isAdminHost(hostname) {
  if (!hostname) return false;
  if (net.isIP(hostname)) return true;
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
  return ownNames().has(hostname);
}

// When a browser says "same-origin" but we refuse the request anyway, the cause
// is almost always a proxy rewriting Host. Say so once per pair, in the log.
const reportedMismatches = new Set();
function reportMismatch(origin, host) {
  const key = `${origin} → ${host}`;
  if (reportedMismatches.has(key) || reportedMismatches.size > 50) return;
  reportedMismatches.add(key);
  console.warn(`[meghxl] Refused a same-origin write from ${origin} to Host "${host}". ` +
    'If MeghXL sits behind a reverse proxy, preserve the Host header or set PUBLIC_BASE_URL.');
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
  const host = String(req.headers.host || '').toLowerCase();
  if (parsed.host === host) return true;

  const originName = hostnameOf(parsed.hostname);
  // A TLS proxy may drop the port from Host (nginx `$host`). The browser's own
  // Sec-Fetch-Site: same-origin — which page script cannot forge — settles it,
  // provided the names still match.
  if (site === 'same-origin' && originName && originName === hostnameOf(host)) return true;
  // Behind a proxy that rewrites Host, the browser's origin is the proxy's
  // public name — accept it only if the operator named it.
  if (originName && explicitHosts.has(originName)) return true;

  if (site === 'same-origin') reportMismatch(parsed.origin, host);
  return false;
}

/**
 * Express middleware, first in the chain: forbid framing, refuse rebinding on
 * every route, and refuse cross-site writes.
 */
function requestGuard(req, res, next) {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');

  const hostname = hostnameOf(req.headers.host);
  if (!isAllowedHost(hostname)) {
    // Echo the name back (it helps the operator fix their config), but only
    // when it is plainly a host name.
    const named = hostname && /^[a-z0-9.:-]{1,253}$/.test(hostname) ? ` "${hostname}"` : '';
    return res
      .status(403)
      .type('text/plain')
      .send(`Unrecognised host${named}. If you reach MeghXL by this name, add it to ALLOWED_HOSTS ` +
        '(comma-separated), or set PUBLIC_BASE_URL if MeghXL sits behind a proxy.');
  }
  if (STATE_CHANGING.has(req.method) && !isSameOrigin(req)) {
    return res.status(403).json({ error: 'Cross-site request refused.' });
  }
  next();
}

/** The same host and origin checks for a WebSocket handshake, which bypasses Express. */
function isAllowedUpgrade(req) {
  return isAllowedHost(hostnameOf(req.headers.host)) && isSameOrigin(req);
}

module.exports = {
  requestGuard,
  isAllowedUpgrade,
  isAllowedHost,
  isAdminHost,
  isSameOrigin,
  hostnameOf,
};
