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
process.env.ALLOWED_HOSTS = 'hub.example.com, https://x.example.org:8443/';

const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const http = require('node:http');
const WebSocket = require('ws');
const { buildApp, tuneServer } = require('../server');
const { createHub } = require('../src/ws-hub');
const { detectLanIPv4 } = require('../src/network');
const lanIp = () => detectLanIPv4();

const runtime = require('../src/runtime');

const store = require('../src/store');
const config = require('../src/config');
const disk = require('../src/disk');
const { handleOf } = require('../src/identity');

// Devices the stub hub treats as online, by handle -> id.
const online = new Map();
const sent = []; // [handle, type, payload] for every sendToDevice

// stub hub — no real WebSocket needed
const { app } = buildApp({
  broadcast() {},
  sendToDevice(handle, type, payload) { sent.push([handle, type, payload]); return online.has(handle) ? 1 : 0; },
  idOfHandle: (handle) => online.get(handle) || null,
  nameOfId: () => null,
  rosterDetailed: () => [],
  kickDevice: () => 0,
  kickUnjoined: () => 0,
  broadcastRoster() {},
});

/** A device as the hub knows it: an id, a remembered name, and online. */
function device(id, name) {
  store.setDeviceName(id, name);
  online.set(handleOf(id), id);
  return { id, name, handle: handleOf(id) };
}
// A request as another device on the LAN sees it (not the host): the
// forwarding header strips loopback trust. Distinct addresses keep the
// per-address rate limits of one test from touching another.
let lanSeq = 10;
const lan = (req, ip = `10.0.0.${lanSeq++}`) => req.set('X-Forwarded-For', ip);

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
  const sender = device('sender-device-000001', 'Laptop');
  const target = device('target-device-000001', 'Phone');
  const up = await lan(request(app).post('/api/upload'))
    .set('x-meghxl-device', sender.id)
    .field('to', target.handle)
    .field('fromName', 'The Boss') // ignored: the hub names the sender
    .attach('file', Buffer.from('direct hello'), { filename: 'direct.txt' });

  assert.equal(up.status, 200);
  assert.equal(up.body.visibility, 'direct');
  assert.equal(up.body.fromName, 'Laptop');
  assert.deepEqual(sent.at(-1).slice(0, 2), [target.handle, 'file-sent']);

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
  assert.equal(r.body.error, 'Cross-site request refused.', 'the request guard must be what refuses it');
  const still = await request(app).get(`/d/${token}`).buffer(true).parse(binaryParser);
  assert.equal(still.status, 200, 'the file must still be there');
});

test('CSRF: Origin "null" (sandboxed frame / data: page) is refused', async () => {
  const r = await request(app).post('/api/admin/files/clear')
    .set('Origin', 'null').set('x-meghxl-request', '1');
  assert.equal(r.status, 403);
});

test('CSRF: a cross-site form POST to a non-admin route is refused by the guard', async () => {
  const r = await request(app).post('/api/notes')
    .set('Origin', EVIL).set('Content-Type', 'application/x-www-form-urlencoded').send('text=hi');
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'Cross-site request refused.');
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
  assert.equal(r.body.error, 'Cross-site request refused.');
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
    assert.equal(await attempt({ origin: EVIL }), 401, 'cross-site origin must be refused');
    assert.equal(await attempt({ origin: 'null' }), 401, 'null origin must be refused');
    assert.equal(await attempt({ headers: { Host: 'rebind.evil.example' } }), 401, 'foreign Host must be refused');
    assert.equal(await attempt({ origin: `http://127.0.0.1:${port}` }), 'open', 'same-origin must connect');
    assert.equal(await attempt({}), 'open', 'a non-browser client (no Origin) must connect');
  } finally {
    for (const client of hub.wss.clients) client.terminate();
    hub.wss.close();
    await new Promise((r) => server.close(r));
  }
});

test('clickjacking: no page can be framed by another site', async () => {
  for (const path of ['/', '/admin', '/api/files']) {
    const r = await request(app).get(path);
    assert.equal(r.headers['x-frame-options'], 'DENY', `${path} X-Frame-Options`);
    assert.match(r.headers['content-security-policy'] || '', /frame-ancestors 'none'/, `${path} CSP`);
  }
});

