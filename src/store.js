'use strict';

const fs = require('node:fs');
const config = require('./config');

const MAX_NOTES = 100;
const WRITE_DEBOUNCE_MS = 150;
const CONSUMED_TTL_MS = 60 * 60 * 1000; // keep a one-time "Gone" tombstone for 1h
// Remembered device names. Every new device id adds one, so the table is
// capped and old entries age out — otherwise a script inventing ids could grow
// metadata.json (rewritten in full on every save) without limit.
const MAX_DEVICE_NAMES = 1000;
const DEVICE_NAME_TTL_MS = 90 * 24 * 60 * 60 * 1000;
// An IP block covers whoever holds that address *now*. DHCP hands addresses
// out again, so after a day it would only catch an innocent device; the block
// on the device itself stays.
const IP_BLOCK_TTL_MS = 24 * 60 * 60 * 1000;

// Maps keyed by client-supplied strings have no prototype, so a token like
// "__proto__" or "constructor" is just a missing key, not Object.prototype.
const dict = (src) => Object.assign(Object.create(null), src || {});
const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

const empty = () => ({
  files: dict(),
  notes: [],
  deviceNames: dict(),
  deviceSeen: dict(),
  blocked: [],
  announcements: [],
  settings: {},
  adminKey: null,
  join: null,
});

let state = empty();
let writeTimer = null;
let writing = false;
let writeAgain = false;
let tmpSeq = 0;

const now = () => Date.now();
const isExpired = (f) => f.expiresAt != null && f.expiresAt <= now();

/** Load metadata from disk into memory (call once at startup). */
function load() {
  let raw;
  try {
    raw = fs.readFileSync(config.dataFile, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`[store] could not read ${config.dataFile}: ${err.message} — starting fresh`);
    state = empty();
    return state;
  }
  try {
    const parsed = JSON.parse(raw);
    const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
    state = {
      files: dict(obj(parsed && parsed.files)),
      notes: parsed && Array.isArray(parsed.notes) ? parsed.notes : [],
      deviceNames: dict(obj(parsed && parsed.deviceNames)),
      deviceSeen: dict(obj(parsed && parsed.deviceSeen)),
      blocked: parsed && Array.isArray(parsed.blocked) ? parsed.blocked : [],
      announcements: parsed && Array.isArray(parsed.announcements) ? parsed.announcements : [],
      settings: obj(parsed && parsed.settings) || {},
      adminKey: parsed && typeof parsed.adminKey === 'string' ? parsed.adminKey : null,
      join: obj(parsed && parsed.join),
    };
    pruneDeviceNames();
  } catch (err) {
    // Keep the damaged file for inspection instead of overwriting it on the
    // next save — it holds every share link and the admin key.
    const aside = `${config.dataFile}.corrupt-${Date.now()}`;
    try { fs.renameSync(config.dataFile, aside); } catch { /* ignore */ }
    console.warn(`[store] ${config.dataFile} is damaged (${err.message}); moved it to ${aside} and started fresh`);
    state = empty();
  }
  // The file holds the admin key: readable by this user only.
  try { fs.chmodSync(config.dataFile, 0o600); } catch { /* not there yet, or not supported */ }
  return state;
}

/** Debounced atomic persist: write to a tmp file, then rename into place. */
function persist() {
  if (writeTimer) return;
  writeTimer = setTimeout(doWrite, WRITE_DEBOUNCE_MS);
  if (writeTimer.unref) writeTimer.unref();
}

async function doWrite() {
  writeTimer = null;
  if (writing) {
    writeAgain = true;
    return;
  }
  writing = true;
  const tmp = `${config.dataFile}.${process.pid}.${++tmpSeq}.tmp`;
  try {
    await fs.promises.writeFile(tmp, JSON.stringify(state), { mode: 0o600 });
    await fs.promises.rename(tmp, config.dataFile);
  } catch (err) {
    console.error(`[store] write failed: ${err.message}`);
    fs.promises.unlink(tmp).catch(() => {});
  } finally {
    writing = false;
    if (writeAgain) {
      writeAgain = false;
      persist();
    }
  }
}

