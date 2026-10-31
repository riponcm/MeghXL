'use strict';

const fs = require('node:fs');
const path = require('node:path');

// ---------------------------------------------------------------------------
// Is this upload a program?
//
// Anyone on the network can share a file, and a program renamed "photo.jpg"
// looks exactly like a photo. MeghXL can't tell good software from bad — and
// never claims to — but it can say what a file *is*: a program, a script, an
// installer, or a document that doesn't match its own name. The dashboard turns
// that into a warning; the host can also refuse programs outright.
//
// Two independent signals:
//   - the final extension (what the OS will do when the file is opened), and
//   - the first bytes (what the file really contains), plus, for zip files,
//     the names inside it — a zipped .app or .exe is the usual disguise.
// ---------------------------------------------------------------------------

const PROGRAM_EXT = {
  windows: ['exe', 'scr', 'com', 'pif', 'cpl', 'dll', 'msi', 'msp', 'msix', 'appx', 'hta', 'bat', 'cmd',
    'ps1', 'psm1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'reg', 'lnk', 'inf', 'scf', 'url', 'chm', 'gadget'],
  mac: ['app', 'command', 'tool', 'pkg', 'mpkg', 'dmg', 'workflow', 'action', 'terminal', 'scpt', 'applescript'],
  other: ['sh', 'bash', 'zsh', 'csh', 'ksh', 'run', 'bin', 'appimage', 'deb', 'rpm', 'jar', 'apk', 'xapk',
    'py', 'pyw', 'rb', 'pl', 'php', 'elf', 'out'],
};
const KIND_OF_EXT = new Map();
for (const [kind, list] of Object.entries(PROGRAM_EXT)) for (const e of list) KIND_OF_EXT.set(e, kind);

// Extensions people expect to be harmless documents/media. A program inside a
// file with one of these names is a disguise, not an accident.
const DOCUMENT_EXT = new Set([
  'pdf', 'txt', 'md', 'rtf', 'csv', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'pages',
  'numbers', 'key', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'bmp', 'tif', 'tiff', 'svg', 'avif',
  'mp4', 'mov', 'm4v', 'mkv', 'avi', 'webm', 'mp3', 'm4a', 'wav', 'flac', 'aac', 'ogg', 'zip', 'epub', 'json',
]);

const LABEL = {
  windows: 'Windows program',
  mac: 'Mac program or installer',
  linux: 'Linux program',
  script: 'Script',
  other: 'Program or script',
  shortcut: 'Windows shortcut',
  installer: 'Installer',
  macro: 'Office document with macros',
};

// Office formats that can carry macros — code that runs inside Word/Excel.
const MACRO_EXT = new Set(['docm', 'dotm', 'xlsm', 'xltm', 'xlam', 'pptm', 'potm', 'ppam', 'ppsm', 'sldm']);

/** A label mid-sentence: "a Windows program", "a script". */
function inSentence(label) {
  return /^(Windows|Mac|Linux|Office)\b/.test(label) ? label : label.charAt(0).toLowerCase() + label.slice(1);
}

function extOf(name) {
  return path.extname(String(name || '')).slice(1).toLowerCase();
}

/** What the first bytes say, or null for "nothing we recognise as runnable". */
function sniffHead(b) {
  if (b.length >= 2 && b[0] === 0x4d && b[1] === 0x5a) return 'windows'; // MZ — PE/DOS executable
  if (b.length >= 4 && b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46) return 'linux'; // ELF
  if (b.length >= 4) {
    const be = b.readUInt32BE(0);
    if (be === 0xfeedface || be === 0xfeedfacf || be === 0xcefaedfe || be === 0xcffaedfe) return 'mac'; // Mach-O
    // 0xCAFEBABE is both a Mach-O universal binary and a Java class; Mach-O
    // keeps the architecture count (small) where Java keeps its version (>= 45).
    if (be === 0xcafebabe && b.length >= 8 && b.readUInt32BE(4) < 30) return 'mac';
    if (be === 0x78617221) return 'installer'; // "xar!" — a macOS .pkg
    if (be === 0x4c000000 && b.length >= 8 && b.readUInt32BE(4) === 0x01140200) return 'shortcut'; // .lnk
  }
  if (b.length >= 2 && b[0] === 0x23 && b[1] === 0x21) return 'script'; // "#!" shebang
  return null;
}

/** File names stored in a zip's central directory (read from its tail). */
function zipEntryNames(tail) {
  const names = [];
  let i = tail.indexOf('PK\x01\x02');
  while (i !== -1 && i + 46 <= tail.length && names.length < 2000) {
    const nameLen = tail.readUInt16LE(i + 28);
    const extraLen = tail.readUInt16LE(i + 30);
    const commentLen = tail.readUInt16LE(i + 32);
    if (i + 46 + nameLen > tail.length) break;
    names.push(tail.toString('utf8', i + 46, i + 46 + nameLen));
    i = tail.indexOf('PK\x01\x02', i + 46 + nameLen + extraLen + commentLen);
  }
  return names;
}

function programInZip(names) {
  for (const n of names) {
    const lower = n.toLowerCase();
    if (/\.app\/contents\/macos\//.test(lower)) return { kind: 'mac', inner: n.split('/').find((p) => /\.app$/i.test(p)) || n };
    if (lower.endsWith('/')) continue;
    const kind = KIND_OF_EXT.get(extOf(lower));
    if (kind && kind !== 'other') return { kind, inner: path.basename(n) };
  }
  return null;
}

function readSlices(file, size) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(Math.min(size, 4096));
    fs.readSync(fd, head, 0, head.length, 0);
    const tailLen = Math.min(size, 256 * 1024);
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, size - tailLen);
    return { head, tail };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Classify an uploaded file. Reads at most ~260 KB whatever its size.
 * Returns null for ordinary files, otherwise
 *   { kind, label, reason: 'extension'|'content'|'archive', mismatch?, inner? }
 * where `mismatch` describes a file whose content contradicts its name.
 */
function classify(filePath, name, size) {
  const ext = extOf(name);
  let head = Buffer.alloc(0);
  let tail = Buffer.alloc(0);
  try {
    if (size > 0) ({ head, tail } = readSlices(filePath, size));
  } catch { /* unreadable: fall back to the name alone */ }

  const sniffed = sniffHead(head);
  const byExt = KIND_OF_EXT.get(ext) || null;

  if (sniffed) {
    const kind = sniffed;
    const out = { kind, label: LABEL[kind], reason: byExt ? 'extension' : 'content' };
    // A program wearing a document's name is the disguise this exists for.
    if (!byExt && ext && DOCUMENT_EXT.has(ext)) {
      out.mismatch = `Named .${ext}, but it's a ${inSentence(LABEL[kind])}`;
    } else if (!byExt) {
      out.mismatch = `Its name doesn't say so, but it's a ${inSentence(LABEL[kind])}`;
    }
    return out;
  }

  if (byExt) return { kind: byExt, label: LABEL[byExt], reason: 'extension' };
  if (MACRO_EXT.has(ext)) return { kind: 'macro', label: LABEL.macro, reason: 'extension' };

  // Zip (and zip-based formats): look at what's inside.
  if (head.length >= 4 && head.readUInt32LE(0) === 0x04034b50) {
    const hit = programInZip(zipEntryNames(tail));
    if (hit) {
      return { kind: hit.kind, label: `Archive containing a ${inSentence(LABEL[hit.kind])}`, reason: 'archive', inner: hit.inner };
    }
  }
  return null;
}

module.exports = { inSentence, classify, sniffHead, zipEntryNames, extOf, PROGRAM_EXT };