test('admin needs the hub named by an address or this machine\'s own name', async () => {
  const short = os.hostname().toLowerCase().split('.')[0];
  for (const host of ['localhost:3000', '127.0.0.1:3000', '[::1]:3000', 'app.localhost',
                      'meghxl.local:3000', short, `${short}.local`]) {
    const r = await request(app).get('/api/admin/files').set('Host', host);
    assert.equal(r.status, 200, `admin via "${host}" must work`);
  }
  // A LAN device can answer mDNS/LLMNR for these, so they may use the board but
  // must not reach the console — nor may a proxy's public name.
  for (const host of ['evil.local:3000', 'wpad', 'printer.lan', 'hub.example.com']) {
    const admin = await request(app).get('/api/admin/files').set('Host', host);
    assert.equal(admin.status, 403, `admin via "${host}" must be refused`);
    const board = await request(app).get('/api/files').set('Host', host);
    assert.equal(board.status, 200, `the board via "${host}" must still work`);
  }
});

test('a proxy that drops the port from Host still works when the browser says same-origin', async () => {
  const ok = await request(app).post('/api/notes')
    .set('Host', 'hub.lan').set('Origin', 'https://hub.lan:8443').set('Sec-Fetch-Site', 'same-origin')
    .send({ text: 'via nginx $host' });
  assert.equal(ok.status, 200);
  const noVouch = await request(app).post('/api/notes')
    .set('Host', 'hub.lan').set('Origin', 'https://hub.lan:8443').send({ text: 'x' });
  assert.equal(noVouch.status, 403, 'without the browser vouching, a port mismatch is a different origin');
});

test('ALLOWED_HOSTS accepts full URLs, and the 403 names the host it refused', async () => {
  const ok = await request(app).get('/api/health').set('Host', 'x.example.org:8443');
  assert.equal(ok.status, 200);
  const r = await request(app).get('/api/health').set('Host', 'imac.tail1234.ts.net');
  assert.equal(r.status, 403);
  assert.match(r.text, /"imac\.tail1234\.ts\.net"/);
  assert.match(r.text, /ALLOWED_HOSTS/);
});

test('downloads are sandboxed and cannot be embedded by other sites', async () => {
  const token = await uploadPrivate('sandboxed');
  const r = await request(app).get(`/d/${token}`).buffer(true).parse(binaryParser);
  assert.match(r.headers['content-security-policy'], /sandbox/);
  assert.equal(r.headers['cross-origin-resource-policy'], 'same-origin');
  assert.match(r.headers['content-disposition'], /^attachment/);
});

test('HEAD on a one-time link does not use it up', async () => {
  const up = await request(app).post('/api/upload')
    .field('oneTime', 'true').attach('file', Buffer.from('once'), 'once.txt');
  const token = up.body.token;
  const head = await request(app).head(`/d/${token}`);
  assert.equal(head.status, 200);
  const first = await request(app).get(`/d/${token}`).buffer(true).parse(binaryParser);
  assert.equal(first.status, 200, 'the real download must still work after a HEAD');
  const second = await request(app).get(`/d/${token}`);
  assert.equal(second.status, 410);
});

test('the update check cannot be triggered by another website', async () => {
  const r = await request(app).get('/api/update').set('Sec-Fetch-Site', 'cross-site');
  assert.equal(r.status, 403);
});

