'use strict';

const fs = require('node:fs');
const { execFile } = require('node:child_process');
const config = require('./config');
const store = require('./store');

// ---------------------------------------------------------------------------
// Free space on the disk that holds uploads/.
//
// Uploads have no size cap by default, so the guard is the disk itself: an
// upload is refused when it would leave less than MIN_FREE_MB free (5 GB by
// default). That keeps a stranger on the Wi-Fi from filling the host's system
// disk, while a 40 GB video still goes through on a disk that has room.
//
// fs.statfs is the obvious source, but the Bun runtime that powers the desktop
// app returns shifted fields on macOS (bsize 0, blocks 4096, …). So every
// answer is sanity-checked, with `df` (macOS/Linux) and PowerShell (Windows)
// as fallbacks. If nothing gives a believable number the guard steps aside
// rather than block every upload.
// ---------------------------------------------------------------------------

const CACHE_MS = 5000;
let cached = null; // { at, bytes }

function fromStatfs(s) {
  if (!s || !(s.bsize > 0) || !(s.blocks > 0) || s.bavail > s.blocks) return null;
  return s.bavail * s.bsize;
}

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 5000, windowsHide: true }, (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

async function measure(dir) {
  try {
    const bytes = fromStatfs(await fs.promises.statfs(dir));
    if (bytes != null) return bytes;
  } catch { /* fall through */ }

  if (process.platform === 'win32') {
    const lit = dir.replace(/'/g, "''");
    const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `(Get-Item -LiteralPath '${lit}').PSDrive.Free`]);
    const n = out && Number(out.trim());
    return Number.isFinite(n) && n >= 0 ? n : null;
  }

  // POSIX df: "Filesystem 1024-blocks Used Available Capacity Mounted on".
  // Filesystem and mount names can contain spaces ("map auto_home"), so find
  // the Capacity column ("85%") and take the number just before it.
  const out = await run('df', ['-Pk', dir]);
  const line = out && out.trim().split('\n').pop();
  const cols = line ? line.trim().split(/\s+/) : [];
  const cap = cols.findIndex((c, i) => i > 0 && /^\d+%$/.test(c));
  const kb = cap > 0 ? Number(cols[cap - 1]) : NaN;
  return Number.isFinite(kb) && kb >= 0 ? kb * 1024 : null;
}

/** Free bytes on the uploads disk, or null when it can't be determined. */
async function freeBytes() {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.bytes;
  const bytes = await measure(config.uploadDir);
  cached = { at: Date.now(), bytes };
  return bytes;
}

const MB = 1024 * 1024;

/**
 * The largest single file a device may share. MAX_UPLOAD_MB (set by whoever
 * runs the server) is a hard ceiling for everyone; the host console's limit
 * applies to the other devices — the host computer itself is never held to it.
 */
function fileCap(forHost) {
  const s = store.getSettings();
  const setting = !forHost && s.maxUploadMb > 0 ? s.maxUploadMb * MB : Infinity;
  return Math.min(config.maxUploadBytes, setting);
}

/** Bytes the hub holds in files right now. */
function storedBytes() {
  return store.listAllFiles()
    .filter((f) => !f.consumed && !store.isExpired(f))
    .reduce((sum, f) => sum + (f.size || 0), 0);
}

/**
 * The most an upload may write right now, and which limit decides it:
 *   'cap'    — the largest-file limit,
 *   'budget' — the host's total storage budget (other devices only),
 *   'disk'   — keeping MIN_FREE_MB free on the disk (everyone, host too).
 * `reserved()` returns what uploads already in progress have claimed: it
 * doesn't show in free space or stored bytes yet, but it will. It's a function
 * so it's read after the disk is measured — otherwise two uploads arriving
 * together would each count the other as not there.
 * `bytes` is 0 when there is no room at all; unknown free space is ignored.
 */
async function uploadAllowance(forHost = false, reservedNow = () => 0) {
  const free = await freeBytes();
  const reserved = reservedNow();
  let bytes = fileCap(forHost);
  let reason = 'cap';
  const budgetMb = store.getSettings().storageBudgetMb;
  if (!forHost && budgetMb > 0) {
    const left = Math.max(0, budgetMb * MB - storedBytes() - reserved);
    if (left < bytes) { bytes = left; reason = 'budget'; }
  }
  if (free != null) {
    const room = Math.max(0, free - config.minFreeBytes - reserved);
    if (room < bytes) { bytes = room; reason = 'disk'; }
  }
  return { bytes, reason };
}

/** Forget the cached reading — call after an upload lands or a file is freed. */
function invalidate() { cached = null; }

module.exports = { freeBytes, uploadAllowance, fileCap, storedBytes, invalidate, fromStatfs };
