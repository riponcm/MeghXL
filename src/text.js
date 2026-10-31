'use strict';

const path = require('node:path');

// ---------------------------------------------------------------------------
// Cleaning text that other devices will see: names, filenames.
//
// Control characters break layouts and headers; Unicode *format* characters
// are worse — U+202E (right-to-left override) makes "photo<RLO>gpj.exe" render
// as "photoexe.jpg", and zero-width characters hide differences between names.
// \p{Cc} and \p{Cf} cover both families. The cost is that emoji built with a
// zero-width joiner split into their parts, which is acceptable for a name.
// ---------------------------------------------------------------------------

const INVISIBLE = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;
const ODD_SPACE = /[\s\u00a0\u2000-\u200a\u202f\u205f\u3000]+/g;

/** Strip control/format characters, collapse whitespace, trim, cap length. */
function cleanText(s, max) {
  return String(s == null ? '' : s)
    .normalize('NFC')
    .replace(INVISIBLE, '')
    .replace(ODD_SPACE, ' ')
    .trim()
    .slice(0, max);
}

// Names that would let a device pass itself off as the hub. Compared after
// dropping everything but letters, so "H.O.S.T" and "Host  (Admin)" count too.
const RESERVED = new Set([
  'host', 'admin', 'administrator', 'hostadmin', 'adminhost', 'hostconsole',
  'hostpc', 'hostcomputer', 'thehost', 'server', 'meghxl', 'meghxlhost', 'system',
]);

function isReservedName(name) {
  const letters = String(name).toLowerCase().replace(/[^\p{L}]/gu, '');
  return RESERVED.has(letters) || letters.startsWith('meghxl');
}

/** A device's display name: cleaned, and never one that mimics the host. */
function cleanName(s, max = 60) {
  const name = cleanText(s, max);
  if (!name) return '';
  return isReservedName(name) ? `${name} (device)`.slice(0, max + 9) : name;
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const MAX_FILENAME = 180;

/**
 * A filename that is safe to show and to save on any OS. The extension is
 * always kept — truncation shortens the stem — so a long name can't push the
 * real type ("….pdf.exe") out of sight.
 */
function cleanFilename(raw) {
  let name = cleanText(raw, 1000)
    .replace(/[/\\:*?"<>|]/g, '_') // separators and characters Windows forbids
    .replace(/^[.\s]+/, '') // no hidden dot-files
    .replace(/[.\s]+$/, ''); // Windows drops trailing dots and spaces
  if (WINDOWS_RESERVED.test(name)) name = '_' + name;
  if (name.length > MAX_FILENAME) {
    let ext = path.extname(name);
    if (ext.length > 16) ext = '';
    name = name.slice(0, MAX_FILENAME - ext.length).replace(/[.\s]+$/, '') + ext;
  }
  return name || 'file';
}

module.exports = { cleanText, cleanName, cleanFilename, isReservedName };