test('WebSocket: X-Forwarded-For is trusted only from a proxy on this machine', { skip: !lanIp() && 'no LAN address' }, async () => {
  const server = http.createServer();
  const hub = createHub(server);
  await new Promise((r) => server.listen(0, '0.0.0.0', r));
  const port = server.address().port;
  const join = (host, id) => new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${host}:${port}/ws`, { headers: { 'X-Forwarded-For': '127.0.0.1' } });
    ws.on('open', () => { ws.send(JSON.stringify({ type: 'identify', deviceId: id, name: id, kind: 'desktop' })); setTimeout(() => resolve(ws), 150); });
    ws.on('error', reject);
  });
  const sockets = [];
  try {
    sockets.push(await join(lanIp(), 'from-lan-0000000001'));
    sockets.push(await join('127.0.0.1', 'from-local-proxy-01'));
    const ipOf = (id) => {
      const dev = hub.rosterDetailed().find((d) => d.id === id);
      assert.ok(dev, `device ${id} must have identified`);
      return String(dev.ip).replace(/^::ffff:/, '');
    };
    assert.equal(ipOf('from-lan-0000000001'), lanIp(), 'a LAN device is recorded at its real address, not the one it claimed');
    assert.equal(ipOf('from-local-proxy-01'), '127.0.0.1', 'a local reverse proxy is still believed');
  } finally {
    // ws v8's wss.close() leaves client connections open, and server.close()
    // waits for them — terminate both ends or the test process never exits.
    for (const ws of sockets) ws.terminate();
    for (const client of hub.wss.clients) client.terminate();
    hub.wss.close();
    await new Promise((r) => server.close(r));
  }
});

test('long uploads are not cut off at five minutes, only when the connection goes silent', () => {
  const server = tuneServer(http.createServer());
  assert.equal(server.requestTimeout, 0, 'no overall deadline on a request');
  assert.equal(server.timeout, 2 * 60 * 1000, 'but a silent connection is dropped');
  assert.ok(server.headersTimeout > 0, 'headers must still arrive promptly');
});

// ---------------------------------------------------------------------------
// 1.0.2 hardening
// ---------------------------------------------------------------------------

/**
 * A minimal zip (stored, empty entries) — enough structure for the index to
 * be read the way real tools read it: from the end-of-directory record back.
 */
function makeZip(names, { prefix = Buffer.alloc(0) } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const n of names) {
    const name = Buffer.from(n, 'utf8');
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([prefix, ...locals, cd, end]);
}

/** Start a real server + hub on a random port. */
async function liveHub() {
  const server = tuneServer(http.createServer());
  const hub = createHub(server);
  const built = buildApp(hub);
  server.on('request', built.app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const sockets = [];
  const connect = (id, name) => new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { 'X-Forwarded-For': '10.1.1.1' } });
    ws.inbox = [];
    ws.on('message', (d) => ws.inbox.push(JSON.parse(d)));
    ws.on('open', () => {
      if (id) ws.send(JSON.stringify({ type: 'identify', deviceId: id, name, kind: 'desktop' }));
      setTimeout(() => resolve(ws), 120);
    });
    ws.on('error', reject);
    sockets.push(ws);
  });
  const close = async () => {
    for (const ws of sockets) ws.terminate();
    for (const c of hub.wss.clients) c.terminate();
    hub.wss.close();
    await new Promise((r) => server.close(r));
  };
  return { port, hub, connect, close };
}

test('WebSocket: an oversized frame closes that socket, not the server', async () => {
  const live = await liveHub();
  try {
    const ws = await live.connect();
    const closed = new Promise((r) => ws.on('close', (code) => r(code)));
    ws.on('error', () => {});
    ws.send(Buffer.alloc(200 * 1024, 97));
    assert.equal(await closed, 1009, 'message too big');
    const health = await request(`http://127.0.0.1:${live.port}`).get('/api/health');
    assert.equal(health.status, 200, 'server still up');
  } finally { await live.close(); }
});

test('WebSocket: a flood of messages gets the socket closed', async () => {
  const live = await liveHub();
  try {
    const ws = await live.connect();
    const closed = new Promise((r) => ws.on('close', (code) => r(code)));
    for (let i = 0; i < 200; i++) ws.send(JSON.stringify({ type: 'noop' }));
    assert.equal(await closed, 1008);
  } finally { await live.close(); }
});

test('identity: the roster shows handles, and a handle cannot be used to impersonate', async () => {
  const live = await liveHub();
  try {
    const alice = await live.connect('alice-device-0000000001', 'Alice');
    const roster = alice.inbox.filter((m) => m.type === 'roster').at(-1).payload.devices;
    const entry = roster.find((d) => d.name === 'Alice');
    assert.ok(entry, 'alice listed');
    assert.notEqual(entry.id, 'alice-device-0000000001', 'the device id itself is never broadcast');
    assert.equal(entry.id, handleOf('alice-device-0000000001'));
    const welcome = alice.inbox.find((m) => m.type === 'welcome');
    assert.equal(welcome.payload.handle, entry.id, 'a device learns its own handle');

    // An attacker identifies with the handle it saw in the roster…
    const mallory = await live.connect(entry.id, 'Alice');
    // …and a message to Alice still reaches only Alice.
    const r = await request(`http://127.0.0.1:${live.port}`).post('/api/dm')
      .set('X-Forwarded-For', '10.1.1.9').send({ to: entry.id, text: 'secret' });
    assert.equal(r.body.delivered, 1);
    await new Promise((res) => setTimeout(res, 80));
    assert.ok(alice.inbox.some((m) => m.type === 'dm' && m.payload.text === 'secret'));
    assert.ok(!mallory.inbox.some((m) => m.type === 'dm'), 'impersonator received nothing');
  } finally { await live.close(); }
});

