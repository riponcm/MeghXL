'use strict';

const $ = (s) => document.querySelector(s);

const state = { key: null, data: null, section: 'overview', poll: null };
let pollFails = 0; // consecutive denied polls; we only show "denied" after a few

// ---------- helpers ----------
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
  monitor: '<rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/>',
  smartphone: '<rect width="14" height="20" x="5" y="2" rx="2" ry="2"/><path d="M12 18h.01"/>',
  tablet: '<rect width="16" height="20" x="4" y="2" rx="2" ry="2"/><line x1="12" x2="12.01" y1="18" y2="18"/>',
  ban: '<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>',
  lockOpen: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  megaphone: '<path d="m3 11 18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  pencil: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
};
function icon(name, size = 18) {
  const t = document.createElement('template');
  t.innerHTML = `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ICONS.file}</svg>`;
  return t.content.firstChild;
}

function fmtSize(b) {
  if (!Number.isFinite(b)) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = b, i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${i === 0 ? n : n.toFixed(n >= 10 ? 0 : 1)} ${u[i]}`;
}
function fmtAge(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const hr = Math.round(m / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}
function fmtUptime(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}
function kindIcon(k) { return k === 'mobile' ? 'smartphone' : k === 'tablet' ? 'tablet' : 'monitor'; }
function isLocal(ip) { return /(^|:)(127\.0\.0\.1|::1)$/.test(ip || '') || ip === '::1'; }

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
  try { await navigator.clipboard.writeText(text); toast('Copied', 'good'); }
  catch { toast('Copy failed', 'danger'); }
}

// ---------- api ----------
async function api(path, opts = {}) {
  // x-meghxl-request marks this as our own script; the server refuses admin
  // writes without it (see requireAdmin in src/admin-auth.js).
  const headers = { 'x-meghxl-request': '1' };
  if (state.key) headers['x-admin-key'] = state.key; // optional remote-admin key (ADMIN_KEY)
  if (opts.body) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers,
    cache: 'no-store',
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || `HTTP ${res.status}`); e.status = res.status; e.body = data; throw e; }
  return data;
}

// ---------- access (the host machine only) ----------
function showConsole() { pollFails = 0; $('#denied').hidden = true; $('#console').hidden = false; startPoll(); }
function showDenied(info) {
  stopPoll();
  $('#console').hidden = true;
  $('#denied').hidden = false;
  const el = $('#denied-info');
  if (el && info && info.yourIp) el.textContent = `This device's IP: ${info.yourIp}`;
  
  if (state.key) {
    state.key = null;
    sessionStorage.removeItem('meghxl_admin_key');
    const errEl = $('#admin-key-err');
    if (errEl) errEl.textContent = 'Session or key invalid. Please re-enter key.';
  }
}

async function loadConsole() {
  try {
    state.data = await api('/api/admin/state');
    showConsole();
    renderSideStatus();
    renderSection();
  } catch (e) {
    showDenied(e.body);
  }
}

function startPoll() { stopPoll(); state.poll = setInterval(refresh, 5000); }
function stopPoll() { if (state.poll) clearInterval(state.poll); state.poll = null; }
function refresh() {
  api('/api/admin/state')
    .then((d) => {
      pollFails = 0;
      if ($('#console').hidden) showConsole(); // access came back — self-heal
      state.data = d;
      renderSideStatus();
      const ae = document.activeElement;
      if (!(ae && /^(INPUT|TEXTAREA)$/.test(ae.tagName))) renderSection();
    })
    .catch((e) => {
      if (e.status === 403) {
        // Tolerate a transient/forwarded 403 — only show "denied" after a few
        // consecutive failures, and never tear down the poll.
        if (++pollFails >= 3) showDenied(e.body);
      } else {
        pollFails = 0; // network blip; keep the console up
      }
    });
}

// ---------- shared bits ----------
// The IP address is shown only on request, so a screenshot or screen-share
// of the console shows the friendly name and nothing else. Survives polls.
let showIp = false;

