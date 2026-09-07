'use strict';

const os = require('node:os');

/**
 * Best-effort detection of this machine's primary LAN IPv4 address.
 * Prefers common private ranges and typical Wi-Fi/Ethernet interface names,
 * and falls back to the first non-internal IPv4, then to loopback.
 */
function detectLanIPv4() {
  const ifaces = os.networkInterfaces();
  const candidates = [];

  for (const name of Object.keys(ifaces)) {
    for (const net of ifaces[name] || []) {
      // Node <18 reports family as 'IPv4'; newer versions may use the number 4.
      const isV4 = net.family === 'IPv4' || net.family === 4;
      if (!isV4 || net.internal) continue;
      candidates.push({ name, address: net.address });
    }
  }

  if (candidates.length === 0) return '127.0.0.1';

  const isPrivate = (a) =>
    a.startsWith('192.168.') ||
    a.startsWith('10.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(a);
  const preferredName = (n) => /^(en0|eth0|wlan0|wlp|enp|Wi-Fi|Ethernet)/i.test(n);

  candidates.sort((a, b) => {
    const score = (c) => (isPrivate(c.address) ? 2 : 0) + (preferredName(c.name) ? 1 : 0);
    return score(b) - score(a);
  });

  return candidates[0].address;
}

/** Every address that belongs to THIS machine (loopback + all interfaces). */
function localAddresses() {
  const set = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const net of ifaces[name] || []) {
      if (net && net.address) set.add(net.address);
    }
  }
  return set;
}

module.exports = { detectLanIPv4, localAddresses };
