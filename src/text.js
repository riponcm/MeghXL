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

const INVISIBLE = /[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/gu;
const ODD_SPACE = /[\s\u00a0\u2000-\u200a\u202f\u205f\u3000]+/g;

/** The first `max` characters, never cutting an emoji or other pair in half. */
function firstChars(s, max) {
  const chars = Array.from(s);
  return chars.length > max ? chars.slice(0, max).join('') : s;
}

/** Strip control/format characters, collapse whitespace, trim, cap length. */
function cleanText(s, max) {
  return firstChars(String(s == null ? '' : s)
    .normalize('NFC')
    .replace(INVISIBLE, '') // \p{Cs} also drops lone halves of a pair
    .replace(ODD_SPACE, ' ')
    .trim(), max).trim();
}

// Names that would let a device pass itself off as the hub. Compared after
// dropping everything but letters, so "H.O.S.T" and "Host  (Admin)" count too.
const RESERVED = new Set([
  'host', 'admin', 'administrator', 'hostadmin', 'adminhost', 'hostconsole',
  'hostpc', 'hostcomputer', 'thehost', 'server', 'meghxl', 'meghxlhost', 'system',
]);

// Letters from other scripts that look like Latin ones, so "Ноst" (Cyrillic
// Н and о) or "Αdmin" (Greek Α) can't pass for the host. NFKC already folds
// full-width and styled forms ("Ｈｏｓｔ", "𝐇𝐨𝐬𝐭").
const LOOKALIKE = {
  а: 'a', в: 'b', е: 'e', ё: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x',
  і: 'i', ї: 'i', ј: 'j', ѕ: 's', ԁ: 'd', һ: 'h', ӏ: 'l', ԛ: 'q', ԝ: 'w', ɡ: 'g',
  α: 'a', β: 'b', ε: 'e', η: 'n', ι: 'i', κ: 'k', μ: 'm', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x', ϲ: 'c',
  0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', // "H0st", "Adm1n"
};

/** A name reduced to plain Latin letters, for comparing names that look alike. */
function skeleton(name) {
  return Array.from(String(name).normalize('NFKC').toLowerCase())
    .map((c) => LOOKALIKE[c] || c)
    .join('')
    .normalize('NFD')
    .replace(/[^a-z0-9]/g, '');
}

function isReservedName(name) {
  const letters = skeleton(name).replace(/[0-9]/g, '');
  return RESERVED.has(letters) || letters.startsWith('meghxl');
}

/** A device's display name: cleaned, and never one that mimics the host. */
function cleanName(s, max = 60) {
  const name = cleanText(s, max);
  if (!name) return '';
  return isReservedName(name) ? `${name} (device)` : name;
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
  if (Array.from(name).length > MAX_FILENAME) {
    let ext = path.extname(name);
    if (ext.length > 16) ext = '';
    name = firstChars(name.slice(0, name.length - ext.length), MAX_FILENAME - ext.length).replace(/[.\s]+$/, '') + ext;
  }
  return name || 'file';
}

module.exports = { cleanText, cleanName, cleanFilename, isReservedName, skeleton };
