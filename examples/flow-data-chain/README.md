# flow-data-chain

`Afterburner::builder().flow()` opens the flow-engine lane: longer
default timeouts, friendly defaults for multi-step data pipelines,
and `register_bundle` for multi-file ES module scripts.

The **data chain** is a calling convention: multiple pipeline steps
see one shared JSON object. Each step reads upstream keys (`$trigger`,
`compute_score`, etc.) and writes its own. The host owns the key
under which each step's output lands.

```bash
cargo run --release
```
