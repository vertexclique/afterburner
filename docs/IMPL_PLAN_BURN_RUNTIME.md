# Implementation Plan: `burn` as a Node.js-Replacement Runtime

**Status:** Design — open questions to the user below.
**Workspace:** primarily `afterburner` (facade + bin), `afterburner-node-compat` (polyfills + host), `afterburner-wasi` (engine), possibly a new `afterburner-server` crate.
**Inspiration:** Edge.js by Wasmer (pluggable JS engine, WASM `--safe` mode, `edge node|npm|pnpm …` command wrapping).
**Depends on:** U0–U8 of `IMPL_PLAN_USABILITY.md` (done as of commit `76c71e8`).

---

## 1. Goal

Make `burn` behave like `edge`: a drop-in for Node.js that runs real
Node scripts (`burn server.js`), and wraps Node-ecosystem commands
(`burn node foo.js`, `burn npm install`, `burn pnpm run dev`) so you
can retrofit an existing JS workflow onto Afterburner's sandboxed
runtime without rewriting the project.

Concretely, this target works end-to-end:

```js
// server.js
const http = require("node:http");

http.createServer((_req, res) => {
  res.end("hello from burn\n");
}).listen(3000, () => {
  console.log("listening on http://localhost:3000");
});
```

```bash
$ burn server.js
listening on http://localhost:3000
```

And:

```bash
$ burn node myfile.js             # direct pass-through
$ burn npm install express        # npm internally spawns node; PATH-shimmed to burn
$ burn pnpm run dev               # same story for pnpm
```

TypeScript lands after the Node-compat baseline is stable.

---

## 2. What Edge.js actually does (reference)

From Wasmer's [edgejs README + ARCHITECTURE.md](https://github.com/wasmerio/edgejs):

- **Runtime kernel**: process bootstrap, module loading, event loop
  orchestration. Implemented in the runtime itself — *not* a shell
  around Node.
- **Binding layer**: system features exposed as **N-API addons** (on
  libuv + OS primitives). N-API, not V8 headers, is the hard
  boundary.
- **Engine adapter**: `napi/v8` is the JS-engine integration point.
  The engine is *pluggable* — V8, JavaScriptCore, or QuickJS can sit
  behind the same N-API boundary.
- **WASM sandbox**: `edge --safe` runs code inside WebAssembly for
  isolation; WASIX build target for container/serverless use.
- **Command wrapping**: `edge node x.js`, `edge npm install`, etc.
  work because `edge` puts itself on the PATH as `node`, so every
  child process invoking `node` actually invokes `edge`.

Key takeaway for us: edge.js is *a new runtime* with Node-compatible
surface, not a CLI trick over Node. burn following the same model
means this is on the order of Bun / Deno / edge.js in complexity —
not an afternoon of patches.

---

## 3. Gap analysis — what burn has vs. what it needs

| Capability                                   | Today                      | Needed             |
|----------------------------------------------|----------------------------|--------------------|
| Sandbox JS engine (QuickJS via Wasmtime)     | ✅                         | ✅                 |
| Multi-worker scheduler                       | ✅                         | ✅                 |
| Capability gates (`Manifold`)                | ✅                         | ✅ + sensible defaults |
| Event loop for Promises / microtasks         | ✅                         | ✅ extended        |
| `require('node:http')` / `require('http')`   | ❌                         | ✅                 |
| `http.createServer().listen(port)`           | ❌ (outbound HTTP only)    | ✅                 |
| TCP / TLS sockets (`net`, `tls`)             | ❌                         | ✅ (min subset)    |
| `fs/promises`, `readable/writable streams`   | partial                    | ✅                 |
| `process.argv`, `process.exit`, `process.env`| partial                    | ✅                 |
| Top-level JS (script mode, not UDF envelope) | ❌ (envelope is UDF-shaped)| ✅                 |
| Daemon mode (long-lived JS runtime)          | ❌ (one-shot per thrust)   | ✅                 |
| `require(pkg)` + `node_modules` resolution   | ❌                         | ✅                 |
| CLI pass-through (`burn node/npm/pnpm`)      | ❌                         | ✅                 |
| TypeScript                                   | ❌                         | ✅ (phase 2)       |
| N-API native-addon compat                    | ❌                         | optional, later    |

