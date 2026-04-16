# udf-batch

Register one JS UDF, apply it across a 2 000-row JSON array via
`Afterburner::run_batch`. Prints throughput + the first three rows.

```bash
cargo run --release     # release-mode recommended for realistic throughput
```