test('identity: a socket cannot switch to another device after identifying', async () => {
  const live = await liveHub();
  try {
    const ws = await live.connect('first-device-000000001', 'First');
    ws.send(JSON.stringify({ type: 'identify', deviceId: 'second-device-00000001', name: 'Second' }));
    await new Promise((r) => setTimeout(r, 80));
    const names = live.hub.rosterDetailed().map((d) => d.name);
    assert.deepEqual(names, ['First']);
  } finally { await live.close(); }
});

test('messages: the hub names the sender; a body cannot claim to be the host', async () => {
  const bob = device('bob-device-00000000001', 'Bob');
  const r = await lan(request(app).post('/api/notes'))
    .set('x-meghxl-device', bob.id).send({ text: 'hi', fromName: 'Host (admin)' });
  assert.equal(r.status, 200);
  assert.equal(r.body.fromName, 'Bob');
  const anon = await lan(request(app).post('/api/notes')).send({ text: 'hello', fromName: 'Host' });
  assert.equal(anon.body.fromName, null, 'unknown senders are unnamed, not whoever they claim');

  const target = device('dm-target-00000000001', 'Target');
  const dm = await lan(request(app).post('/api/dm'))
    .set('x-meghxl-device', bob.id).send({ to: target.handle, text: 'yo', fromName: 'Host', fromId: target.handle });
  assert.equal(dm.status, 200);
  const [, , payload] = sent.at(-1);
  assert.equal(payload.fromName, 'Bob');
  assert.equal(payload.fromId, bob.handle, 'replies go to the real sender');
});

test('device names that imitate the host are marked', () => {
  const { cleanName } = require('../src/text');
  assert.equal(cleanName('Host'), 'Host (device)');
  assert.equal(cleanName('A.d.m.i.n'), 'A.d.m.i.n (device)');
  assert.equal(cleanName('Hostel laptop'), 'Hostel laptop');
});

test('ownership: only the device that shared a file (or the host) can delete it', async () => {
  const owner = device('owner-device-000000001', 'Owner');
  const other = device('other-device-000000001', 'Other');
  const up = await lan(request(app).post('/api/upload'))
    .set('x-meghxl-device', owner.id).field('visibility', 'public')
    .attach('file', Buffer.from('mine'), { filename: 'mine.txt' });
  assert.equal(up.status, 200);
  assert.equal(up.body.ownerHandle, owner.handle);

  assert.equal((await lan(request(app).delete(`/api/files/${up.body.token}`))).status, 403, 'anonymous');
  assert.equal((await lan(request(app).delete(`/api/files/${up.body.token}`)).set('x-meghxl-device', other.id)).status, 403, 'another device');
  assert.equal((await lan(request(app).delete(`/api/files/${up.body.token}`)).set('x-meghxl-device', owner.id)).status, 200, 'owner');

  const up2 = await lan(request(app).post('/api/upload')).set('x-meghxl-device', owner.id)
    .field('visibility', 'public').attach('file', Buffer.from('x'), { filename: 'x.txt' });
  assert.equal((await request(app).delete(`/api/files/${up2.body.token}`)).status, 200, 'the host can delete anything');
});

test('ownership: messages too', async () => {
  const owner = device('note-owner-00000000001', 'Owner');
  const note = await lan(request(app).post('/api/notes')).set('x-meghxl-device', owner.id).send({ text: 'mine' });
  assert.equal((await lan(request(app).delete(`/api/notes/${note.body.id}`))).status, 403);
  assert.equal((await lan(request(app).delete(`/api/notes/${note.body.id}`)).set('x-meghxl-device', owner.id)).status, 200);
});