The existing `express-app` example shows we can already dispatch HTTP
requests to the sandbox — but that test drives it from a Rust axum
server outside. To run an unmodified Node app, the runtime has to
accept the script's *own* call to `http.createServer().listen(...)`
and stand up the socket on its behalf.

---

## 4. Architecture

### 4.1 Three execution modes

Burn today runs JS one way: compile-then-invoke, UDF envelope, one
return value. The runtime work adds two more.

| Mode         | Triggered by                                  | Lifetime                    | Semantics                                                           |
|--------------|-----------------------------------------------|-----------------------------|---------------------------------------------------------------------|
| **UDF**      | `burn thrust FILE < input.json`               | Per-call (fresh `Store`)    | Today's behavior. `module.exports = (data) => …`, stdin JSON.       |
| **Script**   | `burn run FILE`, `burn FILE`, `burn -e CODE`  | One-shot, no residual state | Top-level JS runs to completion; stdout goes to terminal; exit 0/1. |
| **Daemon**   | Script calls `server.listen()` / `setInterval`| Long-lived `Store`          | JS state persists; runtime drives the event loop until SIGINT.      |

Daemon mode is the load-bearing new concept. It violates the current
"fresh per-call JS state" invariant — intentionally, because Node
servers *need* that state to hold route tables, connection maps,
caches. Today's invariant carries over only to UDF mode. Script and
Daemon each get their own long-lived `Store<HostState>`.

### 4.2 Plugin envelope — add a third mode byte

`afterburner-plugin/src/lib.rs` already switches on a mode field
(`legacy` / `compile` / `invoke`). Add:

- `script`: top-level code. No UDF wrapping. `console.log`, top-level
  `await`, and unhandled rejections all work the way they would in
  Node.
- `daemon-init`: compile + evaluate the script once; register any
  callbacks it installed via `http.createServer(...)` etc.; keep the
  runtime alive waiting for host-dispatched events.
- `daemon-event`: the host re-enters the same instance with an event
  payload (`{kind: 'http-request', server_id, req: {...}}`); the
  plugin routes to the correct JS callback; the reply travels back
  through stdout or a fresh host import.

### 4.3 HTTP server — who owns the socket

The sandbox can't bind sockets itself (WASI doesn't give us listen +
accept in the default configuration, and even with wasip2 preview we'd
fight the capability model). The socket lives *on the host*:

```
     JS: http.createServer(cb).listen(3000)
      │
      ▼
  polyfill: __host_http_listen(3000) → returns server_id
      │
      ▼
   Rust host: axum::Server::bind(3000) → running
      │ incoming HTTP request
      ▼
   host-dispatch thrust: {kind: 'http-request', server_id, req}
      │
      ▼
     JS: invoke handler(req, res); res.end(body)
      │
      ▼
  polyfill: __host_http_reply(req_id, {status, headers, body})
      │
      ▼
   Rust host: write response bytes to the socket
```

So `http.createServer` is a polyfill wrapper around a host import that
registers a Rust-side listener. The polyfill builds an
`EventEmitter`-shaped server object; when the host calls back with
request data, the polyfill synthesizes an `IncomingMessage` and
`ServerResponse` pair and invokes the user callback.

`net.createServer` (raw TCP) and `tls.createServer` map the same way
with different host imports. Initial scope: HTTP only. Raw TCP lives
in phase B2.

### 4.4 Command wrappers — PATH shim

`burn node script.js`, `burn npm install`, `burn pnpm run dev`:

```
$ burn npm install
   ├── burn detects argv[1] is a pass-through target ("node", "npm",
   │   "npx", "pnpm", "yarn", "bun")
   ├── burn creates a temp dir PATH_SHIM/
   │     ├── node      → /usr/bin/env bash -c 'exec /path/to/burn run "$@"' --
   │     ├── npm       → forwards to real npm
   │     ├── pnpm      → forwards to real pnpm
   │     └── …
   ├── burn execs the target (npm) with PATH=PATH_SHIM:$PATH
   └── Every `node foo.js` invocation inside npm's child-process tree
       actually runs `burn run foo.js`
```

The shim trick is how volta / fnm / edge all intercept node
invocations. Rust stdlib + `std::os::unix::fs::symlink` + `exec(3)` on
unix; short `.cmd` shims on Windows.

### 4.5 `node_modules` resolution

CommonJS first (simpler). `require(pkg)`:

