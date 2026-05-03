# Afterburner — Implementation Status

Source of truth for what's shipped vs. what's left in the
`burn` runtime plan (`docs/IMPL_PLAN_BURN_RUNTIME.md`) and the
adjacent L3 shadow plan (locked decision Q3 in that doc).

**Last refreshed:** post Node 20 LTS round-2 coverage. Every Node 20.x
LTS built-in module now has a real polyfill — `require('<name>')` for
any name listed in `Module.builtinModules` returns a non-null object,
no module surfaces a "not supported" stub error any more. Newly
polyfilled in this round: `perf_hooks`, `async_hooks`, `vm`, `v8`,
`domain`, `trace_events`, `inspector`, `wasi`, `cluster`, `repl`,
`readline`, `tty`, `module`, `dgram`, `http2`, plus the subpaths
`util/types`, `stream/web`, `constants`, `sys`, `path/posix`, and
`path/win32`. Sibling crates re-exported as `afterburner::core` /
`::wasi` / `::ignite` / `::node_compat` / `::adaptive_crate` /
`::flow_crate` / `::thrust_crate` for users who want the full crate
surface from the facade.
Regenerate by hand when a phase lands; `git log --oneline` is
authoritative if this file drifts.

---

## Test count

**450+ tests pass workspace-wide** across the `afterburner` crate's
27 integration-test files plus the other workspace crates' unit /
integration suites (incl. 6 lock-free `DaemonNet` + 6 `DaemonTls` +
5 `dns_host` + 28 `SqliteShadow` + 33 `Sharp` + 19 `WasmLoader`
unit tests + 22 `b_wasm_loader` integration tests). Run the full
matrix with:

```bash
cargo test --workspace --exclude afterburner-plugin
cargo test -p afterburner --features bin,ts,shadow-bcrypt,shadow-argon2,shadow-jsonwebtoken
```

The plugin is excluded from `cargo test --workspace` because it
targets `wasm32-wasip1` (it can't even compile on the host triple —
`javy-plugin-api` assumes a WASI environment). It carries no unit
tests of its own; its behavior is exercised end-to-end by the host
crates' tests that load the committed `.wasm`. Rebuild it via
`afterburner-plugin/build.sh` when polyfills or extern decls change.

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
| **B10** — `worker_threads` minimal subset | Process-per-worker via `burn run --internal-worker`; length-prefixed JSON IPC; `Worker(path,{workerData})` / `worker.{postMessage,terminate,on('message'\|'online'\|'error'\|'exit')}` / `parentPort.{postMessage,on('message'),close}` / `isMainThread` / `threadId`; capability inheritance never widens; `BURN_WORKER_DEPTH` cap; Linux `PR_SET_PDEATHSIG=SIGKILL`; lock-free runtime (HopscotchMap + kovan_channel) | ✅ | `ead2d7b` | 16 |
| **B7 — `net` raw TCP sockets** | `net.connect` (client) + `net.createServer` (server) — Duplex-shaped EventEmitter facade over per-connection tokio tasks (`tokio::select!` over read+wake-Notify, no Mutex), 64 KiB write HWM with `'drain'` backpressure, daemon-event dispatch for `'connect'`/`'data'`/`'end'`/`'drain'`/`'close'`/`'error'`, `OutboundFull` allow-list (exact + `*` + `*.suffix`), inbound listening daemon-mode-only, `net.{isIP,isIPv4,isIPv6}` | ✅ | `96e0862` | 8+5 |
| **B7 — `tls` raw TLS sockets** | `tls.connect` (client) + `tls.createServer` (server) on top of `tokio-rustls`; same per-conn-task / 64 KiB HWM / lock-free shape as B7-net; mozilla `webpki-roots` for client verification, `rejectUnauthorized: false` opts out, `ca:` accepts custom PEM roots, ALPN negotiation surfaces `socket.alpnProtocol` + `getProtocol()`; server takes PEM `cert` / `key`; daemon-event dispatch for `'secureConnect'`/`'data'`/`'end'`/`'drain'`/`'close'`/`'error'`/`'secureConnection'`; truncated-EOF (no `close_notify`) emits `'end'` instead of `'error'` to match Node's tls; library mode never installs a coordinator | ✅ | `3f24bb9` | 6+4 |
| **B7 — `dns` record-type-aware resolvers** | `dns.resolve4` / `resolve6` / `resolveMx` / `resolveTxt` / `resolveCname` / `resolveNs` / `reverse` via `hickory-resolver` (running synchronously on a worker thread with the same `kovan_channel::select!` timeout pattern as `lookup`); `dns.resolve(host, rrtype)` dispatcher; `dns.Resolver` class with `setServers`/`getServers` no-op stubs; both callback and `dns.promises.*` shapes; sealed manifold blocks every resolver with `EACCES` | ✅ | _this commit_ | 9 |

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
| `sqlite3` | Database / run / get / all / each / exec / close — npm `sqlite3` v5 callback API. Backed by `rusqlite` with `bundled` (SQLite C amalgamation **statically linked into the burn binary**, single-binary deploy, no `libsqlite3.so` runtime dep). Per-connection actor thread (kovan_channel commands + bounded(1) replies) keeps the registry lock-free even though `rusqlite::Connection` is `!Sync`. Buffer round-trips through a `{$blob_b64: ...}` marker. | ✅ | `b4ee395` | 28+23 |
| `sharp` | npm `sharp` fluent builder: resize / rotate (0/90/180/270) / grayscale / flip / flop / extract / blur / negate / `jpeg` / `png` / `webp`; `toBuffer` / `toFile` / `metadata`. Stateless host calls — JS accumulates ops in an array, one host roundtrip per terminal op. Backed by 100% pure-Rust `image` (codec layer) + `fast_image_resize` (SIMD-accelerated resampling). | ✅ | _this commit_ | 33+31 |