function renderSideStatus() {
  const s = state.data && state.data.server;
  const box = $('#side-status');
  if (!s) { box.replaceChildren(); return; }
  const toggle = h('button', { class: 'link-btn', type: 'button', style: 'margin:0', text: showIp ? 'Hide IP' : 'Show IP' });
  toggle.addEventListener('click', () => { showIp = !showIp; renderSideStatus(); });
  box.replaceChildren(
    ...[
      h('div', {}, h('span', { class: 'dot' }), 'Running'),
      s.mdnsName ? h('div', { text: `${s.mdnsName}:${s.port}` }) : null,
      showIp ? h('div', { text: `${s.lanIp}:${s.port}` }) : null,
      h('div', {}, toggle),
      h('div', { text: 'LAN only' }),
      h('div', { text: `uptime ${fmtUptime(s.uptimeSec)}` }),
    ].filter(Boolean)
  );
}

function header(title, sub) {
  return [h('h1', { class: 'admin-h', text: title }), sub ? h('p', { class: 'admin-sub', text: sub }) : null].filter(Boolean);
}

function deviceRow(d, first) {
  return h('div', { class: 'adm-row' + (first ? ' first' : '') },
    h('div', { class: 'adm-ic' }, icon(kindIcon(d.kind), 20)),
    h('div', { class: 'adm-body' },
      h('div', { class: 'adm-name', text: d.name }),
      h('div', { class: 'adm-meta', text: `${d.agent ? d.agent + ' · ' : ''}${d.ip || 'unknown'}${isLocal(d.ip) ? ' · this computer' : ''} · joined ${fmtAge(d.connectedAt)}` }),
    ),
    h('div', { class: 'adm-actions' },
      h('button', { class: 'btn small ghost', type: 'button', title: 'Send a file', onclick: () => pickAndSend(d) }, icon('send', 15), 'Send'),
      h('button', { class: 'icon-btn danger', type: 'button', title: 'Block', onclick: () => blockDevice(d) }, icon('ban')),
    ),
  );
}
function blockedRow(b, first) {
  return h('div', { class: 'adm-row' + (first ? ' first' : '') },
    h('div', { class: 'adm-ic', style: 'color:var(--danger)' }, icon('ban', 20)),
    h('div', { class: 'adm-body' },
      h('div', { class: 'adm-name', text: b.name || 'Device' }),
      h('div', { class: 'adm-meta', text: `${b.ip || 'no ip'} · blocked ${fmtAge(b.at)}` }),
    ),
    h('div', { class: 'adm-actions' },
      h('button', { class: 'btn small ghost', type: 'button', onclick: () => unblockDevice(b.deviceId) }, icon('lockOpen', 15), 'Unblock'),
    ),
  );
}

// ---------- sections ----------
function renderSection() {
  const fn = { overview: renderOverview, devices: renderDevices, files: renderFiles, announce: renderAnnounce, activity: renderActivity, settings: renderSettings }[state.section];
  if (fn) fn();
}

function renderOverview() {
  const d = state.data;
  const main = $('#admin-main');
  const online = d.devices;
  main.replaceChildren(
    ...header('Overview', 'Running on your local network'),
    requestsPanel(d),
    h('div', { class: 'stat-grid' },
      stat('Devices online', String(d.stats.devicesOnline)),
      stat('Files shared', String(d.stats.files)),
      stat('Storage used', fmtSize(d.stats.storageBytes)),
      stat('Mode', 'LAN only'),
    ),
    panel('Connected devices', `${online.length} online`,
      online.length
        ? online.map((dev, i) => deviceRow(dev, i === 0))
        : [emptyRow('No devices connected right now.')]
    ),
    announcePanel(),
  );
}

function renderDevices() {
  const d = state.data;
  const main = $('#admin-main');
  const children = [
    ...header('Devices', 'Everyone connected to this server'),
    requestsPanel(d),
    panel('Connected', `${d.devices.length} online`,
      d.devices.length ? d.devices.map((dev, i) => deviceRow(dev, i === 0)) : [emptyRow('No devices connected.')]
    ),
  ];
  if (d.blocked.length) {
    children.push(panel('Blocked', `${d.blocked.length}`, d.blocked.map((b, i) => blockedRow(b, i === 0))));
  }
  main.replaceChildren(...children);
}

