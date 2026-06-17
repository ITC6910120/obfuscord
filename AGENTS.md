# AGENTS.md — discord

Single-package Electron + Bun + TypeScript project. Obfuscated Discord client using in-memory MITM TLS proxy.

## Setup & build

```bash
bun install
bun run build        # bundle → dist/index.js (Electron external, single-file)
bun run start        # build + launch via `electron .`
```

## Key architecture

| File | Role | Depends on |
|------|------|-----------|
| `index.ts` | Entrypoint — Electron main process, proxy config, window creation | `src/ca.ts`, `src/local-proxy.ts` |
| `src/ca.ts` | In-memory Root CA + per-domain cert generator (node-forge) | — |
| `src/local-proxy.ts` | HTTP CONNECT proxy on random localhost port | `src/terminator.ts` |
| `src/terminator.ts` | TLS termination bridge — server-side TLS (to Chromium) ↔ client-side TLS (to Discord, **no SNI**) | `src/ca.ts`, `src/doh-resolver.ts` |
| `src/doh-resolver.ts` | DNS-over-HTTPS (Cloudflare → Google fallback), IPv4 only | — |

## Critical boot order (must not change)

1. **Module level** — register `certificate-error` handler (line 35 of index.ts)
2. `initCa()` — generate in-memory Root CA
3. `startProxy()` — start local proxy, returns `{port, close}`
4. `app.whenReady()` — Electron ready
5. `session.defaultSession.setProxy(...)` — **must** happen after `whenReady()`
6. `createWindow()` — loads `https://discord.com/app`

The `certificate-error` handler **must** be at module scope to catch early events. `initCa()` must precede `startProxy()` because incoming CONNECT requests immediately call `signCert()`.

## Toolchain quirks

- **Bun** is both runtime and bundler. Do **not** use `tsc` for building; `tsconfig.json` has `noEmit: true`.
- Electron is declared in `devDependencies` and kept external via `--external electron` in build command.
- `node-forge` is the only real dependency (pure JS crypto, no native bindings).
- No tests, no linter, no formatter config. `tsconfig.json` is strict but has `noUnusedLocals: false` and `noUnusedParameters: false`.

## Known limitations

- **IPv4 only** — DoH resolver queries type A only. Discord over IPv6 will fail.
- **`checkServerIdentity` overridden** — `terminator.ts` line 77 sets `() => undefined`, bypassing server cert hostname check.
- **No timeouts** — proxy/TLS connections can hang indefinitely.
- **No connection pooling** — every request opens a new TLS socket.
- **Hardcoded Discord domains** — see `doh-resolver.ts` lines 111–118.
- **No tests exist** — any change needs manual verification.

## Running

```bash
bun run index.ts        # dev mode (Bun runs .ts directly with tsconfig)
bun run build           # bundle for production
bun run start           # build + electron
```

The app launches a visible Electron window. Quit via window close or Ctrl+C. On macOS the app stays alive after closing all windows (native convention).
