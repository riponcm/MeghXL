'use strict';

const config = require('./config');
const store = require('./store');

const lanBase = () => `http://${config.lanIp}:${config.port}`;
// The mDNS name (e.g. http://meghxl.local:3000) — reachable by name from most
// devices, and it keeps the IP off screen. null when not advertising.
const friendlyBase = () => (config.mdnsEnabled ? `http://${config.mdnsName}.local:${config.port}` : null);

/**
 * The canonical base URL for SHAREABLE links + QR codes (file downloads, join).
 * No request needed — it must be routable from *other* devices, so it never
 * returns localhost. Precedence:
 *   1. PUBLIC_BASE_URL   (explicit override — e.g. behind your own VPN/proxy)
 *   2. Friendly name     (host-console setting linkHost = 'friendly')
 *   3. LAN IP            (default — resolvable by every device, Android included)
 */
function getShareBase() {
  if (config.publicBaseUrl) return config.publicBaseUrl;
  const prefer = (store.getSettings() || {}).linkHost;
  if (prefer === 'friendly' && friendlyBase()) return friendlyBase();
  return lanBase();
}

/**
 * Base URL honoring how *this* client reached us — used for the per-connection
 * "hello" so the dashboard knows its own origin. Falls through to getShareBase.
 */
function getBaseUrl(req) {
  if (config.publicBaseUrl) return config.publicBaseUrl;
  if (req) {
    const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http')
      .split(',')[0]
      .trim();
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    if (host) return `${proto}://${host}`;
  }
  return lanBase();
}

const shareDownloadUrl = (token) => `${getShareBase()}/d/${token}`;

module.exports = { getShareBase, getBaseUrl, shareDownloadUrl, lanBase, friendlyBase };