---

## Remaining — plan phases not yet shipped

### Major unblocks

| Phase | Scope | Unblocks |
|:--|:--|:--|
| **B7 — `fs/promises` expansion** | `watch`, `realpath`, `cp`, `opendir`, file-descriptor APIs | File-watcher scripts, complex fs scripts |
| **B7 — `child_process` for WASM** | WASM-side `spawn` / `exec` — currently native-only (WASM can't `fork(2)`; would need a host proxy) | Scripts that orchestrate subprocesses under the sandbox |

### More L3 shadows

**What L3 shadows are.** Burn runs JS inside a WASM sandbox; WASM
cannot load `.node` files (raw native machine code — loading one
defeats the sandbox). But many top npm packages ship `.node` addons
because the pure-JS implementation is too slow or pulls in
non-portable C++. Without intervention, `require('bcrypt')` inside
the sandbox fails and the user's existing Node code breaks.

The L3 fix intercepts `require('<pkg>')` at resolve time and routes
to a thin JS-side adapter that presents the same npm API surface,
**backed by an already-existing Rust crate** through host imports.
We do **not** reimplement SQLite, libvips, etc. — we shim the npm
package's JS API onto crates like `rusqlite` (which embeds the real
SQLite C library, compiled statically into the burn binary at build
time) and `image` (pure Rust decoding/encoding).

#### Why we cannot run `.node` addons inside the sandbox

This is a hard architectural constraint, not a policy choice:

* `.node` files are **arch-specific native machine code** (x86_64 /
  arm64 ELF on Linux, Mach-O on macOS). They load via `dlopen`.
* The WASM sandbox executes WASM bytecode. There is no path that runs
  native instructions inside the sandbox — the CPU/ISA simply doesn't
  match. Even with a full x86-emulator-in-WASM, the addon expects to
  call libc + kernel syscalls; the sandbox surface (WASI) is far
  smaller than libc.
* The same constraint is why **Cloudflare Workers and Vercel Edge
  Functions explicitly do not support `.node` addons**. Deno and Bun
  load them in their *main* process (no sandbox boundary). Nobody
  runs untrusted `.node` files inside a WASM sandbox in production.
* The only realistic "yes" path is a separate process with its own
  OS-level sandbox (seccomp + landlock + namespaces on Linux), running
  a Node-API-compatible runtime, with IPC every C-ABI call from the
  WASM side. That's a substantial new subsystem with its own threat
  model — not in scope here.

#### Scope cutoff

