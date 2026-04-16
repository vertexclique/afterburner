# basic

The smallest viable Afterburner program: default engine, register a
one-line JS UDF, run once, assert output.

```bash
cargo run
```

Expected stdout:

```json
{
  "doubled": 42
}
```

The `Afterburner::new()` default picks adaptive mode when available
(first call runs on native rquickjs; subsequent calls on sandboxed
Wasmtime). No capability grants — `Manifold::sealed()` — so the script
cannot touch `fs`, `net`, `env`, `crypto`, or `child_process`.