test('blocking covers every request, not just the live connection', async () => {
  store.addBlock({ deviceId: 'blocked-device-0000001', ip: null, name: 'x', at: Date.now() });
  const byId = await lan(request(app).post('/api/notes')).set('x-meghxl-device', 'blocked-device-0000001').send({ text: 'hi' });
  assert.equal(byId.status, 403);
  assert.equal((await lan(request(app).get('/api/files')).set('x-meghxl-device', 'blocked-device-0000001')).status, 403);

  store.addBlock({ deviceId: 'blocked-by-ip-00000001', ip: '10.66.66.66', name: 'y', at: Date.now() });
  assert.equal((await lan(request(app).get('/api/files'), '10.66.66.66')).status, 403, 'blocked by address too');
  // An address block lapses after a day: DHCP will have given it to someone else.
  store.listBlocked().find((b) => b.ip === '10.66.66.66').at = Date.now() - 25 * 60 * 60 * 1000;
  assert.equal((await lan(request(app).get('/api/files'), '10.66.66.66')).status, 200);
  assert.equal((await request(app).get('/api/files').set('x-meghxl-device', 'blocked-device-0000001')).status, 200, 'never the host');
});

test('filenames: invisible and dangerous characters are removed, the extension kept', async () => {
  const up = await request(app).post('/api/upload').field('visibility', 'public')
    .attach('file', Buffer.from('x'), { filename: 'photo‮gpj.exe' });
  assert.equal(up.body.originalName, 'photogpj.exe', 'no right-to-left override');
  const long = await request(app).post('/api/upload').field('visibility', 'public')
    .attach('file', Buffer.from('x'), { filename: 'a'.repeat(500) + '.pdf.exe' });
  assert.ok(long.body.originalName.length <= 180);
  assert.ok(long.body.originalName.endsWith('.exe'), 'truncation never hides the real extension');
  const odd = await request(app).post('/api/upload').field('visibility', 'public')
    .attach('file', Buffer.from('x'), { filename: "it's (draft)*.txt" });
  const dl = await request(app).get(`/d/${odd.body.token}`);
  assert.match(dl.headers['content-disposition'], /filename\*=UTF-8''it%27s%20%28draft%29_\.txt/);
});

test('programs are labelled — by extension, by content, and inside zips', async () => {
  const exe = await request(app).post('/api/upload').field('visibility', 'public')
    .attach('file', Buffer.from('MZ\x90\x00rest'), { filename: 'setup.exe', contentType: 'image/png' });
  assert.equal(exe.body.risk.kind, 'windows');
  assert.equal(exe.body.mime, 'application/octet-stream', "the sender's claimed type is ignored");

  const disguised = await request(app).post('/api/upload').field('visibility', 'public')
    .attach('file', Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 7, 0, 0, 1]), { filename: 'holiday.jpg', contentType: 'image/jpeg' });
  assert.equal(disguised.body.risk.kind, 'mac');
  assert.match(disguised.body.risk.mismatch, /Named \.jpg/);

  // A zip holding an app bundle.
  const zipped = await request(app).post('/api/upload').field('visibility', 'public')
    .attach('file', makeZip(['Invoice.app/Contents/MacOS/Invoice']), { filename: 'invoice.zip' });
  assert.equal(zipped.body.risk.reason, 'archive');
  assert.equal(zipped.body.risk.inner, 'Invoice.app');

  const plain = await request(app).post('/api/upload').field('visibility', 'public')
    .attach('file', Buffer.from('%PDF-1.7'), { filename: 'report.pdf' });
  assert.equal(plain.body.risk, null, 'ordinary files carry no label');
});

test('the host can refuse programs; nothing of a refused file is kept', async () => {
  store.setSettings({ blockPrograms: true });
  try {
    const before = fs.readdirSync(config.uploadDir).length;
    const r = await lan(request(app).post('/api/upload')).field('visibility', 'public')
      .attach('file', Buffer.from('#!/bin/sh\necho hi'), { filename: 'notes.txt' });
    assert.equal(r.status, 415);
    assert.equal(fs.readdirSync(config.uploadDir).length, before);
    const host = await request(app).post('/api/upload').field('visibility', 'public')
      .attach('file', Buffer.from('MZ'), { filename: 'tool.exe' });
    assert.equal(host.status, 200, 'the host itself may still share one');
  } finally { store.setSettings({ blockPrograms: false }); }
});

test('uploads are refused when the disk would drop below its reserve', async () => {
  const saved = config.minFreeBytes;
  config.minFreeBytes = Number.MAX_SAFE_INTEGER;
  disk.invalidate();
  try {
    const r = await lan(request(app).post('/api/upload')).field('visibility', 'public')
      .attach('file', Buffer.from('x'), { filename: 'x.txt' });
    assert.equal(r.status, 507);
  } finally { config.minFreeBytes = saved; disk.invalidate(); }
});

