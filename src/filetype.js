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
//
// Some files can't be fully checked: archive formats MeghXL can't read, zips
// whose index is missing or enormous, archives inside archives. Those carry a
// quiet verdict — no label for everyone, but "Refuse programs" refuses them,
// since a strict setting that a zip could walk past wouldn't be one.
// ---------------------------------------------------------------------------

const PROGRAM_EXT = {
  windows: ['exe', 'scr', 'com', 'pif', 'cpl', 'dll', 'ocx', 'sys', 'drv', 'msi', 'msp', 'msix', 'msixbundle',
    'appx', 'appxbundle', 'hta', 'bat', 'cmd', 'ps1', 'psm1', 'psd1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh',
    'wsc', 'sct', 'reg', 'lnk', 'inf', 'scf', 'url', 'chm', 'gadget', 'msc', 'xll', 'appref-ms', 'application',
    'xbap', 'settingcontent-ms', 'library-ms', 'search-ms', 'diagcab', 'mde', 'accde', 'ade', 'adp'],
  mac: ['app', 'command', 'tool', 'pkg', 'mpkg', 'dmg', 'workflow', 'action', 'terminal', 'scpt', 'applescript',
    'osax', 'kext', 'prefpane', 'webloc', 'inetloc', 'fileloc'],
  other: ['sh', 'bash', 'zsh', 'csh', 'ksh', 'fish', 'run', 'bin', 'appimage', 'deb', 'rpm', 'snap', 'flatpak',
    'jar', 'jnlp', 'apk', 'xapk', 'aab', 'ipa', 'py', 'pyw', 'pyz', 'rb', 'pl', 'php', 'elf', 'out', 'desktop'],
  // Disk images open as a drive full of files — and on Windows, what's inside
  // loses the "downloaded from the internet" mark, a favourite way to deliver
  // malware.
  diskimage: ['iso', 'img', 'vhd', 'vhdx', 'vmdk', 'udf'],
  // A web page opened from disk runs its scripts in the browser.
  web: ['html', 'htm', 'xhtml', 'shtml', 'mht', 'mhtml', 'svgz'],
};
const KIND_OF_EXT = new Map();
for (const [kind, list] of Object.entries(PROGRAM_EXT)) for (const e of list) KIND_OF_EXT.set(e, kind);

// Archive formats MeghXL doesn't read inside. Fine to share; "Refuse programs"
// refuses them because it can't vouch for their contents.
const OPAQUE_ARCHIVE_EXT = new Set(['rar', '7z', 'cab', 'tar', 'gz', 'tgz', 'bz2', 'tbz', 'xz', 'txz', 'zst',
  'lz', 'lzma', 'lzh', 'lha', 'arj', 'ace', 'z', 'cpio', 'xar', 'sit', 'sitx', 'zip', 'zipx']);

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
  diskimage: 'Disk image that can contain programs',
  web: 'Web page that runs code when opened',
};

// Office formats that can carry macros — code that runs inside Word/Excel.
const MACRO_EXT = new Set(['docm', 'dotm', 'xlsm', 'xltm', 'xlam', 'pptm', 'potm', 'ppam', 'ppsm', 'sldm']);

const ZIP_LOCAL = 0x04034b50; // "PK\3\4"
const ZIP_CENTRAL = 0x02014b50; // "PK\1\2"
const ZIP_END = Buffer.from([0x50, 0x4b, 0x05, 0x06]); // end of central directory
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_END = 0x06064b50;
const MAX_INDEX_BYTES = 32 * 1024 * 1024; // a zip index bigger than this isn't read

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

function readAt(fd, position, length) {
  const buf = Buffer.alloc(length);
  const n = fs.readSync(fd, buf, 0, length, position);
  return buf.subarray(0, n);
}

/**
 * The file names in a zip, read from its central directory — located from the
 * end of the file, so data glued in front (self-extractors, polyglots) doesn't
 * hide it. Returns null when the file isn't a zip, or 'unreadable' when it
 * looks like one but its index can't be read in full.
 */
