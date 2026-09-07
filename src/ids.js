'use strict';

const crypto = require('node:crypto');
const path = require('node:path');

/**
 * 128-bit, URL-safe random token (22 chars). Doubles as the public file id and
 * the download token — for private files it is the *only* access control, so it
 * must stay long and unguessable.
 */
function token() {
  return crypto.randomBytes(16).toString('base64url');
}

/** Random id for notes. */
function noteId() {
  return 'n_' + crypto.randomBytes(9).toString('base64url');
}

/**
 * Build a safe on-disk filename from a random base plus a sanitized extension.
 * The client's original filename NEVER becomes part of the path — this is the
 * core path-traversal defense.
 */
function storedName(originalName = '') {
  let ext = path.extname(String(originalName)).toLowerCase();
  if (!/^\.[a-z0-9]{1,12}$/.test(ext)) ext = '';
  return crypto.randomBytes(16).toString('hex') + ext;
}

module.exports = { token, noteId, storedName };
