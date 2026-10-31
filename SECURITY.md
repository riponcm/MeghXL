# Security Policy

MeghXL is a small, self-hosted, **LAN-first** file-transfer tool. This document
explains its security model honestly so you can decide whether to trust it — and,
more importantly, so you can **verify it yourself**. Nothing here asks you to take
our word for it; every claim below points at code you can read in minutes.

---

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue for a
vulnerability.

- **Preferred:** GitHub → the repo's **Security** tab → **“Report a vulnerability”**
  (private security advisory).
- **Email:** `riponce.buet [at] gmail [dot] com`

We aim to acknowledge reports within a few days. Responsible disclosure is
appreciated; we will credit reporters who want credit.

## Supported versions

| Version | Supported |
|---|---|
| 1.x (latest) | ✅ |
| < 1.0 | ❌ |

Security fixes land on the **latest 1.x release** (and `main`). Please run a
recent version.

---

## Why you can trust the source (and how to confirm it)

MeghXL is deliberately built to be **auditable in one sitting**:

- **No build step, no minification, no obfuscation.** What you read is what runs.
  The frontend is plain HTML/CSS/JS in `public/`; the server is plain Node in
  `server.js` + `src/`.
- **No telemetry, analytics, tracking, or “phone-home”.** Nothing about you, your
  files, your devices, or your usage is ever sent anywhere. The server serves
  your files on your network and (optionally) advertises an mDNS name on the LAN.
