'use strict';

const $ = (sel) => document.querySelector(sel);
const SENT_KEY = 'meghxl:sent';
const DEVICE_KEY = 'meghxl:device';
const RECEIVED_KEY = 'meghxl:received';
const DM_KEY = 'meghxl:dms';

function deviceKind() {
  const ua = navigator.userAgent;
  if (/iPad|Tablet/.test(ua)) return 'tablet';
  if (/Mobi|iPhone|Android/.test(ua)) return 'mobile';
  return 'desktop';
}
function defaultDeviceName() {
  const ua = navigator.userAgent;
  let os = 'Device';
  if (/iPhone/.test(ua)) os = 'iPhone';
  else if (/iPad/.test(ua)) os = 'iPad';
  else if (/Android/.test(ua)) os = 'Android';
  else if (/Macintosh|Mac OS/.test(ua)) os = 'Mac';
  else if (/Windows/.test(ua)) os = 'Windows';
  else if (/Linux/.test(ua)) os = 'Linux';
  let br = '';
  if (/Edg\//.test(ua)) br = 'Edge';
  else if (/OPR\/|Opera/.test(ua)) br = 'Opera';
  else if (/Firefox\//.test(ua)) br = 'Firefox';
  else if (/Chrome\//.test(ua)) br = 'Chrome';
  else if (/Safari\//.test(ua)) br = 'Safari';
  return br ? os + ' · ' + br : os;
}
// The device id is a secret between this browser and the hub: it proves which
// device is asking, and other devices only ever see a derived handle. 128 bits
// from the browser's CSPRNG (available on plain http://, unlike randomUUID).
function browserName() {
  const n = defaultDeviceName();
  return n.includes(' · ') ? n.split(' · ')[1] : null;
}
function makeId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
function loadDevice() {
  let d = null;
  try { d = JSON.parse(localStorage.getItem(DEVICE_KEY)); } catch { /* ignore */ }
  // Before 1.0.2 ids were broadcast to every device, so any that existed then
  // may have been copied: start a fresh one, keeping the name.
  if (!d || !d.id || d.v !== 2) {
    // The old id goes to the hub once (legacyId), so a block on it carries over.
    d = { id: makeId(), name: (d && d.name) || defaultDeviceName(), kind: (d && d.kind) || deviceKind(), v: 2,
      legacyId: (d && d.id) || undefined };
    try { localStorage.setItem(DEVICE_KEY, JSON.stringify(d)); } catch { /* ignore */ }
  }
  return d;
}
function saveDevice() {
  try { localStorage.setItem(DEVICE_KEY, JSON.stringify(state.device)); } catch { /* ignore */ }
}

const state = {
  view: 'dashboard',
  staged: [], // files queued in the Send tab, uploaded on the Send button
  publicFiles: new Map(), // token -> shape
  baseUrl: location.origin,
  shareBase: location.origin,
  notes: [],
  device: loadDevice(),
  myHandle: null, // how other devices see this one (sent by the hub)
  isAdmin: false,
  maxUploadBytes: null, // the hub's largest-file limit for this device (null = none)
  devices: [],
  deviceCount: 1,
  announcement: null,
  blocked: false,
  unseenPrivate: 0,
};

// ---------- DOM helper (text via textContent, so no XSS from filenames/notes) ----------
function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

const ICONS = {
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  qr: '<rect width="5" height="5" x="3" y="3" rx="1"/><rect width="5" height="5" x="16" y="3" rx="1"/><rect width="5" height="5" x="3" y="16" rx="1"/><path d="M21 16h-3a2 2 0 0 0-2 2v3"/><path d="M21 21v.01"/><path d="M12 7v3a2 2 0 0 1-2 2H7"/><path d="M3 12h.01"/><path d="M12 3h.01"/><path d="M12 16v.01"/><path d="M16 12h1"/><path d="M21 12v.01"/><path d="M12 21v-1"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
  flame: '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  image: '<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>',
  video: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M7 3v18"/><path d="M3 7.5h4"/><path d="M3 12h18"/><path d="M3 16.5h4"/><path d="M17 3v18"/><path d="M17 7.5h4"/><path d="M17 16.5h4"/>',
  audio: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  fileText: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/>',
  fileCode: '<path d="M4 22h14a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v4"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="m9 18 3-3-3-3"/><path d="m5 12-3 3 3 3"/>',
  archive: '<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
  monitor: '<rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/>',
  smartphone: '<rect width="14" height="20" x="5" y="2" rx="2" ry="2"/><path d="M12 18h.01"/>',
  tablet: '<rect width="16" height="20" x="4" y="2" rx="2" ry="2"/><line x1="12" x2="12.01" y1="18" y2="18"/>',
  send: '<path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"/><path d="m21.854 2.147-10.94 10.939"/>',
  pencil: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  reply: '<polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/>',
  megaphone: '<path d="m3 11 18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>',
  message: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
};

function icon(name, size = 18) {
  const tpl = document.createElement('template');
  tpl.innerHTML =
    `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" ` +
    `stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ` +
    `aria-hidden="true">${ICONS[name] || ICONS.file}</svg>`;
  return tpl.content.firstChild;
}

function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = bytes, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${i === 0 ? n : n.toFixed(n >= 10 ? 0 : 1)} ${units[i]}`;
}
function fmtWhen(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ', ' +
    d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
function fmtCountdown(expiresAt) {
  const ms = expiresAt - Date.now();
  if (ms <= 0) return 'expired';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const hr = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d) return `${d}d ${hr}h`;
  if (hr) return `${hr}h ${String(m).padStart(2, '0')}m`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

// The icon follows the hub's verdict first, then the file's real extension —
// never the type the sender claimed, which is how a program passes for a photo.
function fileIconName(file) {
  if (file.risk) return 'alert';
  const name = (file.originalName || '').toLowerCase();
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
  if (/^(png|jpe?g|gif|webp|svg|bmp|heic|heif|avif|tiff?)$/.test(ext)) return 'image';
  if (/^(mp4|mov|mkv|avi|webm|m4v)$/.test(ext)) return 'video';
  if (/^(mp3|wav|flac|aac|ogg|m4a)$/.test(ext)) return 'audio';
  if (ext === 'pdf') return 'fileText';
  if (/^(zip|tar|gz|tgz|rar|7z|bz2|xz)$/.test(ext)) return 'archive';
  if (/^(txt|md|json|xml|ts|css|html|csv|ya?ml)$/.test(ext)) return 'fileCode';
  return 'file';
}

// A filename as stem + extension, the extension in its own element so the
// ellipsis can only ever eat the stem.
function fileNameEl(name, risky) {
  const n = String(name || 'file');
  const dot = n.lastIndexOf('.');
  const stem = dot > 0 ? n.slice(0, dot) : n;
  const ext = dot > 0 ? n.slice(dot) : '';
  return h('div', { class: 'file-name split', title: n },
    h('span', { class: 'file-stem', text: stem }),
    ext ? h('span', { class: 'file-ext' + (risky ? ' risky' : ''), text: ext }) : null);
}

// ---------- programs: warn before saving ----------
function riskBadge(file) {
  if (!file.risk) return null;
  return h('span', { class: 'badge risk', title: file.risk.mismatch || file.risk.label }, icon('alert', 13),
    file.risk.mismatch ? 'not what its name says' : 'program');
}
function riskLine(file) {
  const r = file.risk;
  if (!r) return null;
  let text = r.mismatch || r.label;
  if (r.inner) text += ` (${r.inner})`;
  return h('div', { class: 'risk-line', text: text + ' — only open it if you trust the sender.' });
}
let riskResolve = null;
function confirmRisk(file) {
  const r = file.risk;
  const from = file.fromName ? `from ${file.fromName}` : 'from someone on this network';
  let what = r.mismatch ? `${r.mismatch}.` : `It's a ${r.label.toLowerCase()}.`;
  if (r.inner) what += ` Inside: ${r.inner}.`;
  $('#risk-title').textContent = r.mismatch ? "This file isn't what its name says" : 'This file is a program';
  $('#risk-text').textContent = `“${file.originalName}” ${from}. ${what}`;
  $('#risk-modal').hidden = false;
  $('#risk-ok').focus();
  return new Promise((resolve) => { riskResolve = resolve; });
}
function closeRisk(ok) {
  $('#risk-modal').hidden = true;
  if (riskResolve) { const r = riskResolve; riskResolve = null; r(ok); }
}
// A download link that asks first when the file is a program.
function saveLink(file, label, title) {
  const a = h('a', { class: 'btn small', href: dlUrl(file.token), download: file.originalName, title }, icon('download', 15), label);
  if (file.risk) {
    a.addEventListener('click', async (e) => {
      if (a.dataset.confirmed) { delete a.dataset.confirmed; return; }
      e.preventDefault();
      if (await confirmRisk(file)) { a.dataset.confirmed = '1'; a.click(); }
    });
  }
  return a;
}

const dlUrl = (token) => `${state.shareBase || location.origin}/d/${token}`;
const qrSrc = (text) => `/api/qr?text=${encodeURIComponent(text)}`;

// Every API call says which device is asking. The hub uses it to name the
// sender and to decide who may delete what — never what the request claims.
async function api(url, opts = {}) {
  const headers = { 'x-meghxl-device': state.device.id, ...(opts.headers || {}) };
  if (opts.json !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(url, { ...opts, headers, body: opts.json !== undefined ? JSON.stringify(opts.json) : opts.body });
  if (r.status === 401 || r.status === 403) {
    const data = await r.clone().json().catch(() => ({}));
    if (data.join) showJoinGate();
    if (data.pending) showWaitGate();
  }
  return r;
}

// The host's messages and files carry a badge the hub sets — a device that
// merely names itself "Host" doesn't get one.
const fromLabel = (item, fallback) => [item.fromName || fallback,
  item.fromHost ? h('span', { class: 'badge host', text: 'host' }) : null];

const isMine = (item) => !!item && (state.isAdmin || (!!state.myHandle && item.ownerHandle === state.myHandle));

let toastTimer = null;
function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  t.className = 'toast show' + (kind ? ' ' + kind : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast'; t.hidden = true; }, 2600);
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied', 'good');
  } catch {
    const ta = h('textarea', { style: 'position:fixed;opacity:0;top:0' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    try { document.execCommand('copy'); toast('Copied', 'good'); }
    catch { toast('Press and hold to copy', 'danger'); }
    ta.remove();
  }
}

// ---------- view router ----------
const VIEWS = ['dashboard', 'send', 'private', 'devices', 'about'];

function showView(name) {
  if (!VIEWS.includes(name)) name = 'dashboard';
  state.view = name;
  // Keep the URL in step so the desktop app's View menu (and plain links)
  // can jump straight to a view.
  if (location.hash.slice(1) !== name) {
    history.replaceState(null, '', '#' + name);
  }
  document.querySelectorAll('.app-nav').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  document.querySelectorAll('.view').forEach((v) => { v.hidden = v.dataset.view !== name; });
  if (name === 'private') { state.unseenPrivate = 0; updatePrivateBadge(); }
}
function updatePrivateBadge() {
  const b = $('#private-badge');
  if (state.unseenPrivate > 0) { b.hidden = false; b.textContent = state.unseenPrivate; }
  else b.hidden = true;
}
function bumpPrivate() {
  if (state.view !== 'private') { state.unseenPrivate++; updatePrivateBadge(); }
}

// ---------- the host's fingerprint ----------
// The host proves who it is with a key; the desktop app checks it for you. A
// browser can't, over plain http:// — so the fingerprint is shown where people
// join, to compare with the host's own screen, and we say so plainly.
async function loadHostFingerprint() {
  try {
    const id = await (await fetch('/api/host/identity', { cache: 'no-store' })).json();
    state.hostFingerprint = id.fingerprint || null;
  } catch { state.hostFingerprint = null; }
  document.querySelectorAll('[data-host-fp]').forEach((el) => {
    el.textContent = state.hostFingerprint ? `Host fingerprint ${state.hostFingerprint} — it should match the host computer's screen.` : '';
    el.hidden = !state.hostFingerprint;
  });
}

// ---------- modal ----------
function showQrModal(title, url, { fingerprint = false } = {}) {
  $('#modal-title').textContent = title;
  $('#modal-qr').src = qrSrc(url);
  // The link stays hidden until asked for. People scan the code; a screenshot
  // or screen-share of this modal shouldn't hand out the address by default.
  const urlEl = $('#modal-url');
  const reveal = $('#modal-reveal');
  urlEl.textContent = url;
  urlEl.hidden = true;
  reveal.textContent = 'Show link';
  reveal.onclick = () => {
    urlEl.hidden = !urlEl.hidden;
    reveal.textContent = urlEl.hidden ? 'Show link' : 'Hide link';
  };
  $('#modal-copy').onclick = () => copy(url);
  const fp = $('#modal-fp');
  fp.hidden = !(fingerprint && state.hostFingerprint);
  fp.textContent = fp.hidden ? '' :
    `Host fingerprint: ${state.hostFingerprint}. The MeghXL app checks it automatically; a browser can't, so scan this code from the host's own screen.`;
  $('#modal').hidden = false;
}
function closeModal() {
  $('#modal').hidden = true;
  $('#modal-qr').src = '';
}

// ---------- file card ----------
function fileCard(file, { isPrivate, received }) {
  const url = dlUrl(file.token);
  const badges = [];
  if (file.risk) badges.push(riskBadge(file));
  if (isPrivate) badges.push(h('span', { class: 'badge private' }, icon('lock', 13), 'private'));
  if (received) badges.push(h('span', { class: 'badge private' }, icon('send', 13), 'from ' + (file.fromName || 'device')));
  if (file.oneTime) badges.push(h('span', { class: 'badge warn' }, icon('flame', 13), 'one-time'));
  if (file.expiresAt) {
    badges.push(h('span', { class: 'badge cd' }, icon('clock', 13),
      h('span', { class: 'countdown', 'data-exp': String(file.expiresAt), text: fmtCountdown(file.expiresAt) })));
  }

  const actions = received
    ? [
        saveLink(file, 'Save', 'Save'),
        h('button', { class: 'icon-btn danger', type: 'button', title: 'Dismiss', onclick: () => removeReceived(file.token) }, icon('trash')),
      ]
    : [
        saveLink(file, 'Get', 'Download'),
        h('button', { class: 'icon-btn', type: 'button', title: 'Copy link', onclick: () => copy(url) }, icon('link')),
        h('button', { class: 'icon-btn', type: 'button', title: 'Show QR', onclick: () => showQrModal('Scan to download', url) }, icon('qr')),
        // Only the device that shared it (or the host) can delete it — the hub
        // enforces that; this just doesn't offer a button that would fail.
        isMine(file)
          ? h('button', { class: 'icon-btn danger', type: 'button', title: 'Delete for everyone', onclick: () => deleteFile(file.token) }, icon('trash'))
          : null,
      ];

  const meta = [h('span', { text: formatSize(file.size) })];
  if (file.createdAt) meta.push(h('span', { class: 'dotsep', text: fmtWhen(file.createdAt) }));
  if (!isPrivate && !received && file.fromName) meta.push(h('span', { class: 'dotsep' }, 'by ', ...fromLabel(file)));
  if (badges.length) meta.push(h('span', { class: 'badges' }, ...badges));

  return h('div', { class: 'file-card' },
    h('div', { class: 'file-icon' + (file.risk ? ' risk' : '') }, icon(fileIconName(file), 22)),
    h('div', { class: 'file-main' },
      fileNameEl(file.originalName, !!file.risk),
      h('div', { class: 'file-meta' }, ...meta),
      riskLine(file),
      file.note ? h('div', { class: 'file-note', text: '“' + file.note + '”' }) : null,
    ),
    h('div', { class: 'file-actions' }, ...actions),
  );
}

// ---------- dashboard: public files + announcements ----------
function renderPublic() {
  const list = $('#public-list');
  list.replaceChildren();
  const files = [...state.publicFiles.values()].sort((a, b) => b.createdAt - a.createdAt);
  for (const f of files) list.append(fileCard(f, { isPrivate: false }));
  $('#public-empty').hidden = files.length > 0;
}
function addPublicFile(file) { state.publicFiles.set(file.token, file); renderPublic(); }
function removePublicFile(token) { if (state.publicFiles.delete(token)) renderPublic(); }

function renderAnnounceCards() {
  const box = $('#announce-cards');
  box.replaceChildren();
  const a = state.announcement;
  if (!a || !a.text) return;
  box.append(h('div', { class: 'announce-card' },
    h('span', { class: 'ann-ic' }, icon('megaphone', 18)),
    h('div', { class: 'ann-body' },
      h('div', { class: 'ann-text', text: a.text }),
      h('div', { class: 'ann-meta', text: 'Announced by Admin (host)' + (a.ts ? ' · ' + fmtWhen(a.ts) : '') }),
    ),
  ));
}

// ---------- staging (files queued in the Send tab) ----------
function stageFiles(fileList) {
  if (!fileList || !fileList.length) {
    // A phone can return from its picker with nothing — typically a long video
    // it failed to prepare. Say so instead of doing nothing.
    toast('No file was received. Large videos can take a while to prepare — try again, or pick the file from the Files app.', 'danger');
    return;
  }
  for (const f of fileList) state.staged.push(f);
  showView('send');
  switchSendTab('files');
  renderStaged();
}
function clearStaged() { state.staged = []; renderStaged(); }
function removeStaged(i) { state.staged.splice(i, 1); renderStaged(); }
function renderStaged() {
  const list = $('#staged-list');
  list.replaceChildren();
  state.staged.forEach((f, i) => {
    list.append(h('div', { class: 'staged-item' },
      icon(fileIconName({ originalName: f.name }), 16),
      h('span', { class: 'staged-name', title: f.name, text: f.name }),
      h('span', { class: 'staged-size', text: formatSize(f.size) }),
      h('button', { class: 'icon-btn tiny', type: 'button', title: 'Remove', onclick: () => removeStaged(i) }, icon('x', 14)),
    ));
  });
  const n = state.staged.length;
  $('#staged').hidden = n === 0;
  $('#staged-count').textContent = n + ' file' + (n === 1 ? '' : 's') + ' ready';
  $('#send-btn').disabled = n === 0;
  $('#send-btn-label').textContent = n ? ('Send ' + n + ' file' + (n === 1 ? '' : 's')) : 'Send';
}

// ---------- sent history (this device's outgoing shares) ----------
function loadSent() { try { return JSON.parse(localStorage.getItem(SENT_KEY)) || []; } catch { return []; } }
function saveSent(arr) { try { localStorage.setItem(SENT_KEY, JSON.stringify(arr.slice(0, 300))); } catch { /* ignore */ } }
function addSent(e) { const a = loadSent().filter((x) => x.token !== e.token); a.unshift(e); saveSent(a); renderSent(); }
function removeSentLocal(token) { saveSent(loadSent().filter((x) => x.token !== token)); renderSent(); }
function renderSent() {
  const arr = loadSent().filter((f) => !f.expiresAt || f.expiresAt > Date.now());
  saveSent(arr);
  const list = $('#sent-list');
  list.replaceChildren();
  for (const f of arr) list.append(sentCard(f));
  $('#sent-empty').hidden = arr.length > 0;
}
function sentCard(f) {
  const url = dlUrl(f.token);
  const tag = f.kind === 'public'
    ? h('span', { class: 'badge' }, icon('globe', 13), 'public')
    : f.kind === 'device'
      ? h('span', { class: 'badge private' }, icon('send', 13), 'to ' + (f.toName || 'device'))
      : h('span', { class: 'badge private' }, icon('lock', 13), 'private link');
  const badges = [tag];
  if (f.oneTime) badges.push(h('span', { class: 'badge warn' }, icon('flame', 13), 'one-time'));
  if (f.expiresAt) badges.push(h('span', { class: 'badge cd' }, icon('clock', 13),
    h('span', { class: 'countdown', 'data-exp': String(f.expiresAt), text: fmtCountdown(f.expiresAt) })));
  const meta = [h('span', { text: formatSize(f.size) })];
  if (f.createdAt) meta.push(h('span', { class: 'dotsep', text: fmtWhen(f.createdAt) }));
  meta.push(h('span', { class: 'badges' }, ...badges));
  return h('div', { class: 'file-card' },
    h('div', { class: 'file-icon' + (f.risk ? ' risk' : '') }, icon(fileIconName(f), 22)),
    h('div', { class: 'file-main' },
      fileNameEl(f.originalName, !!f.risk),
      h('div', { class: 'file-meta' }, ...meta),
      f.note ? h('div', { class: 'file-note', text: '“' + f.note + '”' }) : null,
    ),
    h('div', { class: 'file-actions' },
      h('button', { class: 'icon-btn', type: 'button', title: 'Copy link', onclick: () => copy(url) }, icon('link')),
      h('button', { class: 'icon-btn', type: 'button', title: 'Show QR', onclick: () => showQrModal('Scan to download', url) }, icon('qr')),
      h('button', { class: 'icon-btn danger', type: 'button', title: 'Delete', onclick: () => deleteFile(f.token) }, icon('trash')),
    ),
  );
}

// ---------- received (direct files sent to this device) ----------
function loadReceived() {
  try { return JSON.parse(localStorage.getItem(RECEIVED_KEY)) || []; } catch { return []; }
}
function saveReceived(arr) {
  try { localStorage.setItem(RECEIVED_KEY, JSON.stringify(arr)); } catch { /* ignore */ }
}
function addReceived(f) {
  const arr = loadReceived().filter((x) => x.token !== f.token);
  arr.unshift(f);
  saveReceived(arr);
  renderReceived();
}
function removeReceived(token) {
  saveReceived(loadReceived().filter((f) => f.token !== token));
  renderReceived();
}
function renderReceived() {
  const arr = loadReceived().filter((f) => !f.expiresAt || f.expiresAt > Date.now());
  saveReceived(arr);
  const list = $('#received-list');
  list.replaceChildren();
  for (const f of arr) list.append(fileCard(f, { received: true }));
  $('#received-empty').hidden = arr.length > 0;
}

// ---------- private messages (DMs to this device) ----------
function loadDms() {
  try { return JSON.parse(localStorage.getItem(DM_KEY)) || []; } catch { return []; }
}
function saveDms(arr) {
  try { localStorage.setItem(DM_KEY, JSON.stringify(arr.slice(0, 200))); } catch { /* ignore */ }
}
function addDm(m) {
  const arr = loadDms();
  arr.unshift(m);
  saveDms(arr);
  renderDms();
}
function renderDms() {
  const arr = loadDms();
  const list = $('#dm-list');
  list.replaceChildren();
  for (const m of arr) list.append(dmCard(m));
  $('#dm-empty').hidden = arr.length > 0;
}
function dmCard(m) {
  // fromId is the sender's handle, as the hub knows it — not a claim.
  const canReply = m.fromId && state.devices.some((d) => d.id === m.fromId);
  return h('div', { class: 'note-card dm' },
    h('div', { class: 'dm-main' },
      h('div', { class: 'dm-from' }, icon('message', 13), ...fromLabel(m, 'Someone'),
        h('span', { class: 'dm-time', text: ' · ' + fmtWhen(m.ts) })),
      h('div', { class: 'note-text', text: m.text }),
    ),
    h('div', { class: 'note-actions' },
      canReply ? h('button', { class: 'icon-btn', type: 'button', title: 'Reply', onclick: () => replyTo(m) }, icon('reply')) : null,
      h('button', { class: 'icon-btn', type: 'button', title: 'Copy', onclick: () => copy(m.text) }, icon('link')),
      h('button', { class: 'icon-btn danger', type: 'button', title: 'Delete', onclick: () => { saveDms(loadDms().filter((x) => x.id !== m.id)); renderDms(); } }, icon('trash')),
    ),
  );
}
function replyTo(m) {
  showView('send');
  switchSendTab('message');
  const sel = $('#msg-dest');
  if ([...sel.options].some((o) => o.value === m.fromId)) sel.value = m.fromId;
  const inp = $('#msg-input');
  inp.value = '';
  inp.focus();
  toast('Replying to ' + (m.fromName || 'device'));
}

// ---------- devices (roster + rename) ----------
// Browsers on the same computer arrive with the same `computer` tag (see
// ws-hub.js): show them as one device. Sending to any of them reaches all.
function groupedDevices() {
  const out = [];
  const byComputer = new Map();
  for (const d of state.devices) {
    const g = d.computer && byComputer.get(d.computer);
    if (g) {
      g.members.push(d);
      if (d.agent && !g.agents.includes(d.agent)) g.agents.push(d.agent);
      continue;
    }
    const entry = { ...d, members: [d], agents: d.agent ? [d.agent] : [] };
    out.push(entry);
    if (d.computer) byComputer.set(d.computer, entry);
  }
  return out;
}
function othersGrouped() {
  const me = state.devices.find((d) => d.id === state.myHandle);
  return groupedDevices().filter((g) => !g.members.some((m) => m.id === state.myHandle) &&
    !(me && me.computer && g.computer === me.computer));
}
function renderDevices() {
  const list = $('#device-list');
  list.replaceChildren();
  const me = state.device;
  const mine = groupedDevices().find((g) => g.members.some((m) => m.id === state.myHandle));
  list.append(deviceCard(mine || { id: state.myHandle, name: me.name, kind: me.kind, agents: [] }, true));
  const others = othersGrouped();
  for (const d of others) list.append(deviceCard(d, false));
  $('#devices-empty').hidden = others.length > 0;
}
function deviceCard(d, self) {
  const kindIcon = d.kind === 'mobile' ? 'smartphone' : d.kind === 'tablet' ? 'tablet' : 'monitor';
  const card = h('div', { class: 'device-card' + (self ? ' self' : '') },
    h('div', { class: 'device-avatar' }, icon(kindIcon, 20)),
    h('div', { class: 'device-main' },
      h('span', { class: 'device-name', text: d.name }),
      self ? h('span', { class: 'device-tag', text: 'This device' }) : null,
      d.agents && d.agents.length > 1 ? h('span', { class: 'device-agents', text: d.agents.join(' · ') }) : null,
    ),
    h('div', { class: 'device-actions' },
      self
        ? h('button', { class: 'icon-btn', type: 'button', title: 'Rename this device', onclick: () => startRename(card, d) }, icon('pencil', 16))
        : h('button', { class: 'btn small', type: 'button', title: 'Send a file', onclick: () => sendToDeviceFlow(d) }, icon('send', 15), 'Send'),
    ),
  );
  if (!self) {
    card.addEventListener('dragover', (e) => { e.preventDefault(); card.classList.add('drop'); });
    card.addEventListener('dragleave', (e) => { if (e.target === card) card.classList.remove('drop'); });
    card.addEventListener('drop', (e) => {
      e.preventDefault(); e.stopPropagation(); card.classList.remove('drop');
      if (e.dataTransfer && e.dataTransfer.files.length) {
        for (const f of e.dataTransfer.files) uploadOne(f, { to: d.id, toName: d.name });
      }
    });
  }
  return card;
}
function startRename(card, d) {
  const nameEl = card.querySelector('.device-name');
  if (!nameEl) return;
  const input = h('input', { class: 'device-rename', value: d.name, maxlength: '60' });
  nameEl.replaceWith(input);
  input.focus(); input.select();
  let done = false;
  const commit = () => {
    if (done) return;
    done = true;
    const v = input.value.trim().slice(0, 60);
    // The hub decides the final name (it may add "(2)", or wait for the
    // host's approval); the roster brings it back.
    if (v && v !== d.name) wsSend({ type: 'rename', name: v });
    renderDevices();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') { done = true; renderDevices(); }
  });
  input.addEventListener('blur', commit);
}
// Jump to Send view with this device preselected.
function sendToDeviceFlow(d) {
  showView('send');
  switchSendTab('files');
  const sel = $('#send-dest');
  if ([...sel.options].some((o) => o.value === d.id)) { sel.value = d.id; updateSendOpts(); }
  $('#file-input').click();
}

// ---------- delete ----------
async function deleteFile(token) {
  try {
    const r = await api(`/api/files/${token}`, { method: 'DELETE' });
    if (r.status === 403) return toast('Only the device that shared it, or the host, can delete it', 'danger');
    if (!r.ok && r.status !== 404) throw new Error('delete failed');
    removePublicFile(token);
    removeSentLocal(token);
    toast('Deleted');
  } catch { toast('Delete failed', 'danger'); }
}

// ---------- send: destination selectors ----------
function fillDest(sel, includePublic, includeLink) {
  const prev = sel.value;
  sel.replaceChildren();
  if (includePublic) sel.append(h('option', { value: 'everyone', text: 'Everyone (public)' }));
  if (includeLink) sel.append(h('option', { value: 'link', text: 'Private link (anyone with link)' }));
  const others = othersGrouped();
  if (others.length) {
    const grp = h('optgroup', { label: 'Send to a device' });
    for (const d of others) grp.append(h('option', { value: d.id, text: d.name }));
    sel.append(grp);
  }
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
}
function renderDestSelectors() {
  fillDest($('#send-dest'), true, true);
  fillDest($('#msg-dest'), true, false);
  updateSendOpts();
}
function updateSendOpts() {
  const dest = $('#send-dest').value;
  const isDevice = dest !== 'everyone' && dest !== 'link';
  // expiry + one-time apply to every kind of send (public, private link, device)
  $('#expiry-opt').hidden = false;
  $('#onetime-opt').hidden = false;
  // a note only makes sense for a private link or a device send
  $('#send-note').hidden = dest === 'everyone';
  $('#send-note').placeholder = isDevice
    ? 'Add a private message for this device (optional)…'
    : 'Add a note shown with this private link (optional)…';
}

// ---------- send (uploads the staged files with the chosen options) ----------
function doSend() {
  const files = state.staged.slice();
  if (!files.length) return;
  const dest = $('#send-dest').value;
  const note = $('#send-note').value.trim();
  const expiresInMinutes = $('#expiry').value;
  const oneTime = $('#onetime').checked;
  if (dest === 'everyone') {
    for (const f of files) uploadOne(f, { visibility: 'public', expiresInMinutes, oneTime, kind: 'public' });
  } else if (dest === 'link') {
    for (const f of files) uploadOne(f, { visibility: 'private', expiresInMinutes, oneTime, note, kind: 'link' });
  } else {
    const dev = state.devices.find((d) => d.id === dest);
    const toName = dev ? dev.name : 'device';
    for (const f of files) uploadOne(f, { to: dest, toName, expiresInMinutes, oneTime, note, kind: 'device' });
    if (note) sendDm(dest, note);
  }
  $('#send-note').value = '';
  clearStaged();
}

function uploadOne(file, opts) {
  // Say so now, rather than after minutes of uploading.
  if (state.maxUploadBytes && file.size > state.maxUploadBytes) {
    toast(`“${file.name}” is too large — the limit on this hub is ${formatSize(state.maxUploadBytes)}`, 'danger');
    return;
  }
  const uploads = $('#uploads');
  const fill = h('div', { class: 'upload-fill' });
  const pct = h('div', { class: 'upload-pct', text: '0%' });
  const status = h('div', { class: 'upload-status', hidden: true });
  const cancelBtn = h('button', { class: 'icon-btn tiny', type: 'button', title: 'Cancel upload' }, icon('x', 14));
  const row = h('div', { class: 'upload-row' },
    h('div', { class: 'upload-name', text: file.name }),
    h('div', { class: 'upload-bar' }, fill),
    pct,
    cancelBtn,
    status,
  );
  uploads.hidden = false;
  uploads.append(row);

  let finished = false;
  let cancelled = false;
  let uploadId = null;
  let xhr = null;
  const cleanup = () => {
    if (finished) return;
    finished = true;
    row.remove();
    if (!uploads.children.length) uploads.hidden = true;
    uploadEnded();
  };
  const show = (sent) => {
    const p = file.size ? Math.min(100, Math.floor((sent / file.size) * 100)) : 100;
    fill.style.width = p + '%';
    pct.textContent = p + '%';
  };
  const setStatus = (text) => { status.textContent = text || ''; status.hidden = !text; row.classList.toggle('paused', !!text); };
  cancelBtn.addEventListener('click', () => {
    cancelled = true;
    if (xhr) xhr.abort();
    if (uploadId) api(`/api/upload/${uploadId}`, { method: 'DELETE' }).catch(() => {});
    cleanup();
    toast(`Cancelled “${file.name}”`);
  });
  const fail = (msg) => { cleanup(); toast(msg, 'danger'); };

  // One piece, with progress. Resolves to the server's new count; rejects
  // with { status, received } on a refusal, or { network: true } when the
  // connection drops.
  const sendPiece = (offset, blob) => new Promise((resolve, reject) => {
    xhr = new XMLHttpRequest();
    xhr.open('PUT', `/api/upload/${uploadId}?offset=${offset}`);
    xhr.setRequestHeader('x-meghxl-device', state.device.id);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) show(offset + e.loaded); };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* empty */ }
      if (xhr.status === 200) resolve(data.received);
      else reject({ status: xhr.status, received: data.received, error: data.error, gone: data.gone });
    };
    xhr.onerror = () => reject({ network: true });
    xhr.onabort = () => reject({ network: true });
    xhr.send(blob);
  });

  // When the connection drops (a phone locking its screen, Wi-Fi changing),
  // wait — longer each time, or until the page is visible / back online —
  // then ask the hub how much arrived and carry on from there.
  const waitToRetry = (attempt) => new Promise((resolve) => {
    const delay = Math.min(30000, 1000 * 2 ** Math.min(attempt, 5));
    let timer = null;
    const go = () => {
      clearTimeout(timer);
      window.removeEventListener('online', go);
      document.removeEventListener('visibilitychange', onVisible);
      resolve();
    };
    const onVisible = () => { if (document.visibilityState === 'visible') go(); };
    timer = setTimeout(go, delay);
    window.addEventListener('online', go);
    document.addEventListener('visibilitychange', onVisible);
  });

  const finishUpload = (shape) => {
    cleanup();
    addSent({
      token: shape.token, originalName: shape.originalName, size: shape.size, mime: shape.mime,
      expiresAt: shape.expiresAt, oneTime: shape.oneTime, createdAt: shape.createdAt || Date.now(),
      kind: opts.kind, toName: opts.toName || null, note: opts.note || null, risk: shape.risk || null,
    });
    if (opts.to) {
      toast(`Sent to ${opts.toName || 'device'}`, 'good');
    } else if (shape.visibility === 'public') {
      addPublicFile(shape);
      toast('Shared with everyone', 'good');
    } else {
      showQrModal('Private link — share it with one person', dlUrl(shape.token));
    }
  };

  (async () => {
    uploadStarted();
    try {
      // The sender's name comes from the hub's record of this device.
      const startRes = await api('/api/upload/start', { method: 'POST', json: {
        name: file.name, size: file.size,
        visibility: opts.to ? undefined : opts.visibility, to: opts.to || undefined,
        expiresInMinutes: opts.expiresInMinutes || '0', oneTime: !!opts.oneTime,
      } });
      const started = await startRes.json().catch(() => ({}));
      if (!startRes.ok) return fail(`“${file.name}” didn't upload: ${started.error || 'refused'}`);
      uploadId = started.uploadId;
      const chunk = started.chunkSize || 8 * 1024 * 1024;

      let received = 0;
      let attempt = 0;
      while (received < file.size && !cancelled) {
        try {
          received = await sendPiece(received, file.slice(received, Math.min(file.size, received + chunk)));
          attempt = 0;
          setStatus('');
        } catch (e) {
          if (cancelled) return;
          if (e.status === 409 && Number.isFinite(e.received)) { received = e.received; continue; }
          if (e.gone) return fail(`“${file.name}” was interrupted for too long — please send it again.`);
          if (!e.network && e.status && e.status !== 502 && e.status !== 503) {
            return fail(`“${file.name}” didn't upload: ${e.error || 'refused'}`);
          }
          setStatus('Paused — will continue when the connection is back');
          await waitToRetry(attempt++);
          if (cancelled) return;
          try {
            const st = await (await api(`/api/upload/${uploadId}`)).json();
            if (st.gone) return fail(`“${file.name}” was interrupted for too long — please send it again.`);
            if (Number.isFinite(st.received)) received = st.received;
            setStatus('Resuming…');
          } catch { /* still offline: loop and wait again */ }
        }
        show(received);
      }
      if (cancelled) return;
      // An empty file sends no pieces; finishing it is the whole upload.
      for (let tries = 0; ; tries++) {
        try {
          const r = await api(`/api/upload/${uploadId}/finish`, { method: 'POST' });
          const shape = await r.json().catch(() => ({}));
          if (!r.ok) return fail(`“${file.name}” didn't upload: ${shape.error || 'refused'}`);
          return finishUpload(shape);
        } catch {
          if (cancelled) return;
          setStatus('Paused — will continue when the connection is back');
          await waitToRetry(tries);
        }
      }
    } catch {
      if (!cancelled) fail(`“${file.name}” didn't upload — check the Wi-Fi and try again.`);
    }
  })();
}

