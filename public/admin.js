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
  const headers = {};
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
    localStorage.removeItem('meghxl_admin_key');
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
      h('div', { class: 'adm-meta', text: `${d.ip || 'unknown'}${isLocal(d.ip) ? ' · this computer' : ''} · joined ${fmtAge(d.connectedAt)}` }),
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
  const fn = { overview: renderOverview, devices: renderDevices, files: renderFiles, announce: renderAnnounce, settings: renderSettings }[state.section];
  if (fn) fn();
}

function renderOverview() {
  const d = state.data;
  const main = $('#admin-main');
  const online = d.devices;
  main.replaceChildren(
    ...header('Overview', 'Running on your local network'),
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
  if (f.fromName) tags.push(h('span', { class: 'badge', text: 'to a device' }));
  return h('div', { class: 'adm-row' + (first ? ' first' : '') },
    h('div', { class: 'adm-ic' }, icon('file', 20)),
    h('div', { class: 'adm-body' },
      h('div', { class: 'adm-name', text: f.originalName }),
      h('div', { class: 'adm-meta' }, `${fmtSize(f.size)} · ${f.downloadCount} downloads · ${fmtAge(f.createdAt)} `, h('span', { class: 'badges' }, ...tags)),
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
    ].filter(Boolean)),

    panel('Links and QR codes', 'Which address goes into share links and QR codes', [
      linkChoice('ip', 'IP address', 'Works on every phone and PC.', d.settings.linkHost),
      s.mdnsName ? linkChoice('friendly', `Friendly name — ${s.mdnsName}`,
        'Keeps the IP off screen. iPhone, Mac and Windows resolve it; many Android phones do not.', d.settings.linkHost) : null,
    ].filter(Boolean)),

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
      const fd = new FormData();
      fd.append('to', d.id);
      fd.append('fromName', 'Host console');
      fd.append('file', file);
      fetch('/api/upload', { method: 'POST', body: fd })
        .then((r) => r.json()).then(() => toast(`Sent to ${d.name}`, 'good'))
        .catch(() => toast('Send failed', 'danger'));
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
    localStorage.setItem('meghxl_admin_key', fromUrl);
    history.replaceState(null, '', location.pathname);
  } else {
    const stored = localStorage.getItem('meghxl_admin_key');
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
        localStorage.setItem('meghxl_admin_key', key);
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