- **Exactly one outbound request exists, and only on demand.** Pressing
  **Check for updates** (About page, or the desktop app's tray) performs a single
  `GET` to the GitHub releases API to compare version numbers. It sends no
  identifiers, no file names, no usage data — nothing but the request itself, and
  the answer is cached for an hour. Never on a timer, at launch, or in the
  background. Other websites can't trigger it (cross-site requests are refused);
  a script on your LAN could, since the endpoint needs no login. The code is one
  short file, `src/routes/update.js`; delete that route if you want it gone —
  nothing else depends on it.
- **Desktop updates are signature-verified.** The app only installs a package
  signed with the project's private key, checked against the public key compiled
  into the bundle. A tampered or unsigned package is refused, so a compromised
  download host cannot push you malicious code.
- **No dynamic code execution.** No `eval`, no `new Function`, no `child_process`
  at runtime. (The only shell scripts in the repo are the opt-in auto-start
  helpers under `scripts/`, which run **only** when you explicitly call
  `npm run autostart:install`.)
- **No install-time scripts.** `package.json` has **no `postinstall`/`preinstall`**
  hooks — `npm install` won't run arbitrary code.
- **Minimal dependencies:** 7 well-known runtime packages
  (`express`, `ws`, `multer`, `qrcode`, `qrcode-terminal`, `mime-types`,
  `bonjour-service`), pinned via `package-lock.json`. `npm audit` reports **0
  known vulnerabilities** at release.
- **Apache-2.0 licensed**, all history public.

### Audit it yourself (~10 minutes)

```bash
git clone https://github.com/riponcm/MeghXL.git && cd MeghXL
npm ci                      # installs exactly what package-lock.json pins
npm audit                   # expect: 0 vulnerabilities
npm test                    # the included test suite

# Spot-check the claims above:
grep -rn "eval(\|new Function\|child_process" src server.js   # (nothing)
grep -rni "analytics\|telemetry\|track" src public            # (nothing)
node -e "console.log(require('./package.json').scripts)"       # no postinstall
```

Read `server.js` and the files in `src/` — the whole server is a few hundred lines.

---

## Threat model & trust assumptions

MeghXL assumes the **local network is trusted**. That is the security boundary.

- On your LAN, anyone who can reach the URL can see/download **public** files,
  post shared-clipboard notes, and upload — that's the point of a same-network
  sharing tool.
- **MeghXL never exposes itself to the internet.** There is no built-in tunnel and
  no “go public” button. It only listens on the port you bind, on your own
  network. To reach it remotely you must put it behind infrastructure **you**
  control (a VPN such as WireGuard/Tailscale, or an authenticated reverse proxy)
  and set `PUBLIC_BASE_URL`.

## What MeghXL protects against

| Risk | Mitigation | Where |
|---|---|---|
| **Path traversal** | Client filenames never touch disk; files are stored under server-generated random names and served only by token, with a path-containment check. | `src/routes/files.js` (`storedPath`), `src/ids.js` |
| **Guessing private links** | Tokens are **128-bit**, URL-safe random strings (`crypto.randomBytes(16)`). | `src/ids.js` |
| **Another LAN device becoming admin** | The host console is granted only to a connection from the host machine itself (no forwarding header), an `ADMIN_IP`, or the `ADMIN_KEY` header. A spoofed `X-Forwarded-For` cannot grant admin, and the host must be named by an address or its own name, so a device answering mDNS for some other `.local` name can't borrow it. | `src/admin-auth.js`, `src/request-guard.js` (+ tests) |
| **Websites attacking the hub through the host's browser** (DNS rebinding, CSRF, cross-site WebSockets, clickjacking) | Because any web page open on the host PC can make its browser connect from loopback, the machine check alone is not enough. Every request is also checked: unknown `Host` names are refused (rebinding), writes must come from a MeghXL page (`Origin` / `Sec-Fetch-Site`), admin writes need a header only MeghXL's own script sends, WebSocket handshakes must be same-origin, and no page can be framed. **Fixed in 1.0.1** — see the advisory below. | `src/request-guard.js`, `src/admin-auth.js` (+ tests) |
| **XSS / HTML injection** | All user-supplied content (filenames, notes, device names) is inserted with `textContent`. `innerHTML` is used **only** for the project's own static SVG icon markup — never for user input. | `public/app.js`, `public/admin.js` |
| **Uploaded files running as pages** | Downloads are always `Content-Disposition: attachment` with `nosniff`, and carry `Content-Security-Policy: sandbox` and `Cross-Origin-Resource-Policy: same-origin` — so an uploaded `.html` or `.svg` can't run on MeghXL's origin or be embedded by another site. | `src/routes/files.js` |
| **HTTP header injection** | Filenames are cleaned when uploaded (control and invisible characters removed) and sent RFC 5987-encoded with an ASCII fallback. | `src/text.js`, `src/routes/files.js` |
| **Disguised programs** | Names lose invisible characters such as the right-to-left override (`photo‮gpj.exe` → `photogpj.exe`); long names are shortened without hiding the real extension, and the dashboard always shows the extension on its own. Each upload's first bytes and, for zips, the names inside it are checked: programs, scripts, installers and macro documents are labelled, a program wearing a document's name is called out, and saving one asks first. The type the sender claims is ignored. Disk images (`.iso`, `.img`, `.vhd`) and web pages are labelled too. The host can refuse programs altogether — that setting also refuses archives MeghXL can't look inside (`.rar`, `.7z`, a zip inside a zip, a zip whose index it can't read). MeghXL says what a file **is**, never that it is safe — it does not scan for malware. | `src/filetype.js`, `public/app.js` |
| **Received files skipping OS checks** | The desktop app marks every file it saves as downloaded (macOS quarantine, Windows Mark-of-the-Web as Internet zone), so Gatekeeper, SmartScreen and Office Protected View check it before it opens. | `desktop/src-tauri/src/main.rs` |
| **Impersonating another device** | Device ids are secrets between a browser and the hub; other devices only see a derived handle, which can't be used to identify as that device or receive its messages. Sender names come from the hub's own record; two devices online can't share a name (lookalike letters count as the same); names that imitate the host — including lookalikes such as `H0st` or Cyrillic `Ноst` — are marked, and the host's own messages carry a badge only the hub can set. | `src/identity.js`, `src/ws-hub.js`, `src/text.js` |
| **Deleting other people's things** | Only the device that shared a file or posted a message — or the host — can delete it. | `src/routes/files.js`, `src/routes/notes.js` |
| **Blocked devices coming back** | A block applies to every request (pages, uploads, messages, downloads), not only the live connection, by device and by address. Address blocks made in 1.0.2 or later lapse after a day, since DHCP reassigns addresses. A device block lasts, but only binds a client that presents its id — a script can leave it out, so for the first day the address block is what stops it. Blocks from earlier versions follow a device to the new id it gets on upgrade. | `server.js` (`blockGuard`), `src/store.js` |
| **Flooding and exhaustion** | WebSocket messages are capped at 64 KB (a 100 MB frame used to crash the server) and rate-limited per connection; connections are capped per address and in total. Uploads, messages, QR codes, join attempts and wrong admin keys are rate-limited per address, and after 30 wrong join codes in total the code changes by itself. At most 4 uploads at once per address (32 overall), and uploads stop before the disk would drop below `MIN_FREE_MB` (5 GB by default) — counting uploads still in progress. JSON bodies are capped at 16 KB; how many new devices an address can register is limited. | `src/ws-hub.js`, `src/limits.js`, `src/disk.js`, `src/join.js`, `src/admin-auth.js` |
| **Strangers on a shared network** | Optional **private mode**: devices must join with the host's invite QR or a 6-digit code before they can see or send anything. Download links keep working. Optionally the host also **approves each new device** (it receives nothing until let in) and **each name change**. An activity log records joins, approvals, blocks and refused uploads. | `src/join.js`, `src/ws-hub.js` |
| **Someone else posing as the host** (including after knocking the real one offline) | There is exactly one host, chosen on purpose; nothing ever takes over automatically. The host holds an Ed25519 key. Desktop apps on other computers pair with it once — the person compares its fingerprint with the host console — then make it sign a fresh challenge before trusting it, and check again every minute. A machine without the key is refused with a warning. The host also watches the network and alerts when another machine announces itself as MeghXL or uses its name. | `src/host-identity.js`, `desktop/src-tauri/src/host_link.rs`, `src/mdns.js` |
| **Losing or replacing the host** | A recovery key (shown in the host console, to be kept safe) restores the same host identity on a replacement computer; an encrypted settings backup brings its settings back. A planned move uses a one-time 80-bit transfer code that never crosses the network: the new computer proves it knows the code, receives the key sealed with it, checks it is the key the old host had been proving, and the old host then retires. | `src/routes/host.js` |
| **Filling the host's storage** | Besides the disk reserve, the host can set a largest-file size and a total storage budget for other devices. | `src/disk.js` |
| **Script injection, as a backstop** | Pages carry a Content-Security-Policy allowing only MeghXL's own scripts and connections to the hub. | `src/request-guard.js` |

