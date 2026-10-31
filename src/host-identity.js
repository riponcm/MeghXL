'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('./config');

// ---------------------------------------------------------------------------
// The host's identity: an Ed25519 key that only the host computer holds.
//
// MeghXL has exactly one host. Desktop apps on other computers remember the
// host's public key the first time they pair, and from then on make it prove
// itself (sign a fresh challenge) before they trust it. A computer that merely
// answers as "meghxl.local" — or that knocked the real host offline — has no
// key, so it can't pass.
//
// The key can leave the host in only two ways, both deliberate:
//   - the recovery key, which the host owner saves somewhere safe and uses to
//     restore the host on a replacement computer, and
//   - a planned move, where the old host hands its key to the new one over an
//     encrypted channel opened with a one-time transfer code.
// After a move the old computer forgets its key and only points to the new
// host ("retired").
//
// Stored in its own file next to the metadata, readable by this user only.
// ---------------------------------------------------------------------------

const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const PROOF_CONTEXT = 'meghxl-host-proof-v1\n';
// Crockford base32: no I, L, O or U, so a code read aloud or off paper survives.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const identityFile = () => path.join(path.dirname(config.dataFile), 'host-identity.json');

let cached = null; // { seed?: Buffer, publicKey: Buffer, createdAt, retired? }

function base32(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function unbase32(text) {
  const clean = String(text).toUpperCase().replace(/[^0-9A-Z]/g, '')
    .replace(/[IL]/g, '1').replace(/O/g, '0');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const v = ALPHABET.indexOf(ch);
    if (v === -1) return null;
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  // The last character's spare bits are always zero; anything else is a typo
  // that would otherwise decode to the same bytes.
  if (value & ((1 << bits) - 1)) return null;
  return Buffer.from(out);
}

const group = (s, n) => s.match(new RegExp(`.{1,${n}}`, 'g')).join('-');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest();

function privateKeyOf(seed) {
  return crypto.createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
}
function publicKeyOf(seed) {
  return crypto.createPublicKey(privateKeyOf(seed)).export({ format: 'der', type: 'spki' }).subarray(-32);
}
function publicKeyObject(raw) {
  return crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

/** A short, human-comparable form of a public key: "7F3A-91C2-0D4E-B8K5". */
function fingerprintOf(publicKey) {
  return group(base32(sha256(publicKey)).slice(0, 16), 4);
}

function save(state) {
  const data = {
    publicKey: state.publicKey.toString('base64'),
    createdAt: state.createdAt,
    ...(state.seed ? { seed: state.seed.toString('base64') } : {}),
    ...(state.retired ? { retired: state.retired } : {}),
  };
  const file = identityFile();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  cached = state;
}

/** Load the identity, creating one on first run. */
function load() {
  if (cached) return cached;
  try {
    const raw = JSON.parse(fs.readFileSync(identityFile(), 'utf8'));
    const state = {
      publicKey: Buffer.from(raw.publicKey, 'base64'),
      createdAt: raw.createdAt,
      seed: raw.seed ? Buffer.from(raw.seed, 'base64') : null,
      retired: raw.retired || null,
    };
    if (state.seed && !publicKeyOf(state.seed).equals(state.publicKey)) throw new Error('key does not match');
    try { fs.chmodSync(identityFile(), 0o600); } catch { /* best effort */ }
    cached = state;
    return state;
  } catch (err) {
    if (err.code !== 'ENOENT') {
      // Never silently replace a damaged identity: paired apps would stop
      // trusting this host. Keep the file and refuse to start without it.
      throw new Error(`[identity] ${identityFile()} can't be read (${err.message}). Restore it, or restore the host from its recovery key.`);
    }
  }
  const seed = crypto.randomBytes(32);
  save({ seed, publicKey: publicKeyOf(seed), createdAt: Date.now(), retired: null });
  return cached;
}

function publicInfo() {
  const s = load();
  return {
    publicKey: s.publicKey.toString('base64'),
    fingerprint: fingerprintOf(s.publicKey),
    retired: s.retired || null,
  };
}

const isRetired = () => !!load().retired;

/**
 * Sign a challenge from a desktop app. The context string keeps a signature
 * made here from meaning anything anywhere else.
 */
function prove(nonce) {
  const s = load();
  if (!s.seed) return null;
  return crypto.sign(null, Buffer.from(PROOF_CONTEXT + nonce), privateKeyOf(s.seed)).toString('base64');
}

function verifyProof(publicKeyB64, nonce, signatureB64) {
  try {
    return crypto.verify(null, Buffer.from(PROOF_CONTEXT + nonce), publicKeyObject(Buffer.from(publicKeyB64, 'base64')),
      Buffer.from(signatureB64, 'base64'));
  } catch {
    return false;
  }
}

// ---- recovery key ------------------------------------------------------------

/** The host's key as a code to write down: 32 bytes + a 2-byte check, grouped. */
function recoveryCode() {
  const s = load();
  if (!s.seed) return null;
  const check = sha256(s.seed).subarray(0, 2);
  return group(base32(Buffer.concat([s.seed, check])), 5);
}

/** The seed in a recovery code, or null if the code is mistyped. */
function seedFromRecovery(code) {
  const bytes = unbase32(code);
  if (!bytes || bytes.length < 34) return null;
  const seed = bytes.subarray(0, 32);
  if (!sha256(seed).subarray(0, 2).equals(bytes.subarray(32, 34))) return null;
  return Buffer.from(seed);
}

/** Become the host this seed belongs to (restore, or receive a move). */
function adopt(seed) {
  save({ seed: Buffer.from(seed), publicKey: publicKeyOf(seed), createdAt: Date.now(), retired: null });
  return publicInfo();
}

/** Hand the role on: forget the key, remember where the host went. */
function retire(movedTo) {
  const s = load();
  save({ seed: null, publicKey: s.publicKey, createdAt: s.createdAt, retired: { movedTo, at: Date.now() } });
}

// ---- sealed boxes (backups, and the move channel) ------------------------------

const derive = (secret, info) => Buffer.from(crypto.hkdfSync('sha256', secret, Buffer.alloc(0), info, 32));

function seal(key, value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}

function open(key, box) {
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(box.data, 'base64')), decipher.final()]).toString('utf8'));
  } catch {
    return null; // wrong key, or tampered
  }
}

/** A backup only this host's recovery key can open. */
function sealBackup(contents) {
  const s = load();
  return {
    kind: 'meghxl-backup',
    v: 1,
    fingerprint: fingerprintOf(s.publicKey),
    createdAt: Date.now(),
    ...seal(derive(s.seed, 'meghxl-backup-v1'), contents),
  };
}

function openBackup(seed, backup) {
  if (!backup || backup.kind !== 'meghxl-backup') return null;
  return open(derive(seed, 'meghxl-backup-v1'), backup);
}

module.exports = {
  load, publicInfo, isRetired, prove, verifyProof, fingerprintOf,
  recoveryCode, seedFromRecovery, publicKeyOf, adopt, retire,
  derive, seal, open, sealBackup, openBackup, base32, group,
  // for tests
  _reset: () => { cached = null; },
};
