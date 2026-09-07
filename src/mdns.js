'use strict';

let instance = null;

/**
 * Advertise the dashboard on the local network via mDNS/Bonjour so other
 * devices can reach it by a friendly name (e.g. http://meghxl.local:3000)
 * instead of an IP. Best-effort: if it fails (or mDNS is blocked on the
 * network), the IP + QR fallback still works.
 *
 * Returns true if advertising started.
 */
function start({ name, port }) {
  try {
    const { Bonjour } = require('bonjour-service');
    instance = new Bonjour();
    instance.publish({
      name: 'MeghXL',
      type: 'http',
      port,
      host: `${name}.local`,
      txt: { app: 'meghxl' },
    });
    return true;
  } catch (err) {
    console.warn(`[mdns] not advertising (${err.message}); use the IP/QR instead`);
    instance = null;
    return false;
  }
}

function stop() {
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

module.exports = { start, stop };
