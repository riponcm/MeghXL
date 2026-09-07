'use strict';

const crypto = require('node:crypto');
const express = require('express');
const config = require('../config');
const store = require('../store');
const { getShareBase } = require('../baseUrl');
const { localAddresses } = require('../network');
const { isLoopbackHost, clientIp, isAdmin, requireAdmin } = require('../admin-auth');

function sanitize(s, max) {
  let out = '';
  for (const ch of String(s == null ? '' : s)) if (ch.charCodeAt(0) >= 32) out += ch;
  return out.trim().slice(0, max);
}

/**
 * Host console API. Admin is the machine running MeghXL — every browser on
 * the host PC. Other LAN devices get the normal dashboard, never the console.
 * An ADMIN_IP device or the ADMIN_KEY (`x-admin-key` header / `?key=`) can also
 * act as admin (e.g. for remote administration over a VPN/proxy). See isAdmin().
 */
module.exports = function createAdminRouter({ hub, files }) {
  const router = express.Router();

  // GET /api/admin/whoami — UNAUTHENTICATED diagnostic. Shows exactly what the
  // server sees for this request, so admin-access issues can be pinned down.
  router.get('/api/admin/whoami', (req, res) => {
    res.json({
      socketRemoteAddress: (req.socket && req.socket.remoteAddress) || null,
      xForwardedFor: req.headers['x-forwarded-for'] || null,
      cfConnectingIp: req.headers['cf-connecting-ip'] || null,
      host: req.headers.host || null,
      via: req.headers['via'] || null,
      clientIp: clientIp(req),
      isLoopbackHost: isLoopbackHost(req),
      isAdmin: isAdmin(req),
      adminClaimedIp: store.getSettings().adminClaimedIp || null,
      adminIps: config.adminIps,
      localAddresses: [...localAddresses()],
    });
  });

  // GET /api/admin/state — everything the console renders
  router.get('/api/admin/state', requireAdmin, (req, res) => {
    const live = store.listAllFiles().filter((f) => !store.isExpired(f) && !f.consumed);
    res.json({
      server: {
        version: config.version,
        lanIp: config.lanIp,
        port: config.port,
        mdnsName: config.mdnsEnabled ? `${config.mdnsName}.local` : null,
        maxUploadMb: config.maxUploadMb,
        uptimeSec: Math.round(process.uptime()),
        shareBase: getShareBase(),
      },
      stats: {
        devicesOnline: hub.rosterDetailed().length,
        files: live.length,
        storageBytes: live.reduce((sum, f) => sum + (f.size || 0), 0),
      },
      devices: hub.rosterDetailed(),
      blocked: store.listBlocked(),
      announcements: store.listAnnouncements(),
      settings: store.getSettings(),
    });
  });

  // POST /api/admin/announce { text } — broadcast a banner to all devices
  router.post('/api/admin/announce', requireAdmin, (req, res) => {
    const text = sanitize(req.body && req.body.text, 280);
    if (!text) return res.status(400).json({ error: 'Empty announcement' });
    const a = store.addAnnouncement({ id: 'a_' + crypto.randomBytes(6).toString('hex'), text, ts: Date.now() });
    hub.broadcast('announce', a);
    res.json(a);
  });

  // DELETE /api/admin/announcements — clear all (and dismiss the banner everywhere)
  router.delete('/api/admin/announcements', requireAdmin, (req, res) => {
    store.clearAnnouncements();
    hub.broadcast('announce-clear', {});
    res.json({ ok: true });
  });

  // POST /api/admin/block { deviceId } — kick + ban (by id and current IP)
  router.post('/api/admin/block', requireAdmin, (req, res) => {
    const deviceId = sanitize(req.body && req.body.deviceId, 64);
    if (!deviceId) return res.status(400).json({ error: 'Missing deviceId' });
    const dev = hub.rosterDetailed().find((d) => d.id === deviceId);
    store.addBlock({
      deviceId,
      ip: (dev && dev.ip) || null,
      name: (dev && dev.name) || 'Device',
      at: Date.now(),
    });
    hub.kickDevice(deviceId);
    hub.broadcastRoster();
    res.json({ blocked: store.listBlocked() });
  });

  // POST /api/admin/unblock { deviceId }
  router.post('/api/admin/unblock', requireAdmin, (req, res) => {
    store.removeBlock(sanitize(req.body && req.body.deviceId, 64));
    res.json({ blocked: store.listBlocked() });
  });

  // GET /api/admin/files — every file (public, private, direct)
  router.get('/api/admin/files', requireAdmin, (req, res) => {
    const list = store
      .listAllFiles()
      .filter((f) => !store.isExpired(f))
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((f) => ({
        token: f.token,
        originalName: f.originalName,
        size: f.size,
        mime: f.mime,
        visibility: f.visibility,
        createdAt: f.createdAt,
        expiresAt: f.expiresAt,
        oneTime: f.oneTime,
        consumed: !!f.consumed,
        downloadCount: f.downloadCount,
        fromName: f.fromName || null,
        downloadUrl: `${getShareBase()}/d/${f.token}`,
      }));
    res.json({ files: list });
  });

  // DELETE /api/admin/files/:token — force-remove any file
  router.delete('/api/admin/files/:token', requireAdmin, (req, res) => {
    const f = files.purgeFile(req.params.token);
    if (!f) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  });

  // POST /api/admin/files/clear — wipe all files
  router.post('/api/admin/files/clear', requireAdmin, (req, res) => {
    let removed = 0;
    for (const f of store.listAllFiles()) if (files.purgeFile(f.token)) removed++;
    res.json({ ok: true, removed });
  });

  // POST /api/admin/settings { defaultExpiryMinutes?, linkHost? }
  //   linkHost: 'ip' (default — works on every device) or 'friendly' (share
  //   links + QRs use the mDNS name, keeping the IP off screen).
  router.post('/api/admin/settings', requireAdmin, (req, res) => {
    const partial = {};
    const body = req.body || {};
    const exp = parseInt(body.defaultExpiryMinutes, 10);
    if (Number.isFinite(exp) && exp >= 0) partial.defaultExpiryMinutes = Math.min(exp, 7 * 24 * 60);
    if (body.linkHost === 'ip' || body.linkHost === 'friendly') partial.linkHost = body.linkHost;
    res.json({ settings: store.setSettings(partial) });
  });

  return { router };
};
