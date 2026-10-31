'use strict';

const express = require('express');
const join = require('../join');
const { isAdmin } = require('../admin-auth');
const { remoteIp } = require('../identity');
const { rateLimit } = require('../limits');

/** Joining a private hub — see src/join.js. */
module.exports = function createJoinRouter() {
  const router = express.Router();
  // A 6-digit code has a million values; five tries a minute per address puts
  // guessing it out of reach long before anyone notices the hub is private.
  const attempts = rateLimit({ burst: 5, perMinute: 5, keyOf: remoteIp,
    message: 'Too many attempts — wait a minute and try again.' });

  router.get('/api/join/status', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const privateMode = join.isEnabled();
    res.json({ privateMode, joined: !privateMode || join.hasSession(req) || isAdmin(req) });
  });

  // POST /api/join { secret } (from an invite link) or { code } (typed)
  router.post('/api/join', attempts, (req, res) => {
    if (!join.isEnabled()) return res.json({ ok: true });
    const body = req.body || {};
    if (!join.check({ secret: body.secret, code: body.code })) {
      return res.status(403).json({ error: 'That code is not right. Ask the host for the current one.' });
    }
    res.setHeader('Set-Cookie', join.issueSession(req.secure));
    res.json({ ok: true });
  });

  return { router };
};
