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

const MAX_REQUESTS = 100;
const MAX_ACTIVITY = 300;
const MAX_COMPUTER_NAMES = 500;

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
  approved: dict(), // device id -> approved at (when the host approves devices)
  requests: [], // waiting for the host: { id, type: 'device'|'rename', deviceId, … }
  activity: [], // newest first
  computerNames: dict(), // address -> { name, at }: one name per computer
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
      approved: dict(obj(parsed && parsed.approved)),
      requests: parsed && Array.isArray(parsed.requests) ? parsed.requests : [],
      activity: parsed && Array.isArray(parsed.activity) ? parsed.activity : [],
      computerNames: dict(obj(parsed && parsed.computerNames)),
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

/** Note that a device was here, so its name is the last to age out. */
function touchDevice(id) {
  if (!has(state.deviceNames, id)) return;
  const t = now();
  const before = state.deviceSeen[id] || 0;
  state.deviceSeen[id] = t; // in memory every time: eviction order stays true
  if (t - before > 60 * 60 * 1000) persist(); // on disk at most hourly
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
  // Blocks made before 1.0.2 (no `v`) keep their address forever, as they did
  // then: those devices get a new id on upgrade, so the address may be the
  // only thing still matching them.
  const ipStillHeld = (b) => b.v !== 2 || t - (b.at || 0) < IP_BLOCK_TTL_MS;
  return state.blocked.some(
    (b) => (deviceId && b.deviceId === deviceId) || (ip && b.ip && b.ip === ip && ipStillHeld(b))
  );
}
function addBlock(entry) {
  if (!state.blocked.some((b) => b.deviceId === entry.deviceId)) {
    state.blocked.unshift({ ...entry, v: 2 });
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
// ---- approvals, requests, activity, computer names -------------------------

function isApproved(id) {
  return !!id && has(state.approved, id);
}
function approve(id) {
  if (!id || has(state.approved, id)) return;
  state.approved[id] = now();
  persist();
}
function listRequests() {
  return state.requests;
}
/** Add a request, replacing any earlier one of the same type for the device. */
function addRequest(r) {
  state.requests = state.requests.filter((x) => !(x.type === r.type && x.deviceId === r.deviceId));
  state.requests.unshift(r);
  if (state.requests.length > MAX_REQUESTS) state.requests.length = MAX_REQUESTS;
  persist();
  return r;
}
function takeRequest(id) {
  const i = state.requests.findIndex((r) => r.id === id);
  if (i === -1) return null;
  const [r] = state.requests.splice(i, 1);
  persist();
  return r;
}
function dropRequests(deviceId) {
  const before = state.requests.length;
  state.requests = state.requests.filter((r) => r.deviceId !== deviceId);
  if (state.requests.length !== before) persist();
}
function addActivity(entry) {
  state.activity.unshift(entry);
  if (state.activity.length > MAX_ACTIVITY) state.activity.length = MAX_ACTIVITY;
  persist();
}
function listActivity() {
  return state.activity;
}
function getComputerName(key) {
  return has(state.computerNames, key) ? state.computerNames[key].name : null;
}
function setComputerName(key, name) {
  state.computerNames[key] = { name, at: now() };
  const keys = Object.keys(state.computerNames);
  if (keys.length > MAX_COMPUTER_NAMES) {
    keys.sort((a, b) => state.computerNames[a].at - state.computerNames[b].at);
    for (const k of keys.slice(0, keys.length - MAX_COMPUTER_NAMES)) delete state.computerNames[k];
  }
  persist();
}

// ---- backups and moves -------------------------------------------------------

// What a backup carries: the host's settings and decisions — never the files
// themselves (a move copies those separately), never the activity log.
const SNAPSHOT_KEYS = ['settings', 'blocked', 'announcements', 'join', 'approved', 'deviceNames', 'deviceSeen',
  'computerNames', 'notes', 'adminKey'];

function snapshot() {
  return JSON.parse(JSON.stringify(Object.fromEntries(SNAPSHOT_KEYS.map((k) => [k, state[k]]))));
}

/** Take settings and decisions from a backup or a previous host. */
function restoreSnapshot(snap) {
  if (!snap || typeof snap !== 'object') return;
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
  if (obj(snap.settings)) state.settings = snap.settings;
  if (Array.isArray(snap.blocked)) state.blocked = snap.blocked;
  if (Array.isArray(snap.announcements)) state.announcements = snap.announcements;
  if (Array.isArray(snap.notes)) state.notes = snap.notes.slice(0, MAX_NOTES);
  if (obj(snap.join)) state.join = snap.join;
  if (obj(snap.approved)) state.approved = dict(snap.approved);
  if (obj(snap.deviceNames)) state.deviceNames = dict(snap.deviceNames);
  if (obj(snap.deviceSeen)) state.deviceSeen = dict(snap.deviceSeen);
  if (obj(snap.computerNames)) state.computerNames = dict(snap.computerNames);
  if (typeof snap.adminKey === 'string') state.adminKey = snap.adminKey;
  pruneDeviceNames();
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
  snapshot,
  restoreSnapshot,
  isApproved,
  approve,
  listRequests,
  addRequest,
  takeRequest,
  dropRequests,
  addActivity,
  listActivity,
  getComputerName,
  setComputerName,
  listAllFiles,
  clearAllFiles,
};
