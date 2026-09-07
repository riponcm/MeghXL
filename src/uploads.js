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

const upload = multer({
  storage,
  limits: {
    fileSize: config.maxUploadBytes,
    files: 1,
    fields: 10,
  },
});

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

module.exports = { upload, decodeOriginalName };
