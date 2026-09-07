#!/usr/bin/env node
'use strict';

const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');

const config = require('./src/config');
const store = require('./src/store');
const runtime = require('./src/runtime');
const qr = require('./src/qr');
const mdns = require('./src/mdns');
const { getShareBase } = require('./src/baseUrl');
const { createHub } = require('./src/ws-hub');
const createFilesRouter = require('./src/routes/files');
const createNotesRouter = require('./src/routes/notes');
const createAdminRouter = require('./src/routes/admin');
const createUpdateRouter = require('./src/routes/update');

const SWEEP_INTERVAL_MS = 60 * 1000;

/**
 * Build the Express app. `hub` only needs a `.broadcast(type, payload)` method,
 * so tests can pass a stub instead of a real WebSocket hub.
 * Returns { app, files } — `files` exposes purge helpers for the expiry sweep.
 */
function buildApp(hub) {
  const app = express();
  app.disable('x-powered-by');
  app.enable('trust proxy'); // correct req.protocol/host behind a reverse proxy / VPN

  app.use(express.json({ limit: '16kb' }));

  const files = createFilesRouter(hub);
  const notes = createNotesRouter(hub);
  const admin = createAdminRouter({ hub, files });
  const update = createUpdateRouter();
  app.use(files.router);
  app.use(notes.router);
  app.use(admin.router);
  app.use(update.router);

  app.get('/api/health', (req, res) => res.json({ ok: true, version: config.version }));

  // Host console page. no-store so the browser never serves a stale console.
  app.get('/admin', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.join(config.publicDir, 'admin.html'));
  });

  // Static dashboard. express.static never lists directories, and uploads/ is
  // never served here — files leave only through GET /d/:token.
  // `no-store` = never cache the UI assets, so the browser can't serve a stale
  // dashboard/console (this was the real cause of the "Host only" ghost page).
  app.use(express.static(config.publicDir, {
    index: 'index.html',
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-store'),
  }));

  // Upload-size + fallback error handler (must be last).
  app.use((err, req, res, next) => {
    if (err && err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: `File too large (max ${config.maxUploadMb} MB)` });
    }
    console.error(err);
    if (res.headersSent) return next(err);
    res.status(500).json({ error: 'Server error' });
  });

  return { app, files };
}

function printBanner() {
  const shareUrl = getShareBase();
  console.log('');
  console.log('  ┌─────────────────────────────────────────────');
  console.log('  │  MeghXL is running');
  console.log('  │');
  console.log(`  │  On this computer:  http://localhost:${config.port}`);
  console.log(`  │  On your network:   http://${config.lanIp}:${config.port}`);
  if (config.mdnsEnabled) {
    console.log(`  │  Friendly name:     http://${config.mdnsName}.local:${config.port}`);
  }
  if (config.publicBaseUrl) {
    console.log(`  │  Public URL:        ${config.publicBaseUrl}`);
  }
  console.log('  │');
  const cap = config.maxUploadMb ? `${config.maxUploadMb} MB` : 'unlimited';
  console.log(`  │  Max upload ${cap}  ·  files in ${config.uploadDir}`);
  console.log('  └─────────────────────────────────────────────');
  console.log('');
  console.log(`  Host console:  http://localhost:${config.port}/admin   (opens automatically on this PC)`);
  if (runtime.adminKey) console.log(`                 remote admin: append ?key=${runtime.adminKey}`);
  console.log('');
  console.log('  Scan to open the dashboard on your phone:');
  console.log('');
  return qr.printTerminal(shareUrl).then(() => {
    console.log('  Same Wi-Fi required.  LAN-only by design — for remote access, put it');
    console.log('  behind your own VPN / reverse proxy and set PUBLIC_BASE_URL.');
    console.log('  Stop with Ctrl+C.\n');
  });
}

function main() {
  store.load();
  let key = process.env.ADMIN_KEY || store.getAdminKey();
  if (!key) {
    key = crypto.randomBytes(6).toString('hex');
    store.setAdminKey(key);
    store.flushSync();
  }
  runtime.adminKey = key;

  const server = http.createServer();
  const hub = createHub(server);
  const { app, files } = buildApp(hub);
  server.on('request', app);

  const sweep = setInterval(() => {
    const n = files.purgeExpired();
    if (n) console.log(`[sweep] removed ${n} expired file(s)`);
  }, SWEEP_INTERVAL_MS);
  if (sweep.unref) sweep.unref();

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n  Port ${config.port} is already in use. Try:  PORT=8080 npm start\n`);
      process.exit(1);
    }
    throw err;
  });

  server.listen(config.port, config.host, () => {
    if (config.mdnsEnabled) mdns.start({ name: config.mdnsName, port: config.port });
    printBanner();
  });

  const shutdown = () => {
    console.log('\n  Shutting down…');
    store.flushSync();
    mdns.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Launched as the desktop app's sidecar: stdin is a pipe from the app, so
  // EOF means the app is gone — shut down with it. Without this, force-quitting
  // the app orphans this process; it keeps port 3000, and every later launch
  // attaches to it and silently serves the old build. Opt-in so the CLI, whose
  // stdin is a terminal, is unaffected.
  if (process.env.MEGHXL_EXIT_WITH_PARENT === '1') {
    process.stdin.resume();
    for (const ev of ['end', 'close', 'error']) process.stdin.on(ev, shutdown);
  }
}

if (require.main === module) main();

module.exports = { buildApp };
