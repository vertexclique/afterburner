#!/usr/bin/env bash
# Build the custom Javy plugin, run Wizer pre-initialization on it, and
# copy the result into `quickjs-provider/`. Run from the plugin dir. The
# output is committed to the repo — downstream builds never need this
# script or the `javy` CLI.

set -euo pipefail

cd "$(dirname "$0")"

# 1. Compile the plugin. Use workspace target dir so the artifact
#    lands where subsequent scripts expect it.
cargo build --target wasm32-wasip1 --release

# Workspace target is one level up.
raw=../target/wasm32-wasip1/release/afterburner_plugin.wasm
if [[ ! -f "$raw" ]]; then
    echo "expected $raw not produced" >&2
    exit 1
fi

# 2. Wizer-preinit so the QuickJS runtime + plenum bundle are baked
#    into the snapshot. This is a one-time build step; at runtime the
#    host never shells out to `javy`.
javy=${JAVY:-javy}
if ! command -v "$javy" >/dev/null; then
    if [[ -x /home/vclq/.local/bin/javy ]]; then
        javy=/home/vclq/.local/bin/javy
    else
        echo "javy CLI not found. Set JAVY=... or install from https://github.com/bytecodealliance/javy" >&2
        exit 1
    fi
fi

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
"$javy" init-plugin "$raw" -o "$tmp"

dest=../quickjs-provider/afterburner_plugin.wasm
cp "$tmp" "$dest"

# Record the SHA-256 of the plenum bundle the plugin was built against
# so the host crate's build.rs can detect drift and fail cleanly.
bundle=../afterburner-node-compat/generated/plenum_bundle.js
sha=$(sha256sum "$bundle" | awk '{print $1}')
printf '%s\n' "$sha" > "$dest.bundle-sha256"

echo "wrote $(stat -c %s "$dest") bytes to $dest (Wizer-preinitialized)"
echo "recorded bundle sha256: $sha → $dest.bundle-sha256"