async function renderFiles() {
  const main = $('#admin-main');
  main.replaceChildren(...header('Files', 'Every transfer on this server'), h('p', { class: 'admin-sub', text: 'Loading…' }));
  let files = [];
  try { files = (await api('/api/admin/files')).files; } catch (e) { if (e.status === 401) return lock('Session expired.'); }
  const rows = files.length
    ? files.map((f, i) => fileRow(f, i === 0))
    : [emptyRow('No files yet.')];
  main.replaceChildren(
    ...header('Files', 'Every transfer on this server'),
    panel('All files', `${files.length}`, rows, files.length
      ? h('button', { class: 'btn small ghost danger', type: 'button', onclick: clearAllFiles }, icon('trash', 15), 'Clear all')
      : null),
  );
}
function fileRow(f, first) {
  const tags = [h('span', { class: 'badge', text: f.visibility })];
  if (f.oneTime) tags.push(h('span', { class: 'badge warn', text: 'one-time' }));
  if (f.visibility === 'direct') tags.push(h('span', { class: 'badge', text: 'to a device' }));
  if (f.risk) tags.push(h('span', { class: 'badge risk', title: f.risk.mismatch || f.risk.label, text: f.risk.mismatch ? 'disguised program' : 'program' }));
  return h('div', { class: 'adm-row' + (first ? ' first' : '') },
    h('div', { class: 'adm-ic', style: f.risk ? 'color:var(--danger)' : null }, icon(f.risk ? 'alert' : 'file', 20)),
    h('div', { class: 'adm-body' },
      h('div', { class: 'adm-name', text: f.originalName }),
      h('div', { class: 'adm-meta' }, `${fmtSize(f.size)} · ${f.downloadCount} downloads · ${fmtAge(f.createdAt)}${f.fromName ? ' · by ' + f.fromName : ''} `, h('span', { class: 'badges' }, ...tags)),
      f.risk ? h('div', { class: 'risk-line', text: (f.risk.mismatch || f.risk.label) + (f.risk.inner ? ` (${f.risk.inner})` : '') }) : null,
    ),
    h('div', { class: 'adm-actions' },
      h('a', { class: 'btn small ghost', href: f.downloadUrl, download: f.originalName, title: 'Download' }, 'Open'),
      h('button', { class: 'icon-btn danger', type: 'button', title: 'Delete', onclick: () => deleteFile(f.token) }, icon('trash')),
    ),
  );
}

function renderAnnounce() {
  const main = $('#admin-main');
  const list = state.data.announcements;
  main.replaceChildren(
    ...header('Announcements', 'Broadcast a banner to every connected device'),
    announcePanel(),
    panel('History', `${list.length}`,
      list.length
        ? list.map((a, i) => h('div', { class: 'adm-row' + (i === 0 ? ' first' : '') },
            h('div', { class: 'adm-ic' }, icon('megaphone', 18)),
            h('div', { class: 'adm-body' },
              h('div', { class: 'adm-name', text: a.text }),
              h('div', { class: 'adm-meta', text: fmtAge(a.ts) }),
            ),
          ))
        : [emptyRow('Nothing sent yet.')],
      list.length ? h('button', { class: 'btn small ghost', type: 'button', onclick: clearAnnouncements }, 'Clear all') : null),
  );
}
function announcePanel() {
  const input = h('input', { class: 'adm-input', type: 'text', maxlength: '280', placeholder: 'Message everyone — e.g. server restarts at 6pm', style: 'flex:1' });
  const send = () => {
    const text = input.value.trim();
    if (!text) return;
    api('/api/admin/announce', { method: 'POST', body: { text } })
      .then(() => { input.value = ''; toast('Announcement sent', 'good'); refresh(); })
      .catch((e) => toast(e.message, 'danger'));
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); send(); } });
  return h('div', { class: 'panel' },
    h('div', { class: 'panel-h' }, h('h2', { text: 'Send an announcement' })),
    h('div', { style: 'display:flex;gap:8px;margin-top:8px' }, input,
      h('button', { class: 'btn', type: 'button', onclick: send }, icon('megaphone', 15), 'Send to all')),
  );
}

