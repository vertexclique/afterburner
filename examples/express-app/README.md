# express-app

**Real HTTP server running Express-style JS handlers inside Afterburner.**

- Axum (Rust) listens on `127.0.0.1:3000` and accepts HTTP requests.
- Every request is serialized to a JSON envelope (`method`, `path`,
  `query`, `headers`, `body`) and handed to `Afterburner::run`.
- `src/app.js` contains the Express-compatible app — a mini-router
  with `.get`, `.post`, `.use`, path params (`:name`), and
  `res.status(…).json(…)`.
- Afterburner's `thrust` scheduler (N workers = available parallelism,
  capped at 8) runs concurrent requests on different worker threads.

```bash
cargo run --release
```

Then in another shell:

```bash
curl http://127.0.0.1:3000/
curl http://127.0.0.1:3000/health
curl http://127.0.0.1:3000/hello/world
curl -X POST -H 'Content-Type: application/json' \
     -d '{"hello": "server"}' http://127.0.0.1:3000/echo
curl -X POST -H 'Content-Type: application/json' \
     -d '[1, 2, 3, 4]' http://127.0.0.1:3000/sum
```

## How it works

| layer                          | responsibility                                             |
|--------------------------------|------------------------------------------------------------|
| `axum` (Rust, `src/main.rs`)   | TCP + HTTP framing + concurrent request dispatch           |
| `tokio::task::spawn_blocking`  | Each request runs Afterburner on a blocking pool thread    |
| `Afterburner` with `threaded(N)` | Hash-routes concurrent thrusts across N scheduler workers |
| Wasmtime + Javy plugin         | Sandboxed QuickJS execution of `app.js`                    |
| `app.js` (JS, inside Afterburner) | Express-style router owns path dispatch + response shape |

## Isolation

- No `require('express')` — the router is in-file JS (~40 lines).
  That's intentional: the example shows what *really* drives Express
  in practice (routing + req/res shape) without pulling in the npm
  package. If you want the real Express npm module, bundle it with
  esbuild against the WASM target and feed the bundle to
  `Afterburner::register` directly.
- JS state is fresh per call (Afterburner invariant). Sessions /
  long-lived state live on the Rust side; pass them through the
  envelope if your handler needs them.
- `Manifold::sealed()` is the default — `app.js` can't touch fs, net,
  or env. Grant capabilities via `.manifold(Manifold { … })` on the
  builder if your handlers need them.