test('disk: an implausible statfs answer (Bun on macOS) is not trusted', () => {
  assert.equal(disk.fromStatfs({ bsize: 0, blocks: 4096, bavail: 244139436 }), null);
  assert.equal(disk.fromStatfs({ bsize: 4096, blocks: 100, bavail: 50 }), 4096 * 50);
});

test('tokens shaped like object keys are just "not found"', async () => {
  for (const t of ['__proto__', 'constructor', 'toString']) {
    assert.equal((await request(app).get(`/d/${t}`)).status, 404);
    assert.equal((await request(app).delete(`/api/files/${t}`)).status, 404);
  }
});

test('a malformed upload is a 400, not a server error', async () => {
  const r = await lan(request(app).post('/api/upload'))
    .set('Content-Type', 'multipart/form-data; boundary=zzz')
    .send('--zzz\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\n\r\nunterminated');
  assert.ok(r.status >= 400 && r.status < 500, `got ${r.status}`);
});

test('messages are rate-limited per address', async () => {
  const ip = '10.77.77.77';
  let last;
  for (let i = 0; i < 12; i++) last = await lan(request(app).post('/api/notes'), ip).send({ text: `n${i}` });
  assert.equal(last.status, 429);
});

test('private mode: only invited devices get in; links and the host still work', async () => {
  const pub = await request(app).post('/api/upload').field('visibility', 'private')
    .attach('file', Buffer.from('shared by link'), { filename: 'link.txt' });
  const host = request.agent(app);
  assert.equal((await host.post('/api/admin/settings').set('x-meghxl-request', '1').send({ privateMode: true })).status, 200);
  try {
    const { code, secret } = (await host.get('/api/admin/join')).body;
    assert.match(code, /^\d{6}$/);

    assert.equal((await lan(request(app).get('/api/files'))).status, 401, 'a stranger is turned away');
    assert.equal((await lan(request(app).get('/'))).status, 200, 'but can load the page to join');
    assert.equal((await lan(request(app).get(`/d/${pub.body.token}`))).status, 200, 'download links still work');
    assert.equal((await request(app).get('/api/files')).status, 200, 'the host never has to join');

    const wrong = await lan(request(app).post('/api/join')).send({ code: '000000' === code ? '111111' : '000000' });
    assert.equal(wrong.status, 403);

    const ok = await lan(request(app).post('/api/join')).send({ code });
    assert.equal(ok.status, 200);
    const cookie = ok.headers['set-cookie'][0].split(';')[0];
    assert.match(ok.headers['set-cookie'][0], /HttpOnly; SameSite=Strict/);
    assert.equal((await lan(request(app).get('/api/files')).set('Cookie', cookie)).status, 200, 'joined');

    const viaLink = await lan(request(app).post('/api/join')).send({ secret });
    assert.equal(viaLink.status, 200, 'the invite link works too');

    await host.post('/api/admin/join/rotate').set('x-meghxl-request', '1');
    assert.equal((await lan(request(app).get('/api/files')).set('Cookie', cookie)).status, 401, 'a new code revokes everyone');
  } finally {
    await host.post('/api/admin/settings').set('x-meghxl-request', '1').send({ privateMode: false });
  }
});

test('private mode: guessing the code is rate-limited', async () => {
  store.setSettings({ privateMode: true });
  try {
    const ip = '10.88.88.88';
    const codes = [];
    for (let i = 0; i < 7; i++) codes.push((await lan(request(app).post('/api/join'), ip).send({ code: String(100000 + i) })).status);
    assert.ok(codes.includes(429), `got ${codes}`);
  } finally { store.setSettings({ privateMode: false }); }
});

test('private mode: the WebSocket is closed to devices that have not joined', async () => {
  store.setSettings({ privateMode: true });
  const live = await liveHub();
  try {
    await assert.rejects(live.connect(), /401|Unexpected server response/);
  } finally { await live.close(); store.setSettings({ privateMode: false }); }
});

test('pages get a strict content security policy', async () => {
  const r = await request(app).get('/');
  const csp = r.headers['content-security-policy'];
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
});

test('the metadata file is private to this user', { skip: process.platform === 'win32' }, () => {
  store.flushSync();
  assert.equal(fs.statSync(config.dataFile).mode & 0o777, 0o600);
});