function renderSettings() {
  const d = state.data;
  const s = d.server;
  const main = $('#admin-main');

  const expiryInput = h('input', { class: 'adm-input', type: 'number', min: '0', max: '10080', value: d.settings.defaultExpiryMinutes || 0, style: 'width:110px' });

  main.replaceChildren(
    ...header('Settings', 'Server configuration and controls'),

    panel('Server', null, [
      kv('On this computer', `http://localhost:${s.port}`),
      s.mdnsName ? kv('Friendly name', `http://${s.mdnsName}:${s.port}`) : null,
      ipRow(s),
      kv('Max upload', `${s.maxUploadMb ? s.maxUploadMb + ' MB' : 'No limit'}  (set MAX_UPLOAD_MB to change)`),
      kv('Disk reserve', `Uploads stop when less than ${fmtSize((s.minFreeMb || 0) * 1024 * 1024)} would be left free  (set MIN_FREE_MB to change)`),
    ].filter(Boolean)),

    panel('Links and QR codes', 'Which address goes into share links and QR codes', [
      linkChoice('ip', 'IP address', 'Works on every phone and PC.', d.settings.linkHost),
      s.mdnsName ? linkChoice('friendly', `Friendly name — ${s.mdnsName}`,
        'Keeps the IP off screen. iPhone, Mac and Windows resolve it; many Android phones do not.', d.settings.linkHost) : null,
    ].filter(Boolean)),

    privatePanel(d),

    panel('Approvals', 'For when you want the final say', [
      toggleRow('Approve new devices', "A device that hasn't been here before waits on a \"waiting for the host\" screen until you let it in (Overview → Waiting for you). Devices already connected when you turn this on are let in automatically. Declining blocks the device.",
        !!d.settings.approveDevices, (on) => saveSetting({ approveDevices: on }, on ? 'New devices will wait for you' : 'New devices join straight away')),
      toggleRow('Approve name changes', 'When a device renames itself, the new name waits for your tick. A brand-new device that arrives with a made-up name waits too, so a fresh device is no way around it.',
        !!d.settings.approveRenames, (on) => saveSetting({ approveRenames: on }, on ? 'Name changes will wait for you' : 'Devices can rename themselves')),
      toggleRow('One name per computer', "Safari, Chrome and Firefox on the same computer are listed as one device with one name, and a file sent to it reaches all of them. Works by address, so it switches itself off where more than 4 computers share one (a VPN or a shared router). Turn it off if several people use one address.",
        d.settings.groupBrowsers !== false, (on) => saveSetting({ groupBrowsers: on }, on ? 'Browsers on one computer share a name' : 'Every browser is listed separately')),
    ]),

    limitsPanel(d),

    panel('Programs', 'Apps, installers and scripts shared on this hub', [
      toggleRow('Refuse programs', 'Uploads that are programs — .exe, .dmg, .pkg, scripts, or a program renamed to look like a photo or PDF — are rejected. Off: they are allowed but clearly labelled, and everyone is asked before saving one. You can always share them from this computer.',
        !!d.settings.blockPrograms, (on) => saveSetting({ blockPrograms: on }, on ? 'Programs will be refused' : 'Programs allowed, with a warning')),
    ]),

    panel('Default expiry', 'Applies to new public/private uploads (0 = never)',
      [h('div', { style: 'display:flex;gap:8px;align-items:center' }, expiryInput,
        h('span', { class: 'adm-meta', text: 'minutes' }),
        h('button', { class: 'btn small ghost', type: 'button', onclick: () => saveExpiry(expiryInput.value) }, 'Save'))]),

    panel('Host device', null,
      [h('div', { class: 'adm-meta', text: 'This is the host computer — every browser on it has admin access. All other devices on the network see only the normal dashboard. To make a different PC admin, set ADMIN_IP (or ADMIN_KEY for remote access).' })]),

    panel('Danger zone', null,
      [h('div', { style: 'display:flex;gap:8px;align-items:center;justify-content:space-between' },
        h('div', { class: 'adm-meta', text: 'Delete every file on the server.' }),
        h('button', { class: 'btn small ghost danger', type: 'button', onclick: clearAllFiles }, icon('trash', 15), 'Clear all files'))]),
  );
}