// ---------- keeping uploads alive on phones ----------
// A phone stops an upload the moment its screen locks or the browser goes to
// the background — a real risk for a video that takes minutes. While anything
// is uploading: show a hint, warn before leaving, and ask to keep the screen on.
// Browsers only offer the Wake Lock API to secure contexts (HTTPS/localhost),
// so over plain http:// on a LAN it's unavailable and the hint does the work.
let activeUploads = 0;
let wakeLock = null;
async function holdWakeLock() {
  if (wakeLock || !('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch { /* refused (e.g. low-power mode) — the hint still shows */ }
}
function updateUploadHint() { $('#upload-hint').hidden = activeUploads === 0; }
function uploadStarted() { activeUploads++; holdWakeLock(); updateUploadHint(); }
function uploadEnded() {
  activeUploads = Math.max(0, activeUploads - 1);
  if (!activeUploads && wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  updateUploadHint();
}
// The browser drops the wake lock whenever the page is hidden; take it back.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && activeUploads) holdWakeLock();
});
window.addEventListener('beforeunload', (e) => {
  if (!activeUploads) return;
  e.preventDefault();
  e.returnValue = '';
});

// ---------- messages ----------
async function sendDm(to, text) {
  try {
    const r = await api('/api/dm', { method: 'POST', json: { to, text } });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'failed');
    if (data.delivered) toast('Message sent', 'good');
    else toast('Sent — device is offline right now', 'good');
  } catch { toast('Could not send message', 'danger'); }
}
async function sendPublicNote(text) {
  try {
    const r = await api('/api/notes', { method: 'POST', json: { text } });
    if (r.status === 429) return toast('Sending too fast — wait a moment', 'danger');
    if (!r.ok) throw new Error('note failed');
    // The server echoes the note back over WebSocket, which is what renders it.
    toast('Posted to everyone', 'good');
  } catch { toast('Could not post note', 'danger'); }
}

