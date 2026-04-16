# Node.js Compatibility Surface

Afterburner's `burn` runtime is a **drop-in for Node.js scripts** —
require the modules you already know, write the same code, run with
`burn foo.js`. This page lists every Node.js API surface we ship so
you can use the **official Node.js documentation as our documentation**.

> **Compatibility target:** Node.js 20.x LTS API surface. Where we
> diverge intentionally, the divergence is called out in the per-module
> notes below.

```js
// Drop-in. Same code. No `afterburner-` prefix anywhere.
const http = require('node:http');
const { createHash } = require('node:crypto');

http.createServer((_req, res) => {
  const id = createHash('sha256').update(_req.url).digest('hex');
  res.end(`id: ${id}\n`);
}).listen(3000);
```

## Status legend

| Symbol | Meaning |
|:------:|:--------|
| ✅ | Full — entire documented API surface covered. |
| 🟡 | Partial — most common APIs covered; less-used ones missing. See per-module notes. |
| 🪶 | Stub — minimal placeholder so dependent code doesn't crash. Behaviour may be a no-op. |
| ❌ | Not implemented — `require('node:foo')` throws. |

## Globals

Everything below is installed eagerly into `globalThis`; you do not
need an explicit `require` to access them.

| Global | Status | Node.js docs | Notes |
|:-------|:------:|:-------------|:------|
| `console` | ✅ | [console](https://nodejs.org/docs/latest-v20.x/api/console.html) | All standard methods. `util.format`-based rendering. |
| `process` | 🟡 | [process](https://nodejs.org/docs/latest-v20.x/api/process.html) | `argv`, `env`, `platform`, `arch`, `version`, `versions`, `pid`, `nextTick`, `exit`, `cwd`, `hrtime`, `stdout/stderr/stdin` (`.write`/`.read`), EventEmitter base. `chdir` throws — sandbox can't migrate cwd. `process.exit(N)` honoured as the script exit code in script mode. |
| `Buffer` | ✅ | [buffer](https://nodejs.org/docs/latest-v20.x/api/buffer.html) | Standard surface; backed by Uint8Array under the hood. |
| `setTimeout` / `setInterval` / `clearTimeout` / `clearInterval` / `setImmediate` / `queueMicrotask` | ✅ | [timers](https://nodejs.org/docs/latest-v20.x/api/timers.html) | Microtask & timer scheduling routed through Javy's event loop on the WASM path; matched on the native path. |
| `fetch`, `Request`, `Response`, `Headers` | 🟡 | [globals#fetch](https://nodejs.org/docs/latest-v20.x/api/globals.html#fetch) | Outbound HTTP only; gated by `Manifold::net`. Streaming bodies are buffered today. |
| `AbortController`, `AbortSignal` | ✅ | [globals#abortcontroller](https://nodejs.org/docs/latest-v20.x/api/globals.html#class-abortcontroller) | Standard. |
| `URL`, `URLSearchParams` | ✅ | [url#whatwg-url-class](https://nodejs.org/docs/latest-v20.x/api/url.html#the-whatwg-url-api) | WHATWG URL parser. |
| `TextEncoder`, `TextDecoder` | ✅ | [util#class-utiltextdecoder](https://nodejs.org/docs/latest-v20.x/api/util.html#class-utiltextdecoder) | Built into the runtime; UTF-8 only. |
| `btoa`, `atob` | ✅ | [globals#atob](https://nodejs.org/docs/latest-v20.x/api/globals.html#atobdata) | Standard. |
| `performance.now` | ✅ | [perf_hooks](https://nodejs.org/docs/latest-v20.x/api/perf_hooks.html#performancenow) | Monotonic clock. |
| `structuredClone` | ✅ | [globals#structuredclone](https://nodejs.org/docs/latest-v20.x/api/globals.html#structuredclonevalue-options) | Standard. |

## Built-in modules

`require('node:foo')` and bare `require('foo')` resolve to the same
implementation.

### Pure JS — always available, no capability gate

| Module | Status | Node.js docs | Notes |
|:-------|:------:|:-------------|:------|
| `assert` | ✅ | [assert](https://nodejs.org/docs/latest-v20.x/api/assert.html) | Including `assert.strict`. |
| `buffer` | ✅ | [buffer](https://nodejs.org/docs/latest-v20.x/api/buffer.html) | Same as the global `Buffer`. |
| `events` | ✅ | [events](https://nodejs.org/docs/latest-v20.x/api/events.html) | `EventEmitter` with all standard methods. |
| `path` | ✅ | [path](https://nodejs.org/docs/latest-v20.x/api/path.html) | Both POSIX (`path.posix`) and Win32 (`path.win32`) sub-namespaces; the default matches the host platform. |
| `punycode` | ✅ | [punycode](https://nodejs.org/docs/latest-v20.x/api/punycode.html) | Deprecated in Node but still ships — kept for compat. |
| `querystring` | ✅ | [querystring](https://nodejs.org/docs/latest-v20.x/api/querystring.html) | Legacy parser. Use `URLSearchParams` for new code. |
| `string_decoder` | ✅ | [string_decoder](https://nodejs.org/docs/latest-v20.x/api/string_decoder.html) | UTF-8 only. |
| `timers` | ✅ | [timers](https://nodejs.org/docs/latest-v20.x/api/timers.html) | Mirror of the globals above. |
| `url` | ✅ | [url](https://nodejs.org/docs/latest-v20.x/api/url.html) | Both legacy (`url.parse`) and WHATWG. |
| `util` | 🟡 | [util](https://nodejs.org/docs/latest-v20.x/api/util.html) | `format`, `inspect`, `inherits`, `promisify`, `callbackify`, `deprecate`, `types.*`, `TextEncoder/Decoder`. Missing: `util.parseArgs`, `util.styleText`, debug-log infrastructure. |

### Streams — pure JS, always available

| Module | Status | Node.js docs | Notes |
|:-------|:------:|:-------------|:------|
| `stream` | 🟡 | [stream](https://nodejs.org/docs/latest-v20.x/api/stream.html) | `Readable`, `Writable`, `Duplex`, `Transform`, `PassThrough`, `pipeline`. Object-mode and flowing-mode work. Missing: web-streams interop (`Readable.toWeb` / `Writable.toWeb`). |

### Host-backed — capability-gated via `Manifold`

These reach the host process. Each is denied by default; the `burn`
CLI's open default (Q1-D) flips them on for ad-hoc script use, while
the library API stays sealed unless the embedder grants explicit
capabilities.

| Module | Status | Node.js docs | Capability | Notes |
|:-------|:------:|:-------------|:-----------|:------|
| `fs` (sync surface) | 🟡 | [fs](https://nodejs.org/docs/latest-v20.x/api/fs.html) | `Manifold::fs` | `readFileSync`, `writeFileSync`, `existsSync`, `statSync`, `unlinkSync`, `renameSync`, `mkdirSync`, `readdirSync`, plus chunked `createReadStream` / `createWriteStream`. Missing: `watch`, file descriptors, `cp`, `realpath`. |
| `fs/promises` | 🟡 | [fs#promises-api](https://nodejs.org/docs/latest-v20.x/api/fs.html#promises-api) | `Manifold::fs` | Promise wrappers around the sync surface. Same coverage. |
| `crypto` | ✅ | [crypto](https://nodejs.org/docs/latest-v20.x/api/crypto.html) | `Manifold::crypto` | Hashes (`createHash` SHA-1/256/384/512, MD5), HMACs, AES-GCM/CBC, PBKDF2, scrypt, RSA + ECDSA `sign`/`verify` (PEM keys), `randomBytes`, `randomUUID`. Streaming `createHash` / `createSign` / `createVerify`. |
| `http` | 🟡 | [http](https://nodejs.org/docs/latest-v20.x/api/http.html) | `Manifold::net` | Outbound only via `http.request` / `http.get`. Per-call wall-clock cap via `Manifold::http_timeout_ms`. **Inbound `http.createServer().listen()` lands in B2** of the burn-runtime plan. |
| `https` | 🟡 | [https](https://nodejs.org/docs/latest-v20.x/api/https.html) | `Manifold::net` | Same surface as `http`; TLS handled by the host. |
| `dns` | 🟡 | [dns](https://nodejs.org/docs/latest-v20.x/api/dns.html) | `Manifold::net` | `lookup`, `resolve` with bounded per-call wall-clock timeout. Async + promise variants both present. |
| `os` | 🟡 | [os](https://nodejs.org/docs/latest-v20.x/api/os.html) | always on | `platform`, `arch`, `type`, `release`, `EOL`, `tmpdir`, `homedir`, `cpus`, `totalmem`, `freemem`. Non-sensitive surface. |
| `zlib` | ✅ | [zlib](https://nodejs.org/docs/latest-v20.x/api/zlib.html) | always on | `deflate`/`inflate`/`gzip`/`gunzip` (sync + async). Backed by Rust `flate2`. |
| `child_process` | 🟡 | [child_process](https://nodejs.org/docs/latest-v20.x/api/child_process.html) | `Manifold::child_process` | **Native path only.** `spawn`, `exec`, `execSync`, `spawnSync`. Sandboxed (WASM) builds reject the capability — there is no way to `fork(2)` from inside a Wasmtime instance. |

### Custom — Afterburner-specific

| Module | Status | Notes |
|:-------|:------:|:------|
| `afterburner:state` | ✅ | Cross-invocation key/value store backed by a pluggable `StateStore` trait (default `InMemoryStateStore`). `get`, `set`, `setJSON`, `delete`, `increment`. |
| `afterburner:host` | ✅ | Host-context bridge: `getEnv`, `emitRow`, `readColumn`, `log`. Embedders supply a `HostContext` impl when constructing the runtime. |

## Sandbox model

Every host-backed module routes through the active `Manifold` —
Afterburner's capability profile. Library callers always start from
`Manifold::sealed()` (deny-everything) and explicitly grant what they
need. The `burn` CLI defaults to `Manifold::open()` so Node scripts
drop in without ceremony, with a one-time first-run banner; pass
`--sandbox` (or any `--allow-*` flag) to seal it back down.

```rust
// Library — sealed by default, opt in to specific capabilities.
let ab = Afterburner::builder()
    .manifold(Manifold {
        fs: FsAccess::ReadOnly(vec!["/var/data".into()]),
        net: NetAccess::OutboundFull(Some(vec!["api.example.com".into()])),
        ..Manifold::sealed()
    })
    .build()?;
```

```bash
# CLI — open by default, --sandbox to seal.
burn foo.js                          # open (banner once)
burn --sandbox foo.js                # sealed (Manifold::sealed())
burn --sandbox --allow-net=*.x.com foo.js   # sealed + outbound HTTPS to *.x.com
burn -A foo.js                       # explicit open (no banner)
```

## Not supported

These Node.js surfaces are not implemented and **`require` will
throw**. None of them are in scope for the current burn-runtime plan
(see `docs/IMPL_PLAN_BURN_RUNTIME.md`). Where a future phase is
expected to address them, it's noted.

| Surface | Status | Why / when |
|:--------|:------:|:-----------|
| Native addons (`.node` binaries) | ❌ | Raw native code; cannot load in the WASM sandbox. The L3 npm-ecosystem plan lands pure-Rust shadow modules for popular N-API packages (`bcrypt`, `argon2`, `sqlite3`, `sharp`, `jsonwebtoken`) instead. |
| `cluster` | ❌ | Multi-process orchestration. Out of scope today; B10 of the runtime plan revisits a minimal subset. |
| `worker_threads` | ❌ | Same as above — B10. |
| `vm` | ❌ | Running JS inside JS isn't useful when we already are the JS runtime. |
| `inspector` | ❌ | No DevTools protocol surface today. |
| `async_hooks` | ❌ | Heavy hooks API not yet wired through Javy / rquickjs. |
| `tls` (raw socket) | ❌ | Inbound `https.createServer` (B2b); raw `tls.createServer` later. Outbound TLS via `https` works today. |
| `net` (raw socket) | ❌ | B7 of the runtime plan. |
| `dgram` (UDP) | ❌ | Future work. |
| `repl` (programmatic) | ❌ | `burn repl` is the user-facing REPL; the `node:repl` library API is separate and not implemented. |
| `readline` | ❌ | Future work. |
| `perf_hooks` (full surface) | 🪶 | Only `performance.now()` lives today. |
| `trace_events` | ❌ | Workspace logger covers basic tracing via `AFTERBURNER_LOG`. |
| `process.binding(*)` | ❌ | Internal-only Node API; not part of the public surface. |
| `module` (the module object itself, e.g. `module.createRequire`) | ❌ | CommonJS `require` works; the meta-module's introspection helpers don't. |

## Reporting incompatibilities

If a Node.js script that should work doesn't, or a documented Node API
behaves differently from what the official docs describe — **that's a
bug**. File an issue with:

1. The Node API name (link to its docs page).
2. The minimal `burn`-runnable repro.
3. What Node.js does vs. what `burn` did.

Drop-in compatibility is the goal. Divergences should be deliberate
and documented here.