// Private mode: who may use the hub. The code and invite QR are fetched only
// when the panel is drawn, and never shown on the shared dashboard.
let joinInfo = null;
function privatePanel(d) {
  const on = !!d.settings.privateMode;
  const rows = [
    toggleRow('Private mode', 'Only devices you invite can see or send anything. Use it on shared Wi-Fi — a café, office or hotel. This computer never needs to join, and download links keep working.',
      on, (v) => saveSetting({ privateMode: v }, v ? 'Private mode on — devices that have not joined were disconnected' : 'Private mode off — anyone on this network can join').then(() => { joinInfo = null; })),
  ];
  if (on) {
    const box = h('div', { class: 'join-box' }, h('div', { class: 'adm-meta', text: 'Loading…' }));
    rows.push(box);
    const paint = (j) => {
      const link = `${state.data.server.shareBase}/#join=${j.secret}`;
      // Fetched with the console's own headers (an <img> can't send the admin
      // key), then shown from memory.
      const img = h('img', { class: 'join-qr', alt: 'Invite QR code', width: '168', height: '168' });
      const headers = state.key ? { 'x-admin-key': state.key } : {};
      fetch(`/api/qr?text=${encodeURIComponent(link)}`, { headers, cache: 'no-store' })
        .then((r) => (r.ok ? r.blob() : Promise.reject(new Error('qr'))))
        .then((b) => { img.src = URL.createObjectURL(b); })
        .catch(() => { img.alt = 'QR unavailable — use the code'; });
      box.replaceChildren(
        img,
        h('div', { class: 'join-side' },
          h('div', { class: 'adm-meta', text: 'Join code' }),
          h('div', { class: 'join-code', text: j.code.replace(/(\d{3})(\d{3})/, '$1 $2') }),
          h('div', { class: 'adm-meta', text: `${j.joined} device${j.joined === 1 ? '' : 's'} joined. Scanning the QR joins instantly; the code works from any browser on the network.` }),
          h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-top:10px' },
            h('button', { class: 'btn small ghost', type: 'button', onclick: () => copy(link) }, 'Copy invite link'),
            h('button', { class: 'btn small ghost danger', type: 'button', onclick: rotateJoin }, 'New code — remove everyone')),
        ),
      );
    };
    if (joinInfo) paint(joinInfo);
    else api('/api/admin/join').then((j) => { joinInfo = j; paint(j); }).catch((e) => toast(e.message, 'danger'));
  }
  return panel('Who can join', on ? 'Private' : 'Anyone on this network', rows);
}
function rotateJoin() {
  if (!confirmAction('Make a new code? Every device that joined will be disconnected and must join again with the new code.')) return;
  api('/api/admin/join/rotate', { method: 'POST' })
    .then((j) => { joinInfo = { ...j, joined: 0 }; toast('New code ready', 'good'); renderSection(); })
    .catch((e) => toast(e.message, 'danger'));
}
// window.confirm can be unavailable inside the desktop app's webview; treat
// that as "yes" only for non-destructive prompts. This one is destructive, so
// a missing dialog means the user simply can't confirm — use the button twice.
let pendingConfirm = null;
function confirmAction(message) {
  try { return window.confirm(message); } catch { /* fall through */ }
  if (pendingConfirm === message) { pendingConfirm = null; return true; }
  pendingConfirm = message;
  toast('Click again to confirm', 'danger');
  return false;
}
function toggleRow(label, help, checked, onChange) {
  const input = h('input', { type: 'checkbox', checked: checked ? 'checked' : null });
  // Let go of focus: the console doesn't redraw while a field is focused, and
  // this panel should redraw to show the result.
  input.addEventListener('change', () => { input.blur(); onChange(input.checked); });
  return h('label', { class: 'toggle-row' }, input,
    h('div', {}, h('div', { class: 'toggle-label', text: label }), h('div', { class: 'adm-meta', text: help })));
}
function saveSetting(body, okMessage) {
  return api('/api/admin/settings', { method: 'POST', body })
    .then(() => { toast(okMessage || 'Saved', 'good'); refresh(); })
    .catch((e) => toast(e.message, 'danger'));
}

