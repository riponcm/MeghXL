'use strict';

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const mime = require('mime-types');

const config = require('../config');
const store = require('../store');
const qr = require('../qr');
const disk = require('../disk');
const crypto = require('node:crypto');
const { token, storedName } = require('../ids');
const { uploadWithin, decodeOriginalName } = require('../uploads');
const { shareDownloadUrl } = require('../baseUrl');
const { isAdmin } = require('../admin-auth');
const { deviceOf, handleOf, sameId, remoteIp } = require('../identity');
const { cleanText, cleanFilename } = require('../text');
const { classify, inSentence } = require('../filetype');
const { rateLimit, createCounter } = require('../limits');
const activity = require('../activity');

const fmtMb = (bytes) => (bytes >= 1024 * 1024 * 1024
  ? `${+(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB` : `${Math.round(bytes / (1024 * 1024))} MB`);

/** The response for an upload stopped by a limit (see disk.uploadAllowance). */
function limitError({ reason, cap }) {
  if (reason === 'budget') {
    return { status: 507, why: 'storage budget full',
      error: "The hub's storage limit is full. Ask the host to delete some files or raise the limit." };
  }
  if (reason === 'disk') {
    return { status: 507, why: 'host disk nearly full',
      error: "The host computer is running out of disk space, so it can't take this file right now." };
  }
  return { status: 413, why: 'file too large', error: `File too large — the limit on this hub is ${fmtMb(cap)}.` };
}

const VALID_VISIBILITY = new Set(['public', 'private']);
const MAX_EXPIRY_MINUTES = 7 * 24 * 60; // 7 days
const TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;
// Files MeghXL itself wrote (see storedName in ids.js) — the only ones the
// orphan sweep may ever delete, whatever else lives in the uploads folder.
const STORED_NAME_RE = /^[0-9a-f]{32}(\.[a-z0-9]{1,12})?$/;
const ORPHAN_AGE_MS = 60 * 60 * 1000;
const MAX_UPLOADS_PER_IP = 4;
const MAX_UPLOADS_TOTAL = 32;

/** Resolve a stored file's absolute path, refusing anything outside uploadDir. */
function storedPath(storedName) {
  const p = path.resolve(config.uploadDir, storedName);
  const root = path.resolve(config.uploadDir) + path.sep;
  return p.startsWith(root) ? p : null;
}

function unlinkQuiet(storedName) {
  const p = storedPath(storedName);
  if (p) fs.promises.unlink(p).catch(() => {});
}

/**
 * Public-facing shape for a file. `downloadUrl` is correct for the requesting
 * client (direct HTTP responses); browsers also recompute links/QRs from their
 * own origin, so broadcasts stay correct across different devices.
 */
function toPublicShape(f) {
  return {
    token: f.token,
    originalName: f.originalName,
    size: f.size,
    mime: f.mime,
    visibility: f.visibility,
    createdAt: f.createdAt,
    expiresAt: f.expiresAt,
    oneTime: f.oneTime,
    downloadCount: f.downloadCount,
    fromName: f.fromName || null,
    fromHost: !!f.fromHost,
    // Lets the device that shared it (and only that one) recognise it as its
    // own and offer Delete. A handle, never the device id — see identity.js.
    ownerHandle: handleOf(f.ownerId) || null,
    risk: f.risk || null,
    downloadUrl: shareDownloadUrl(f.token),
  };
}

