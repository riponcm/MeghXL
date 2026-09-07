# Changelog

All notable changes to MeghXL are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The in-app **Check for updates** reads GitHub Releases, so each release's notes
should mirror the entry below it.

## [Unreleased]

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

[Unreleased]: https://github.com/riponcm/MeghXL/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/riponcm/MeghXL/releases/tag/v1.0.0
