'use strict';

const crypto = require('node:crypto');

// ---------------------------------------------------------------------------
// Who is this device?
//
// Each browser keeps a random 128-bit device id in localStorage. Until 1.0.2
// that id was also broadcast in the device list — so any device could copy
// someone else's, identify as them, and silently receive their direct files
// and messages. Now the id is a secret between the browser and the hub:
//
//   - The id travels only from its own browser: in the WebSocket `identify`
//     message and the `x-meghxl-device` header on API calls.
//   - Everyone else sees a *handle*: an HMAC of the id under a key that lives
//     only in this process. Handles address sends and replies; they can't be
//     turned back into an id, so knowing one grants nothing.
//   - Sender names come from the hub's own record of the id, never from the
//     request body, so a message can't claim to be from someone else.
// ---------------------------------------------------------------------------

const DEVICE_HEADER = 'x-meghxl-device';
const HANDLE_KEY = crypto.randomBytes(32);
const VALID_ID = /^[A-Za-z0-9_-]{16,64}$/;

/** A well-formed device id, or null. */
function validId(v) {
  return typeof v === 'string' && VALID_ID.test(v) ? v : null;
}

/** The public stand-in for a device id. Stable for the life of the process. */
function handleOf(id) {
  if (!id) return null;
  return 'h_' + crypto.createHmac('sha256', HANDLE_KEY).update(id).digest('base64url').slice(0, 16);
}

/** The device id this request claims (from its header), or null. */
function deviceOf(req) {
  return validId(req.get ? req.get(DEVICE_HEADER) : req.headers[DEVICE_HEADER]);
}

/** Constant-time "is this the same device id?" */
function sameId(a, b) {
  if (!a || !b) return false;
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * The client's address. X-Forwarded-For is believed only from a proxy on this
 * machine; from anywhere else it's just a claim, and a LAN device could use it
 * to dodge a block or pose as another address.
 */
function remoteIp(req) {
  const peer = ((req.socket && req.socket.remoteAddress) || '').replace(/%.*$/, '');
  const bare = peer.replace(/^::ffff:/, '');
  if (bare === '127.0.0.1' || bare === '::1') {
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (fwd) return fwd.replace(/^::ffff:/, '');
  }
  return bare;
}

module.exports = { DEVICE_HEADER, validId, handleOf, deviceOf, sameId, remoteIp };