/** RFC 5987 Content-Disposition with a safe ASCII fallback (no header injection). */
function contentDisposition(name) {
  const fallback = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'download';
  // encodeURIComponent leaves ' ( ) * alone; RFC 5987 doesn't allow them raw.
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/**
 * Answer an upload before reading its body. A client still sending often sees
 * a reset connection instead of the answer unless the body is read — so read
 * and discard small ones; for big ones, answer and hang up (the dashboard
 * checks the limit before it starts, so a person rarely gets here).
 */
const DRAIN_LIMIT = 64 * 1024 * 1024;
function refuseEarly(req, res, status, error, declared) {
  if (Number.isFinite(declared) && declared <= DRAIN_LIMIT) {
    // Read (and drop) the rest, then answer: the client finishes sending and
    // is listening by the time the answer comes.
    let answered = false;
    const answer = () => { if (!answered) { answered = true; res.status(status).json({ error }); } };
    req.on('end', answer);
    req.on('error', () => {});
    req.resume();
    return;
  }
  res.setHeader('Connection', 'close');
  res.status(status).json({ error });
}

function unlinkPath(p) {
  if (p) fs.promises.unlink(p).catch(() => {});
}

module.exports = function createFilesRouter(hub) {
  const router = express.Router();
  const uploadsInFlight = createCounter(MAX_UPLOADS_PER_IP);
  const uploadsTotal = createCounter(MAX_UPLOADS_TOTAL);
  // Bytes promised to uploads still in progress. Free space doesn't show them
  // yet, so without this several uploads at once could each take the whole
  // allowance and overrun the disk reserve together.
  let reservedBytes = 0;
  // Uploads announce themselves to everyone; this keeps a script from
  // flooding every screen (and the metadata file) with tiny files.
  // The host is exempt: it may well share a folder's worth at once.
  const uploadLimiter = rateLimit({ burst: 30, perMinute: 60, keyOf: remoteIp,
    message: 'Too many uploads too quickly — wait a moment.' });
  const uploadRate = (req, res, next) => (isAdmin(req) ? next() : uploadLimiter(req, res, next));

  // Anything that isn't shaped like one of our tokens is simply not found —
  // including "__proto__" and friends, which never reach the store.
  router.param('token', (req, res, next, value) => {
    if (!TOKEN_RE.test(value)) return res.status(404).type('text/plain').send('Not found');
    next();
  });

  /** Remove a file (metadata + disk); broadcast removal if it was public. */
  function purgeFile(tok) {
    const f = store.removeFile(tok);
    if (!f) return null;
    unlinkQuiet(f.storedName);
    if (f.visibility === 'public') hub.broadcast('file-removed', { token: f.token });
    return f;
  }

  /**
   * Burn a one-time link: free the disk file but keep a small tombstone so the
   * link returns "410 Gone" (not a bare 404). The sweep drops tombstones later.
   */
  function consumeOneTime(tok) {
    const f = store.getFile(tok);
    if (!f || f.consumedAt) return;
    unlinkQuiet(f.storedName);
    f.consumed = true;
    f.consumedAt = Date.now();
    store.persist();
    if (f.visibility === 'public') hub.broadcast('file-removed', { token: f.token });
  }

  /** Remove all expired files; returns how many were removed. */
  function purgeExpired() {
    const removed = store.sweepExpired();
    for (const f of removed) {
      unlinkQuiet(f.storedName);
      if (f.visibility === 'public') hub.broadcast('file-removed', { token: f.token });
    }
    if (removed.length) disk.invalidate();
    return removed.length;
  }

  /**
   * Delete upload files no record points to — left behind when the process
   * died mid-write or a metadata save failed. Only names MeghXL generates, and
   * only ones older than an hour, so an upload in progress is never touched.
   */
  async function cleanOrphans() {
    const known = new Set(store.listAllFiles().map((f) => f.storedName));
    let names = [];
    try { names = await fs.promises.readdir(config.uploadDir); } catch { return 0; }
    let removed = 0;
    for (const name of names) {
      if (!STORED_NAME_RE.test(name) || known.has(name)) continue;
      const p = storedPath(name);
      try {
        const st = await fs.promises.stat(p);
        if (!st.isFile() || Date.now() - st.mtimeMs < ORPHAN_AGE_MS) continue;
        await fs.promises.unlink(p);
        removed++;
      } catch { /* gone already */ }
    }
    // Pieces of uploads that were in progress when the server last stopped.
    try {
      for (const name of await fs.promises.readdir(partialDir)) {
        const p = path.join(partialDir, name);
        const st = await fs.promises.stat(p);
        if (!sessions.has(name) && Date.now() - st.mtimeMs > ORPHAN_AGE_MS) { await fs.promises.unlink(p); removed++; }
      }
    } catch { /* none */ }
    return removed;
  }

  // GET /api/qr?text=... — a QR PNG for arbitrary text, so each client renders
  // links for its OWN origin. Pure encoding, no fetching (no SSRF surface).
  // Rendering costs CPU, so it's rate-limited like any other write-ish route.
  const qrLimit = rateLimit({ burst: 60, perMinute: 120, keyOf: remoteIp });
  router.get('/api/qr', qrLimit, async (req, res) => {
    const text = String(req.query.text || '');
    if (!text || text.length > 1024) return res.status(400).type('text/plain').send('bad text');
    try {
      const png = await qr.toBuffer(text);
      res.setHeader('Content-Type', 'image/png');
      // An invite QR carries the join secret, so nothing is kept in a cache.
      res.setHeader('Cache-Control', 'no-store');
      res.send(png);
    } catch {
      res.status(500).end();
    }
  });

  // POST /api/upload --------------------------------------------------------
  // Before a byte is stored: a few uploads at a time per address, and only as
  // much as the disk can take while keeping its reserve (see src/disk.js).
  async function admitUpload(req, res, next) {
    const ip = remoteIp(req);
    if (!uploadsInFlight.tryAcquire(ip)) {
      return res.status(429).json({ error: 'Too many uploads at once from this device — wait for one to finish.' });
    }
    if (!uploadsTotal.tryAcquire('all')) {
      uploadsInFlight.release(ip);
      return res.status(503).json({ error: 'The hub is busy with other uploads — try again in a moment.' });
    }
    let reserved = 0;
    res.on('close', () => {
      uploadsInFlight.release(ip);
      uploadsTotal.release('all');
      reservedBytes -= reserved;
    });

    const host = isAdmin(req);
    const { bytes: allowance, reason } = await disk.uploadAllowance(host, () => reservedBytes);
    req.meghxlLimit = { reason, bytes: allowance, cap: disk.fileCap(host) };
    const declared = Number(req.headers['content-length']);
    // multipart adds a little around the file; allow for it before refusing.
    const tooBig = Number.isFinite(declared) && declared > allowance + 1024 * 1024;
    if (allowance <= 0 || tooBig) {
      const r = limitError(req.meghxlLimit);
      if (allowance <= 0 || reason !== 'cap') activity.log('upload-refused', `Refused an upload: ${r.why}`, { ip, noisy: true });
      return refuseEarly(req, res, r.status, r.error, declared);
    }
    // Hold what this upload says it will send (browsers always say); one that
    // doesn't say gets the rest of the allowance and holds all of it.
    reserved = Number.isFinite(declared) && declared > 0 ? Math.min(declared, allowance) : allowance;
    if (Number.isFinite(reserved)) reservedBytes += reserved;
    else reserved = 0; // no cap and free space unknown: nothing to hold
    uploadWithin(allowance).single('file')(req, res, next);
  }

  /**
   * Turn a file that has fully arrived into a share: name it, label or refuse
   * programs, record it, announce it. Used by both upload paths. `fields` are
   * the sender's options (visibility, to, expiry, one-time). Returns false if
   * it answered with an error (and removed the file).
   */
  function finalize(req, res, { filePath, fileName, size, rawName, fields }) {
    disk.invalidate();
    const admin = isAdmin(req);
    const deviceId = deviceOf(req);

    const oneTime = fields.oneTime === true || fields.oneTime === 'true' || fields.oneTime === 'on';

    let expiresAt = null;
    const mins = parseInt(fields.expiresInMinutes, 10);
    if (Number.isFinite(mins) && mins > 0) {
      expiresAt = Date.now() + Math.min(mins, MAX_EXPIRY_MINUTES) * 60 * 1000;
    }

    // A `to` (a device's handle) means a direct, device-to-device send: not
    // listed anywhere, delivered only to that device's live sockets.
    const to = cleanText(fields.to, 40);
    let toDeviceId = null;
    if (to) {
      toDeviceId = hub.idOfHandle(to);
      if (!toDeviceId) {
        unlinkPath(filePath);
        res.status(404).json({ error: 'That device is no longer connected.' });
        return false;
      }
    }
    // Who shared it — shown on the dashboard ("by <name>") and on direct sends.
    // Taken from the hub's own record of the sending device, never from the
    // request, so nobody can send as someone else (or as the host).
    const fromName = admin ? 'Host'
      : (deviceId && (hub.nameOfId(deviceId) || store.getDeviceName(deviceId))) || (to ? 'Someone' : null);
    let visibility = 'private';
    if (to) {
      visibility = 'direct';
      // Honor a user-set expiry; otherwise self-clean after 24h.
      if (expiresAt == null) expiresAt = Date.now() + 24 * 60 * 60 * 1000;
    } else if (VALID_VISIBILITY.has(fields.visibility)) {
      visibility = fields.visibility;
    }

    // Apply the host's default expiry (Settings) when the upload didn't set one.
    if (visibility !== 'direct' && expiresAt == null) {
      const def = parseInt(store.getSettings().defaultExpiryMinutes, 10);
      if (Number.isFinite(def) && def > 0) {
        expiresAt = Date.now() + Math.min(def, MAX_EXPIRY_MINUTES) * 60 * 1000;
      }
    }

    const originalName = cleanFilename(rawName);

    // Programs, scripts, installers — and anything whose content contradicts
    // its name. Labelled for everyone; refused if the host has said so.
    const verdict = classify(filePath, originalName, size);
    if (verdict && store.getSettings().blockPrograms === true && !admin) {
      unlinkPath(filePath);
      const what = verdict.quiet ? "archives it can't look inside" : `programs (${inSentence(verdict.label)})`;
      activity.log('upload-refused', `Refused “${originalName}”: ${verdict.quiet ? "archive it can't look inside" : inSentence(verdict.label)}`, { ip: remoteIp(req), noisy: true });
      res.status(415).json({ error: `This hub doesn't accept ${what}. Ask the host if you need to share one.` });
      return false;
    }
    // Quiet verdicts ("couldn't look inside") only matter to the setting above.
    const risk = verdict && !verdict.quiet ? verdict : null;

    const meta = {
      token: token(),
      originalName,
      storedName: fileName,
      size,
      // From the name, never the sender's claim — and nothing that would
      // invite a browser to treat a program as something else.
      mime: risk ? 'application/octet-stream' : (mime.lookup(originalName) || 'application/octet-stream'),
      visibility,
      createdAt: Date.now(),
      expiresAt,
      oneTime,
      downloadCount: 0,
      uploader: remoteIp(req),
      ownerId: deviceId,
      toDeviceId,
      fromName,
      fromHost: admin,
      risk,
    };
    store.addFile(meta);

    const shape = toPublicShape(meta);
    if (visibility === 'public') {
      hub.broadcast('file-added', shape);
    } else if (visibility === 'direct') {
      hub.sendToDevice(to, 'file-sent', shape);
    }
    res.json(shape);
    return true;
  }

  // One request with the whole file (multipart). Simple, and what scripts and
  // older pages use; a phone that locks its screen loses the lot, which is
  // what the resumable path below is for.
  router.post('/api/upload', uploadRate, admitUpload, (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    finalize(req, res, {
      filePath: req.file.path,
      fileName: req.file.filename,
      size: req.file.size,
      rawName: decodeOriginalName(req.file.originalname),
      fields: req.body,
    });
  });

  // ---- resumable uploads ------------------------------------------------------
  // A file goes up in pieces. If the connection drops — a phone locking its
  // screen, Wi-Fi changing — the page asks how much arrived and carries on
  // from there instead of starting again.
  //
  //   POST   /api/upload/start          { name, size, …options } → { uploadId, chunkSize }
  //   PUT    /api/upload/:id?offset=N   the next piece (raw bytes)
  //   GET    /api/upload/:id            { received, size } — where to resume
  //   POST   /api/upload/:id/finish     the file is complete: share it
  //   DELETE /api/upload/:id            give up; the partial file is removed
  //
  // The upload id is a 128-bit secret held by the sending page. The size is
  // checked against the limits (and its disk space held) when the upload
  // starts, not after it has crept onto the disk.

  const CHUNK_MAX = 8 * 1024 * 1024;
  const SESSION_IDLE_MS = 24 * 60 * 60 * 1000;
  const MAX_SESSIONS_PER_IP = 8;
  const MAX_SESSIONS = 64;
  const UPLOAD_ID_RE = /^u_[0-9a-f]{32}$/;
  const partialDir = path.join(config.uploadDir, '.partial');
  fs.mkdirSync(partialDir, { recursive: true });
  const sessions = new Map();

  function dropSession(s, removeFile = true) {
    sessions.delete(s.id);
    reservedBytes -= s.reserved;
    s.reserved = 0;
    if (removeFile) unlinkPath(s.path);
  }

  router.param('uploadId', (req, res, next, value) => {
    const s = UPLOAD_ID_RE.test(value) && sessions.get(value);
    if (!s) return res.status(404).json({ error: 'That upload has ended — start it again.', gone: true });
    s.touchedAt = Date.now();
    req.uploadSession = s;
    next();
  });

  router.post('/api/upload/start', uploadRate, async (req, res) => {
    const body = req.body || {};
    const size = Number(body.size);
    const name = typeof body.name === 'string' ? body.name : '';
    if (!Number.isSafeInteger(size) || size < 0 || !name) return res.status(400).json({ error: 'Missing file name or size' });
    const ip = remoteIp(req);
    const mine = [...sessions.values()].filter((x) => x.ip === ip).length;
    if (mine >= MAX_SESSIONS_PER_IP || sessions.size >= MAX_SESSIONS) {
      return res.status(429).json({ error: 'Too many uploads at once — wait for one to finish.' });
    }
    if (body.to && !hub.idOfHandle(cleanText(body.to, 40))) {
      return res.status(404).json({ error: 'That device is no longer connected.' });
    }
    const host = isAdmin(req);
    const { bytes: allowance, reason } = await disk.uploadAllowance(host, () => reservedBytes);
    if (size > allowance) {
      const r = limitError({ reason, cap: disk.fileCap(host) });
      if (reason !== 'cap') activity.log('upload-refused', `Refused an upload: ${r.why}`, { ip, noisy: true });
      return res.status(r.status).json({ error: r.error });
    }
    const id = 'u_' + crypto.randomBytes(16).toString('hex');
    const s = {
      id, ip, size, name,
      path: path.join(partialDir, id),
      received: 0,
      reserved: size,
      writing: false,
      touchedAt: Date.now(),
      fields: { visibility: body.visibility, to: body.to, expiresInMinutes: body.expiresInMinutes, oneTime: body.oneTime },
    };
    try { fs.writeFileSync(s.path, '', { mode: 0o600 }); } catch { return res.status(500).json({ error: 'Server error' }); }
    reservedBytes += size;
    sessions.set(id, s);
    res.json({ uploadId: id, chunkSize: CHUNK_MAX, received: 0 });
  });

  router.get('/api/upload/:uploadId', (req, res) => {
    const s = req.uploadSession;
    res.setHeader('Cache-Control', 'no-store');
    res.json({ received: s.received, size: s.size });
  });

  router.put('/api/upload/:uploadId', (req, res) => {
    const s = req.uploadSession;
    const offset = Number(req.query.offset);
    const length = Number(req.headers['content-length']);
    // Pieces arrive in order, one at a time; anything else is told where to
    // resume from. A piece is only counted once all of it has arrived, so a
    // cut-off piece is simply sent again.
    if (s.writing || offset !== s.received) return res.status(409).json({ received: s.received });
    if (!Number.isSafeInteger(length) || length <= 0 || length > CHUNK_MAX || offset + length > s.size) {
      return res.status(400).json({ error: 'Bad piece size' });
    }
    s.writing = true;
    let got = 0;
    const out = fs.createWriteStream(s.path, { flags: 'r+', start: offset });
    const done = (ok) => {
      if (!s.writing) return;
      s.writing = false;
      if (ok && got === length) {
        s.received += length;
        // Now on disk, so no longer held in reserve.
        const freed = Math.min(length, s.reserved);
        s.reserved -= freed;
        reservedBytes -= freed;
        disk.invalidate();
      }
    };
    req.on('data', (chunk) => {
      got += chunk.length;
      if (got > length) { req.destroy(); out.destroy(); done(false); }
    });
    req.on('aborted', () => { out.destroy(); done(false); });
    req.on('error', () => { out.destroy(); done(false); });
    out.on('error', () => { done(false); if (!res.headersSent) res.status(500).json({ error: 'Could not write the file' }); });
    out.on('finish', () => {
      done(true);
      if (!res.headersSent) res.json({ received: s.received });
    });
    req.pipe(out);
  });

  router.post('/api/upload/:uploadId/finish', (req, res) => {
    const s = req.uploadSession;
    if (s.writing || s.received !== s.size) return res.status(409).json({ received: s.received, error: 'Not all of the file has arrived yet' });
    const fileName = storedName(s.name);
    const dest = path.join(config.uploadDir, fileName);
    try { fs.renameSync(s.path, dest); } catch { return res.status(500).json({ error: 'Could not store the file' }); }
    dropSession(s, false);
    finalize(req, res, { filePath: dest, fileName, size: s.size, rawName: s.name, fields: s.fields });
  });

  router.delete('/api/upload/:uploadId', (req, res) => {
    dropSession(req.uploadSession);
    res.json({ ok: true });
  });

  // Uploads abandoned for a day are given up; their space is freed.
  const sessionSweep = setInterval(() => {
    const cutoff = Date.now() - SESSION_IDLE_MS;
    for (const s of sessions.values()) if (s.touchedAt < cutoff && !s.writing) dropSession(s);
  }, 10 * 60 * 1000);
  if (sessionSweep.unref) sessionSweep.unref();

  // GET /api/files — public, non-expired only -------------------------------
  router.get('/api/files', (req, res) => {
    res.json({ files: store.listPublicFiles().map((f) => toPublicShape(f)) });
  });

  // GET /d/:token — download (public or private) ----------------------------
  router.get('/d/:token', (req, res) => {
    const f = store.getFile(req.params.token);
    if (!f) return res.status(404).type('text/plain').send('Not found');

    if (store.isExpired(f)) {
      purgeFile(f.token);
      return res.status(404).type('text/plain').send('This link has expired');
    }
    if (f.oneTime && (f.consumed || f.downloadCount > 0)) {
      return res.status(410).type('text/plain').send('This one-time link has already been used');
    }

    const p = storedPath(f.storedName);
    if (!p) return res.status(404).type('text/plain').send('Not found');

    let stat;
    try {
      stat = fs.statSync(p);
    } catch {
      purgeFile(f.token);
      return res.status(404).type('text/plain').send('Not found');
    }

    res.setHeader('Content-Type', f.mime || 'application/octet-stream');
    res.setHeader('Content-Disposition', contentDisposition(f.originalName));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Even if some browser rendered an upload instead of saving it, it would run
    // with no script, no origin and no framing — and other sites can't embed it.
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; frame-ancestors 'none'");
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'no-store');

    const total = stat.size;
    // One-time links are served whole (no range) so a probe can't burn them and
    // a multi-range fetch can't double-consume; mark consumed up front.
    const range = f.oneTime ? null : req.headers.range;
    let stream;
    let countsAsDownload = true;

    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (!m || (m[1] === '' && m[2] === '')) {
        res.setHeader('Content-Range', `bytes */${total}`);
        return res.status(416).end();
      }
      let start = m[1] === '' ? total - parseInt(m[2], 10) : parseInt(m[1], 10);
      let end = m[2] === '' ? total - 1 : parseInt(m[2], 10);
      start = Math.max(0, start);
      end = Math.min(end, total - 1);
      if (Number.isNaN(start) || Number.isNaN(end) || start > end) {
        res.setHeader('Content-Range', `bytes */${total}`);
        return res.status(416).end();
      }
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
      res.setHeader('Content-Length', end - start + 1);
      countsAsDownload = end === total - 1; // count once, on the final chunk
      stream = fs.createReadStream(p, { start, end });
    } else {
      res.status(200);
      res.setHeader('Content-Length', total);
      stream = fs.createReadStream(p);
    }

    // HEAD asks about a file without fetching it — link previewers do this.
    // Answer with the headers only, and don't let it burn a one-time link.
    if (req.method === 'HEAD') {
      stream.destroy();
      return res.end();
    }

    if (f.oneTime) {
      f.consumed = true;
      store.persist();
    }

    stream.on('error', () => {
      if (!res.headersSent) res.status(500);
      res.end();
    });

    res.on('finish', () => {
      if (!countsAsDownload) return;
      const cur = store.getFile(f.token);
      if (cur) {
        cur.downloadCount = (cur.downloadCount || 0) + 1;
        store.persist();
      }
    });

    // For one-time files, burn the link once the response is done (whether it
    // completed or the client aborted after consuming it).
    if (f.oneTime) res.on('close', () => consumeOneTime(f.token));

    stream.pipe(res);
  });

  // DELETE /api/files/:token ------------------------------------------------
  // Only the device that shared a file, or the host, may delete it.
  router.delete('/api/files/:token', (req, res) => {
    const f = store.getFile(req.params.token);
    if (!f) return res.status(404).json({ error: 'Not found' });
    if (!isAdmin(req) && !sameId(deviceOf(req), f.ownerId)) {
      return res.status(403).json({ error: 'Only the device that shared this file, or the host, can delete it.' });
    }
    purgeFile(f.token);
    disk.invalidate();
    res.json({ ok: true });
  });

  return { router, purgeFile, purgeExpired, cleanOrphans, limitError };
};