// ---------- requests waiting for the host ----------
function requestsPanel(d) {
  const reqs = d.requests || [];
  if (!reqs.length) return document.createDocumentFragment(); // nothing to show
  const rows = reqs.map((r, i) => h('div', { class: 'adm-row' + (i === 0 ? ' first' : '') },
    h('div', { class: 'adm-ic', style: 'color:var(--accent)' }, icon(r.type === 'rename' ? 'pencil' : kindIcon(r.kind), 20)),
    h('div', { class: 'adm-body' },
      r.type === 'rename'
        ? h('div', { class: 'adm-name' }, `“${r.from}” wants to be called `, h('b', { text: `“${r.wanted}”` }))
        : h('div', { class: 'adm-name', text: `“${r.name}”${r.agent ? ' (' + r.agent + ')' : ''} wants to join` }),
      h('div', { class: 'adm-meta', text: `${r.ip || ''} · ${fmtAge(r.at)}` }),
    ),
    h('div', { class: 'adm-actions' },
      h('button', { class: 'btn small', type: 'button', title: 'Approve', onclick: () => decide(r, true) }, icon('check', 15), r.type === 'rename' ? 'Allow' : 'Let in'),
      h('button', { class: 'btn small ghost danger', type: 'button', title: r.type === 'rename' ? 'Keep the current name' : 'Turn away and block',
        onclick: () => decide(r, false) }, icon('x', 15), r.type === 'rename' ? 'Keep old name' : 'Decline'),
    ),
  ));
  return panel('Waiting for you', `${reqs.length}`, rows);
}
function decide(r, accept) {
  if (!accept && r.type === 'device' && !confirmAction(`Turn away “${r.name}”? It will be blocked.`)) return;
  api(`/api/admin/requests/${encodeURIComponent(r.id)}`, { method: 'POST', body: { accept } })
    .then(() => { toast(accept ? 'Done' : 'Declined', accept ? 'good' : ''); refresh(); })
    .catch((e) => toast(e.message, 'danger'));
}

// ---------- upload limits ----------
const SIZE_CHOICES = [[0, 'No limit'], [100, '100 MB'], [1024, '1 GB'], [5 * 1024, '5 GB'], [10 * 1024, '10 GB'], [50 * 1024, '50 GB']];
// A preset list plus "Custom", which opens a GB field inline (window.prompt
// isn't available inside the desktop app).
function sizeSelect(value, onChange) {
  const sel = h('select', { class: 'adm-input' });
  const known = SIZE_CHOICES.some(([mb]) => mb === (value || 0));
  for (const [mb, label] of SIZE_CHOICES) sel.append(h('option', { value: String(mb), text: label }));
  sel.append(h('option', { value: 'custom', text: known ? 'Custom…' : `Custom: ${fmtSize(value * 1024 * 1024)}` }));
  sel.value = known ? String(value || 0) : 'custom';
  const gb = h('input', { class: 'adm-input', type: 'number', min: '0.1', step: '0.1', placeholder: 'GB', style: 'width:80px',
    value: known ? '' : String(+(value / 1024).toFixed(2)) });
  const save = h('button', { class: 'btn small ghost', type: 'button', text: 'Save' });
  const custom = h('span', { class: 'custom-size' }, gb, save);
  custom.hidden = true;
  save.addEventListener('click', () => {
    const mb = Math.round(parseFloat(gb.value) * 1024);
    if (Number.isFinite(mb) && mb > 0) { gb.blur(); onChange(mb); } else toast('Enter a size in GB', 'danger');
  });
  sel.addEventListener('change', () => {
    if (sel.value === 'custom') { custom.hidden = false; gb.focus(); return; }
    sel.blur();
    onChange(Number(sel.value));
  });
  return h('span', { class: 'size-pick' }, sel, custom);
}
function limitsPanel(d) {
  const s = d.server;
  const used = fmtSize(s.storedBytes || 0);
  return panel('Upload limits', 'Apply to other devices — this computer can share anything', [
    h('div', { class: 'limit-row' },
      h('div', {}, h('div', { class: 'toggle-label', text: 'Largest file' }),
        h('div', { class: 'adm-meta', text: 'A phone sees the limit before it starts, instead of failing after a long upload.' + (s.maxUploadMb ? ` MAX_UPLOAD_MB caps everyone at ${fmtSize(s.maxUploadMb * 1024 * 1024)}.` : '') })),
      sizeSelect(d.settings.maxUploadMb || 0, (mb) => saveSetting({ maxUploadMb: mb }, mb ? `Largest file: ${fmtSize(mb * 1024 * 1024)}` : 'No file size limit'))),
    h('div', { class: 'limit-row' },
      h('div', {}, h('div', { class: 'toggle-label', text: 'Total storage' }),
        h('div', { class: 'adm-meta', text: `Stop accepting files once the hub holds this much. In use now: ${used}. Expired and deleted files free space.` })),
      sizeSelect(d.settings.storageBudgetMb || 0, (mb) => saveSetting({ storageBudgetMb: mb }, mb ? `Storage limit: ${fmtSize(mb * 1024 * 1024)}` : 'No storage limit'))),
  ]);
}

