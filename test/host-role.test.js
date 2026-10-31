'use strict';

// The host role end to end, with real server processes standing in for
// separate computers: proving identity, moving the host, restoring it from the
// recovery key. (Each "computer" needs its own process: the host key and the
// store are per process.)

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const root = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'meghxl-host-'));
const children = [];

const freePort = () => new Promise((resolve) => {
  const srv = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = srv.address();
    srv.close(() => resolve(port));
  });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Start a MeghXL server as its own "computer". */
async function computer(name) {
  const port = await freePort();
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), MDNS: 'off', UPLOAD_DIR: path.join(dir, 'uploads'),
      DATA_FILE: path.join(dir, 'metadata.json'), ADMIN_KEY: '', MIN_FREE_MB: '0' },
    stdio: 'ignore',
  });
  children.push(child);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* starting */ }
    await sleep(100);
  }
  // From this machine, with no forwarding header, we are each server's host.
  const call = async (method, route, body, headers = {}) => {
    const r = await fetch(base + route, {
      method,
      headers: { 'x-meghxl-request': '1', ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, body: json, text };
  };
  return { name, base, dir, child, call };
}

async function upload(c, filename, content) {
  const fd = new FormData();
  fd.append('visibility', 'public');
  fd.append('file', new Blob([content]), filename);
  const r = await fetch(`${c.base}/api/upload`, { method: 'POST', body: fd });
  return r.json();
}

test('a desktop app can make the host prove itself, and a wrong key fails', async () => {
  const host = await computer('prover');
  const id = (await host.call('GET', '/api/host/identity')).body;
  assert.match(id.fingerprint, /^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/);
  const nonce = crypto.randomBytes(18).toString('base64url');
  const { signature } = (await host.call('POST', '/api/host/prove', { nonce })).body;
  const identity = require('../src/host-identity');
  assert.ok(identity.verifyProof(id.publicKey, nonce, signature), 'the real key verifies');
  const other = crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
  assert.ok(!identity.verifyProof(other, nonce, signature), 'any other key does not');
});

test('moving the host: key, settings and files go to the new computer; the old one stands down', async () => {
  const a = await computer('old-host');
  const b = await computer('new-host');
  const idA = (await a.call('GET', '/api/host/identity')).body;
  const shared = await upload(a, 'report.pdf', '%PDF-1.7 the quarterly numbers');
  await a.call('POST', '/api/admin/settings', { maxUploadMb: 7, approveRenames: true });

  // A wrong transfer code gets nowhere.
  const started = (await a.call('POST', '/api/admin/host/move')).body;
  assert.match(started.code, /^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/);
  const wrong = await b.call('POST', '/api/admin/host/receive', { from: a.base, code: 'AAAA-BBBB-CCCC-DDDD', copyFiles: true });
  assert.equal(wrong.status, 200);
  let status;
  for (let i = 0; i < 50; i++) {
    status = (await b.call('GET', '/api/admin/host')).body.receiving;
    if (status.state !== 'running') break;
    await sleep(100);
  }
  assert.equal(status.state, 'failed');
  assert.notEqual((await b.call('GET', '/api/host/identity')).body.fingerprint, idA.fingerprint, 'nothing changed');

  // The right one moves everything.
  await b.call('POST', '/api/admin/host/receive', { from: a.base, code: started.code, copyFiles: true });
  for (let i = 0; i < 100; i++) {
    status = (await b.call('GET', '/api/admin/host')).body.receiving;
    if (status.state !== 'running') break;
    await sleep(100);
  }
  assert.equal(status.state, 'done', status.step);

  const idB = (await b.call('GET', '/api/host/identity')).body;
  assert.equal(idB.fingerprint, idA.fingerprint, 'same host identity — paired apps keep trusting it');
  const file = await fetch(`${b.base}/d/${shared.token}`);
  assert.equal(file.status, 200, 'shared links keep working');
  assert.equal(await file.text(), '%PDF-1.7 the quarterly numbers');
  const settings = (await b.call('GET', '/api/admin/state')).body.settings;
  assert.equal(settings.maxUploadMb, 7);
  assert.equal(settings.approveRenames, true);

  const health = (await a.call('GET', '/api/health')).body;
  assert.equal(health.retired, true, 'the old computer stood down');
  assert.equal((await a.call('GET', '/api/files')).status, 410);
  assert.equal((await a.call('POST', '/api/host/prove', { nonce: crypto.randomBytes(18).toString('base64url') })).status, 410,
    'and can no longer prove it is the host');
  assert.equal((await a.call('POST', '/api/admin/host/move')).status, 410);
});

test('restoring a lost host from its recovery key (and an encrypted backup)', async () => {
  const lost = await computer('lost-host');
  await lost.call('POST', '/api/admin/settings', { blockPrograms: true });
  const { code, fingerprint } = (await lost.call('POST', '/api/admin/host/recovery')).body;
  const { backup } = (await lost.call('POST', '/api/admin/host/backup')).body;
  assert.equal(backup.kind, 'meghxl-backup');
  assert.ok(!JSON.stringify(backup).includes('blockPrograms'), 'the backup is encrypted');
  lost.child.kill(); // the disk died

  const replacement = await computer('replacement');
  const typo = code.slice(0, -1) + (code.endsWith('0') ? '1' : '0');
  assert.equal((await replacement.call('POST', '/api/admin/host/restore', { recovery: typo })).status, 400, 'a typo is caught');

  const stranger = await computer('stranger');
  const strangersBackup = (await stranger.call('POST', '/api/admin/host/backup')).body.backup;
  const mismatch = await replacement.call('POST', '/api/admin/host/restore', { recovery: code, backup: strangersBackup });
  assert.equal(mismatch.status, 400, "another host's backup won't open with this key");

  const ok = await replacement.call('POST', '/api/admin/host/restore', { recovery: code.toLowerCase(), backup });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.fingerprint, fingerprint, 'the same host again');
  assert.equal(ok.body.settingsRestored, true);
  assert.equal((await replacement.call('GET', '/api/admin/state')).body.settings.blockPrograms, true);
});

test('the move channel is closed unless the host opened it, and only to the code', async () => {
  const host = await computer('closed-channel');
  const r = await host.call('POST', '/api/host/handover/bundle', { ts: Date.now(), proof: 'x'.repeat(64) });
  assert.equal(r.status, 403);
  const f = await host.call('GET', '/api/host/handover/file/abc');
  assert.equal(f.status, 403);
  // The console's host routes need the host.
  const lan = await host.call('POST', '/api/admin/host/recovery', null, { 'X-Forwarded-For': '10.0.0.7' });
  assert.equal(lan.status, 403);
});

test.after(async () => {
  for (const c of children) c.kill();
  await sleep(200);
  fs.rmSync(tmp, { recursive: true, force: true });
});
