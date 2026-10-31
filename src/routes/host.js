'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const express = require('express');

const config = require('../config');
const store = require('../store');
const runtime = require('../runtime');
const identity = require('../host-identity');
const activity = require('../activity');
const disk = require('../disk');
const { storedName } = require('../ids');
const { requireAdmin } = require('../admin-auth');
const { remoteIp } = require('../identity');
const { rateLimit } = require('../limits');
const { getShareBase } = require('../baseUrl');

// ---------------------------------------------------------------------------
// The host role: proving it, backing it up, restoring it, moving it.
//
// Public (any device):
//   GET  /api/host/identity   the host's public key and fingerprint
//   POST /api/host/prove      sign a desktop app's challenge
// The move channel (authenticated by the one-time transfer code, which never
// crosses the network — each request carries an HMAC made with it):
//   POST /api/host/handover/bundle      key + settings + file list, encrypted
//   GET  /api/host/handover/file/:token one file
//   POST /api/host/handover/done        the new host has everything: retire
// Host console only: recovery key, backup, restore, start/receive a move.
// ---------------------------------------------------------------------------

const MOVE_TTL_MS = 30 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;

const transferCode = () => identity.group(identity.base32(crypto.randomBytes(10)), 4); // 80 bits
const normalizeCode = (c) => String(c || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
const moveKey = (code) => identity.derive(Buffer.from(normalizeCode(code)), 'meghxl-move-v1');
const proofOf = (key, purpose, ts, extra = '') =>
  crypto.createHmac('sha256', key).update(`${purpose}\n${ts}\n${extra}`).digest('hex');

/** The files a move carries: everything still downloadable. */
function movableFiles() {
  return store.listAllFiles().filter((f) => !f.consumed && !store.isExpired(f));
}
const fileRecord = (f) => {
  const { storedName: _ignored, ...rest } = f;
  return rest;
};

module.exports = function createHostRouter({ hub }) {
  const router = express.Router();
  const proveLimit = rateLimit({ burst: 20, perMinute: 60, keyOf: remoteIp });
  const moveLimit = rateLimit({ burst: 20, perMinute: 30, keyOf: remoteIp });

  // ---- proving who the host is ------------------------------------------------

  router.get('/api/host/identity', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ...identity.publicInfo(), name: config.mdnsEnabled ? `${config.mdnsName}.local` : null, version: config.version });
  });

  router.post('/api/host/prove', proveLimit, (req, res) => {
    const nonce = req.body && typeof req.body.nonce === 'string' ? req.body.nonce : '';
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) return res.status(400).json({ error: 'Bad challenge' });
    const signature = identity.prove(nonce);
    if (!signature) return res.status(410).json({ error: 'This computer is no longer the host.', retired: identity.publicInfo().retired });
    res.json({ signature });
  });

  // ---- the move channel (old host side) -----------------------------------------

  let move = null; // { code, key, expiresAt, usedProofs: Set }

  /** Check a request's proof that it knows the transfer code. */
  function authorised(req, purpose, extra = '') {
    if (!move || Date.now() > move.expiresAt) return false;
    const ts = Number(req.get('x-meghxl-ts') || (req.body && req.body.ts));
    const proof = String(req.get('x-meghxl-proof') || (req.body && req.body.proof) || '');
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > CLOCK_SKEW_MS) return false;
    const want = Buffer.from(proofOf(move.key, purpose, ts, extra));
    const got = Buffer.from(proof);
    if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return false;
    const once = `${purpose}|${ts}|${extra}|${proof}`;
    if (move.usedProofs.has(once)) return false;
    move.usedProofs.add(once);
    return true;
  }
  const refuse = (res) => res.status(403).json({ error: 'No move in progress, or the transfer code is wrong or expired.' });

  router.post('/api/host/handover/bundle', moveLimit, (req, res) => {
    if (!authorised(req, 'bundle')) {
      activity.log('move-refused', 'A computer tried to take the host role without the right transfer code', { ip: remoteIp(req), noisy: true });
      return refuse(res);
    }
    const s = identity.load();
    const bundle = {
      seed: s.seed.toString('base64'),
      snapshot: store.snapshot(),
      files: movableFiles().map(fileRecord),
    };
    res.json({ box: identity.seal(move.key, bundle) });
  });

  router.get('/api/host/handover/file/:token', moveLimit, (req, res) => {
    const token = String(req.params.token);
    if (!authorised(req, 'file', token)) return refuse(res);
    const f = store.getFile(token);
    const p = f && path.resolve(config.uploadDir, f.storedName);
    if (!f || !p.startsWith(path.resolve(config.uploadDir) + path.sep) || !fs.existsSync(p)) {
      return res.status(404).json({ error: 'Not found' });
    }
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', fs.statSync(p).size);
    fs.createReadStream(p).pipe(res);
  });

  router.post('/api/host/handover/done', moveLimit, (req, res) => {
    const movedTo = String((req.body && req.body.movedTo) || '').slice(0, 300);
    if (!authorised(req, 'done', movedTo)) return refuse(res);
    identity.retire(/^https?:\/\/[^\s"<>]+$/.test(movedTo) ? movedTo : null);
    move = null;
    activity.log('host-moved', `The host role moved to ${movedTo || 'another computer'}. This computer is no longer the host.`);
    res.json({ ok: true });
    // Everyone still connected here is told where the host went.
    hub.broadcast('host-moved', { to: movedTo || null });
    setTimeout(() => { for (const c of hub.wss.clients) try { c.close(4002, 'host moved'); } catch { /* ignore */ } }, 500);
  });

  // ---- host console ---------------------------------------------------------------

  router.get('/api/admin/host', requireAdmin, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      ...identity.publicInfo(),
      move: move && Date.now() < move.expiresAt ? { code: move.code, expiresAt: move.expiresAt } : null,
      receiving: receiving ? { ...receiving } : null,
      files: movableFiles().length,
      bytes: disk.storedBytes(),
    });
  });

  router.post('/api/admin/host/recovery', requireAdmin, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const code = identity.recoveryCode();
    if (!code) return res.status(410).json({ error: 'This computer is no longer the host.' });
    activity.log('recovery-viewed', 'The recovery key was shown or downloaded');
    res.json({ code, fingerprint: identity.publicInfo().fingerprint });
  });

  router.post('/api/admin/host/backup', requireAdmin, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (identity.isRetired()) return res.status(410).json({ error: 'This computer is no longer the host.' });
    activity.log('backup', 'An encrypted backup of the host settings was downloaded');
    res.json({ backup: identity.sealBackup(store.snapshot()) });
  });

  // The same, as a file download (a real HTTP download works in the desktop
  // app, where a script-made file may not). Encrypted, so harmless if a
  // website on this computer made the browser fetch it: it lands on this
  // computer's disk, unreadable without the recovery key.
  router.get('/api/admin/host/backup.json', requireAdmin, (req, res) => {
    if (identity.isRetired()) return res.status(410).json({ error: 'This computer is no longer the host.' });
    activity.log('backup', 'An encrypted backup of the host settings was downloaded');
    const day = new Date().toISOString().slice(0, 10);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Disposition', `attachment; filename="meghxl-backup-${day}.json"`);
    res.json(identity.sealBackup(store.snapshot()));
  });

  // Restore the host on this computer from its recovery key (and, optionally,
  // an encrypted backup of its settings).
  router.post('/api/admin/host/restore', requireAdmin, (req, res) => {
    const body = req.body || {};
    const seed = identity.seedFromRecovery(body.recovery);
    if (!seed) return res.status(400).json({ error: "That recovery key isn't right — check it for typos." });
    let restored = false;
    if (body.backup) {
      const contents = identity.openBackup(seed, body.backup);
      if (!contents) return res.status(400).json({ error: "That backup doesn't belong to this recovery key, or it was changed." });
      store.restoreSnapshot(contents);
      if (!process.env.ADMIN_KEY && store.getAdminKey()) runtime.adminKey = store.getAdminKey();
      restored = true;
    }
    const info = identity.adopt(seed);
    activity.log('host-restored', `This computer was restored as the host (${info.fingerprint})${restored ? ', with its settings' : ''}`);
    res.json({ ...info, settingsRestored: restored });
  });

  // Start a move: show a one-time transfer code to type on the new computer.
  router.post('/api/admin/host/move', requireAdmin, (req, res) => {
    if (identity.isRetired()) return res.status(410).json({ error: 'This computer is no longer the host.' });
    const code = transferCode();
    move = { code, key: moveKey(code), expiresAt: Date.now() + MOVE_TTL_MS, usedProofs: new Set() };
    activity.log('move-started', 'A host move was started — the transfer code is valid for 30 minutes');
    res.json({ code, expiresAt: move.expiresAt });
  });

  router.delete('/api/admin/host/move', requireAdmin, (req, res) => {
    move = null;
    activity.log('move-cancelled', 'The host move was cancelled');
    res.json({ ok: true });
  });

  // ---- the move channel (new host side) ------------------------------------------

  let receiving = null; // progress, for the console to poll

  /**
   * Take the host role from another computer: fetch the key and settings,
   * copy the files if asked, then tell the old host to retire.
   */
  async function receive({ from, code, copyFiles }) {
    const key = moveKey(code);
    const stamp = (purpose, extra = '') => {
      const ts = Date.now();
      return { ts, proof: proofOf(key, purpose, ts, extra) };
    };
    const post = async (route, body) => {
      const r = await fetch(`${from}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || `${route}: HTTP ${r.status}`);
      return data;
    };

    receiving.step = 'Contacting the current host';
    const info = await (await fetch(`${from}/api/host/identity`)).json();
    if (!info || !info.publicKey) throw new Error("That address doesn't answer like a MeghXL host.");
    if (info.retired) throw new Error('That computer is no longer the host.');

    receiving.step = 'Receiving the host key and settings';
    const { box } = await post('/api/host/handover/bundle', stamp('bundle'));
    const bundle = identity.open(key, box);
    if (!bundle) throw new Error("Couldn't open what the host sent — is the transfer code right?");
    const seed = Buffer.from(bundle.seed, 'base64');
    // The key must be the one that host has been proving all along.
    if (!identity.publicKeyOf(seed).equals(Buffer.from(info.publicKey, 'base64'))) {
      throw new Error("The key received doesn't match that host's identity. Nothing was changed.");
    }

    const files = copyFiles ? bundle.files : [];
    const total = files.reduce((n, f) => n + (f.size || 0), 0);
    if (total) {
      const free = await disk.freeBytes();
      if (free != null && free - config.minFreeBytes < total) {
        throw new Error(`Not enough free space here for the files (${Math.round(total / 1048576)} MB). Free some space, or move without files.`);
      }
    }
    receiving.filesTotal = files.length;
    receiving.filesDone = 0;
    for (const f of files) {
      receiving.step = `Copying files (${receiving.filesDone + 1} of ${files.length})`;
      const { ts, proof } = stamp('file', f.token);
      const r = await fetch(`${from}/api/host/handover/file/${encodeURIComponent(f.token)}`, {
        headers: { 'x-meghxl-ts': String(ts), 'x-meghxl-proof': proof },
      });
      if (!r.ok) { receiving.skipped = (receiving.skipped || 0) + 1; continue; }
      const name = storedName(f.originalName);
      const dest = path.join(config.uploadDir, name);
      await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(dest, { mode: 0o600 }));
      // Same token, so links already shared keep working at the new address.
      store.addFile({ ...f, storedName: name });
      receiving.filesDone++;
    }

    receiving.step = 'Telling the old computer to stand down';
    store.restoreSnapshot(bundle.snapshot);
    if (!process.env.ADMIN_KEY && store.getAdminKey()) runtime.adminKey = store.getAdminKey();
    identity.adopt(seed);
    const movedTo = getShareBase();
    await post('/api/host/handover/done', { ...stamp('done', movedTo), movedTo });
    disk.invalidate();
    activity.log('host-received', `This computer is now the host (moved from ${from}${files.length ? `, ${receiving.filesDone} files copied` : ''})`);
    hub.broadcastRoster();
  }

  router.post('/api/admin/host/receive', requireAdmin, (req, res) => {
    if (receiving && receiving.state === 'running') return res.status(409).json({ error: 'A move is already in progress.' });
    const body = req.body || {};
    let from;
    try {
      const u = new URL(/^https?:\/\//.test(body.from) ? body.from : `http://${body.from}`);
      if (!u.port) u.port = '3000';
      from = u.origin;
    } catch {
      return res.status(400).json({ error: 'Enter the current host\'s address, e.g. 192.168.1.20:3000' });
    }
    if (normalizeCode(body.code).length !== 16) return res.status(400).json({ error: 'The transfer code has 16 letters and digits.' });
    receiving = { state: 'running', from, step: 'Starting', startedAt: Date.now() };
    receive({ from, code: body.code, copyFiles: body.copyFiles === true })
      .then(() => { receiving.state = 'done'; receiving.step = 'Done — this computer is the host now.'; })
      .catch((err) => {
        receiving.state = 'failed';
        receiving.step = err.message;
        activity.log('move-failed', `Taking over the host role from ${from} failed: ${err.message}`);
      });
    res.json({ receiving });
  });

  return { router };
};
