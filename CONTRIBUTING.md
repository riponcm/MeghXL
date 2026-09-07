# Contributing to MeghXL

Thanks for taking the time. The codebase is deliberately small — read `server.js`
and `src/` and you'll have the whole picture in a few minutes.

## Getting set up

Requires **Node.js 18+**. For the desktop app you also need
[Rust](https://rustup.rs) and [Bun](https://bun.sh).

```bash
git clone https://github.com/riponcm/MeghXL.git
cd MeghXL
npm install
npm run dev      # auto-restarts on change
npm test         # node --test
```

Desktop app:

```bash
cd desktop
npm install
npm run build
```

## What we're looking for

Good first contributions: translations, browser compatibility fixes, packaging for
a distro, docs, and anything on the [Roadmap](README.md#roadmap).

Please **open an issue before starting anything large**. It's no fun writing a
feature that turns out to conflict with the design.

## The design constraints

These are load-bearing. A change that breaks one of them probably won't be merged,
however good it is otherwise:

- **LAN-only.** MeghXL never exposes itself to the internet on its own. Remote
  access is the operator's VPN or authenticated proxy, never a built-in tunnel.
- **No build step for the front-end.** `public/` is plain HTML, CSS and JS. Someone
  should be able to read the shipped file and see exactly what runs.
- **Dependencies are a cost.** Seven runtime dependencies today. A PR adding one
  needs to argue for it.
- **No telemetry.** Nothing about a user, their files or their devices leaves their
  machine. The single update check is manual and sends nothing.
- **The receiver installs nothing.** Any feature that requires software on the
  receiving device breaks the core promise.
- **Render user content with `textContent`.** `innerHTML` is only for static icon
  markup. Filenames and messages come from other people.

## Before you open a PR

```bash
npm test                          # must pass
node --check public/app.js        # front-end has no build step, so check syntax
```

- Match the surrounding style; there's no linter to argue with.
- Comments should explain *why*, not restate the code.
- One logical change per PR.
- If you fixed a bug, say how you reproduced it.

## Reporting security issues

Please **don't** open a public issue for a vulnerability. See
[SECURITY.md](./SECURITY.md) for how to report privately.