test('wrong admin keys lock that address out of key login for a while', async () => {
  runtime.adminKey = 'the-right-key-123';
  for (let i = 0; i < 10; i++) {
    await lan(request(app).get('/api/admin/state')).set('x-admin-key', `wrong-${i}`);
  }
  const right = await lan(request(app).get('/api/admin/state')).set('x-admin-key', 'the-right-key-123');
  assert.equal(right.status, 403, 'even the right key, until the window passes');
});

// ---------------------------------------------------------------------------
// Independent review of the 1.0.2 branch
// ---------------------------------------------------------------------------

test('private mode: changing the letter case of a path does not get around it', async () => {
  store.setSettings({ privateMode: true });
  try {
    for (const p of ['/API/files', '/Api/notes', '/api/FILES', '/API/qr?text=x']) {
      assert.equal((await lan(request(app).get(p))).status, 401, p);
    }
  } finally { store.setSettings({ privateMode: false }); }
});

test('zips: a program deep in a large index, or behind junk bytes, is still found', async () => {
  const padded = Array.from({ length: 2500 }, (_, i) => `pad/file-${i}.txt`).concat('evil.exe');
  const a = await request(app).post('/api/upload').field('visibility', 'public')
    .attach('file', makeZip(padded), { filename: 'photos.zip' });
  assert.equal(a.body.risk && a.body.risk.inner, 'evil.exe');

  const b = await request(app).post('/api/upload').field('visibility', 'public')
    .attach('file', makeZip(['run.sh'], { prefix: Buffer.alloc(5000, 7) }), { filename: 'data.zip' });
  assert.equal(b.body.risk && b.body.risk.inner, 'run.sh', 'scripts count, and a prefix does not hide the index');
});

test('disk images and web pages are labelled; archives it cannot read are refused only in strict mode', async () => {
  const iso = await request(app).post('/api/upload').field('visibility', 'public')
    .attach('file', Buffer.alloc(64), { filename: 'Setup.iso' });
  assert.equal(iso.body.risk.kind, 'diskimage');

  const nested = makeZip(['inner.zip']);
  const shown = await request(app).post('/api/upload').field('visibility', 'public')
    .attach('file', nested, { filename: 'bundle.zip' });
  assert.equal(shown.body.risk, null, 'no alarm for a zip of zips by default');

  store.setSettings({ blockPrograms: true });
  try {
    const refused = await lan(request(app).post('/api/upload')).field('visibility', 'public')
      .attach('file', nested, { filename: 'bundle.zip' });
    assert.equal(refused.status, 415);
    const rar = await lan(request(app).post('/api/upload')).field('visibility', 'public')
      .attach('file', Buffer.from('Rar!\x1a\x07\x00'), { filename: 'stuff.rar' });
    assert.equal(rar.status, 415);
  } finally { store.setSettings({ blockPrograms: false }); }
});

test('uploads at the same time cannot overrun the disk reserve together', async () => {
  const free = await disk.freeBytes();
  if (free == null) return; // nothing to measure against on this machine
  const saved = config.minFreeBytes;
  config.minFreeBytes = free - 3 * 1024 * 1024; // leaves room for ~3 MB
  disk.invalidate();
  try {
    const file = Buffer.alloc(2.5 * 1024 * 1024, 1);
    const send = (ip) => lan(request(app).post('/api/upload'), ip).field('visibility', 'private')
      .attach('file', file, { filename: 'big.bin' });
    const results = await Promise.all([send('10.5.5.1'), send('10.5.5.2')]);
    const codes = results.map((r) => r.status).sort();
    assert.deepEqual(codes, [200, 507]);
  } finally { config.minFreeBytes = saved; disk.invalidate(); }
});

test('uploads are rate-limited per address (the host is not)', async () => {
  const ip = '10.44.44.44';
  let last;
  for (let i = 0; i < 32; i++) {
    last = await lan(request(app).post('/api/upload'), ip).field('visibility', 'private')
      .attach('file', Buffer.from('x'), { filename: `f${i}.txt` });
  }
  assert.equal(last.status, 429);
});

test('a long name full of emoji stays downloadable', async () => {
  const up = await request(app).post('/api/upload').field('visibility', 'public')
    .attach('file', Buffer.from('x'), { filename: 'a'.repeat(175) + '😀'.repeat(10) + '.txt' });
  assert.ok(up.body.originalName.endsWith('.txt'));
  assert.equal((await request(app).get(`/d/${up.body.token}`)).status, 200);
});

