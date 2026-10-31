'use strict';

const store = require('./store');

// ---------------------------------------------------------------------------
// What happened on the hub, for the host: devices joining and leaving the
// approved list, renames, blocks, refused uploads, wrong codes. Kept in the
// metadata file (the last 300 entries) and shown in the host console.
//
// Noisy events — a wrong code, a refused upload — are logged at most once per
// minute per kind and address, with a count, so a flood can't wash the rest
// of the log away.
// ---------------------------------------------------------------------------

const QUIET_MS = 60 * 1000;
const recent = new Map(); // `${type}|${ip}` -> the entry being counted

/**
 * Record an event. `text` is shown as written; `ip` is for the host's eyes
 * only (the console already shows addresses).
 */
function log(type, text, { ip = null, noisy = false } = {}) {
  const at = Date.now();
  if (noisy) {
    const key = `${type}|${ip}`;
    const prev = recent.get(key);
    if (prev && at - prev.at < QUIET_MS) {
      prev.count = (prev.count || 1) + 1;
      store.persist();
      return;
    }
    if (recent.size > 1000) recent.clear();
    const entry = { at, type, text, ip, count: 1 };
    recent.set(key, entry);
    store.addActivity(entry);
    return;
  }
  store.addActivity({ at, type, text, ip });
}

module.exports = { log };
