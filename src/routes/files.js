'use strict';

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const mime = require('mime-types');

const config = require('../config');
const store = require('../store');
const qr = require('../qr');
const disk = require('../disk');
const { token } = require('../ids');
const { uploadWithin, decodeOriginalName } = require('../uploads');
const { shareDownloadUrl } = require('../baseUrl');
const { isAdmin } = require('../admin-auth');
const { deviceOf, handleOf, sameId, remoteIp } = require('../identity');
const { cleanText, cleanFilename } = require('../text');
const { classify, inSentence } = require('../filetype');
const { rateLimit, createCounter } = require('../limits');

const VALID_VISIBILITY = new Set(['public', 'private']);
const MAX_EXPIRY_MINUTES = 7 * 24 * 60; // 7 days
const TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;
// Files MeghXL itself wrote (see storedName in ids.js) — the only ones the
// orphan sweep may ever delete, whatever else lives in the uploads folder.
const STORED_NAME_RE = /^[0-9a-f]{32}(\.[a-z0-9]{1,12})?$/;
const ORPHAN_AGE_MS = 60 * 60 * 1000;
const MAX_UPLOADS_PER_IP = 4;

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

function unlinkPath(p) {
  if (p) fs.promises.unlink(p).catch(() => {});
}

module.exports = function createFilesRouter(hub) {
  const router = express.Router();
  const uploadsInFlight = createCounter(MAX_UPLOADS_PER_IP);

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
      res.setHeader('Cache-Control', 'public, max-age=3600');
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
    res.on('close', () => uploadsInFlight.release(ip));

    const allowance = await disk.uploadAllowance();
    const spaceBound = allowance < config.maxUploadBytes;
    req.meghxlLimit = spaceBound ? 'disk' : 'cap';
    const declared = Number(req.headers['content-length']);
    if (allowance <= 0 || (spaceBound && Number.isFinite(declared) && declared > allowance + 1024 * 1024)) {
      return res.status(507).json({ error: "The host computer is running out of disk space, so it can't take this file right now." });
    }
    uploadWithin(allowance).single('file')(req, res, next);
  }

  router.post('/api/upload', admitUpload, (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    disk.invalidate();
    const admin = isAdmin(req);
    const deviceId = deviceOf(req);

    const oneTime = req.body.oneTime === 'true' || req.body.oneTime === 'on';

    let expiresAt = null;
    const mins = parseInt(req.body.expiresInMinutes, 10);
    if (Number.isFinite(mins) && mins > 0) {
      expiresAt = Date.now() + Math.min(mins, MAX_EXPIRY_MINUTES) * 60 * 1000;
    }

    // A `to` (a device's handle) means a direct, device-to-device send: not
    // listed anywhere, delivered only to that device's live sockets.
    const to = cleanText(req.body.to, 40);
    let toDeviceId = null;
    if (to) {
      toDeviceId = hub.idOfHandle(to);
      if (!toDeviceId) {
        unlinkPath(req.file.path);
        return res.status(404).json({ error: 'That device is no longer connected.' });
      }
    }
    // Who shared it — shown on the dashboard ("by <name>") and on direct sends.
    // Taken from the hub's own record of the sending device, never from the
    // request, so nobody can send as someone else (or as the host).
    const fromName = admin ? 'Host'
      : (deviceId && store.getDeviceName(deviceId)) || (to ? 'Someone' : null);
    let visibility = 'private';
    if (to) {
      visibility = 'direct';
      // Honor a user-set expiry; otherwise self-clean after 24h.
      if (expiresAt == null) expiresAt = Date.now() + 24 * 60 * 60 * 1000;
    } else if (VALID_VISIBILITY.has(req.body.visibility)) {
      visibility = req.body.visibility;
    }

    // Apply the host's default expiry (Settings) when the upload didn't set one.
    if (visibility !== 'direct' && expiresAt == null) {
      const def = parseInt(store.getSettings().defaultExpiryMinutes, 10);
      if (Number.isFinite(def) && def > 0) {
        expiresAt = Date.now() + Math.min(def, MAX_EXPIRY_MINUTES) * 60 * 1000;
      }
    }

    const originalName = cleanFilename(decodeOriginalName(req.file.originalname));

    // Programs, scripts, installers — and anything whose content contradicts
    // its name. Labelled for everyone; refused if the host has said so.
    const risk = classify(req.file.path, originalName, req.file.size);
    if (risk && store.getSettings().blockPrograms === true && !admin) {
      unlinkPath(req.file.path);
      return res.status(415).json({ error: `This hub doesn't accept programs (${inSentence(risk.label)}). Ask the host if you need to share one.` });
    }

    const meta = {
      token: token(),
      originalName,
      storedName: req.file.filename,
      size: req.file.size,
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
  });

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

  return { router, purgeFile, purgeExpired, cleanOrphans };
};
