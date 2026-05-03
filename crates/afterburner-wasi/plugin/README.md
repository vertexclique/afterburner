# Custom Javy Plugin WASM

`afterburner_plugin.wasm` is the **custom Javy plugin** burn ships:
QuickJS + the afterburner-host imports + the plenum.js polyfill bundle,
all Wizer-preinitialized so the host can instantiate it in
sub-millisecond time. User scripts become ~500-byte stubs that import
`invoke`, `canonical_abi_realloc`, and `memory` from the
`javy-default-plugin-v3` namespace this plugin provides.

`afterburner_plugin.wasm.bundle-sha256` records the SHA-256 of the
plenum bundle the plugin was Wizer-preinitialized against.
`crates/afterburner-wasi/build.rs` re-hashes the current bundle on
every host build and **panics with a remediation command** if the
two diverge — drift between the polyfill source and the committed
plugin binary cannot reach `cargo build` silently.

`afterburner-wasi` pulls the plugin in via `include_bytes!`, so
**downstream consumers don't need anything in this directory at
runtime** — the bytes ride inside the host crate.

## Regeneration procedure

Run after editing any polyfill, plugin Rust code, or extern decls:

```bash
# 1. Rebuild the plenum bundle from polyfills/.
AFTERBURNER_REBUILD_PLENUM=1 cargo build -p afterburner-node-compat

# 2. Compile the plugin, lower modern WASM features, Wizer-preinit.
bash crates/afterburner-plugin/build.sh
```

The script rewrites both `afterburner_plugin.wasm` and
`afterburner_plugin.wasm.bundle-sha256`. Commit them together.

Tooling needed (build-time only — no runtime deps): `wasm32-wasip1`
target, `javy` 8.1.1 CLI, `wasm-opt` (Binaryen 119+). See the root
README for installation instructions.

## Why a committed binary?

- Reproducible builds: no network dependency from `cargo build`.
- Air-gapped environments work out of the box.
- ~3.5 MB is small enough to live in git without concern.
- Wizer pre-init is non-trivial (warming QuickJS + freezing the
  bundle); doing it once at commit time keeps `cargo build` fast.