1. If `pkg` starts with `./` / `../` / `/`: treat as path.
2. If `pkg` is `node:*`: route to the Node-stdlib polyfill (§4.6).
3. Otherwise walk up from the script's directory looking for
   `node_modules/pkg/package.json`; load `"main"` (or `"exports"`).
4. Cache the module export on first load; subsequent `require`s hit
   the cache.

ESM imports are deferred — phase B5.1 — because they require stream-
compiling individual modules + async resolution + top-level-await
semantics. CJS covers 90 %+ of existing npm packages.

### 4.6 Node-stdlib polyfill surface

A module registry inside `afterburner-node-compat/polyfills/node/`
with one file per Node built-in. `require('node:http')` resolves to
`polyfills/node/http.js`; bare `require('http')` resolves the same.
`require('node:fs/promises')` → `polyfills/node/fs/promises.js`.

Priority order (Node stdlib by frequency of use in npm):

1. **Phase B2.a**: `http`, `path`, `url`, `events`, `stream`, `buffer`
   (much of stream/buffer lives in plenum already).
2. **Phase B2.b**: `fs`, `fs/promises`, `crypto`, `zlib`, `os`,
   `querystring`, `util`.
3. **Phase B2.c**: `net`, `tls`, `dns`, `dgram`, `child_process`.
4. **Phase B2.d**: `worker_threads`, `cluster`, `perf_hooks`,
   `async_hooks`.

Each polyfill is JS that imports host functions from the existing
`__host_*` globals where needed. We already cover a lot of this —
`crypto`, `zlib`, `buffer`, `events`, `os`, `path` are in place. `fs`
is partial (sync + chunked read/write live; `fs.promises.*` is thin).
Server-side `http` is the biggest new addition.

### 4.7 Code organization and testing conventions

These rules apply to every B-phase below and, going forward, to the rest
of the workspace. Existing files that exceed the ceiling get split
opportunistically as a phase touches them — not a separate refactor pass.

**File size.**

- Soft target: **≤500 lines** per `.rs` / `.js` file.
- Hard ceiling: **1000 lines** — at that point the file *must* split, no
  exceptions.
- Polyfill `.js` files over ~400 lines also split (`http/server.js`,
  `http/agent.js`, … re-exported from `http.js`).

**Burn binary — module layout.**

`afterburner/src/bin/burn.rs` stays a thin entrypoint (arg parsing +
dispatch, under 100 lines). Every subcommand and CLI concern lives in
its own file under `afterburner/src/cli/`:

```
afterburner/src/cli/
  mod.rs              // pub use re-exports
  args.rs             // Cli struct, Cmd enum, clap derives
  manifold.rs         // --allow-* / --sandbox / -A → Manifold
  run.rs              // `burn run` / `burn <file>`
  eval.rs             // `burn -e`
  thrust.rs           // `burn thrust` (UDF stdin mode)
  bench.rs            // `burn bench`
  repl.rs             // `burn repl`
  check.rs            // `burn check`
  script.rs           // script mode plumbing (B0)
  daemon.rs           // daemon event loop + shutdown (B2/B3)
  passthrough.rs      // `burn node|npm|pnpm|…` dispatch (B4/B5)
  shim.rs             // PATH shim generation (B5)
  banner.rs           // first-run open-capabilities banner (Q1-D)
```

**node-compat — module layout.**

- **JS polyfills**: one file per Node built-in at
  `afterburner-node-compat/polyfills/node/<name>.js`; sub-files for
  large built-ins (`http/server.js`, `http/client.js`, `fs/sync.js`,
  `fs/promises.js`, `stream/readable.js`, `stream/writable.js`).
- **Rust host bindings**: one file per host-import surface:

```
afterburner-node-compat/src/
  http_host.rs            // outbound HTTP (existing)
  http_server_host.rs     // inbound HTTP via axum (B2, NEW)
  net_host.rs             // raw TCP (B7, NEW)
  tls_host.rs             // TLS sockets (B7, NEW)
  fs_promises_host.rs     // fs.promises.* (B7, NEW)
  dns_host.rs             // (existing)
  child_process_host.rs   // (existing — extend in B7)
  resolver.rs             // require() + node_modules walk (B6, NEW)
  shadows/                // pure-Rust N-API shadow modules (Q3 / L3)
    mod.rs
    bcrypt.rs
    argon2.rs
    jsonwebtoken.rs
    sqlite.rs
    sharp.rs
```

