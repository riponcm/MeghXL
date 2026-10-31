'use strict';

const crypto = require('node:crypto');
const express = require('express');

const config = require('../config');
const store = require('../store');
const disk = require('../disk');
const join = require('../join');
const identity = require('../host-identity');
const { requireAdmin } = require('../admin-auth');
const { remoteIp } = require('../identity');
const { rateLimit } = require('../limits');
const { hostWarnings, OTHER_CAUSES, platformInfo } = require('../network-check');

// ---------------------------------------------------------------------------
// "Can phones reach this computer?" — and a diagnostic report for bug reports.
//
// The host console starts a test and shows a QR code for /reach/<token> on
// this computer's IP address. When a phone opens it, the page says so and the
// console sees it. If nothing arrives, the console lists what on this computer
// (and around it) usually blocks devices.
// ---------------------------------------------------------------------------

const TEST_TTL_MS = 10 * 60 * 1000;

module.exports = function createReachRouter({ hub }) {
  const router = express.Router();
  const tests = new Map(); // token -> { startedAt, hits: [{ at, agent }] }
  let lastResult = null; // for diagnostics: 'reached' | 'not reached' | null
  const hitLimit = rateLimit({ burst: 20, perMinute: 30, keyOf: remoteIp });

  function sweep() {
    const cutoff = Date.now() - TEST_TTL_MS;
    for (const [k, t] of tests) if (t.startedAt < cutoff) tests.delete(k);
  }

  router.post('/api/admin/reach', requireAdmin, (req, res) => {
    sweep();
    const tokenValue = crypto.randomBytes(12).toString('base64url');
    tests.set(tokenValue, { startedAt: Date.now(), hits: [] });
    // By IP on purpose: this tests the network path itself, which a friendly
    // name (mDNS) could hide either way.
    res.json({ token: tokenValue, url: `http://${config.lanIp}:${config.port}/reach/${tokenValue}` });
  });

  router.get('/api/admin/reach/:token', requireAdmin, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const t = tests.get(String(req.params.token));
    if (!t) return res.status(404).json({ error: 'That test has ended.' });
    if (t.hits.length) lastResult = 'reached';
    else if (Date.now() - t.startedAt > 60 * 1000) lastResult = 'not reached';
    res.json({ reached: t.hits.length > 0, hits: t.hits, warnings: await hostWarnings(), otherCauses: OTHER_CAUSES });
  });

  // What a phone sees when it scans the test code. Plain page, no script.
  router.get('/reach/:token', hitLimit, (req, res) => {
    const t = tests.get(String(req.params.token));
    const ok = !!t;
    if (t && t.hits.length < 20) {
      t.hits.push({ at: Date.now(), agent: String(req.headers['user-agent'] || '').slice(0, 160) });
      hub.notifyHosts('reach-hit', {});
    }
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MeghXL connection test</title><body style="font:17px system-ui;background:#0f1117;color:#e7e9ee;display:grid;place-items:center;min-height:100vh;margin:0">
<div style="max-width:380px;padding:24px;text-align:center"><div style="font-size:44px">${ok ? '✓' : '·'}</div>
<h1 style="font-size:20px">${ok ? 'This device can reach the MeghXL host' : 'This test has ended'}</h1>
<p style="color:#9aa0b0">${ok ? 'You can close this page. The host computer now knows the connection works.' : 'Start a new test from the host console.'}</p></div>`);
  });

  // A report to paste into a bug report: settings and conditions, no
  // addresses, names or files.
  router.get('/api/admin/diagnostics', requireAdmin, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const s = store.getSettings();
    const free = await disk.freeBytes();
    const gb = (b) => (b == null ? 'unknown' : `${(b / 1024 ** 3).toFixed(1)} GB`);
    const warnings = await hostWarnings();
    const on = (v) => (v ? 'on' : 'off');
    const lines = [
      `MeghXL ${config.version}`,
      `Platform: ${platformInfo()}`,
      `Desktop app: ${process.env.MEGHXL_EXIT_WITH_PARENT === '1' ? 'yes' : 'no (npm start / service)'}`,
      `Port: ${config.port}${config.port === 3000 ? '' : ' (not the default)'}`,
      `Friendly name (mDNS): ${config.mdnsEnabled ? 'on' : 'off'}`,
      `Links use: ${s.linkHost === 'friendly' ? 'friendly name' : 'IP address'}`,
      `Behind a proxy (PUBLIC_BASE_URL): ${config.publicBaseUrl ? 'yes' : 'no'}`,
      `Host retired: ${identity.isRetired() ? 'yes' : 'no'}`,
      `Private mode: ${on(join.isEnabled())} · approve devices: ${on(s.approveDevices)} · approve names: ${on(s.approveRenames)} · refuse programs: ${on(s.blockPrograms)}`,
      `Devices online: ${hub.rosterDetailed().length}`,
      `Free disk: ${gb(free)} (reserve ${config.minFreeMb} MB) · largest file: ${s.maxUploadMb ? s.maxUploadMb + ' MB' : 'no limit'}`,
      `Connection test: ${lastResult || 'not run'}`,
      `Host checks: ${warnings.length ? warnings.map((w) => w.id).join(', ') : 'nothing found'}`,
    ];
    res.json({ text: lines.join('\n') });
  });

  return { router };
};
