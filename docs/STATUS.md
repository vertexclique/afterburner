# Afterburner — Implementation Status

Source of truth for what's shipped vs. what's left in the
`burn` runtime plan (`docs/IMPL_PLAN_BURN_RUNTIME.md`) and the
adjacent L3 shadow plan (locked decision Q3 in that doc).

**Last refreshed:** post commit `dd52bf5` (L3 jsonwebtoken shadow).
Regenerate by hand when a phase lands; `git log --oneline` is
authoritative if this file drifts.

---

## Test count

**216 tests pass workspace-wide** across the `afterburner` crate's
17 integration-test files plus the other workspace crates' unit/
integration suites. Run the full matrix with:

```bash
cargo test --workspace --exclude afterburner-plugin
cargo test -p afterburner --features bin,ts,shadow-bcrypt,shadow-argon2,shadow-jsonwebtoken
```

The plugin is excluded from `cargo test --workspace` because it
targets `wasm32-wasip1`; rebuild it via `afterburner-plugin/build.sh`.

---

## Shipped — phase-by-phase

### Phase B — `burn` as a Node.js-replacement runtime

| Phase | Gate | Status | Commit | Tests |
|:--|:--|:-:|:--|:-:|
| **B0** — Script mode (top-level JS, no UDF envelope) | `burn run foo.js` executes top-level; `console.log` / `process.argv` / `process.env` work | ✅ | `5706270` | 10+8+9 |
| **B1** — `require('node:X')` / `require('X')` parity | Every built-in reachable under both forms | ✅ | `4e7e102` | 27 |
| **B2** — `http.createServer` server-side polyfill | `burn server.js` serves HTTP end-to-end | ✅ | `67be29f` through `dc0e0bf` | 3 |
| **B2b** — Host-wide multiplex listener pool | Synchronous bind + proper EADDRINUSE + `.close()` releases the port | ✅ | `fd47ca6` | 5 |
| **B3** — Daemon lifecycle | `process.exit(n)` + host-managed timers + Ctrl-C clean shutdown | ✅ | `8f3d8ba`, `5803f14`, `c50a954` | 12 |
| **B4** — `burn node foo.js` pass-through | `burn node -e '1+2'` prints 3 | ✅ | `45ca0b3` | 15 |
| **B5** — PATH shim for npm / pnpm / npx / yarn / bun | `burn npm install X` routes npm's internal `node` child-processes back to burn | ✅ | `30ae5e0` | 10 |
| **B6** — CommonJS `require(pkg)` + `node_modules` walk | `require('./lib')`, `require('pkg')` walk up; `package.json "main"`; `.json` auto-parse; per-module `__dirname` scoping; cyclic partial-exports | ✅ | `f81510a` | 21 |
| **B8** — TypeScript via oxc (strip-types) | `burn foo.ts` / `.mts` / `.cts` transpile transparently; `.tsx` rejected | ✅ | `be560ad` | 13 |
| **B9** — ESM → CJS transform | `import X from 'Y'` / `export default X` / named exports / re-exports work in `.mjs` / `.ts` | ✅ | `c7090b2` | 18 |

### L3 shadows — pure-Rust substitutes for native-addon npm packages

Each shadow lives behind its own cargo feature (`shadow-<pkg>`) and
follows the five-file recipe:
`shadows/<pkg>.rs` + `shadow_<pkg>.js` + wasi host import + plugin
extern + plugin JS global.

| Package | Coverage | Status | Commit | Tests |
|:--|:--|:-:|:--|:-:|
| `bcrypt` | hash/compare/genSalt (+Sync +async dual shape) | ✅ | `5b5cd25` | 11 |
| `argon2` | hash/verify/needsRehash with Argon2id/i/d variants | ✅ | `3c5bd8d` | 9 |
| `jsonwebtoken` | sign/verify/decode with HS/RS/ES/PS/EdDSA algorithms | ✅ | `dd52bf5` | 15 |

---

## Remaining — plan phases not yet shipped

### Major unblocks