**Plugin modes — module layout.**

Mode dispatch already exists in `afterburner-plugin/src/lib.rs`. Peel
each mode out into its own file:

```
afterburner-plugin/src/modes/
  mod.rs              // dispatcher
  legacy.rs
  compile.rs
  invoke.rs
  script.rs           // B0 — top-level JS, no UDF envelope
  daemon_init.rs      // B2 — first-entry: eval + register handlers
  daemon_event.rs     // B2 — re-entry: dispatch payload to handler
```

**Test layout.**

- **No `#[cfg(test)] mod tests { … }` blocks inline in `src/*.rs`.** All
  tests live in each crate's `tests/` directory.
- Existing inline test modules are migrated when the surrounding file is
  touched. No separate "migrate tests" PR.
- Cross-crate integration tests live in the workspace-level `tests/`
  directory. Burn-runtime phase gates live in
  `tests/burn-runtime/<phase>.rs` — one file per verification fixture
  in §8.
- Doctests on public items are fine — they document the API surface.
- Every phase B0–B10 lands its verification test in the right place
  **in the same commit** as the implementation. No "tests later"
  carve-outs — this reinforces the repo's "no deferred /
  production-grade only" rule.

**Why.** Long files are unreviewable; the PR diff drowns the real
change. Per-mode / per-built-in files also match how readers *navigate*
the code — `require('node:http')` → `polyfills/node/http.js` — and keep
compile units recompilable independently.

---

## 5. Phase breakdown

All phases *after* the usability plan (U0–U8). Numbered B for "burn
runtime" so they don't collide with T- / U- / P- series.

