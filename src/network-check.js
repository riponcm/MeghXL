'use strict';

const os = require('node:os');
const { execFile } = require('node:child_process');

// ---------------------------------------------------------------------------
// Why can't phones reach the host?
//
// The most common reason MeghXL "doesn't work" is that the host computer
// blocks incoming connections: Windows treats the network as Public, or a
// firewall blocks everything coming in. Nothing on the phone can tell the
// difference between that and a hub that isn't running. So the host looks for
// those settings itself and says, in plain words, what to change.
//
// Read-only: this only asks the OS how it is set up; it never changes a
// firewall rule or network setting.
// ---------------------------------------------------------------------------

const CACHE_MS = 60 * 1000;
let cached = null;

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 8000, windowsHide: true }, (err, stdout) => resolve(err ? '' : String(stdout)));
  });
}

async function windowsChecks() {
  const out = [];
  const categories = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Get-NetConnectionProfile | ForEach-Object { $_.NetworkCategory }']);
  if (/Public/i.test(categories)) {
    out.push({
      id: 'win-public-network',
      level: 'block',
      text: 'Windows treats this network as Public, which blocks other devices from reaching MeghXL.',
      fix: 'Settings → Network & internet → Wi-Fi (or Ethernet) → your network → set "Network profile type" to Private.',
    });
  }
  out.push({
    id: 'win-firewall',
    level: 'hint',
    text: 'Windows Defender Firewall must allow MeghXL on private networks.',
    fix: 'If Windows asked when MeghXL first started, choose Allow. Otherwise: Windows Security → Firewall & network protection → Allow an app through firewall → tick MeghXL (Private).',
  });
  return out;
}

async function macChecks() {
  const out = [];
  const fw = '/usr/libexec/ApplicationFirewall/socketfilterfw';
  const [state, blockAll] = await Promise.all([run(fw, ['--getglobalstate']), run(fw, ['--getblockall'])]);
  if (/enabled|block all/i.test(blockAll) && !/disabled/i.test(blockAll)) {
    out.push({
      id: 'mac-block-all',
      level: 'block',
      text: 'The Mac firewall is set to block all incoming connections, so no device can reach MeghXL.',
      fix: 'System Settings → Network → Firewall → Options → turn off "Block all incoming connections".',
    });
  } else if (/enabled/i.test(state)) {
    out.push({
      id: 'mac-firewall-on',
      level: 'hint',
      text: 'The Mac firewall is on. That is fine as long as MeghXL is allowed.',
      fix: 'System Settings → Network → Firewall → Options → MeghXL: Allow incoming connections.',
    });
  }
  return out;
}

async function linuxChecks() {
  const ufw = await run('ufw', ['status']);
  if (/Status:\s*active/i.test(ufw)) {
    return [{
      id: 'linux-ufw',
      level: 'hint',
      text: 'The ufw firewall is active.',
      fix: 'Allow MeghXL\'s port, for example: sudo ufw allow 3000/tcp',
    }];
  }
  return [];
}

/** Settings on this computer that can stop devices reaching it. */
async function hostWarnings() {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.list;
  let list = [];
  try {
    if (process.platform === 'win32') list = await windowsChecks();
    else if (process.platform === 'darwin') list = await macChecks();
    else if (process.platform === 'linux') list = await linuxChecks();
  } catch { list = []; }
  cached = { at: Date.now(), list };
  return list;
}

/** Things outside this computer that commonly block devices, for when a test fails. */
const OTHER_CAUSES = [
  'The phone is on a different network — a guest Wi-Fi, mobile data, or a "5 GHz" network that is kept separate.',
  'The router keeps devices apart ("AP isolation" or "client isolation" — common on guest and office Wi-Fi).',
  'A VPN is on, on the phone or on this computer.',
];

/** A runtime description for diagnostics: OS, version, architecture. */
function platformInfo() {
  const runtime = process.versions.bun ? `Bun ${process.versions.bun}` : `Node ${process.versions.node}`;
  return `${os.type()} ${os.release()} (${process.platform}/${process.arch}), ${runtime}`;
}

module.exports = { hostWarnings, OTHER_CAUSES, platformInfo };