// ---------- public messages (the shared clipboard) ----------
function renderNotes() {
  const list = $('#note-list');
  list.replaceChildren();
  for (const n of state.notes) list.append(noteCard(n));
  $('#note-empty').hidden = state.notes.length > 0;
}
function noteCard(n) {
  return h('div', { class: 'note-card dm' },
    h('div', { class: 'dm-main' },
      h('div', { class: 'dm-from' }, icon('message', 13), ...fromLabel(n, 'Someone'),
        h('span', { class: 'dm-time', text: ' · ' + fmtWhen(n.createdAt) })),
      h('div', { class: 'note-text', text: n.text }),
    ),
    h('div', { class: 'note-actions' },
      h('button', { class: 'icon-btn', type: 'button', title: 'Copy', onclick: () => copy(n.text) }, icon('link')),
      isMine(n)
        ? h('button', { class: 'icon-btn danger', type: 'button', title: 'Delete for everyone', onclick: () => deleteNote(n.id) }, icon('trash'))
        : null,
    ),
  );
}
async function deleteNote(id) {
  try {
    const r = await api(`/api/notes/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (r.status === 403) return toast('Only the device that posted it, or the host, can delete it', 'danger');
    if (!r.ok) throw new Error('delete failed');
  } catch { toast('Could not delete message', 'danger'); }
}

// ---------- websocket ----------
let ws = null;
let reconnectDelay = 1000;
function wsSend(obj) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); }

function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => {
    state.everConnected = true;
    reconnectDelay = 1000;
    setOnline(true);
    wsSend({ type: 'identify', deviceId: state.device.id, name: state.device.name, kind: state.device.kind,
      agent: browserName(), legacyId: state.device.legacyId });
  };
  ws.onclose = (ev) => {
    setOnline(false);
    if (state.blocked || state.joinRequired) return;
    // A private hub turns away sockets that haven't joined; check before
    // reconnecting in a loop.
    if (ev && ev.code === 1006 && !state.everConnected) {
      api('/api/join/status').then((r) => r.json()).then((s) => { if (!s.joined) showJoinGate(); }).catch(() => {});
    }
    setTimeout(connectWs, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.6, 15000);
  };
  ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    const { type, payload } = msg;
    if (type === 'hello') {
      state.baseUrl = payload.baseUrl || location.origin;
      if (payload.shareBase) state.shareBase = payload.shareBase;
      // The sidebar shows the hub's friendly address — never the IP.
      if (payload.friendlyBase) {
        const addr = $('#side-addr');
        addr.textContent = payload.friendlyBase.replace(/^https?:\/\//, '');
        addr.hidden = false;
      }
      state.announcement = payload.announcement || null;
      state.maxUploadBytes = payload.maxUploadBytes || null;
      setDeviceCount(payload.clients);
      renderAnnounceCards();
      renderPublic();
      renderSent();
    } else if (type === 'file-added') {
      addPublicFile(payload);
    } else if (type === 'file-removed') {
      removePublicFile(payload.token);
    } else if (type === 'welcome') {
      state.myHandle = payload.handle;
      if (state.device.legacyId) { delete state.device.legacyId; saveDevice(); }
      // The hub may have adjusted the name (e.g. "Sam (2)" if "Sam" is taken).
      if (payload.name && payload.name !== state.device.name) { state.device.name = payload.name; saveDevice(); updateSideMe(); }
      renderDevices(); renderDestSelectors(); renderPublic(); renderNotes();
    } else if (type === 'roster') {
      state.devices = payload.devices || [];
      const mine = state.devices.find((d) => d.id === state.myHandle);
      if (mine && mine.name && mine.name !== state.device.name) { state.device.name = mine.name; saveDevice(); updateSideMe(); }
      setDeviceCount(state.devices.length || 1);
      renderDevices();
      renderDestSelectors();
      renderDms(); // refresh reply-availability
    } else if (type === 'file-sent') {
      addReceived(payload);
      bumpPrivate();
      toast(`${payload.fromName || 'Someone'} sent you "${payload.originalName}"`, 'good');
    } else if (type === 'note-added') {
      state.notes = [payload, ...state.notes.filter((n) => n.id !== payload.id)];
      renderNotes();
    } else if (type === 'note-removed') {
      state.notes = state.notes.filter((n) => n.id !== payload.id);
      renderNotes();
    } else if (type === 'dm') {
      addDm(payload);
      bumpPrivate();
      toast(`${payload.fromName || 'Someone'}: ${payload.text}`.slice(0, 90), 'good');
    } else if (type === 'announce') {
      state.announcement = payload;
      renderAnnounceCards();
    } else if (type === 'announce-clear') {
      state.announcement = null;
      renderAnnounceCards();
    } else if (type === 'host-moved') {
      // The host role moved to another computer (a planned move).
      state.hostMoved = true;
      const banner = $('#offline-banner');
      banner.replaceChildren('MeghXL moved to another computer. ',
        payload && payload.to ? h('a', { href: payload.to, text: 'Open the new host' }) : 'Ask the host for its new address.');
      banner.hidden = false;
    } else if (type === 'join-required') {
      showJoinGate();
    } else if (type === 'approval-pending') {
      showWaitGate(payload && payload.name);
    } else if (type === 'approved') {
      location.reload();
    } else if (type === 'rename-pending') {
      toast(`Asked the host to approve the name “${payload.wanted}”`, 'good');
    } else if (type === 'rename-declined') {
      toast('The host kept your current name', 'danger');
    } else if (type === 'limits') {
      state.maxUploadBytes = payload.maxUploadBytes || null;
    } else if (type === 'requests-changed') {
      if (state.isAdmin) toast('A device is waiting for you — open the Host console', 'good');
    } else if (type === 'blocked') {
      state.blocked = true;
      setOnline(false);
      toast((payload && payload.reason) || 'You were blocked by the host', 'danger');
    }
  };
}
// Brief blips are normal (Wi-Fi, a phone waking up); say something only when
// the host has been unreachable for a few seconds.
let offlineTimer = null;
function setOnline(online) {
  $('#side-dot').classList.toggle('offline', !online);
  clearTimeout(offlineTimer);
  const banner = $('#offline-banner');
  if (online) { if (!state.hostMoved) banner.hidden = true; return; }
  if (state.hostMoved || state.blocked) return;
  offlineTimer = setTimeout(() => {
    banner.textContent = 'The host computer is offline — waiting for it to come back. Nothing is lost; this page reconnects by itself.';
    banner.hidden = false;
  }, 4000);
}
function setDeviceCount(n) {
  if (!Number.isFinite(n)) return;
  state.deviceCount = n;
  $('#nav-device-count').textContent = n;
}
function updateSideMe() { $('#side-me-name').textContent = state.device.name; }

// ---------- send tabs ----------
function switchSendTab(tab) {
  document.querySelectorAll('#send-tabs .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.sendtab === tab));
  document.querySelectorAll('[data-tab]').forEach((el) => { el.hidden = el.dataset.tab !== tab; });
}

// ---------- about / updates ----------
// The only outbound request MeghXL ever makes, and only on this button.
async function checkForUpdates() {
  const btn = $('#update-btn');
  const status = $('#update-status');
  const notes = $('#update-notes');
  const link = $('#update-link');
  btn.disabled = true;
  status.className = 'about-tag';
  status.textContent = 'Checking…';
  try {
    const res = await fetch('/api/update');
    const d = await res.json();
    $('#about-version').textContent = 'v' + (d.current || '');
    if (!res.ok) {
      status.textContent = `${d.error || 'Check failed'} — you can browse releases on GitHub instead.`;
      return;
    }
    if (d.noReleases) {
      status.className = 'about-tag';
      status.textContent = `You're on v${d.current}. No releases have been published yet.`;
      notes.hidden = true; link.hidden = true;
      return;
    }
    if (d.updateAvailable) {
      status.className = 'about-tag about-available';
      status.textContent = `Version ${d.latest} is available — you have ${d.current}.`;
      link.href = d.url;
      link.hidden = false;
      notes.textContent = d.notes || 'No release notes.';
      notes.hidden = false;
      $('#about-badge').hidden = false;
    } else {
      status.className = 'about-tag about-up-to-date';
      status.textContent = `You're up to date (v${d.current}).`;
      notes.hidden = true;
      link.hidden = true;
      $('#about-badge').hidden = true;
    }
  } catch {
    status.textContent = 'Could not check right now — you may be offline.';
  } finally {
    btn.disabled = false;
  }
}
function initAbout() {
  $('#update-btn').addEventListener('click', checkForUpdates);
  fetch('/api/health')
    .then((r) => r.json())
    .then((d) => { $('#about-version').textContent = 'v' + (d.version || ''); })
    .catch(() => { /* offline: the version stays a dash */ });
}