All five L3 launch-list shadows shipped: `bcrypt`, `argon2`,
`jsonwebtoken`, `sqlite3`, `sharp`.

**We are now done adding shadows.** Anything beyond the launch list
goes through one of these escape hatches:

| Need | What to use |
|:--|:--|
| The npm package has an official or community **WASM build** | The future WASM-npm-loader (see fast-follows below) — burn loads it natively as a WASM module, no shadow code needed |
| The package has a **pure-JS alternative** that's "good enough" | Use the alternative. Examples: `bcryptjs` instead of `bcrypt`, `jsbn` instead of native big-int helpers, `crypto-js` for many crypto primitives. |
| The package only ships as `.node` and has no WASM build | Not supported. Same boundary as Cloudflare Workers / Vercel Edge. |

### Polish / follow-ups on already-shipped phases

Smaller items that aren't full new phases — refinements to features
that are functional today but have stable stub behavior at one or
two seams.

| Area | Item | Size | Today |
|:--|:--|:-:|:--|
| **B7 tls** | `socket.getPeerCertificate()` returns the real chain | S | ✅ shipped — DER bytes + colon-hex SHA-256 fingerprint. `getPeerCertChain()` for the full chain. |
| **B7 tls** | `socket.getCipher()` returns the real negotiated suite | S | ✅ shipped — IANA-normalized name (rustls' `TLS13_*` mapped to `TLS_*`). |
| **B7 tls** | Server-side SNI multi-cert routing (cert callback) | M | ✅ shipped — `tls.createSecureContext({cert, key})`, `Server.addContext(servername, ctx)`, and the `serverContexts` ctor option. Host installs a `rustls::server::ResolvesServerCert` impl (`SniResolver`) that matches ClientHello `server_name` exactly first, then via single-label wildcards (`*.example.com`), and falls through to the default cert. |
| **B7 dns** | `Resolver.setServers([...])` actually plumbs through to hickory | M | Larger than initially sized — needs a server-list parameter plumbed through 7 dns functions × {host coord, host import, plugin bridge, polyfill}. Still pending. |
| **B7 net** | `socket.setNoDelay` / `setKeepAlive` actually toggle the flags | S | ✅ shipped — `tokio::net::TcpStream::set_nodelay` for `TCP_NODELAY`, `socket2::SockRef::set_tcp_keepalive` for `SO_KEEPALIVE` + idle timer. |
| **B6 require** | `Resolver` cache control / TTLs surface to JS | S | Internal cache works; not user-visible. |
| **A11 — ergonomics** | `process.binding(*)` clear-error messages | XS | ✅ shipped — `process.binding('tcp_wrap')` now throws with the requested binding name in the message and `err.bindingName`. `_linkedBinding` symmetric. |
| **L3 long tail** | **WASM-npm-loader** | ✅ shipped | `WebAssembly.compile` / `instantiate` / `validate` / `Module` / `Instance` / `Memory` work in JS, backed by a per-`HostState` wasmtime sub-runner. Module + Instance ids are i64 (lock-free `HopscotchMap` registry). Function exports callable with primitive args (i32/i64/f32/f64); memory accessible via `Memory.buffer`, `.read(off, len)`, `.write(off, bytes)`. v1 doesn't bridge user-defined JS imports — modules with `(import "env" "f")` callbacks fail at instantiate with a clear LinkError; the host always supplies an empty import set. SQL.js / @jsquash / libheif-js / pure-Rust → wasm32-wasi modules with no env imports load directly. |

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
| `require('bcrypt')` / `require('argon2')` / `require('jsonwebtoken')` / `require('sqlite3')` / `require('sharp')` inside WASM | ✅ |
| Password hashing in a request handler | ✅ |
| Issuing + verifying JWTs in auth middleware | ✅ |
| `new Worker('./bg.js', { workerData })` with `postMessage` round-trip | ✅ |
| **Raw TCP protocol clients** (`net.connect` / `net.createServer`) | ✅ |
| **TLS clients + servers** (`tls.connect` / `tls.createServer`) | ✅ |
| Database drivers (`pg`, `redis`, `mongodb`) — both plain-TCP and TLS-terminating | ✅ |
| **File watchers / `fs.watch`** | ❌ — partial `fs/promises` expansion pending |
