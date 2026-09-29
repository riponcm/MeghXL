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
// A proxy's public name, as an operator would declare it.
process.env.ALLOWED_HOSTS = 'hub.example.com';

const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const http = require('node:http');
const WebSocket = require('ws');
const { buildApp } = require('../server');
const { createHub } = require('../src/ws-hub');

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
  const posted = await request(app)
    .post('/api/admin/announce')
    .set('x-meghxl-request', '1')
    .send({ text: 'hello team' });
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

// ---------------------------------------------------------------------------
// Security regressions — 1.0.1. Each test is one attack from the report (or
// found while reproducing it), sent with the headers a real browser attaches.
// ---------------------------------------------------------------------------

const EVIL = 'https://evil.example';
const SAME = { Host: 'meghxl.local:3000', Origin: 'http://meghxl.local:3000' };

async function uploadPrivate(text) {
  const r = await request(app)
    .post('/api/upload')
    .field('visibility', 'private')
    .attach('file', Buffer.from(text), 'secret.txt');
  assert.equal(r.status, 200);
  return r.body.token;
}

test('DNS rebinding: a foreign Host header is refused on every kind of route', async () => {
  const token = await uploadPrivate('rebind target');
  for (const path of ['/api/admin/files', '/api/files', `/d/${token}`, '/', '/admin']) {
    const r = await request(app).get(path).set('Host', 'rebind.evil.example:3000');
    assert.equal(r.status, 403, `${path} must refuse a foreign Host`);
  }
});

test('DNS rebinding: look-alike and malformed hosts are refused', async () => {
  for (const host of ['evil.com', 'evil.com.', 'localhost.evil.com', 'meghxl.local.evil.com',
                      'EVIL.COM:3000', 'evil.com:abc', 'user@127.0.0.1', '[::1', '1.2.3.4:3000:1']) {
    const r = await request(app).get('/api/health').set('Host', host);
    assert.equal(r.status, 403, `Host "${host}" must be refused`);
  }
});

test('every legitimate way of reaching the hub is still allowed', async () => {
  for (const host of ['localhost:3000', '127.0.0.1:3000', '[::1]:3000', '10.0.0.3:3000',
                      '192.168.1.10', 'meghxl.local:3000', 'meghxl.local.:3000', 'MeghXL.Local',
                      'myhub:3000', 'hub.lan', 'office.home.arpa', 'nas.internal', 'hub.example.com']) {
    const r = await request(app).get('/api/health').set('Host', host);
    assert.equal(r.status, 200, `Host "${host}" must be allowed`);
  }
});

test('CSRF: a cross-site form POST cannot clear the files', async () => {
  const token = await uploadPrivate('must survive');
  const r = await request(app)
    .post('/api/admin/files/clear')
    .set('Origin', EVIL)
    .set('Sec-Fetch-Site', 'cross-site')
    .set('Content-Type', 'application/x-www-form-urlencoded')
    .send('');
  assert.equal(r.status, 403);
  const still = await request(app).get(`/d/${token}`).buffer(true).parse(binaryParser);
  assert.equal(still.status, 200, 'the file must still be there');
});

test('CSRF: Origin "null" (sandboxed frame / data: page) is refused', async () => {
  const r = await request(app).post('/api/admin/files/clear')
    .set('Origin', 'null').set('x-meghxl-request', '1');
  assert.equal(r.status, 403);
});

test('CSRF: Sec-Fetch-Site cross-site or same-site is refused even without Origin', async () => {
  for (const site of ['cross-site', 'same-site']) {
    const r = await request(app).post('/api/notes').set('Sec-Fetch-Site', site).send({ text: 'x' });
    assert.equal(r.status, 403, `Sec-Fetch-Site: ${site}`);
  }
});

test('CSRF: a cross-site multipart upload cannot plant files on the board', async () => {
  const r = await request(app)
    .post('/api/upload')
    .set('Origin', EVIL)
    .field('visibility', 'public')
    .attach('file', Buffer.from('planted'), 'planted.txt');
  assert.equal(r.status, 403);
});

test('CSRF: an admin write without the x-meghxl-request header is refused, even same-origin', async () => {
  const r = await request(app).post('/api/admin/announce').set(SAME).send({ text: 'x' });
  assert.equal(r.status, 403);
});

test('same-origin browser requests and plain clients (curl) keep working', async () => {
  const ok = await request(app).post('/api/admin/announce')
    .set(SAME).set('x-meghxl-request', '1').send({ text: 'same-origin works' });
  assert.equal(ok.status, 200);

  const curl = await request(app).post('/api/upload')
    .attach('file', Buffer.from('from a script'), 'script.txt');
  assert.equal(curl.status, 200, 'no Origin and no Sec-Fetch-Site = not a browser');
});

test('behind a proxy that rewrites Host, the declared public origin is accepted', async () => {
  const r = await request(app).post('/api/notes')
    .set('Host', '127.0.0.1:3000').set('Origin', 'https://hub.example.com').send({ text: 'via proxy' });
  assert.equal(r.status, 200);
});

test('whoami reveals only isAdmin — no host addresses or headers', async () => {
  const r = await request(app).get('/api/admin/whoami');
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body), ['isAdmin']);
});

test('the admin key is accepted in a header but no longer in the query string', async () => {
  runtime.adminKey = 'test-key-456';
  try {
    const viaQuery = await request(app).get('/api/admin/state?key=test-key-456')
      .set('X-Forwarded-For', '203.0.113.9');
    assert.equal(viaQuery.status, 403);
    const viaHeader = await request(app).get('/api/admin/state')
      .set('X-Forwarded-For', '203.0.113.9').set('x-admin-key', 'test-key-456');
    assert.equal(viaHeader.status, 200);
    const wrong = await request(app).get('/api/admin/state')
      .set('X-Forwarded-For', '203.0.113.9').set('x-admin-key', 'test-key-45');
    assert.equal(wrong.status, 403, 'a prefix of the key is not the key');
  } finally {
    runtime.adminKey = null;
  }
});

test('WebSocket: cross-site origins and foreign hosts cannot join the board', async () => {
  const server = http.createServer();
  const hub = createHub(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const url = `ws://127.0.0.1:${port}/ws`;

  const attempt = (opts) => new Promise((resolve) => {
    const ws = new WebSocket(url, opts);
    ws.on('open', () => { ws.close(); resolve('open'); });
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode));
    ws.on('error', () => resolve('error'));
  });

  try {
    assert.notEqual(await attempt({ origin: EVIL }), 'open', 'cross-site origin must be refused');
    assert.notEqual(await attempt({ origin: 'null' }), 'open', 'null origin must be refused');
    assert.notEqual(await attempt({ headers: { Host: 'rebind.evil.example' } }), 'open', 'foreign Host must be refused');
    assert.equal(await attempt({ origin: `http://127.0.0.1:${port}` }), 'open', 'same-origin must connect');
    assert.equal(await attempt({}), 'open', 'a non-browser client (no Origin) must connect');
  } finally {
    hub.wss.close();
    await new Promise((r) => server.close(r));
  }
});

test.after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});
