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
- **Exactly one outbound request exists, and only when you ask for it.** Pressing
  **Check for updates** (About page, or the desktop app's tray) performs a single
  `GET` to the GitHub releases API to compare version numbers. It sends no
  identifiers, no file names, no usage data — nothing but the request itself, and
  the answer is cached for an hour. Never happens on a timer, at launch, or in
  the background. The code is one short file, `src/routes/update.js`; read it.
  If you want it gone, delete that route — nothing else depends on it.
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
- **MIT licensed**, all history public.

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
| **Privilege escalation to admin** | The host console is **host-only**: granted only to a raw loopback/own-interface connection (no forwarding header), an `ADMIN_IP`, or `ADMIN_KEY`. A spoofed `X-Forwarded-For` cannot grant admin (auth uses the raw socket). | `src/admin-auth.js` (+ tests) |
| **XSS / HTML injection** | All user-supplied content (filenames, notes, device names) is inserted with `textContent`. `innerHTML` is used **only** for the project's own static SVG icon markup — never for user input. | `public/app.js`, `public/admin.js` |
| **HTTP header injection** | `Content-Disposition` filenames are sanitized (control chars stripped, RFC 5987 encoded). | `src/routes/files.js` |
| **Memory exhaustion** | Uploads stream to disk (never buffered in RAM); upload size is capped (`MAX_UPLOAD_MB`, default 500); JSON bodies capped at 16 KB. | `src/uploads.js`, `server.js` |

## What MeghXL does **not** do (limitations, stated plainly)

Honesty matters more than reassurance:

- On the LAN, **public files can be read and deleted by anyone on the network**
  (the “shared board” model). Use **private** + **expiry** + **one-time** links
  for anything sensitive.
- **No at-rest encryption** of stored files.
- **No rate limiting / brute-force throttling.** This is acceptable on a trusted
  LAN (and private tokens are 128-bit), but it is not hardened to face a hostile
  network directly.
- It is **not designed to be directly internet-facing** without your own
  authentication layer in front (see below).

## Hardening checklist (if you expose it beyond a trusted LAN)

- Put it behind a **VPN** or an **authenticated reverse proxy**; never port-forward
  it raw.
- Set **`ADMIN_KEY`** for admin access from outside the host machine.
- Prefer **private + expiry + one-time** links for anything sensitive.
- Keep dependencies current (`npm audit`, Dependabot), and run a recent Node LTS.

---

*MeghXL is open-source (MIT). If something here doesn't match the code, that's a
bug in the docs — please report it.*
