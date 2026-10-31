'use strict';

const os = require('node:os');

let instance = null;
let browser = null;

/**
 * Advertise the dashboard on the local network via mDNS/Bonjour so other
 * devices can reach it by a friendly name (e.g. http://meghxl.local:3000)
 * instead of an IP. Best-effort: if it fails (or mDNS is blocked on the
 * network), the IP + QR fallback still works.
 *
 * Returns true if advertising started.
 */
function start({ name, port, id }) {
  try {
    const { Bonjour } = require('bonjour-service');
    instance = new Bonjour();
    instance.publish({
      name: 'MeghXL',
      type: 'http',
      port,
      host: `${name}.local`,
      // `id` is the host key's fingerprint, so the real host can tell its own
      // announcement from another machine's (see watch()).
      txt: { app: 'meghxl', ...(id ? { id } : {}) },
    });
    return true;
  } catch (err) {
    console.warn(`[mdns] not advertising (${err.message}); use the IP/QR instead`);
    instance = null;
    return false;
  }
}

/** This machine's own addresses, to ignore our own announcement. */
function ownAddresses() {
  const out = new Set();
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) out.add(a.address.replace(/%.*$/, ''));
  }
  return out;
}

/**
 * Why an announced service looks like a second hub, or null if it doesn't.
 * Only called for announcements from other machines (see watch). A matching
 * fingerprint proves nothing — it's public, so an impostor can copy it.
 */
function suspicion(svc, { name }) {
  const txt = svc.txt || {};
  if (txt.app === 'meghxl') return 'another-meghxl';
  if (String(svc.host || '').toLowerCase().replace(/\.$/, '') === `${name}.local`) return 'same-name';
  return null;
}

/**
 * Watch the network for anyone else claiming to be this hub: another MeghXL
 * announcing itself, or any service using our name (meghxl.local). There is
 * only one host; a second one is a mistake at best and an impostor at worst.
 * Calls `onImpostor({ address, name, reason })` once per address and reason.
 */
function watch({ name, onImpostor }) {
  if (!instance) return;
  const seen = new Set();
  const report = (svc, reason) => {
    const mine = ownAddresses();
    const addresses = (svc.addresses || []).filter((a) => !mine.has(a));
    if (!addresses.length) return; // our own announcement, or a loopback echo
    const key = `${addresses[0]}|${reason}`;
    if (seen.has(key)) return;
    seen.add(key);
    onImpostor({ address: addresses[0], name: svc.host || svc.name || '', reason });
  };
  try {
    browser = instance.find({ type: 'http' }, (svc) => {
      const reason = suspicion(svc, { name });
      if (reason) report(svc, reason);
    });
  } catch (err) {
    console.warn(`[mdns] can't watch for other hubs (${err.message})`);
  }
}

function stop() {
  if (browser) { try { browser.stop(); } catch { /* ignore */ } browser = null; }
  if (!instance) return;
  const inst = instance;
  instance = null;
  try {
    inst.unpublishAll(() => {
      try { inst.destroy(); } catch { /* ignore */ }
    });
  } catch {
    try { inst.destroy(); } catch { /* ignore */ }
  }
}

module.exports = { start, stop, watch, suspicion };
