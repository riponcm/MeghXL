'use strict';

const crypto = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');
const { getBaseUrl, getShareBase, friendlyBase } = require('./baseUrl');
const store = require('./store');
const join = require('./join');
const { isAllowedUpgrade } = require('./request-guard');
const { isAdmin } = require('./admin-auth');
const { validId, handleOf, remoteIp } = require('./identity');
const { cleanName, skeleton } = require('./text');
const { createCounter, createBucket } = require('./limits');
const activity = require('./activity');
const disk = require('./disk');

const HEARTBEAT_MS = 30000;
// Every message a client sends is a few hundred bytes of JSON. Without a cap
// the ws library accepts frames up to 100 MB — and one over that used to crash
// the whole server.
const MAX_PAYLOAD = 64 * 1024;
const MAX_SOCKETS_PER_IP = 20;
const MAX_SOCKETS = 1000;
const MSG_BURST = 30;
const MSG_PER_SEC = 10;
// More desktop devices than this at one address looks like a shared router,
// VPN or container network rather than one computer: don't group them.
const MAX_BROWSERS_PER_COMPUTER = 4;
// The name a browser gives itself before anyone renames it ("Mac · Safari").
const DEFAULT_NAME = /^(iPhone|iPad|Android|Mac|Windows|Linux|Device)( · (Edge|Opera|Firefox|Chrome|Safari))?$/;
const GROUP_KEY = crypto.randomBytes(16);