// ---------- init ----------
function initNav() {
  // Only in-page views; the host-console entry is a real link to /admin.
  document.querySelectorAll('.app-nav[data-view]').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));
}
function initSend() {
  document.querySelectorAll('#send-tabs .seg-btn').forEach((b) =>
    b.addEventListener('click', () => switchSendTab(b.dataset.sendtab)));
  $('#send-dest').addEventListener('change', updateSendOpts);

  const fileInput = $('#file-input');
  $('#browse-btn').addEventListener('click', (e) => { e.stopPropagation(); fileInput.click(); });
  fileInput.addEventListener('change', () => { stageFiles(fileInput.files); fileInput.value = ''; });
  $('#send-btn').addEventListener('click', doSend);
  $('#staged-clear').addEventListener('click', clearStaged);

  const dz = $('#dropzone');
  dz.addEventListener('click', () => fileInput.click());
  dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
  ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag'); }));
  dz.addEventListener('dragleave', (e) => { if (e.target === dz) dz.classList.remove('drag'); });
  dz.addEventListener('drop', (e) => {
    e.preventDefault(); dz.classList.remove('drag');
    if (e.dataTransfer && e.dataTransfer.files.length) stageFiles(e.dataTransfer.files);
  });
  document.addEventListener('paste', (e) => {
    if (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
    const files = e.clipboardData && e.clipboardData.files;
    if (files && files.length) stageFiles(files);
  });

  $('#msg-send').addEventListener('click', () => {
    const text = $('#msg-input').value.trim();
    if (!text) return;
    const dest = $('#msg-dest').value;
    $('#msg-input').value = '';
    if (dest === 'everyone') sendPublicNote(text);
    else sendDm(dest, text);
  });
}
function initModal() {
  $('#modal').addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
}
function initFoot() {
  $('#join-btn').addEventListener('click', async () => {
    let url = state.shareBase || location.origin;
    // On a private hub, the host's QR is an invite: it carries the join
    // secret in the fragment, which never reaches a server or a log.
    if (state.isAdmin) {
      try {
        const j = await (await fetch('/api/admin/join', { cache: 'no-store' })).json();
        if (j.privateMode && j.secret) {
          return showQrModal(`Scan to join — or enter ${j.code}`, `${url}/#join=${j.secret}`, { fingerprint: true });
        }
      } catch { /* fall back to the plain link */ }
    }
    showQrModal('Scan to open on another device', url, { fingerprint: true });
  });
}

// ---------- approval: waiting to be let in ----------
function showWaitGate(name) {
  $('#app-shell').hidden = true;
  $('#join-gate').hidden = true;
  $('#wait-gate').hidden = false;
  $('#wait-name').textContent = name || state.device.name;
}

// ---------- private mode: joining ----------
function showJoinGate() {
  if (state.joinRequired) return;
  state.joinRequired = true;
  $('#app-shell').hidden = true;
  $('#join-gate').hidden = false;
  try { if (ws) ws.close(); } catch { /* ignore */ }
  setTimeout(() => $('#join-code').focus(), 50);
}
async function submitJoin(body) {
  const r = await fetch('/api/join', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (r.ok) { location.replace(location.pathname + '#dashboard'); location.reload(); return true; }
  const data = await r.json().catch(() => ({}));
  $('#join-err').textContent = data.error || 'Could not join.';
  return false;
}
function initJoin() {
  const submit = () => {
    const code = $('#join-code').value.replace(/\D/g, '');
    if (code.length !== 6) { $('#join-err').textContent = 'Enter the 6-digit code.'; return; }
    submitJoin({ code });
  };
  $('#join-submit').addEventListener('click', submit);
  $('#join-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
}
// An invite link: #join=<secret>. Use it once, then take it off the address
// bar so it doesn't linger in history or a screenshot.
async function consumeInvite() {
  const m = /^#join=([A-Za-z0-9_-]{10,64})$/.exec(location.hash);
  if (!m) return false;
  history.replaceState(null, '', location.pathname + '#dashboard');
  return submitJoin({ secret: m[1] });
}

// ---------- programs dialog ----------
function initRisk() {
  $('#risk-ok').addEventListener('click', () => closeRisk(true));
  $('#risk-modal').addEventListener('click', (e) => { if (e.target.closest('[data-risk-cancel]')) closeRisk(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#risk-modal').hidden) closeRisk(false); });
}
// Show the "Host console" nav entry only where the server says this device is
// admin (the host PC). Pure UX: /admin and /api/admin/* are gated server-side
// regardless, so a hidden link is never the security boundary.
async function revealAdminNav() {
  try {
    const res = await fetch('/api/admin/whoami', { cache: 'no-store' });
    const who = await res.json();
    state.isAdmin = !!who.isAdmin;
    $('#nav-admin').hidden = !who.isAdmin;
    if (state.isAdmin) { renderPublic(); renderNotes(); }
  } catch { /* leave hidden */ }
}

async function loadInitial() {
  try {
    const filesRes = await api('/api/files');
    if (!filesRes.ok) return; // not joined, or waiting for the host
    const { files } = await filesRes.json();
    for (const f of files) state.publicFiles.set(f.token, f);
    renderPublic();
  } catch { /* WS will catch us up */ }
  try {
    const { notes } = await (await api('/api/notes')).json();
    state.notes = notes || [];
    renderNotes();
  } catch { /* WS will catch us up */ }
  renderSent();
  renderReceived();
  renderDms();
}

initNav();
initSend();
initModal();
initFoot();
initAbout();
initJoin();
initRisk();
updateSideMe();
renderAnnounceCards();
renderDevices();
renderDestSelectors();
renderStaged();
renderNotes();

(async function boot() {
  loadHostFingerprint();
  if (await consumeInvite()) return; // reloads once joined
  showView(location.hash.slice(1) || 'dashboard');
  window.addEventListener('hashchange', () => showView(location.hash.slice(1) || 'dashboard'));
  try {
    const status = await (await fetch('/api/join/status', { cache: 'no-store' })).json();
    if (!status.joined) return showJoinGate();
  } catch { /* older hub or offline: carry on */ }
  await revealAdminNav();
  loadInitial();
  connectWs();
})();

// Live countdowns; prune expired items when they hit zero.
setInterval(() => {
  let expired = false;
  document.querySelectorAll('.countdown[data-exp]').forEach((el) => {
    const txt = fmtCountdown(Number(el.getAttribute('data-exp')));
    el.textContent = txt;
    if (txt === 'expired') expired = true;
  });
  if (expired) { renderPublic(); renderSent(); renderReceived(); }
}, 1000);
