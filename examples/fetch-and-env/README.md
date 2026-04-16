# fetch-and-env

Demonstrates three host-facing integration patterns:

1. **Custom `HostContext`** — a small Rust struct answering
   `getEnv`, `log`, and `emitRow` requests from the script. The
   script never sees the real process environment; output "rows"
   from the script end up in a host-owned collection.

2. **Narrow capability grant** — `Manifold` with
   `NetAccess::OutboundFull(Some(["api.github.com"]))`,
   `EnvAccess::AllowList(["GITHUB_USER"])`, and `http_timeout_ms =
   Some(3_000)`. All other hosts / env vars stay denied.

3. **`emit_row` as a structured-logging sink** — the script pushes
   records back to the host via `host.emitRow`; the Rust side reads
   the collection after `ab.run` returns and prints it.

```bash
cargo run --release
```

Expected output (abridged):

```
script return: { "user": "afterburner-bot", "emitted": 2 }
host-collected rows (2):
  {"action":"login","kind":"audit","user":"afterburner-bot"}
  {"action":"query","kind":"audit","target":"/stats"}
```
