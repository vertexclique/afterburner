# cli-quickstart

A CLI-driven example: TypeScript HTTP server run directly through the
`burn` binary. Unlike the other entries in `examples/`, this one is **not** a
Cargo project — it's a single `.ts` file that `burn` strips, sandboxes, and
serves end-to-end.

```bash
# default: auto-shards across CPUs
burn -A app.ts

# force single-shard (matches pre-B1 semantics; useful for state-coherent demos)
BURN_SHARDS=1 burn -A app.ts

# capability-gated: only network listening, no fs / env / child_process
burn --sandbox --allow-net '*' app.ts
```

Routes:

| route | what it shows |
|---|---|
| `GET /`        | JSON hello with service name, version, uptime, pid |
| `GET /health`  | liveness probe |
| `GET /counter` | **per-shard** counter — same handler, N independent counters when multi-shard. Demonstrates the cluster-mode-style state model B1 introduced. |
| `POST /echo`   | JSON in, JSON out + sha256 of body — exercises `node:crypto`, `Buffer.concat`, async handler |

Try it:

```bash
curl http://127.0.0.1:3000/
curl http://127.0.0.1:3000/counter   # run a few times — values differ on multi-core
curl -X POST -H 'content-type: application/json' \
     -d '{"hi":1}' http://127.0.0.1:3000/echo
```

## Why per-shard counter values, not monotonic?

When `burn` enters daemon mode (any script that binds an HTTP listener), it
spawns one parallel worker per CPU the OS gives the process. `let counter = 0`
declared outside the route is local to each worker; you'll see N independent
counters, same as Node's `cluster` module. For shared state, use
`require('afterburner:state')`.

`BURN_SHARDS=1` reverts to single-shard semantics if you want a strictly
monotonic counter for a demo.

## What this exercises

* TypeScript stripping (oxc → JS)
* Multi-shard daemon HTTP serving (B1 work)
* Capability gates: `-A` opens everything, `--sandbox --allow-net '*'` is the
  minimum for an HTTP listener
* Node compat: `node:http`, `node:crypto`, `Buffer`, `process`,
  `setHeader`/`statusCode`/`end`
* Async handler with `await Promise.resolve()` and a real JSON body parse

No `cargo run` here — install `burn` (see the top-level [README](../../README.md))
and run the snippets above.
