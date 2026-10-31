'use strict';

const { WebSocketServer, WebSocket } = require('ws');
const { getBaseUrl, getShareBase, friendlyBase } = require('./baseUrl');
const store = require('./store');
const join = require('./join');
const { isAllowedUpgrade } = require('./request-guard');
const { isAdmin } = require('./admin-auth');
const { validId, handleOf, remoteIp } = require('./identity');
const { cleanName } = require('./text');
const { createCounter } = require('./limits');

const HEARTBEAT_MS = 30000;
// Every message a client sends is a few hundred bytes of JSON. Without a cap
// the ws library accepts frames up to 100 MB — and one over that used to crash
// the whole server.
const MAX_PAYLOAD = 64 * 1024;
const MAX_SOCKETS_PER_IP = 20;
const MAX_SOCKETS = 1000;
const MSG_BURST = 30;
const MSG_PER_SEC = 10;

/**
 * WebSocket hub. Broadcasts live events, and tracks a roster of connected
 * "devices" (each browser identifies itself with a stable id + name) so the
 * dashboard can show who's online and send files straight to one of them.
 */
function createHub(server) {
  // Browsers don't apply CORS to WebSockets, so without this any website open
  // on the host PC could join the board through that browser.
  const wss = new WebSocketServer({
    server,
    path: '/ws',
    maxPayload: MAX_PAYLOAD,
    // In private mode the board is for devices that joined (or the host) only.
    verifyClient: ({ req }) => isAllowedUpgrade(req) &&
      (!join.isEnabled() || join.hasSession(req) || isAdmin(req)),
  });
  // An error event with no listener throws and takes the process down.
  wss.on('error', (err) => console.error(`[ws] ${err.message}`));
  const perIp = createCounter(MAX_SOCKETS_PER_IP);

  const sendTo = (ws, type, payload) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type, payload, ts: Date.now() }));
    }
  };

  function broadcast(type, payload) {
    const msg = JSON.stringify({ type, payload, ts: Date.now() });
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(msg);
    }
  }

  // Deduplicated list of connected devices (one entry per device, even if it
  // has several tabs open). Devices are listed by handle, never by their id —
  // see src/identity.js.
  function roster() {
    const byId = new Map();
    for (const ws of wss.clients) {
      const d = ws.device;
      if (d && !byId.has(d.handle)) byId.set(d.handle, { id: d.handle, name: d.name, kind: d.kind });
    }
    return [...byId.values()];
  }

  function broadcastRoster() {
    broadcast('roster', { devices: roster() });
  }

  // Deliver an event to every socket of the device with this handle. Returns
  // the number of sockets reached (0 means the device is offline).
  function sendToDevice(handle, type, payload) {
    let delivered = 0;
    for (const ws of wss.clients) {
      if (ws.device && ws.device.handle === handle) {
        sendTo(ws, type, payload);
        delivered++;
      }
    }
    return delivered;
  }

  /** The device id behind a handle, if that device is online. */
  function idOfHandle(handle) {
    for (const ws of wss.clients) if (ws.device && ws.device.handle === handle) return ws.device.id;
    return null;
  }

  // Roster with IP + connect time, for the admin console only (not broadcast).
  function rosterDetailed() {
    const byId = new Map();
    for (const ws of wss.clients) {
      const d = ws.device;
      if (!d) continue;
      const cur = byId.get(d.id);
      if (!cur) {
        byId.set(d.id, { id: d.id, handle: d.handle, name: d.name, kind: d.kind, ip: ws.ip, connectedAt: ws.connectedAt });
      } else if (ws.connectedAt < cur.connectedAt) {
        cur.connectedAt = ws.connectedAt;
      }
    }
    return [...byId.values()];
  }

  // Disconnect every socket of a device (used by Block).
  function kickDevice(deviceId) {
    let n = 0;
    for (const ws of wss.clients) {
      if (ws.device && ws.device.id === deviceId) {
        sendTo(ws, 'blocked', { reason: 'You were blocked by the host.' });
        try { ws.close(); } catch { /* ignore */ }
        n++;
      }
    }
    return n;
  }

  // Private mode was switched on, or its code changed: disconnect every socket
  // that no longer qualifies. `stillJoined(ws)` decides; the host always stays.
  function kickUnjoined(stillJoined) {
    let n = 0;
    for (const ws of wss.clients) {
      if (ws.isHost || stillJoined(ws)) continue;
      sendTo(ws, 'join-required', {});
      try { ws.close(4001, 'join required'); } catch { /* ignore */ }
      n++;
    }
    if (n) broadcastRoster();
    return n;
  }

  wss.on('connection', (ws, req) => {
    ws.isAlive = true;
    ws.device = null;
    // X-Forwarded-For is trusted only from a reverse proxy on this machine.
    ws.ip = remoteIp(req);
    ws.connectedAt = Date.now();
    ws.isHost = isAdmin(req);
    ws.joinedAtConnect = join.hasSession(req);
    // A socket that errors (oversized frame, bad framing) is closed by ws; the
    // listener is what keeps that from being an uncaught exception.
    ws.on('error', () => { try { ws.terminate(); } catch { /* ignore */ } });
    ws.on('pong', () => { ws.isAlive = true; });

    if (wss.clients.size > MAX_SOCKETS || !perIp.tryAcquire(ws.ip)) {
      ws.close(1013, 'too many connections');
      return;
    }
    ws.on('close', () => perIp.release(ws.ip));

    // A token bucket per socket: a burst of MSG_BURST, then MSG_PER_SEC.
    let tokens = MSG_BURST;
    let refilledAt = Date.now();
    const allowMessage = () => {
      const t = Date.now();
      tokens = Math.min(MSG_BURST, tokens + ((t - refilledAt) / 1000) * MSG_PER_SEC);
      refilledAt = t;
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    };

    // Reject blocked devices (by IP) the moment they connect.
    if (store.isBlocked(null, ws.ip)) {
      sendTo(ws, 'blocked', { reason: 'This device is blocked by the host.' });
      ws.close();
      return;
    }

    sendTo(ws, 'hello', {
      baseUrl: getBaseUrl(req),
      shareBase: getShareBase(),
      friendlyBase: friendlyBase(),
      clients: wss.clients.size,
      announcement: store.latestAnnouncement(),
    });

    ws.on('message', (data) => {
      if (!allowMessage()) {
        ws.close(1008, 'slow down');
        return;
      }
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      if (!msg || typeof msg !== 'object') return;

      if (msg.type === 'identify') {
        // One identity per socket: a socket can't hop between devices.
        if (ws.device) return;
        const id = validId(msg.deviceId);
        if (!id) return;
        if (store.isBlocked(id, ws.ip)) {
          sendTo(ws, 'blocked', { reason: 'This device is blocked by the host.' });
          ws.close();
          return;
        }
        // A previously-saved name (server is the source of truth) wins, so names
        // survive restarts; otherwise remember the name this device announces.
        let name = store.getDeviceName(id);
        if (!name) {
          name = cleanName(msg.name) || 'Device';
          store.setDeviceName(id, name);
        } else {
          store.touchDevice(id);
        }
        ws.device = {
          id,
          handle: handleOf(id),
          name,
          kind: ['mobile', 'tablet', 'desktop'].includes(msg.kind) ? msg.kind : 'desktop',
        };
        // The device's own handle, so it can find itself in the roster.
        sendTo(ws, 'welcome', { handle: ws.device.handle, name });
        broadcastRoster();
      } else if (msg.type === 'rename') {
        // A socket renames only the device it identified as; any target in the
        // message is ignored. Ids are never shared, so nobody else can
        // identify as this device to rename it.
        const name = cleanName(msg.name);
        if (!ws.device || !name) return;
        const id = ws.device.id;
        store.setDeviceName(id, name);
        for (const c of wss.clients) {
          if (c.device && c.device.id === id) c.device.name = name;
        }
        broadcastRoster();
      }
    });

    ws.on('close', () => { if (ws.device) broadcastRoster(); });
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* ignore */ }
    }
  }, HEARTBEAT_MS);
  if (heartbeat.unref) heartbeat.unref();
  wss.on('close', () => clearInterval(heartbeat));

  return { wss, broadcast, broadcastRoster, sendToDevice, idOfHandle, rosterDetailed, kickDevice, kickUnjoined };
}

module.exports = { createHub };
