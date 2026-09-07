'use strict';

const config = require('./config');
const runtime = require('./runtime');
const { localAddresses } = require('./network');

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

// Admin = the machine running MeghXL (every browser on it), OR a PC designated
// by ADMIN_IP, OR a request carrying the ADMIN_KEY. This gates the host console
// AND going public (the most consequential action), so a random LAN device
// can't expose the whole server to the internet.
function isAdmin(req) {
  if (isLoopbackHost(req)) return true;
  if (config.adminIps.length && config.adminIps.includes(clientIp(req))) return true;
  if (runtime.adminKey && (req.get('x-admin-key') || req.query.key) === runtime.adminKey) return true;
  return false;
}

function requireAdmin(req, res, next) {
  if (isAdmin(req)) return next();
  return res.status(403).json({
    error: 'This action is restricted to the host computer (or an ADMIN_IP device / the admin key).',
    yourIp: clientIp(req),
  });
}

module.exports = { isLoopbackHost, clientIp, isAdmin, requireAdmin };
