'use strict';

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const mime = require('mime-types');

const config = require('../config');
const store = require('../store');
const qr = require('../qr');
const { token } = require('../ids');
const { upload, decodeOriginalName } = require('../uploads');
const { shareDownloadUrl } = require('../baseUrl');

const VALID_VISIBILITY = new Set(['public', 'private']);
const MAX_EXPIRY_MINUTES = 7 * 24 * 60; // 7 days

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
    downloadUrl: shareDownloadUrl(f.token),
  };
}

/** Strip control characters, trim, and cap length (for client-supplied fields). */
function sanitize(s, max) {
  let out = '';
  for (const ch of String(s == null ? '' : s)) if (ch.charCodeAt(0) >= 32) out += ch;
  return out.trim().slice(0, max);
}

/** RFC 5987 Content-Disposition with a safe ASCII fallback (no header injection). */
function contentDisposition(name) {
  const fallback = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'download';
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

module.exports = function createFilesRouter(hub) {
  const router = express.Router();

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
    return removed.length;
  }

  // GET /api/qr?text=... — a QR PNG for arbitrary text, so each client renders
  // links for its OWN origin. Pure encoding, no fetching (no SSRF surface).
  router.get('/api/qr', async (req, res) => {
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
  router.post('/api/upload', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const oneTime = req.body.oneTime === 'true' || req.body.oneTime === 'on';

    let expiresAt = null;
    const mins = parseInt(req.body.expiresInMinutes, 10);
    if (Number.isFinite(mins) && mins > 0) {
      expiresAt = Date.now() + Math.min(mins, MAX_EXPIRY_MINUTES) * 60 * 1000;
    }

    // A `to` (target deviceId) means a direct, device-to-device send: not listed
    // anywhere, delivered only to that device's live sockets.
    const to = sanitize(req.body.to, 64);
    // Who shared it — shown on the dashboard ("by <name>") and on direct sends.
    const fromName = sanitize(req.body.fromName, 60) || (to ? 'Someone' : null);
    let visibility = 'private';
    let toDeviceId = null;
    if (to) {
      visibility = 'direct';
      toDeviceId = to;
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

    const originalName = decodeOriginalName(req.file.originalname) || 'file';
    const meta = {
      token: token(),
      originalName,
      storedName: req.file.filename,
      size: req.file.size,
      mime: req.file.mimetype || mime.lookup(originalName) || 'application/octet-stream',
      visibility,
      createdAt: Date.now(),
      expiresAt,
      oneTime,
      downloadCount: 0,
      uploader: req.ip,
      toDeviceId,
      fromName,
    };
    store.addFile(meta);

    const shape = toPublicShape(meta);
    if (visibility === 'public') {
      hub.broadcast('file-added', shape);
    } else if (visibility === 'direct') {
      hub.sendToDevice(toDeviceId, 'file-sent', { ...shape, fromName });
    }
    res.json({ ...shape, fromName });
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
  router.delete('/api/files/:token', (req, res) => {
    const f = purgeFile(req.params.token);
    if (!f) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  });

  return { router, purgeFile, purgeExpired };
};