const settings = () => store.getSettings();
const approvingDevices = () => settings().approveDevices === true;
const approvingRenames = () => settings().approveRenames === true;
const groupingBrowsers = () => settings().groupBrowsers !== false; // on unless turned off
const loopback = (ip) => /^(127\.|::1$|::ffff:127\.)/.test(ip || '');
const privateAddress = (ip) => loopback(ip) ||
  /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|f[cd][0-9a-f]{2}:|fe80:)/i.test(ip || '');

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
  // New devices remembered per address: plenty for real phones and laptops,
  // too few for a script minting ids to push everyone else's names out.
  const newDevices = createBucket({ burst: 20, perMinute: 10 / 60 });

  // ---- one computer, several browsers -------------------------------------
  // Browsers can't see each other's storage, so Safari and Chrome on the same
  // Mac are separate devices to the hub. What they share is their address.
  // Desktop browsers at the same private address are treated as one computer:
  // one name, listed together, and a direct send reaches all of them. It's
  // only ever about names and delivery between browsers on that address —
  // never a way in: each browser still has its own secret id.

  /** The computer key for an address, or null when grouping doesn't apply. */
  function computerKey(ip, kind) {
    if (!groupingBrowsers() || kind !== 'desktop' || !privateAddress(ip)) return null;
    const ids = new Set();
    for (const c of wss.clients) {
      if (c.device && c.device.kind === 'desktop' && c.ip === ip) ids.add(c.device.id);
    }
    if (ids.size > MAX_BROWSERS_PER_COMPUTER) return null;
    return loopback(ip) ? 'loopback' : ip;
  }
  /** What other devices see for a computer: a stand-in, never the address. */
  const groupTag = (key) => key && 'c_' + crypto.createHmac('sha256', GROUP_KEY).update(key).digest('base64url').slice(0, 10);
  const keyOf = (ws) => (ws.device ? computerKey(ws.ip, ws.device.kind) : null);
  /** Device ids of every browser on the same computer as this one (itself included). */
  function sameComputer(ws) {
    const key = keyOf(ws);
    const ids = new Set([ws.device.id]);
    if (!key) return ids;
    for (const c of wss.clients) if (c.device && keyOf(c) === key) ids.add(c.device.id);
    return ids;
  }

  /**
   * A name nobody else online is using. Compared by skeleton, so "Sam" and
   * "Ѕam" (Cyrillic S) count as the same; the newcomer gets "Sam (2)".
   * Browsers on the same computer share their name, so they don't count.
   */
  function uniqueName(id, wanted, own = new Set([id])) {
    const taken = new Set();
    for (const c of wss.clients) if (c.device && !own.has(c.device.id)) taken.add(skeleton(c.device.name));
    if (!taken.has(skeleton(wanted))) return wanted;
    for (let n = 2; n < 100; n++) {
      const candidate = `${wanted} (${n})`;
      if (!taken.has(skeleton(candidate))) return candidate;
    }
    return `${wanted} (${Date.now() % 1000})`;
  }

  /** The current name of an online device, by its id. */
  function nameOfId(id) {
    if (!id) return null;
    for (const c of wss.clients) if (c.device && c.device.id === id) return c.device.name;
    return null;
  }

  const sendTo = (ws, type, payload) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type, payload, ts: Date.now() }));
    }
  };

  // While the host approves devices, a device waiting for approval (or one
  // that hasn't said who it is) hears nothing from the board.
  const admitted = (ws) => ws.isHost || !approvingDevices() || (ws.device && store.isApproved(ws.device.id));

  function broadcast(type, payload) {
    const msg = JSON.stringify({ type, payload, ts: Date.now() });
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN && admitted(client)) client.send(msg);
    }
  }

  /** Tell every host console something changed (requests, activity). */
  function notifyHosts(type, payload = {}) {
    for (const c of wss.clients) if (c.isHost) sendTo(c, type, payload);
  }

  // Deduplicated list of connected devices (one entry per device, even if it
  // has several tabs open). Devices are listed by handle, never by their id —
  // see src/identity.js.
  function roster() {
    const byId = new Map();
    for (const ws of wss.clients) {
      const d = ws.device;
      if (d && !byId.has(d.handle)) {
        byId.set(d.handle, { id: d.handle, name: d.name, kind: d.kind, agent: d.agent || null, computer: groupTag(keyOf(ws)) });
      }
    }
    return [...byId.values()];
  }

  function broadcastRoster() {
    broadcast('roster', { devices: roster() });
  }

  // Deliver an event to every socket of the device with this handle — and to
  // the other browsers on the same computer, which share its name. Returns the
  // number of sockets reached (0 means the device is offline).
  function sendToDevice(handle, type, payload) {
    let target = null;
    for (const ws of wss.clients) if (ws.device && ws.device.handle === handle) { target = ws; break; }
    if (!target) return 0;
    const ids = sameComputer(target);
    let delivered = 0;
    for (const ws of wss.clients) {
      if (ws.device && ids.has(ws.device.id) && admitted(ws)) {
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
        byId.set(d.id, { id: d.id, handle: d.handle, name: d.name, kind: d.kind, agent: d.agent || null,
          computer: groupTag(keyOf(ws)), ip: ws.ip, connectedAt: ws.connectedAt });
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

  // ---- names ----------------------------------------------------------------

  /**
   * Give a device a name — and every browser on the same computer with it.
   * Returns the name actually used (made unique among other devices).
   */
  function applyName(ws, wanted) {
    const ids = sameComputer(ws);
    const name = uniqueName(ws.device.id, wanted, ids);
    for (const id of ids) store.setDeviceName(id, name);
    const key = keyOf(ws);
    if (key) store.setComputerName(key, name);
    for (const c of wss.clients) if (c.device && ids.has(c.device.id)) c.device.name = name;
    broadcastRoster();
    return name;
  }

  function socketOf(deviceId) {
    for (const c of wss.clients) if ((c.device && c.device.id === deviceId) || (c.pending && c.pending.id === deviceId)) return c;
    return null;
  }

  /** Ask the host to approve a name. */
  function requestRename(ws, wanted) {
    const r = store.addRequest({
      id: 'r_' + crypto.randomBytes(6).toString('hex'),
      type: 'rename',
      deviceId: ws.device.id,
      handle: ws.device.handle,
      from: ws.device.name,
      wanted,
      ip: ws.ip,
      at: Date.now(),
    });
    activity.log('rename-requested', `“${r.from}” asked to be called “${wanted}”`, { ip: ws.ip });
    sendTo(ws, 'rename-pending', { wanted });
    notifyHosts('requests-changed');
  }

  // ---- approving requests (host console) -------------------------------------

  /** Approve or decline a request. Returns false if it no longer exists. */
  function decide(requestId, accept) {
    const r = store.takeRequest(requestId);
    if (!r) return false;
    const ws = socketOf(r.deviceId);
    if (r.type === 'rename') {
      if (accept && ws && ws.device) {
        const name = applyName(ws, r.wanted);
        activity.log('rename-approved', `Approved the name “${name}” (was “${r.from}”)`);
      } else if (accept) {
        store.setDeviceName(r.deviceId, r.wanted); // offline: takes effect next visit
        activity.log('rename-approved', `Approved the name “${r.wanted}” (was “${r.from}”)`);
      } else {
        activity.log('rename-declined', `Declined the name “${r.wanted}” for “${r.from}”`);
        for (const c of wss.clients) if (c.device && c.device.id === r.deviceId) sendTo(c, 'rename-declined', { name: c.device.name });
      }
    } else if (r.type === 'device') {
      if (accept) {
        store.approve(r.deviceId);
        activity.log('device-approved', `Let in “${r.name}”`);
        for (const c of wss.clients) {
          if (c.pending && c.pending.id === r.deviceId) {
            c.device = c.pending;
            c.pending = null;
            sendTo(c, 'approved', {});
          }
        }
        broadcastRoster();
      } else {
        store.addBlock({ deviceId: r.deviceId, ip: r.ip, name: r.name, at: Date.now() });
        activity.log('device-declined', `Turned away “${r.name}” (blocked)`, { ip: r.ip });
        for (const c of wss.clients) {
          if (c.pending && c.pending.id === r.deviceId) {
            sendTo(c, 'blocked', { reason: 'The host did not let this device in.' });
            try { c.close(); } catch { /* ignore */ }
          }
        }
      }
    }
    notifyHosts('requests-changed');
    return true;
  }

  /** Approving devices was just switched on: everyone already here stays. */
  function approveEveryoneOnline() {
    for (const c of wss.clients) if (c.device) store.approve(c.device.id);
  }

  /** The upload limit this socket's device should check against. */
  function limitsFor(ws) {
    const cap = disk.fileCap(ws.isHost);
    return { maxUploadBytes: Number.isFinite(cap) ? cap : null };
  }
  function pushLimits() {
    for (const c of wss.clients) sendTo(c, 'limits', limitsFor(c));
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
      announcement: admitted(ws) ? store.latestAnnouncement() : null,
      ...limitsFor(ws),
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
        if (ws.device || ws.pending) return;
        const id = validId(msg.deviceId);
        if (!id) return;
        // A browser upgrading from 1.0.1 sends its old id once, so a block on
        // that id follows it to the new one.
        const legacyId = validId(msg.legacyId);
        if (legacyId && store.isBlocked(legacyId, null)) {
          store.addBlock({ deviceId: id, ip: ws.ip, name: cleanName(msg.name) || 'Device', at: Date.now() });
        }
        if (store.isBlocked(id, ws.ip)) {
          sendTo(ws, 'blocked', { reason: 'This device is blocked by the host.' });
          ws.close();
          return;
        }
        const kind = ['mobile', 'tablet', 'desktop'].includes(msg.kind) ? msg.kind : 'desktop';
        const agent = cleanName(msg.agent, 20) || null; // "Safari", for the device list
        const announced = cleanName(msg.name) || 'Device';
        // A previously-saved name (server is the source of truth) wins, so names
        // survive restarts. A new browser on a computer we know takes that
        // computer's name. Otherwise, the name this device announces — though
        // while the host approves names, a new device only gets a browser's
        // default name and asks for the one it wanted.
        const saved = store.getDeviceName(id);
        const key = computerKey(ws.ip, kind);
        const computerName = !saved && key ? store.getComputerName(key) : null;
        let wanted = saved || computerName || announced;
        let askFor = null;
        if (!saved && !computerName && approvingRenames() && !ws.isHost && !DEFAULT_NAME.test(announced)) {
          askFor = announced;
          wanted = kind === 'desktop' ? 'Computer' : 'Phone';
        }
        const device = { id, handle: handleOf(id), name: wanted, kind, agent };

        // While the host approves devices, a new one waits outside.
        if (approvingDevices() && !ws.isHost && !store.isApproved(id)) {
          ws.pending = device;
          store.addRequest({
            id: 'r_' + crypto.randomBytes(6).toString('hex'),
            type: 'device', deviceId: id, handle: device.handle, name: announced, agent, kind,
            ip: ws.ip, at: Date.now(),
          });
          activity.log('device-waiting', `“${announced}” is waiting to be let in`, { ip: ws.ip });
          sendTo(ws, 'approval-pending', { name: announced });
          notifyHosts('requests-changed');
          return;
        }

        ws.device = device;
        const others = new Set([id]);
        for (const c of wss.clients) if (c !== ws && c.device && key && keyOf(c) === key) others.add(c.device.id);
        const name = uniqueName(id, wanted, others);
        device.name = name;
        if (!saved || name !== saved) {
          // Remember it — unless this address is minting devices too fast, in
          // which case the name lasts for this connection only.
          if (saved || newDevices.take(ws.ip)) {
            store.setDeviceName(id, name);
            if (!saved) activity.log('device-new', `New device “${name}”${agent ? ` (${agent})` : ''}`, { ip: ws.ip });
          }
        } else {
          store.touchDevice(id);
        }
        // The device's own handle, so it can find itself in the roster.
        sendTo(ws, 'welcome', { handle: device.handle, name });
        if (askFor) requestRename(ws, askFor);
        broadcastRoster();
      } else if (msg.type === 'rename') {
        // A socket renames only the device it identified as; any target in the
        // message is ignored. Ids are never shared, so nobody else can
        // identify as this device to rename it.
        const wanted = cleanName(msg.name);
        if (!ws.device || !wanted || wanted === ws.device.name) return;
        if (approvingRenames() && !ws.isHost) return requestRename(ws, wanted);
        applyName(ws, wanted);
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

  return {
    wss, broadcast, broadcastRoster, sendToDevice, idOfHandle, nameOfId, rosterDetailed, kickDevice, kickUnjoined,
    decide, approveEveryoneOnline, pushLimits, notifyHosts,
  };
}

module.exports = { createHub };
