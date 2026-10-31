'use strict';

const fs = require('node:fs');
const { execFile } = require('node:child_process');
const config = require('./config');

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

  // POSIX df: "Filesystem 1024-blocks Used Available Capacity Mounted on"
  const out = await run('df', ['-Pk', dir]);
  const line = out && out.trim().split('\n').pop();
  const kb = line && Number(line.trim().split(/\s+/)[3]);
  return Number.isFinite(kb) && kb >= 0 ? kb * 1024 : null;
}

/** Free bytes on the uploads disk, or null when it can't be determined. */
async function freeBytes() {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.bytes;
  const bytes = await measure(config.uploadDir);
  cached = { at: Date.now(), bytes };
  return bytes;
}

/**
 * The most an upload may write right now: the configured cap, further limited
 * so the disk keeps its reserve. Returns 0 when there is no room at all, and
 * the plain cap when free space is unknown.
 */
async function uploadAllowance() {
  const free = await freeBytes();
  if (free == null) return config.maxUploadBytes;
  return Math.max(0, Math.min(config.maxUploadBytes, free - config.minFreeBytes));
}

/** Forget the cached reading — call after an upload lands or a file is freed. */
function invalidate() { cached = null; }

module.exports = { freeBytes, uploadAllowance, invalidate, fromStatfs };
