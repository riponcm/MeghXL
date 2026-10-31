# Changelog

All notable changes to MeghXL are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The in-app **Check for updates** reads GitHub Releases, so each release's notes
should mirror the entry below it.

## [Unreleased]

### Security
- **One oversized WebSocket message crashed the server.** Any device on the
  network could take the hub down with a single message over 100 MB. Messages
  are now capped at 64 KB, socket errors are handled, and sockets, messages and
  connections per address are rate-limited.
- **A device could impersonate another one** by copying its id from the device
  list, then receive that device's direct files and private messages. Device ids
  are now never shared: other devices see a handle derived from it. Sender names
  come from the hub's own records, so nobody can post as someone else — or as the
  host. Existing browsers get a fresh id on first load (names are kept).
- **Anyone could delete any file or message.** Now only the device that shared it,
  or the host, can.
- **Blocking only cut the live connection** — a blocked device could keep
  uploading, posting and deleting. A block now covers every request.
- **Disguised programs.** Filenames lose invisible characters such as the
  right-to-left override that makes `photo‮gpj.exe` read as `photoexe.jpg`, and
  long names keep their real extension. Uploads are checked: programs, scripts,
  installers, macro documents and zipped apps are labelled; a program named like
  a photo or document is called out; saving one asks first. The type a sender
  claims is ignored.
- **The desktop app marks received files as downloaded**, so macOS Gatekeeper
  and Windows SmartScreen / Protected View check them before they open.
- Uploads stop before the host's disk drops below `MIN_FREE_MB` (5 GB by
  default), at most 4 uploads at once per address.
- Wrong admin keys are throttled per address; the console keeps the key for the
  tab's session only.
- Pages send a strict Content-Security-Policy; `X-Forwarded-*` is trusted only
  from a proxy on the same machine.
- The metadata file (which holds the admin key) is readable by its owner only;
  a damaged one is set aside instead of overwritten; files a crash left behind
  in `uploads/` are cleaned up.
- Tokens such as `__proto__` are plain "not found" instead of a server error;
  malformed uploads get a 400.

### Added
- **Private mode** (host console → Settings → Who can join). Devices must join
  with the host's invite QR or 6-digit code before they can see or send
  anything; “New code” removes everyone at once. Off by default.
- **Refuse programs** (host console → Settings → Programs). Off by default:
  programs are allowed but labelled.

### Fixed
- In the desktop app, two downloads at once could swap paths in the "Saved to"
  notice.

### Upgrading
- Scripts that post notes, messages or direct sends: the sender is now taken from
  the `x-meghxl-device` header (a device that has identified over WebSocket);
  `fromName` / `fromId` in the body are ignored. Direct sends and messages are
  addressed by the handle shown in the device list.
- Deleting a public file through the API needs the uploading device's
  `x-meghxl-device` header, or admin.

## [1.0.1] — 2026-09-28

### Security
- **A website open in a browser on the host PC could act as the host console**
  in 1.0.0. The console trusted any request arriving from the host machine, and a
  web page can make its browser send exactly that. Through cross-site requests
  (CSRF), DNS rebinding and cross-site WebSockets, such a page could delete every
  file, read private files, post announcements shown to every device as coming
  from the host, block devices, and join the board. Every request is now checked:
  unknown `Host` names are refused, writes must come from a MeghXL page, admin
  writes need a header only MeghXL's own script sends, WebSocket handshakes must
  be same-origin, and no page can be framed. Reported by **kta1kri**.
  [GHSA-q5qg-gwfw-p5w5](https://github.com/riponcm/MeghXL/security/advisories/GHSA-q5qg-gwfw-p5w5)
- Admin rights also require the hub to be named by an address or this machine's
  own name, so a device on the LAN answering mDNS for another name can't borrow
  the host's trust.
- `/api/admin/whoami` no longer reveals the host's network addresses (it listed
  every address, including globally routable IPv6, to any device).
- The admin key is accepted only in the `x-admin-key` header, compared in
  constant time — no longer as `?key=` in API URLs.
- A device's WebSocket address is taken from `X-Forwarded-For` only when it comes
  from a reverse proxy on the same machine, so a LAN device can no longer appear
  as "this computer" or dodge an IP block.
- Downloads carry a sandbox Content-Security-Policy and
  `Cross-Origin-Resource-Policy: same-origin`.

### Fixed
- **Interrupted uploads are no longer silent.** When a phone stopped an upload —
  screen locked, browser sent to the background, Wi-Fi dropped — the progress
  bar simply vanished. The dashboard now names the file and says what happened,
  shows a "keep this page open" hint while uploading, and warns before leaving
  the page mid-upload. A picker that returns nothing (typically a long video the
  phone failed to prepare) is reported too.
- **Long uploads are no longer cut off at five minutes** when running with Node
  (`npm start`), which answered HTTP 408. A connection is now dropped only after
  two minutes of silence. (The desktop app was not affected.)
- A `HEAD` request (as sent by link previewers) no longer uses up a one-time link.

### Added
- `ALLOWED_HOSTS` — extra host names to accept, for proxies and names such as
  Tailscale's `*.ts.net`. Full URLs are accepted, and unparseable entries are
  reported at startup.

### Upgrading
- **Nothing to do** if you reach MeghXL by IP address, `localhost`, or a local
  name (`meghxl.local`, `*.lan`, a single-label name).
- **Other host names** (a proxy's public domain, `*.ts.net`) must be the host in
  `PUBLIC_BASE_URL` or be listed in `ALLOWED_HOSTS`, otherwise they get a 403
  naming the host. Behind a reverse proxy, preserve the `Host` header.
- **Admin API scripts** must send the key as the `x-admin-key` header (not
  `?key=`), plus `x-meghxl-request: 1` on anything that changes state. Opening
  `/admin?key=…` in a browser still unlocks the console.
- Open the host console via `localhost`, `127.0.0.1`, the LAN IP, or
  `meghxl.local`; a proxy's public name no longer grants host rights.

## [1.0.0] — 2026-09-07

First public release.

### Added
- LAN file transfer over one port: drop a file on one device and every other
  device on the network sees it, live over WebSocket.
- Public or private per file, with auto-expiry and one-time "burn after download"
  links.
- Shared message board and private device-to-device messages.
- Instant link and QR for every file, plus a join QR for the dashboard.
- Friendly `meghxl.local` name via mDNS.
- Host console at `/admin` — device roster, blocking, announcements, file
  management — restricted to the machine running the server.
- Native desktop apps for macOS, Windows and Linux (Tauri), with a tray icon,
  autostart, a chosen downloads folder, and signature-verified in-app updates.
- Uploads stream to disk and downloads support HTTP Range, so size is limited only
  by the disk and transfers resume.

### Security
- Host console access is decided at the socket, never from a spoofable
  `X-Forwarded-For` header.
- 128-bit URL-safe tokens for every file; path-traversal containment on downloads.
- `X-Content-Type-Options: nosniff` on downloads; the desktop app writes files to
  disk instead of ever rendering them.
- No telemetry. The only outbound request is a manual update check.

[Unreleased]: https://github.com/riponcm/MeghXL/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/riponcm/MeghXL/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/riponcm/MeghXL/releases/tag/v1.0.0
