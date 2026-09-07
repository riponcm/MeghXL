'use strict';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

// Point storage at a throwaway temp dir BEFORE requiring the app — config reads
// process.env at load time, so this must run first.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'meghxl-test-'));
process.env.UPLOAD_DIR = path.join(tmp, 'uploads');
process.env.DATA_FILE = path.join(tmp, 'metadata.json');
process.env.MAX_UPLOAD_MB = '5';

const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { buildApp } = require('../server');

const runtime = require('../src/runtime');

// stub hub — no real WebSocket needed
const { app } = buildApp({
  broadcast() {},
  sendToDevice() {},
  rosterDetailed: () => [],
  kickDevice: () => 0,
  broadcastRoster() {},
});

// Collect the response body as raw bytes (supertest won't buffer octet-streams).
function binaryParser(res, cb) {
  const chunks = [];
  res.on('data', (c) => chunks.push(Buffer.from(c)));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
}

test('uploads a file and downloads identical bytes with the original (unicode) name', async () => {
  const content = Buffer.from('hello meghxl — café', 'utf8');
  const up = await request(app)
    .post('/api/upload')
    .field('visibility', 'public')
    .attach('file', content, { filename: 'grüße.txt', contentType: 'text/plain' });

  assert.equal(up.status, 200);
  assert.ok(up.body.token, 'returns a token');
  assert.equal(up.body.visibility, 'public');
  assert.equal(up.body.size, content.length);

  const dl = await request(app).get(`/d/${up.body.token}`).buffer().parse(binaryParser);
  assert.equal(dl.status, 200);
  assert.match(dl.headers['content-disposition'], /filename\*=UTF-8''/);
  assert.deepEqual(dl.body, content);
});

test('supports HTTP range requests (resumable downloads)', async () => {
  const content = Buffer.from('0123456789');
  const up = await request(app)
    .post('/api/upload')
    .field('visibility', 'public')
    .attach('file', content, { filename: 'nums.txt' });

  const r = await request(app)
    .get(`/d/${up.body.token}`)
    .set('Range', 'bytes=2-5')
    .buffer()
    .parse(binaryParser);

  assert.equal(r.status, 206);
  assert.equal(r.headers['content-range'], 'bytes 2-5/10');
  assert.deepEqual(r.body, Buffer.from('2345'));
});

test('private files are hidden from the public list but downloadable by token', async () => {
  const up = await request(app)
    .post('/api/upload')
    .field('visibility', 'private')
    .attach('file', Buffer.from('secret'), { filename: 'secret.txt' });

  assert.equal(up.body.visibility, 'private');

  const list = await request(app).get('/api/files');
  assert.ok(
    !list.body.files.some((f) => f.token === up.body.token),
    'private token must not appear in /api/files'
  );

  const dl = await request(app).get(`/d/${up.body.token}`);
  assert.equal(dl.status, 200);
});

test('one-time links are consumed after the first download', async () => {
  const up = await request(app)
    .post('/api/upload')
    .field('visibility', 'private')
    .field('oneTime', 'true')
    .attach('file', Buffer.from('burn me'), { filename: 'once.txt' });

  const first = await request(app).get(`/d/${up.body.token}`);
  assert.equal(first.status, 200);

  const second = await request(app).get(`/d/${up.body.token}`);
  assert.equal(second.status, 410);
});

test('rejects files larger than the configured limit', async () => {
  const big = Buffer.alloc(6 * 1024 * 1024, 0x61); // 6 MB > 5 MB limit
  const up = await request(app)
    .post('/api/upload')
    .field('visibility', 'private')
    .attach('file', big, { filename: 'big.bin' });

  assert.equal(up.status, 413);
});

test('unknown download token returns 404', async () => {
  const r = await request(app).get('/d/does-not-exist');
  assert.equal(r.status, 404);
});

test('direct send to a device is hidden from the public list but downloadable by token', async () => {
  const up = await request(app)
    .post('/api/upload')
    .field('to', 'device-xyz')
    .field('fromName', 'Laptop')
    .attach('file', Buffer.from('direct hello'), { filename: 'direct.txt' });

  assert.equal(up.status, 200);
  assert.equal(up.body.visibility, 'direct');
  assert.equal(up.body.fromName, 'Laptop');

  const list = await request(app).get('/api/files');
  assert.ok(
    !list.body.files.some((f) => f.token === up.body.token),
    'direct file must not appear in /api/files'
  );

  const dl = await request(app).get(`/d/${up.body.token}`);
  assert.equal(dl.status, 200);
});

test('host (localhost) gets the admin console without a key', async () => {
  const r = await request(app).get('/api/admin/state');
  assert.equal(r.status, 200);
  assert.ok(r.body.server && r.body.stats, 'returns server + stats');
});

test('host can post an announcement that appears in state', async () => {
  const posted = await request(app).post('/api/admin/announce').send({ text: 'hello team' });
  assert.equal(posted.status, 200);
  assert.equal(posted.body.text, 'hello team');

  const state = await request(app).get('/api/admin/state');
  assert.ok(state.body.announcements.some((a) => a.text === 'hello team'));
});

test('only the host PC is admin: a forwarded/other-device request is denied', async () => {
  // A request carrying a forwarding header is not the host machine, so even on a
  // quiet LAN it must NOT get the console — other devices see the normal app.
  const r = await request(app).get('/api/admin/state').set('X-Forwarded-For', '203.0.113.99');
  assert.equal(r.status, 403);
});

test('only the host PC is admin: forwarded polls from varying source IPs are all denied', async () => {
  for (const ip of ['198.51.100.1', '198.51.100.2', '198.51.100.3']) {
    const r = await request(app).get('/api/admin/state').set('X-Forwarded-For', ip);
    assert.equal(r.status, 403, `forwarded request from ${ip} must not be admin`);
  }
});

test('a forwarded request WITH the admin key is allowed (e.g. behind a VPN/proxy)', async () => {
  runtime.adminKey = 'test-key-123';
  try {
    const r = await request(app)
      .get('/api/admin/state')
      .set('X-Forwarded-For', '203.0.113.7')
      .set('x-admin-key', 'test-key-123');
    assert.equal(r.status, 200);
  } finally {
    runtime.adminKey = null;
  }
});

test('a forwarded request spoofing loopback via XFF cannot escalate to admin', async () => {
  // A proxied request claiming 127.0.0.1 must NOT be treated as the host: the
  // presence of a forwarding header disqualifies it (auth uses the raw socket).
  const r = await request(app).get('/api/admin/state').set('X-Forwarded-For', '127.0.0.1');
  assert.equal(r.status, 403);
});

test.after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});