| Phase | Scope | Unblocks |
|:--|:--|:--|
| **B7 — `net` raw TCP sockets** | `net.connect` (client) + `net.createServer` (server) — Duplex-stream-shaped API, tokio-backed connection pool, daemon-event dispatch for `'data'` / `'end'` / `'close'` / `'error'` events analogous to the B2 HTTP server design | Every database driver (`pg`, `redis`, `mongodb`, `mysql2`) + raw-protocol clients (smtp, ftp, custom binary protocols) |
| **B7 — `tls` raw sockets** | `tls.connect` + `tls.createServer` on top of B7-net | TLS-terminating clients (secure redis, encrypted postgres), server-side HTTPS with custom TLS |
| **B7 — `fs/promises` expansion** | `watch`, `realpath`, `cp`, `opendir`, file-descriptor APIs | File-watcher scripts, complex fs scripts |
| **B7 — `dns` expansion** | `dns.resolveMx`, `dns.resolveTxt`, reverse lookup, cache control | Mail servers, service discovery |
| **B7 — `child_process` for WASM** | WASM-side `spawn` / `exec` — currently native-only (WASM can't `fork(2)`; would need a host proxy) | Scripts that orchestrate subprocesses under the sandbox |

### Niche

| Phase | Scope | Gate |
|:--|:--|:--|
| **B10 — `worker_threads` minimal subset** | Multi-process / cluster-style parallelism | Apps that spawn sibling node processes |

### More L3 shadows

The three password/auth primitives cover the highest-frequency
cases. Remaining L3 targets from the plan:

| Package | Backing crate | Complexity |
|:--|:--|:--|
| `sqlite3` | `rusqlite` | Medium — needs persistent connection handle map (statement prepare + step + finalize lifecycle), streaming row fetches |
| `sharp` | `image` + `fast_image_resize` | High — huge API surface (resize, format conversion, composition, metadata) |

---

## Not in scope

Carried over from `docs/NODE_COMPAT.md`'s "Not supported" section —
these are deliberately out-of-scope for the current plan:

- Native `.node` addons (shim via L3 shadows where the package is
  popular; otherwise `require` fails with a clear error)
- `cluster` (multi-process orchestration; B10 revisits a subset)
- `vm` (the whole runtime IS the JS sandbox; no "JS inside JS")
- `inspector` (no DevTools protocol)
- `async_hooks` (heavy hooks API)
- `dgram` UDP, `readline`, `repl` (library API), `trace_events`,
  `process.binding(*)`, `module.createRequire`

---

## Feature matrix

What's opt-in vs. on-by-default:

| Feature | Default | Unlocks |
|:--|:-:|:--|
| `wasm` (afterburner) | ✅ | Wasmtime backend |
| `native` (afterburner) | ✅ | rquickjs backend |
| `thrust` (afterburner) | ✅ | Multi-threaded scheduler |
| `adaptive` | — | Dual-tier native→wasm auto-switch |
| `bin` (afterburner) | — | `burn` CLI binary deps (`clap`, `tokio`, `rustyline`, daemon-mode axum) |
| `ts` (afterburner) | — | TypeScript strip + ESM→CJS transform via oxc |
| `shadow-bcrypt` | — | `require('bcrypt')` inside the WASM sandbox |
| `shadow-argon2` | — | `require('argon2')` inside the WASM sandbox |
| `shadow-jsonwebtoken` | — | `require('jsonwebtoken')` inside the WASM sandbox |
| `daemon` (afterburner-wasi) | — | http.createServer().listen() — pulled in by `bin` |
| `host-http` (afterburner-wasi) | — | Outbound `http.request` in the sandbox |

Build the CLI with everything: `cargo install afterburner
--features bin,ts,shadow-bcrypt,shadow-argon2,shadow-jsonwebtoken`.

---

## "Can real Node apps run under burn?" — feature recap

| Use case | Works today |
|:--|:-:|
| `burn server.js` with `http.createServer().listen()` | ✅ |
| TypeScript file: `burn foo.ts` | ✅ |
| ES modules: `burn foo.mjs` with `import`/`export` | ✅ |
| CommonJS `require('./pkg')` + `node_modules` walk | ✅ |
| `burn npm install X` (real npm routes `node` via PATH shim) | ✅ |
| `burn node foo.js` / `burn npx X` / `burn pnpm X` / `burn yarn X` / `burn bun X` | ✅ |
| `process.exit(n)` / SIGINT / `setInterval` / `.unref()` | ✅ |
| `require('bcrypt')` / `require('argon2')` / `require('jsonwebtoken')` inside WASM | ✅ |
| Password hashing in a request handler | ✅ |
| Issuing + verifying JWTs in auth middleware | ✅ |
| **Database drivers (`pg`, `redis`, `mongodb`)** | ❌ — needs B7 `net` |
| **Parallel worker threads** | ❌ — B10 |
| **Raw TCP protocol clients** | ❌ — needs B7 `net` |
| **File watchers / `fs.watch`** | ❌ — partial `fs/promises` expansion pending |
