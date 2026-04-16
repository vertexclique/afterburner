# burn-embedding

Rebuild of `burn run <FILE>` in ~30 lines of Rust using only the
public `afterburner` API. Demonstrates that the `burn` binary is a
thin CLI shell — you can replicate (or customize) its behavior from
your own Rust code without forking.

```bash
# Default payload (temp file generated on first run):
cargo run

# Or point at any .js:
cargo run -- /path/to/your/script.js
```
