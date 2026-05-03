# afterburner

Afterburner - JS ~> WASM Sandboxed Execution VM

Part of the [Afterburner](https://github.com/vertexclique/afterburner) workspace —
a sandboxed JavaScript runtime for Rust. See the workspace [README](https://github.com/vertexclique/afterburner#readme)
for the full picture and getting-started guide.

```toml
[dependencies]
afterburner = "0.1"
```

Most users only need the `afterburner` facade; this sub-crate is re-exported
through it and rarely consumed directly.