## What MeghXL does **not** do (limitations, stated plainly)

Honesty matters more than reassurance:

- On the LAN, **public files can be read by anyone on the network** (the
  “shared board” model) — unless the host turns on **private mode**. Use
  **private** + **expiry** + **one-time** links for anything sensitive.
- **Traffic is plain HTTP.** On an open or shared network, someone able to
  intercept traffic can read transfers and copy a session. Private mode keeps
  strangers off the board; it does not encrypt anything.
- **No malware scanning.** Program labels describe what a file is; they can't
  tell good software from bad.
- **No at-rest encryption** of stored files.
- It is **not designed to be directly internet-facing** without your own
  authentication layer in front (see below).
- **Admin is tied to the host machine, not to a login.** Every browser on the host
  PC — and every program and OS user on it — has admin rights. Don't run MeghXL on
  a PC shared with people you don't trust. A reverse proxy on the same machine must
  send `X-Forwarded-For`, or the people it forwards look like the host. A per-install
  pairing secret is planned for 1.1.
- **"One name per computer" groups browsers by address.** Desktop browsers at
  the same private address share a name and receive direct sends together. If
  several people reach the hub from one address (a shared router, VPN or
  container network) and it doesn't switch itself off (it does above 4
  devices), turn it off in Settings → Approvals.
- **Phones and browsers can't check the host's key.** Over plain HTTP a browser
  has no way to tell the real host from another machine answering at the same
  name. Desktop apps check; for phones, scan the QR code on the host's screen
  (it carries the host's address), and watch for the host's "posing as MeghXL"
  alert.
- **The recovery key is the host.** Whoever has it can become your host. Keep it
  like a password: in a password manager or printed and put away.
- **Device identity lives in the browser.** A device is whoever holds its id,
  kept in that browser's storage. Anyone with access to that browser — or able to
  intercept plain-HTTP traffic — can act as that device. Display names are chosen
  by their owners and are not verified.
- **Host names.** IP addresses, `localhost`, and local names (`.local`, `.lan`,
  single-label names, …) work out of the box. Any other name — a proxy's public
  domain, a Tailscale `*.ts.net` name — must be listed in `ALLOWED_HOSTS` or be the
  host in `PUBLIC_BASE_URL`.

## Hardening checklist (if you expose it beyond a trusted LAN)

- Put it behind a **VPN** or an **authenticated reverse proxy**; never port-forward
  it raw.
- A random **admin key** is generated on first run and printed in the terminal;
  set **`ADMIN_KEY`** to choose your own. Enter it on the console's unlock form
  rather than in a URL. Scripts send it as the `x-admin-key` header (admin writes
  also need `x-meghxl-request: 1`).
- Behind a reverse proxy, **preserve the `Host` header** and set `PUBLIC_BASE_URL`
  (or `ALLOWED_HOSTS`) to the public name, so rebinding protection can see the real
  host name.
- Prefer **private + expiry + one-time** links for anything sensitive.
- Keep dependencies current (`npm audit`, Dependabot), and run a recent Node LTS.

## Security advisories

| Version | Issue | Credit |
|---|---|---|
| **1.0.1** ([GHSA-q5qg-gwfw-p5w5](https://github.com/riponcm/MeghXL/security/advisories/GHSA-q5qg-gwfw-p5w5)) | A website open in a browser on the host PC could act as the host console — read and delete files, post announcements, block devices — via CSRF, DNS rebinding or cross-site WebSockets. Fixed by validating `Host`, `Origin` and framing on every request. | kta1kri |

Published advisories: https://github.com/riponcm/MeghXL/security/advisories

---

*MeghXL is open-source (Apache-2.0). If something here doesn't match the code, that's a
bug in the docs — please report it.*
