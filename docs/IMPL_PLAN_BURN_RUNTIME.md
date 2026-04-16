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

## 6. Design questions — needs your decision before starting

**Q1 — Sandbox default for script mode.** Burn today is sandbox-first
(`Manifold::sealed()`); real Node apps expect open FS/net/env. Three
choices:

- **A**: `burn foo.js` stays sealed — Node apps break unless user
  passes `--allow-*`. Matches today's security posture; breaks the
  "drop-in Node replacement" promise.
- **B**: `burn foo.js` defaults to open (everything granted) — matches
  Node semantics; gives up the sandbox-by-default win.
- **C**: Default to open *only when invoked as `burn node …` or
  `burn <pkg-mgr> …`*; stay sealed for direct `burn foo.js`. Mixed.
- **D**: Default to `Manifold::open()` but announce it loudly on
  startup; require `burn --sandbox foo.js` for sealed.

> **Ask:** which?

**Q2 — When does daemon mode kick in?** `.listen()` auto-entering is
the Node-natural behavior but surprising: a one-line change to a
script can make it long-lived. Alternative:

- **A**: Auto-daemon whenever JS creates a handler the host knows is
  event-driven (listen, setInterval, repeated setTimeout).
- **B**: Explicit `burn serve foo.js` subcommand; plain `burn foo.js`
  always runs to completion and exits even if handlers are installed.
- **C**: Auto-detect, but require `--serve` for "yes, I mean it" when
  the script uses risky event sources.

> **Ask:** A, B, or C?

**Q3 — npm/node_modules depth target.** We can pick a depth and stick
to it:

- **Level 1**: pure-JS CommonJS packages. No native addons. No `.node`
  binary support. Roughly 70 % of npm "it works."
- **Level 2**: Level 1 + ESM. ~85 %.
- **Level 3**: Level 2 + minimal N-API shim so packages with native
  bindings *that only use stable N-API* work (sqlite3, bcrypt, …).
  ~95 %. Much more work.
- **Level 4**: Full Node ABI compat (libuv, libc details, etc.). Bun /
  Deno are still climbing this hill after years.

> **Ask:** Level 1 as the initial gate, Level 2 shortly after, Level 3
> as an explicit stretch?

**Q4 — TypeScript transpiler.** Three realistic choices:

- **oxc** (Rust-native, fast, ecosystem still maturing).
- **swc** (Rust-native, battle-tested in Next.js / Deno).
- **esbuild** (Go, requires shelling out a binary; excellent quality).

> **Ask:** prefer swc for maturity? Or oxc for deeper Rust integration
> ("it's the same team that wrote ruff and biome-rs in spirit")?

**Q5 — Wrapper-scope: `burn <anything>` or specific allow-list?**

- **A**: Any first-arg that isn't a known subcommand / file path is
  treated as a pass-through command (`burn deno test`,
  `burn tsc -w`, …). Maximally flexible.
- **B**: Hard allow-list: `node`, `npm`, `pnpm`, `npx`, `yarn`, `bun`.
  Everything else is a run-the-script or error.

> **Ask:** A or B?

**Q6 — Where does the HTTP server live in the architecture?**

- **A**: Each `createServer().listen()` call starts its own `axum`
  listener, owned by the host, with a channel plumbed into the
  sandbox. Simple, fits our facade.
- **B**: A single host-wide listener multiplexes by `server_id` across
  all scripts running in the process. Cheaper on sockets when a
  process hosts many scripts; mostly relevant to multi-tenant
  deployments.

> **Ask:** A is the obvious default; is B interesting to you
> long-term?

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

**Ready to execute once Q1–Q6 are decided.**

Sources:
- [wasmerio/edgejs on GitHub](https://github.com/wasmerio/edgejs)
- [edgejs.org](https://edgejs.org) — tagline "Run Node.js safely, anywhere, with any JS engine"