function zipEntryNames(fd, size, head) {
  const tailLen = Math.min(size, 65535 + 22);
  const tail = readAt(fd, size - tailLen, tailLen);
  const at = tail.lastIndexOf(ZIP_END);
  const startsLikeZip = head.length >= 4 && head.readUInt32LE(0) === ZIP_LOCAL;
  if (at === -1 || at + 22 > tail.length) return startsLikeZip ? 'unreadable' : null;
  const endPos = size - tailLen + at;

  let cdSize = tail.readUInt32LE(at + 12);
  let cdEnd = endPos;
  if (cdSize === 0xffffffff || tail.readUInt16LE(at + 10) === 0xffff) {
    // Zip64: the real sizes live in a second record, found via a locator.
    if (at < 20 || tail.readUInt32LE(at - 20) !== ZIP64_LOCATOR) return 'unreadable';
    const recPos = Number(tail.readBigUInt64LE(at - 20 + 8));
    const rec = readAt(fd, recPos, 56);
    if (rec.length < 56 || rec.readUInt32LE(0) !== ZIP64_END) {
      // The record's offset is relative to the archive's start; with data in
      // front, it's just before the locator instead.
      const near = readAt(fd, endPos - 20 - 56, 56);
      if (near.length < 56 || near.readUInt32LE(0) !== ZIP64_END) return 'unreadable';
      cdSize = Number(near.readBigUInt64LE(40));
      cdEnd = endPos - 20 - 56;
    } else {
      cdSize = Number(rec.readBigUInt64LE(40));
      cdEnd = endPos - 20 - 56;
    }
  }
  if (cdSize > MAX_INDEX_BYTES || cdSize > cdEnd) return 'unreadable';
  // The directory sits right before its end record, wherever the archive
  // itself starts in the file.
  const cd = readAt(fd, cdEnd - cdSize, cdSize);
  if (cd.length < 46 || cd.readUInt32LE(0) !== ZIP_CENTRAL) return startsLikeZip ? 'unreadable' : null;

  const names = [];
  let i = 0;
  while (i + 46 <= cd.length && cd.readUInt32LE(i) === ZIP_CENTRAL) {
    const nameLen = cd.readUInt16LE(i + 28);
    const extraLen = cd.readUInt16LE(i + 30);
    const commentLen = cd.readUInt16LE(i + 32);
    if (i + 46 + nameLen > cd.length) return 'unreadable';
    names.push(cd.toString('utf8', i + 46, i + 46 + nameLen));
    i += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

/** The first thing inside a zip worth warning about, if any. */
function riskInZip(names) {
  let nested = null;
  for (const n of names) {
    const lower = n.toLowerCase().replace(/\\/g, '/');
    if (/\.app\/contents\/macos\//.test(lower)) {
      return { kind: 'mac', inner: n.split(/[\\/]/).find((p) => /\.app$/i.test(p)) || n };
    }
    if (lower.endsWith('/')) continue;
    // Macros inside an Office file (which is itself a zip).
    if (/(^|\/)vbaproject\.bin$/.test(lower)) return { kind: 'macro', inner: path.basename(n) };
    const ext = extOf(lower);
    const kind = KIND_OF_EXT.get(ext) || (MACRO_EXT.has(ext) ? 'macro' : null);
    if (kind) return { kind, inner: path.basename(n) };
    if (!nested && OPAQUE_ARCHIVE_EXT.has(ext)) nested = path.basename(n);
  }
  return nested ? { quiet: true, inner: nested } : null;
}

const UNCHECKED = (why) => ({ kind: 'unchecked', label: "Archive MeghXL couldn't look inside", reason: 'archive', quiet: true, why });

/**
 * Classify an uploaded file. Reads its first 4 KB, last 64 KB and, for a zip,
 * its index — never the whole file.
 * Returns null for ordinary files, otherwise
 *   { kind, label, reason: 'extension'|'content'|'archive', mismatch?, inner?, quiet? }
 * `mismatch` describes content that contradicts the name. `quiet` verdicts
 * aren't shown to everyone; they only matter when the host refuses programs.
 */
function classify(filePath, name, size) {
  const ext = extOf(name);
  let fd;
  try { fd = fs.openSync(filePath, 'r'); } catch { fd = null; }
  try {
    const head = fd !== null && size > 0 ? readAt(fd, 0, Math.min(size, 4096)) : Buffer.alloc(0);
    const sniffed = sniffHead(head);
    const byExt = KIND_OF_EXT.get(ext) || null;

    if (sniffed) {
      const out = { kind: sniffed, label: LABEL[sniffed], reason: byExt ? 'extension' : 'content' };
      // A program wearing a document's name is the disguise this exists for.
      if (!byExt && ext && DOCUMENT_EXT.has(ext)) out.mismatch = `Named .${ext}, but it's a ${inSentence(LABEL[sniffed])}`;
      else if (!byExt) out.mismatch = `Its name doesn't say so, but it's a ${inSentence(LABEL[sniffed])}`;
      return out;
    }
    if (byExt) return { kind: byExt, label: LABEL[byExt], reason: 'extension' };
    if (MACRO_EXT.has(ext)) return { kind: 'macro', label: LABEL.macro, reason: 'extension' };

    // Zips, and zip-based formats (docx, xlsx, jar, apk, …): look inside.
    if (fd !== null && size >= 22) {
      let names;
      try { names = zipEntryNames(fd, size, head); } catch { names = 'unreadable'; }
      if (names === 'unreadable') return UNCHECKED('index unreadable');
      if (names) {
        const hit = riskInZip(names);
        if (hit && hit.quiet) return { ...UNCHECKED('archive inside'), inner: hit.inner };
        if (hit) {
          return { kind: hit.kind, label: `Archive containing ${hit.kind === 'macro' ? 'macros' : `a ${inSentence(LABEL[hit.kind])}`}`, reason: 'archive', inner: hit.inner };
        }
        return null;
      }
    }
    if (OPAQUE_ARCHIVE_EXT.has(ext)) return UNCHECKED('format not read');
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

module.exports = { inSentence, classify, sniffHead, extOf, PROGRAM_EXT };