| Phase | Effort | Gate |
|---|---|---|
| **B0 — Script mode** (top-level JS, no UDF envelope)          | 1 d | `burn run foo.js` executes top-level code; `console.log` + `process.argv` / `process.env` (AllowList) work. |
| **B1 — Node-style module resolution for stdlib**              | 1 d | `require('node:path')` / `require('path')` both work; same for events, url, buffer, stream. |
| **B2 — `http.createServer` server-side polyfill**             | 5 d | The `hello from burn` example at the top of this doc runs end-to-end (`burn server.js` serves HTTP on port 3000). |
| **B3 — Daemon mode lifecycle** (signals, graceful shutdown)   | 2 d | Ctrl-C cleanly stops the daemon; `process.exit(n)` returns the right code. |
| **B4 — `burn node foo.js` pass-through**                      | 0.5 d | `burn node foo.js` is exactly `burn run foo.js`. |
| **B5 — PATH shim for `burn npm` / `burn pnpm` / `burn npx`**  | 2 d | `burn npm install express` succeeds (npm's internal node calls hit burn). |
| **B6 — CommonJS `require(pkg)` + `node_modules` walk**        | 3 d | `require('express')` loads the installed package and works in a basic `app.listen(3000)` sense. |
| **B7 — Broader stdlib: `fs/promises`, `net`, `tls`, `dns`, `child_process`** | 5 d | Common frameworks (Express, Fastify) start up cleanly. |
| **B8 — TypeScript via oxc / swc**                             | 3 d | `burn foo.ts` transpiles and runs transparently. |
| **B9 — ESM imports** (`import …`, `.mjs`, top-level await)    | 3 d | `import express from 'express'` works; `.mjs` detected automatically. |
| **B10 — `worker_threads` / `cluster` minimal subset**         | 3 d | Multi-process workers that spawn sibling `node` processes get each one correctly routed to burn. |

Rough total: **~28 engineering days** to reach a meaningful Node-compat
baseline (Express + http.createServer + typical npm packages + TS).
Deep ecosystem compat (full fs semantics, native addons, all of
streams) is months more, same as Deno / Bun learned.

### 5.1 Critical path for "burn server.js serves HTTP"

B0 → B1 → B2 → B3. That's ~9 days and delivers the user-visible
headline feature. B4/B5 unlock the Node-workflow ergonomics. B6 on is
the long-tail grind toward npm-ecosystem compatibility.

---

## 6. Locked decisions

Answers to Q1–Q6 below are final; later phases layer on top without
revisiting.

### Q1 — Sandbox default: **D — open, announced on first use**

- `burn <file>` grants `Manifold::open()` so Node scripts run unmodified.
- On first run per user, print a one-line banner to stderr:
  `burn: running with open capabilities. --sandbox to seal; BURN_QUIET=1 to silence.`
  Write an ack-marker to `~/.cache/burn/opened` so the banner does not
  repeat.
- `--sandbox` resets the manifold to `Manifold::sealed()` for that
  invocation. `BURN_QUIET=1` or `--quiet` silences the banner (and
  future notices) globally — for CI.
- **Library API default stays `Manifold::sealed()`.** The CLI flip does
  *not* leak into `Afterburner::builder()`. Embedders choose their
  posture explicitly.

### Q2 — Daemon trigger: **A — auto on `.listen()` / long-lived timers**

- **CLI-only.** The runtime detects handler registration via the host
  imports that back `http.createServer().listen()`, `setInterval`, and
  repeated `setTimeout`; it transitions the `Store` into daemon mode
  and drives the event loop until signal (SIGINT / SIGTERM).
- Node-style **ref semantics**: unref'd timers do not keep the runtime
  alive. `setTimeout(fn, 100).unref()` does not immortalize the script.
- **Library API never auto-daemons.** `Afterburner::run()` and
  flow-style entry points are always one-shot. If user JS calls
  `.listen()` or `setInterval` inside a library call, the thrust
  returns typed `AfterburnerError::UnsupportedInLibraryMode`. A
  `LibraryConfig::allow_event_handlers: bool` escape hatch (default
  false) exists for embedders who genuinely want a library-mode daemon.
- Add a **per-phase CLI-vs-library test pair**
  (`tests/burn-runtime/<phase>_cli.rs`,
  `tests/burn-runtime/<phase>_library.rs`) so this contract can't
  silently regress.

### Q3 — npm depth: **L3, pure Rust, WASM-compilable**

- **Tiered rollout**: L1 (pure-JS CommonJS) → L2 (+ ESM) → L3
  (on-demand pure-Rust shadows of the most popular N-API packages).
  No big bang.
- L3 explicitly **excludes loading `.node` binaries** — they're raw
  native code, incompatible with the WASM sandbox. `require('bcrypt')`
  / `require('sqlite3')` / … are intercepted in the resolver and
  routed to pure-Rust shadow modules exposed via host imports.
- **Shadow list at launch**: `bcrypt`, `argon2`, `jsonwebtoken`,
  `sqlite3` (via `rusqlite`), `sharp` (via `image` +
  `fast_image_resize`). Each shadow lives in
  `afterburner-node-compat/src/shadows/<pkg>.rs` and is gated behind a
  cargo feature (`shadow-bcrypt`, `shadow-sqlite`, …) so binary size
  scales with opt-in.
- Pure-JS packages fall through to real `node_modules` resolution.
  Packages requiring a non-shadowed `.node` addon fail with a typed
  `AfterburnerError::NativeAddonUnsupported { pkg }` — never a crash.

### Q4 — TypeScript: **oxc, transpile-only**

- Rust-native, actively maintained, ~5–10× faster than swc on
  transpile; smaller dep footprint (WASM-compile friendly).
- **Strip-types only.** No type-checking inside burn — `tsc --noEmit`
  remains the user's concern.
- Behind a `ts` cargo feature; non-TS users don't pay the ~3 MiB dep
  cost.

### Q5 — Wrapper scope: **A — any unknown first-arg is pass-through**

Guardrails:

1. **Existing-file wins.** If `argv[1]` resolves to a file in cwd,
   "run this file" wins over "pass through" — deterministically
   resolves the `burn tsc.js` (local file) vs. `burn tsc` (global
   binary) ambiguity.
2. **Unknown-command error.** If `argv[1]` is not a known subcommand
   *and* not on PATH, fail with `burn: unknown command '<arg>'`
   before calling `exec(3)`. No more "could not exec noed: No such
   file" confusion.
3. **Shim recursion guard.** `BURN_SHIM_DEPTH` env var caps PATH-shim
   re-entry at 8. Higher values → `burn: shim recursion limit
   reached`, protecting against fork-bomb misconfig.

### Q6 — HTTP topology: **B — host-wide multiplex, phased**

- **End state:** one axum listener per `(host, port)` tuple with a
  dispatch table keyed by `server_id`. Multiple scripts' servers on
  different ports share the process's listener pool. Matches the
  multi-tenant use case this runtime is ultimately for.
- **Phasing:** B2 ships A-style per-script listeners to keep the
  critical path at ~5 days. B2b (~2 days) refactors internals to the
  multiplex table. JS-visible surface is identical across both — no
  client breakage.
- **Node semantics preserved:** two scripts both calling `.listen(3000)`
  → the second gets `EADDRINUSE`, same as Node.

### Library-vs-CLI contract (cross-cutting)

| Concern                      | `burn` CLI               | Library API (`Afterburner::builder()`) |
|------------------------------|--------------------------|----------------------------------------|
| Default `Manifold`           | `open()` + banner (Q1-D) | `sealed()` — unchanged                 |
| Daemon mode                  | Auto (Q2-A)              | Never (one-shot enforced)              |
| `.listen()` / `setInterval`  | Starts daemon            | `UnsupportedInLibraryMode` error       |
| Default timeout              | User-set                 | `FuelGauge::timeout_ms` must be set    |
| `require()`                  | Full CJS + L3 shadows    | Off by default; opt-in flag            |
| TS transpile                 | Auto via oxc             | Same — embedder opts in via `ts` flag  |

CLI defaults **must not** regress the library's sealed/one-shot
contract — the phase-pair tests above are the guardrail.

---

## 7. Risks

- **Sandbox-vs-Node tension.** The entire point of afterburner is
  capability gating. The entire point of Node compat is "open." We
  have to pick a default that's defensible as "production grade"
  (per the durable memory rule). Q1 is load-bearing.
- **Daemon mode breaks the fresh-per-call invariant.** Every test
  assumption we have about per-call JS isolation needs re-checking
  once scripts can hold state across events. Audit before B3.
- **`node_modules` is a dragon.** Real-world packages do things like
  probe `process.platform`, dynamically load `.node` binaries,
  `fs.realpathSync`, `require.resolve`. Every workaround we don't
  have is one package that silently misbehaves.
- **HTTP polyfill surface is big.** `IncomingMessage` is a
  `Readable` stream, `ServerResponse` is a `Writable`. Getting the
  stream events right (`'data'`, `'end'`, `'error'`) is where edge-
  case breakage lives.
- **PATH shim on Windows.** Unix symlinks don't work; we need `.cmd`
  shims + `.ps1` for PowerShell. Cross-platform needs explicit
  testing per the workspace universal-portability rule.
- **Plugin size.** Each added polyfill bundle grows the
  Wizer-preinitialized plugin `.wasm`. Keeping cold-start fast means
  being picky about what lands in the core polyfill vs. loaded on
  demand.
- **TypeScript integration bloat.** swc pulls in ~6 MiB of deps;
  binary grows. Gate TS behind a `ts` feature.

---

## 8. Verification targets

Per phase, a regression test against well-known Node code. Suggested
fixtures:

1. `burn server.js` where server.js is the `http.createServer`
   example at the top of this doc. Curl it, assert body = `hello
   from burn\n`.
2. `burn node -e 'console.log(1 + 2)'` prints `3`.
3. `burn npm install express` inside a scratch dir succeeds and
   produces `node_modules/express/`.
4. `burn dist-test.js` where `dist-test.js` is `express`'s own
   minimal hello-world example.
5. `burn app.ts` where `app.ts` uses `import` + types; exits 0 with
   expected output.

Each regression test goes under `tests/burn-runtime/`, one file per
phase gate.

---

## 9. What this plan explicitly does NOT do

- **No Bun-compatibility aim.** Bun's stdlib is its own. Targeting it
  would add orthogonal surface.
- **No browser APIs.** `fetch` is already partial; `Request`/
  `Response`/`Headers` as full browser types is distinct work.
- **No WebSocket server.** Phase B7+ adds `ws`-compatible surface if
  node_modules ecosystem demands it.
- **No `vm` module.** Running JS inside JS isn't useful given we are
  the JS runtime.
- **No cluster-level orchestration.** Single-process boundary. Multi-
  process is out of scope unless B10 lands.

---

**Ready to execute — decisions locked in §6.**

Sources:
- [wasmerio/edgejs on GitHub](https://github.com/wasmerio/edgejs)
- [edgejs.org](https://edgejs.org) — tagline "Run Node.js safely, anywhere, with any JS engine"