// ---------- activity ----------
async function renderActivity() {
  const main = $('#admin-main');
  let list = [];
  try { list = (await api('/api/admin/activity')).activity; } catch (e) { return toast(e.message, 'danger'); }
  if (state.section !== 'activity') return;
  main.replaceChildren(
    ...header('Activity', 'What happened on this hub — newest first'),
    panel('Recent', `${list.length}`, list.length
      ? list.map((a, i) => h('div', { class: 'adm-row' + (i === 0 ? ' first' : '') },
          h('div', { class: 'adm-body' },
            h('div', { class: 'adm-name', style: 'white-space:normal', text: a.text + (a.count > 1 ? `  ×${a.count}` : '') }),
            h('div', { class: 'adm-meta', text: `${fmtAge(a.at)}${a.ip ? ' · ' + a.ip : ''}` }),
          )))
      : [emptyRow('Nothing yet.')]),
  );
}

// ---------- small builders ----------
function stat(label, value) {
  return h('div', { class: 'stat' }, h('div', { class: 'l', text: label }), h('div', { class: 'v', text: value }));
}
function panel(title, badge, rows, action) {
  return h('div', { class: 'panel' },
    h('div', { class: 'panel-h' },
      h('h2', { text: title }),
      h('div', { style: 'display:flex;gap:10px;align-items:center' },
        badge ? h('span', { class: 'adm-meta', text: badge }) : null, action || null)),
    ...(Array.isArray(rows) ? rows : [rows]),
  );
}
function kv(k, v) {
  return h('div', { class: 'adm-row first', style: 'border-top:none;padding:7px 0' },
    h('div', { class: 'adm-meta', style: 'flex:none;width:140px', text: k }),
    h('div', { style: 'word-break:break-all', text: v }));
}
function emptyRow(text) {
  return h('div', { class: 'adm-meta', style: 'padding:10px 0', text });
}

