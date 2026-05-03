# Afterburner — Examples

Each subdirectory is a **fully standalone Cargo project** with its own
`Cargo.toml`, `Cargo.lock`, and `[workspace]` root stanza. There is no
shared workspace — you can `cp -r <example> ~/my-project` and it works
in isolation against a pinned `afterburner` version.

To run any example:

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

Every example runs under the default Docker capability set. No
`SCHED_FIFO`, no signals, no privileged syscalls. Tests embedded in
each example's `src/main.rs` double as smoke tests.
