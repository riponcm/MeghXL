# MeghXL — desktop app

A [Tauri](https://tauri.app) shell around the MeghXL server, so the machine
hosting it needs **no Node.js installation and no terminal**.

```
MeghXL.app
├─ meghxl-desktop   Rust shell — window, tray, server lifecycle  (~6 MB)
└─ meghxl-server    server.js compiled by `bun build --compile`  (~82 MB)
       ↑ the window points at http://127.0.0.1:3000
```

The server has no native dependencies, so it compiles to one self-contained
executable that Tauri ships as a **sidecar**. Nothing about the server changes
for the desktop build — it is the same `server.js` the CLI runs.

## Build

Needs [Rust](https://rustup.rs), [Bun](https://bun.sh), and (on macOS) the Xcode
Command Line Tools.

```bash
npm install
npm run build          # → src-tauri/target/release/bundle/
npm run dev            # hot-reloading development build
```

Output is `MeghXL.app` + `.dmg` on macOS, `.msi` + NSIS `.exe` on Windows.

`npm run build` runs `scripts/build-server.sh` first, which compiles the server
for the host target triple into `src-tauri/binaries/meghxl-server-<triple>` and
stages `public/` into `src-tauri/resources/`. Both are generated, and both are
git-ignored.

Tauri **cannot cross-compile** between macOS and Windows — build each on its own
machine or in a CI matrix. (The server half alone can be cross-compiled:
`bash scripts/build-server.sh x86_64-pc-windows-msvc`.)

## How the shell behaves

- **Attaches before it spawns.** On launch it checks whether port 3000 already
  answers MeghXL's `/api/health`. If so it uses that server instead of starting
  a second one — so it never fights a server you started from the terminal or an
  autostart agent. It only ever stops a process it started itself.
- **Falls forward on a busy port.** If something *else* holds 3000, it takes the
  next free port rather than failing.
- **Stores data outside the bundle.** Transfers and `metadata.json` go to the
  OS user-data directory (`~/Library/Application Support/com.matily.meghxl` on
  macOS), so they survive app updates and stay writable.
- **Closing the window hides to the tray.** The server keeps serving the other
  devices on your network. Quit from the tray menu.
- **Downloads are always written to disk.** The window never renders a
  transferred file, whatever its type — a download handler saves it to your
  downloads folder (chosen from the tray, defaulting to the OS Downloads
  folder) and never overwrites, adding `(1)`, `(2)` to the name. Navigation is
  pinned to the dashboard; any other link opens in your real browser.

## Signing

Local builds are unsigned. Distributed builds should be signed and notarized —
otherwise macOS shows an "unidentified developer" warning and Windows shows a
SmartScreen prompt. See Tauri's
[signing guide](https://tauri.app/distribute/sign/).