test('names that only look like "Host" are marked', () => {
  const { cleanName } = require('../src/text');
  for (const n of ['Ноst', 'Ｈｏｓｔ', 'H0st', 'Adm1n']) {
    assert.match(cleanName(n), /\(device\)$/, n);
  }
});

test('owning a message does not depend on the hub remembering the name', async () => {
  const id = 'never-named-device-0001';
  const note = await lan(request(app).post('/api/notes')).set('x-meghxl-device', id).send({ text: 'mine' });
  assert.equal(note.body.ownerHandle, handleOf(id));
  assert.equal((await lan(request(app).delete(`/api/notes/${note.body.id}`)).set('x-meghxl-device', id)).status, 200);
});

test('the host is flagged by the hub, not by its name', async () => {
  const fake = device('fake-host-device-00001', 'Host');
  const fromDevice = await lan(request(app).post('/api/notes')).set('x-meghxl-device', fake.id).send({ text: 'hi' });
  assert.equal(fromDevice.body.fromHost, false);
  const fromHost = await request(app).post('/api/notes').send({ text: 'hello all' });
  assert.equal(fromHost.body.fromHost, true);
  assert.equal(fromHost.body.fromName, 'Host');
});

test('two devices cannot use the same name, even with lookalike letters', async () => {
  const live = await liveHub();
  try {
    await live.connect('sam-device-a-0000000001', 'Sam');
    const b = await live.connect('sam-device-b-0000000001', 'Ѕam'); // Cyrillic S
    const welcome = b.inbox.find((m) => m.type === 'welcome');
    assert.equal(welcome.payload.name, 'Ѕam (2)');
  } finally { await live.close(); }
});

test('a block made before the upgrade follows the device to its new id', async () => {
  store.addBlock({ deviceId: 'old-style-uuid-0000000001', ip: null, name: 'old', at: Date.now() });
  const live = await liveHub();
  try {
    const ws = await new Promise((resolve, reject) => {
      const s = new WebSocket(`ws://127.0.0.1:${live.port}/ws`, { headers: { 'X-Forwarded-For': '10.3.3.3' } });
      s.inbox = [];
      s.on('message', (d) => s.inbox.push(JSON.parse(d)));
      s.on('open', () => {
        s.send(JSON.stringify({ type: 'identify', deviceId: 'brand-new-device-000001', name: 'x', legacyId: 'old-style-uuid-0000000001' }));
        setTimeout(() => resolve(s), 120);
      });
      s.on('error', reject);
    });
    assert.ok(ws.inbox.some((m) => m.type === 'blocked'));
    assert.ok(store.isBlocked('brand-new-device-000001', null), 'the new id is blocked too');
    ws.terminate();
  } finally { await live.close(); }
});

test('blocks from before 1.0.2 keep their address; new ones lapse after a day', () => {
  const day = 25 * 60 * 60 * 1000;
  store.listBlocked().push({ deviceId: 'pre-102-0000000000001', ip: '10.9.9.1', at: Date.now() - day });
  assert.ok(store.isBlocked(null, '10.9.9.1'));
  store.addBlock({ deviceId: 'post-102-000000000001', ip: '10.9.9.2', at: Date.now() - day });
  assert.ok(!store.isBlocked(null, '10.9.9.2'));
});

test('too many wrong join codes overall change the code by itself', async () => {
  store.setSettings({ privateMode: true });
  try {
    const join = require('../src/join');
    const before = join.current().code;
    for (let i = 0; i < 30; i++) {
      await lan(request(app).post('/api/join'), `10.20.${i}.1`).send({ code: before === '999999' ? '999998' : '999999' });
    }
    assert.notEqual(join.current().code, before);
  } finally { store.setSettings({ privateMode: false }); }
});

test('the page policy allows only this hub\'s own WebSocket', async () => {
  const csp = (await request(app).get('/').set('Host', 'meghxl.local:3000')).headers['content-security-policy'];
  assert.match(csp, /connect-src 'self' ws:\/\/meghxl\.local:3000 wss:\/\/meghxl\.local:3000;/);
  assert.doesNotMatch(csp, /ws: |wss:;/);
});

test.after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});