// ---------- actions ----------
function blockDevice(d) {
  if (!confirm(`Block "${d.name}"? It will be disconnected and can't rejoin.`)) return;
  api('/api/admin/block', { method: 'POST', body: { deviceId: d.id } })
    .then(() => { toast(`Blocked ${d.name}`); refresh(); })
    .catch((e) => toast(e.message, 'danger'));
}
function unblockDevice(deviceId) {
  api('/api/admin/unblock', { method: 'POST', body: { deviceId } })
    .then(() => { toast('Unblocked'); refresh(); })
    .catch((e) => toast(e.message, 'danger'));
}
function deleteFile(token) {
  api(`/api/admin/files/${token}`, { method: 'DELETE' })
    .then(() => { toast('Deleted'); renderFiles(); })
    .catch((e) => toast(e.message, 'danger'));
}
function clearAllFiles() {
  if (!confirm('Delete ALL files on the server?')) return;
  api('/api/admin/files/clear', { method: 'POST' })
    .then((r) => { toast(`Removed ${r.removed} file(s)`); refresh(); })
    .catch((e) => toast(e.message, 'danger'));
}
function clearAnnouncements() {
  api('/api/admin/announcements', { method: 'DELETE' })
    .then(() => { toast('Cleared'); refresh(); })
    .catch((e) => toast(e.message, 'danger'));
}
// Settings → Server: the IP row is masked until clicked (same reason as the
// sidebar — keep it out of screenshots by default).
function ipRow(s) {
  const value = h('div', { style: 'word-break:break-all' });
  const btn = h('button', { class: 'link-btn', type: 'button', style: 'margin:0 0 0 10px' });
  const paint = () => {
    value.textContent = showIp ? `http://${s.lanIp}:${s.port}` : '••••••••••••';
    btn.textContent = showIp ? 'Hide' : 'Show';
  };
  btn.addEventListener('click', () => { showIp = !showIp; paint(); renderSideStatus(); });
  paint();
  return h('div', { class: 'adm-row first', style: 'border-top:none;padding:7px 0' },
    h('div', { class: 'adm-meta', style: 'flex:none;width:140px', text: 'IP address' }),
    h('div', { style: 'display:flex;align-items:center' }, value, btn));
}
function linkChoice(value, label, help, current) {
  const input = h('input', { type: 'radio', name: 'link-host', value, checked: (current || 'ip') === value ? 'checked' : null });
  input.addEventListener('change', () => saveLinkHost(value));
  return h('label', { style: 'display:flex;gap:10px;align-items:flex-start;padding:7px 0;cursor:pointer' }, input,
    h('div', {}, h('div', { text: label }), h('div', { class: 'adm-meta', text: help })));
}
function saveLinkHost(linkHost) {
  api('/api/admin/settings', { method: 'POST', body: { linkHost } })
    .then(() => { toast('Saved — new links and QR codes use it', 'good'); refresh(); })
    .catch((e) => toast(e.message, 'danger'));
}
function saveExpiry(val) {
  api('/api/admin/settings', { method: 'POST', body: { defaultExpiryMinutes: Number(val) || 0 } })
    .then(() => { toast('Saved', 'good'); refresh(); })
    .catch((e) => toast(e.message, 'danger'));
}
function pickAndSend(d) {
  const inp = h('input', { type: 'file', multiple: 'true', style: 'display:none' });
  document.body.append(inp);
  inp.addEventListener('change', () => {
    [...inp.files].forEach((file) => {
      // Sends are addressed by the device's handle; the hub names the sender
      // "Host" because the request comes from this computer.
      const fd = new FormData();
      fd.append('to', d.handle);
      fd.append('file', file);
      const headers = state.key ? { 'x-admin-key': state.key } : {};
      fetch('/api/upload', { method: 'POST', body: fd, headers })
        .then(async (r) => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || 'Send failed'); })
        .then(() => toast(`Sent to ${d.name}`, 'good'))
        .catch((e) => toast(e.message || 'Send failed', 'danger'));
    });
    inp.remove();
  });
  inp.click();
}

// ---------- init ----------
// Only section buttons — the "Back to dashboard" entry is a plain link.
document.querySelectorAll('.admin-nav[data-section]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.admin-nav').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.section = btn.dataset.section;
    renderSection();
  });
});
(function boot() {
  const url = new URL(location.href);
  const fromUrl = url.searchParams.get('key');
  if (fromUrl) {
    state.key = fromUrl;
    sessionStorage.setItem('meghxl_admin_key', fromUrl);
    history.replaceState(null, '', location.pathname);
  } else {
    // Older versions kept the key in localStorage for good; move it to this
    // tab's session, so it's gone when the tab closes.
    const legacy = localStorage.getItem('meghxl_admin_key');
    if (legacy) { sessionStorage.setItem('meghxl_admin_key', legacy); localStorage.removeItem('meghxl_admin_key'); }
    const stored = sessionStorage.getItem('meghxl_admin_key');
    if (stored) {
      state.key = stored;
    }
  }

  // Set up event listeners for the unlock form
  const adminKeyInput = $('#admin-key');
  const unlockBtn = $('#unlock-btn');
  const errEl = $('#admin-key-err');

  if (unlockBtn && adminKeyInput) {
    const doUnlock = async () => {
      let key = adminKeyInput.value.trim();
      if (!key) {
        if (errEl) errEl.textContent = 'Please enter a key.';
        return;
      }

      // Smart extraction: if they pasted a URL or query string containing the key, extract it
      const match = key.match(/(?:[?&]key=|\bkey=)([a-zA-Z0-9_-]+)/i);
      if (match) {
        key = match[1];
      }

      if (errEl) errEl.textContent = '';
      state.key = key;
      try {
        state.data = await api('/api/admin/state');
        sessionStorage.setItem('meghxl_admin_key', key);
        showConsole();
        renderSideStatus();
        renderSection();
      } catch (e) {
        state.key = null;
        if (errEl) errEl.textContent = e.message || 'Invalid Admin Key.';
      }
    };

    unlockBtn.addEventListener('click', doUnlock);
    adminKeyInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        doUnlock();
      }
    });
  }

  loadConsole();
})();