/** Synchronous flush — used on shutdown so nothing is lost. */
function flushSync() {
  const tmp = `${config.dataFile}.${process.pid}.${++tmpSeq}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(tmp, config.dataFile);
  } catch (err) {
    console.error(`[store] flush failed: ${err.message}`);
  }
}

// ---- files ----------------------------------------------------------------

function addFile(meta) {
  state.files[meta.token] = meta;
  persist();
  return meta;
}

function getFile(token) {
  return has(state.files, token) ? state.files[token] : null;
}

function listPublicFiles() {
  return Object.values(state.files)
    .filter((f) => f.visibility === 'public' && !isExpired(f) && !f.consumed)
    .sort((a, b) => b.createdAt - a.createdAt);
}

function removeFile(token) {
  if (!has(state.files, token)) return null;
  const f = state.files[token];
  delete state.files[token];
  persist();
  return f;
}

/**
 * Remove expired files and stale one-time tombstones from metadata.
 * Returns the removed records (caller unlinks their disk files).
 */
function sweepExpired() {
  const removed = [];
  const t = now();
  for (const f of Object.values(state.files)) {
    const staleTombstone = f.consumed && f.consumedAt && t - f.consumedAt > CONSUMED_TTL_MS;
    if (isExpired(f) || staleTombstone) {
      delete state.files[f.token];
      removed.push(f);
    }
  }
  if (removed.length) persist();
  return removed;
}

// ---- notes ----------------------------------------------------------------

function addNote(note) {
  state.notes.unshift(note);
  if (state.notes.length > MAX_NOTES) state.notes.length = MAX_NOTES;
  persist();
  return note;
}

function listNotes() {
  return state.notes;
}

function removeNote(id) {
  const i = state.notes.findIndex((n) => n.id === id);
  if (i === -1) return null;
  const [note] = state.notes.splice(i, 1);
  persist();
  return note;
}

// ---- device names (remembered across restarts) ----------------------------

function getDeviceName(id) {
  return has(state.deviceNames, id) ? state.deviceNames[id] : null;
}

function setDeviceName(id, name) {
  state.deviceNames[id] = name;
  state.deviceSeen[id] = now();
  pruneDeviceNames();
  persist();
}

/** Note that a device was here, so its name doesn't age out while in use. */
function touchDevice(id) {
  if (!has(state.deviceNames, id)) return;
  const t = now();
  // Day resolution is plenty for a 90-day expiry and keeps saves rare.
  if (t - (state.deviceSeen[id] || 0) > 24 * 60 * 60 * 1000) {
    state.deviceSeen[id] = t;
    persist();
  }
}

function pruneDeviceNames() {
  const cutoff = now() - DEVICE_NAME_TTL_MS;
  const ids = Object.keys(state.deviceNames);
  for (const id of ids) {
    if ((state.deviceSeen[id] || 0) < cutoff && state.deviceSeen[id] !== undefined) {
      delete state.deviceNames[id];
      delete state.deviceSeen[id];
    }
  }
  const left = Object.keys(state.deviceNames);
  if (left.length > MAX_DEVICE_NAMES) {
    left.sort((a, b) => (state.deviceSeen[a] || 0) - (state.deviceSeen[b] || 0));
    for (const id of left.slice(0, left.length - MAX_DEVICE_NAMES)) {
      delete state.deviceNames[id];
      delete state.deviceSeen[id];
    }
  }
}

// ---- blocked devices (persistent) -----------------------------------------

function listBlocked() {
  return state.blocked;
}
function isBlocked(deviceId, ip) {
  const t = now();
  return state.blocked.some(
    (b) => (deviceId && b.deviceId === deviceId) ||
      (ip && b.ip && b.ip === ip && t - (b.at || 0) < IP_BLOCK_TTL_MS)
  );
}
function addBlock(entry) {
  if (!state.blocked.some((b) => b.deviceId === entry.deviceId)) {
    state.blocked.unshift(entry);
    persist();
  }
  return entry;
}
function removeBlock(deviceId) {
  const before = state.blocked.length;
  state.blocked = state.blocked.filter((b) => b.deviceId !== deviceId);
  if (state.blocked.length !== before) persist();
}

// ---- announcements (persistent) -------------------------------------------

function listAnnouncements() {
  return state.announcements;
}
function latestAnnouncement() {
  return state.announcements[0] || null;
}
function addAnnouncement(a) {
  state.announcements.unshift(a);
  if (state.announcements.length > 50) state.announcements.length = 50;
  persist();
  return a;
}
function clearAnnouncements() {
  state.announcements = [];
  persist();
}

// ---- settings / admin key / all-files -------------------------------------

function getSettings() {
  return state.settings;
}
function setSettings(partial) {
  Object.assign(state.settings, partial);
  persist();
  return state.settings;
}
function getAdminKey() {
  return state.adminKey;
}
function setAdminKey(k) {
  state.adminKey = k;
  persist();
}
function getJoin() {
  return state.join;
}
function setJoin(j) {
  state.join = j;
  persist();
}
function listAllFiles() {
  return Object.values(state.files);
}
function clearAllFiles() {
  const all = Object.values(state.files);
  state.files = dict();
  persist();
  return all;
}

module.exports = {
  load,
  persist,
  flushSync,
  isExpired,
  addFile,
  getFile,
  listPublicFiles,
  removeFile,
  sweepExpired,
  addNote,
  listNotes,
  removeNote,
  getDeviceName,
  setDeviceName,
  touchDevice,
  listBlocked,
  isBlocked,
  addBlock,
  removeBlock,
  listAnnouncements,
  latestAnnouncement,
  addAnnouncement,
  clearAnnouncements,
  getSettings,
  setSettings,
  getAdminKey,
  setAdminKey,
  getJoin,
  setJoin,
  listAllFiles,
  clearAllFiles,
};
