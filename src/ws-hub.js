'use strict';

const { WebSocketServer, WebSocket } = require('ws');
const { getBaseUrl, getShareBase, friendlyBase } = require('./baseUrl');
const store = require('./store');

const HEARTBEAT_MS = 30000;

// Strip control characters (keep spaces + unicode), trim, and cap length.
function clean(s, max) {
  let out = '';
  for (const ch of String(s == null ? '' : s)) {
    if (ch.charCodeAt(0) >= 32) out += ch;
  }
  return out.trim().slice(0, max);
}

/**
 * WebSocket hub. Broadcasts live events, and tracks a roster of connected
 * "devices" (each browser identifies itself with a stable id + name) so the
 * dashboard can show who's online and send files straight to one of them.
 */
function createHub(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

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

  // Deduplicated list of connected devices (one entry per deviceId, even if a
  // device has several tabs open).
  function roster() {
    const byId = new Map();
    for (const ws of wss.clients) {
      const d = ws.device;
      if (d && !byId.has(d.id)) byId.set(d.id, { id: d.id, name: d.name, kind: d.kind });
    }
    return [...byId.values()];
  }

  function broadcastRoster() {
    broadcast('roster', { devices: roster() });
  }

  // Deliver an event to every socket belonging to a given device. Returns the
  // number of sockets reached (0 means the device is offline).
  function sendToDevice(deviceId, type, payload) {
    let delivered = 0;
    for (const ws of wss.clients) {
      if (ws.device && ws.device.id === deviceId) {
        sendTo(ws, type, payload);
        delivered++;
      }
    }
    return delivered;
  }

  // Roster with IP + connect time, for the admin console only (not broadcast).
  function rosterDetailed() {
    const byId = new Map();
    for (const ws of wss.clients) {
      const d = ws.device;
      if (!d) continue;
      const cur = byId.get(d.id);
      if (!cur) {
        byId.set(d.id, { id: d.id, name: d.name, kind: d.kind, ip: ws.ip, connectedAt: ws.connectedAt });
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

  wss.on('connection', (ws, req) => {
    ws.isAlive = true;
    ws.device = null;
    ws.ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
      (req.socket && req.socket.remoteAddress) || '';
    ws.connectedAt = Date.now();
    ws.on('pong', () => { ws.isAlive = true; });

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
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      if (!msg || typeof msg !== 'object') return;

      if (msg.type === 'identify') {
        const id = clean(msg.deviceId, 64);
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
          name = clean(msg.name, 60) || 'Device';
          store.setDeviceName(id, name);
        }
        ws.device = {
          id,
          name,
          kind: ['mobile', 'tablet', 'desktop'].includes(msg.kind) ? msg.kind : 'desktop',
        };
        broadcastRoster();
      } else if (msg.type === 'rename') {
        // A device may rename ONLY itself: we use this socket's own id and ignore
        // any target in the message, so no one can rename someone else's device.
        const name = clean(msg.name, 60);
        if (!ws.device || !name) return;
        const id = ws.device.id;
        store.setDeviceName(id, name);
        for (const c of wss.clients) {
          if (c.device && c.device.id === id) c.device.name = name;
        }
        broadcastRoster();
      }
    });

    ws.on('close', () => broadcastRoster());
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

  return { wss, broadcast, broadcastRoster, sendToDevice, rosterDetailed, kickDevice };
}

module.exports = { createHub };
