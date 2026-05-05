# Afterburner — Examples

Two flavours of example here:

* **Library examples** — each is a fully standalone Cargo project with its
  own `Cargo.toml`, `Cargo.lock`, and `[workspace]` root stanza. No shared
  workspace; you can `cp -r <example> ~/my-project` and it builds in
  isolation against a pinned `afterburner` version. Run with `cargo run`.
* **CLI examples** — single `.ts` / `.js` files driven through the `burn`
  binary itself. No Cargo project. Run with `burn <args> <script>`.

## Library examples (cargo run)

```bash
cd examples/<name>
cargo run
```

| example              | what it demonstrates                                                     | features needed |
|----------------------|--------------------------------------------------------------------------|-----------------|
| `basic`              | `Afterburner::new()` → register → run → assert output.                   | defaults        |
| `udf-batch`          | Batched UDF: one script transforms a JSON array of records.              | defaults        |
| `parallel-thrust`    | Multi-worker scheduler. Fan 10k thrusts across N cores + measure perf.   | `thrust`        |
| `flow-data-chain`    | `Afterburner::builder().flow()` + multi-module bundle via data-chain.    | `flow`          |
| `fetch-and-env`      | Custom `HostContext` granting HTTP for a specific host allow-list.       | `host-http`     |
| `burn-embedding`     | Rebuild of `burn run` in ~30 lines using only the `afterburner` API.     | defaults        |
| `streaming-crypto`   | `crypto.createHash` streaming over a large buffer.                       | defaults        |
| `cache-backend-sqlite` | Custom `BurnCacheBackend` impl backed by a shared SQLite file. Two `Afterburner` instances using the same file share content-addressed scripts. | defaults        |

Every library example runs under the default Docker capability set. No
`SCHED_FIFO`, no signals, no privileged syscalls. Tests embedded in
each example's `src/main.rs` double as smoke tests.

## CLI examples (run via the `burn` binary)

| example          | what it demonstrates                                                                |
|------------------|-------------------------------------------------------------------------------------|
| `cli-quickstart` | TypeScript HTTP server end-to-end: multi-shard daemon, per-worker state (`/counter`), capability gates, `node:http` + `node:crypto`. `burn -A app.ts`. |
