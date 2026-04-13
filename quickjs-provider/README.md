# Javy Plugin WASM

`plugin.wasm` in this directory is the **Javy plugin** (formerly called
`quickjs_provider.wasm` in the design doc): QuickJS compiled to
`wasm32-wasi` with dynamic-linking symbols, wizer-preinitialized so the
runtime can instantiate it in sub-millisecond time. User scripts become
~500-byte stubs that import from the `javy-default-plugin-v3` namespace.

**Source:** [bytecodealliance/javy v8.1.1](https://github.com/bytecodealliance/javy/releases/tag/v8.1.1)
(SHA-256 verified from the published `.sha256` sibling on GitHub).

## Regeneration procedure

This binary is **committed to the repository** so `cargo build` never needs
network access. Regenerate only when bumping Javy.

```bash
# 1. Download the matching javy CLI and plugin artifacts from the Javy
#    GitHub release page for the target version (e.g. v8.1.1). Verify
#    both .sha256 files.
# 2. Decompress.
gunzip javy-x86_64-linux-v8.1.1.gz
gunzip plugin.wasm.gz
chmod +x javy

# 3. Initialize the plugin (runs wizer to freeze a warm runtime snapshot).
./javy init-plugin plugin.wasm -o quickjs-provider/plugin.wasm

# 4. Commit the updated binary alongside any code changes.
git add quickjs-provider/plugin.wasm
```

`afterburner-wasi` pulls this file in via `include_bytes!`.

## Building user script stubs at runtime

For each user JS source, `afterburner-wasi` shells out to `javy build` in
dynamic-linking mode, producing a ~500-byte stub WASM module:

```bash
javy build user.js -C dynamic=y -C plugin=quickjs-provider/plugin.wasm -o stub.wasm
```

The stub imports `invoke`, `canonical_abi_realloc`, and `memory` from
`javy-default-plugin-v3` — all provided by this plugin at instantiation.

## Why not fetch at build time?

- Reproducible builds: no network dependency in CI.
- Air-gapped environments work out of the box.
- The binary is ~1.3 MB — small enough to live in git without concern.
