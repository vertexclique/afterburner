# streaming-crypto

Demonstrates the streaming hash polyfill: `crypto.createHash('sha256')`
→ `.update(chunk)` × N → `.digest('hex')`. Each `.update` goes through
a host-side digest handle that keeps state across calls; no per-chunk
allocation on the JS heap.

```bash
cargo run
```

Expected output:

```
sha256 of 1MiB of 'a': 9bc1b2a288b26af7257a36277ae3816a7d4f16e89c1e7e77d0a5c48bad62b360
```

`Manifold::open()` grants `crypto`. Sealed manifold (the default)
denies crypto entirely — try swapping it to see the
`PermissionDenied`.
