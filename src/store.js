'use strict';

const fs = require('node:fs');
const config = require('./config');

const MAX_NOTES = 100;
const WRITE_DEBOUNCE_MS = 150;
const CONSUMED_TTL_MS = 60 * 60 * 1000; // keep a one-time "Gone" tombstone for 1h

let state = {
  files: {},
  notes: [],
  deviceNames: {},
  blocked: [],
  announcements: [],
  settings: {},
  adminKey: null,
};
let writeTimer = null;
let writing = false;
let writeAgain = false;

const now = () => Date.now();
const isExpired = (f) => f.expiresAt != null && f.expiresAt <= now();

/** Load metadata from disk into memory (call once at startup). */
function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(config.dataFile, 'utf8'));
    const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
    state = {
      files: obj(parsed && parsed.files) || {},
      notes: parsed && Array.isArray(parsed.notes) ? parsed.notes : [],
      deviceNames: obj(parsed && parsed.deviceNames) || {},
      blocked: parsed && Array.isArray(parsed.blocked) ? parsed.blocked : [],
      announcements: parsed && Array.isArray(parsed.announcements) ? parsed.announcements : [],
      settings: obj(parsed && parsed.settings) || {},
      adminKey: parsed && typeof parsed.adminKey === 'string' ? parsed.adminKey : null,
    };
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[store] could not read ${config.dataFile}: ${err.message} — starting fresh`);
    }
    state = { files: {}, notes: [], deviceNames: {}, blocked: [], announcements: [], settings: {}, adminKey: null };
  }
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
  const tmp = config.dataFile + '.tmp';
  try {
    await fs.promises.writeFile(tmp, JSON.stringify(state, null, 2));
    await fs.promises.rename(tmp, config.dataFile);
  } catch (err) {
    console.error(`[store] write failed: ${err.message}`);
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
  const tmp = config.dataFile + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
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
  return state.files[token] || null;
}

function listPublicFiles() {
  return Object.values(state.files)
    .filter((f) => f.visibility === 'public' && !isExpired(f) && !f.consumed)
    .sort((a, b) => b.createdAt - a.createdAt);
}

function removeFile(token) {
  const f = state.files[token];
  if (!f) return null;
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
  return state.deviceNames[id] || null;
}

function setDeviceName(id, name) {
  state.deviceNames[id] = name;
  persist();
}

// ---- blocked devices (persistent) -----------------------------------------

function listBlocked() {
  return state.blocked;
}
function isBlocked(deviceId, ip) {
  return state.blocked.some(
    (b) => (deviceId && b.deviceId === deviceId) || (ip && b.ip && b.ip === ip)
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
function listAllFiles() {
  return Object.values(state.files);
}
function clearAllFiles() {
  const all = Object.values(state.files);
  state.files = {};
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
  listAllFiles,
  clearAllFiles,
};
