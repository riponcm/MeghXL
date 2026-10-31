'use strict';

const fs = require('node:fs');
const multer = require('multer');
const config = require('./config');
const { storedName } = require('./ids');

// Ensure the storage directory exists before multer tries to write to it.
fs.mkdirSync(config.uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, config.uploadDir),
  filename: (req, file, cb) => cb(null, storedName(file.originalname)),
});

/**
 * An upload handler that stops at `maxBytes` — the size cap, or less when the
 * disk is nearly full (see src/disk.js). Built per request because the limit
 * moves with free space; multer instances are cheap.
 */
function uploadWithin(maxBytes) {
  return multer({
    storage,
    limits: {
      fileSize: maxBytes,
      files: 1,
      fields: 10,
      fieldSize: 8 * 1024,
    },
  });
}

/**
 * multer/busboy decode the multipart filename as latin1; reinterpret it as utf8
 * so unicode filenames (e.g. accents, CJK) survive. ASCII names are unaffected.
 */
function decodeOriginalName(name) {
  try {
    return Buffer.from(String(name), 'latin1').toString('utf8');
  } catch {
    return String(name);
  }
}

module.exports = { uploadWithin, decodeOriginalName };
