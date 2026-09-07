'use strict';

const path = require('node:path');
const pkg = require('../package.json');
const { detectLanIPv4 } = require('./network');

const toPositiveInt = (value, fallback) => {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

// Max upload size in MB. 0 or unset = unlimited ("any size" by default);
// set MAX_UPLOAD_MB to a positive number to cap it.
const maxUploadMb = (() => {
  const n = parseInt(process.env.MAX_UPLOAD_MB, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
})();
const publicBaseUrl = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '') || null;
const mdnsName = (process.env.MDNS_NAME || 'meghxl')
  .toLowerCase()
  .replace(/[^a-z0-9-]/g, '-')
  .replace(/^-+|-+$/g, '') || 'meghxl';

module.exports = {
  version: pkg.version,
  port: toPositiveInt(process.env.PORT, 3000),
  host: '0.0.0.0',
  maxUploadMb, // 0 = unlimited
  maxUploadBytes: maxUploadMb > 0 ? maxUploadMb * 1024 * 1024 : Infinity,
  uploadDir: path.resolve(process.env.UPLOAD_DIR || './uploads'),
  dataFile: path.resolve(process.env.DATA_FILE || './metadata.json'),
  // Where the dashboard's static files live. Overridable so a packaged build
  // (the desktop app) can point at the assets it ships alongside the binary.
  publicDir: path.resolve(process.env.PUBLIC_DIR || path.join(__dirname, '..', 'public')),
  publicBaseUrl,
  lanIp: detectLanIPv4(),
  mdnsEnabled: process.env.MDNS !== 'off',
  mdnsName,
  // Optional: PCs (by LAN IP) that always get the admin console — every browser
  // on that PC included. e.g. ADMIN_IP=192.168.x.x,192.168.x.y
  adminIps: (process.env.ADMIN_IP || '')
    .split(',')
    .map((s) => s.trim().replace(/^::ffff:/, ''))
    .filter(Boolean),
};
