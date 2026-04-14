//! ABI drift gate. Host imports are declared in three places:
//!
//! 1. `afterburner-plugin/src/lib.rs` — `extern "C" { fn host_foo(...) }`.
//! 2. `afterburner-wasi/src/host_imports.rs` — `linker.func_wrap(NS, "host_foo", ...)`.
//! 3. `wit/afterburner-host.wit` — the shape contract (docs).
//!
//! The `extern` declaration and the `func_wrap` registration MUST name
//! the same imports — a missing entry on either side manifests as a
//! link error at Wasmtime instantiation time with a message like
//! "unknown import". This test catches the drift at `cargo test` time
//! instead.

use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;

fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf()
}

/// Extract `host_xxx` names from string literals inside `func_wrap`
/// registrations in host_imports.rs.
fn wasi_imports() -> BTreeSet<String> {
    let src = fs::read_to_string(workspace_root().join("afterburner-wasi/src/host_imports.rs"))
        .expect("read host_imports.rs");
    let mut out = BTreeSet::new();
    for line in src.lines() {
        let line = line.trim();
        // func_wrap takes the name as a string literal; also the zlib /
        // cipher loops register via tuple entries like `("host_foo", ...)`.
        if let Some(name) = extract_host_literal(line) {
            out.insert(name);
        }
    }
    out
}

/// Extract `host_xxx` names from `extern "C"` declarations in the
/// plugin. The plugin block looks like:
///
/// ```ignore
/// extern "C" {
///     fn host_foo(...);
/// }
/// ```
fn plugin_imports() -> BTreeSet<String> {
    let src = fs::read_to_string(workspace_root().join("afterburner-plugin/src/lib.rs"))
        .expect("read plugin/src/lib.rs");
    let mut out = BTreeSet::new();
    let mut in_extern = false;
    for line in src.lines() {
        let trimmed = line.trim();
        // The plugin uses `unsafe extern "C" {` with a
        // `#[link(wasm_import_module = ...)]` attribute above. Treat
        // either form as the start of the extern block.
        if trimmed.contains("extern \"C\"") && trimmed.ends_with('{') {
            in_extern = true;
            continue;
        }
        if !in_extern {
            continue;
        }
        if trimmed == "}" {
            in_extern = false;
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix("fn host_")
            && let Some(open) = rest.find('(')
        {
            let name = format!("host_{}", &rest[..open]);
            out.insert(name);
        }
    }
    out
}

fn extract_host_literal(line: &str) -> Option<String> {
    // Look for `"host_xxx_yyy"` as a substring — simple but effective
    // because the plugin doesn't emit random `host_` string literals
    // outside of the import-naming spots.
    let start = line.find("\"host_")? + 1;
    let rest = &line[start..];
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

#[test]
fn plugin_and_wasi_host_imports_match() {
    let wasi = wasi_imports();
    let plugin = plugin_imports();

    let only_plugin: BTreeSet<_> = plugin.difference(&wasi).collect();
    let only_wasi: BTreeSet<_> = wasi.difference(&plugin).collect();

    assert!(
        only_plugin.is_empty() && only_wasi.is_empty(),
        "ABI drift between afterburner-plugin and afterburner-wasi:\n\
         - only in plugin (extern but no linker wiring): {only_plugin:?}\n\
         - only in wasi   (linker wiring but no extern): {only_wasi:?}\n\
         Every host import must be declared in BOTH afterburner-plugin/src/lib.rs \
         and afterburner-wasi/src/host_imports.rs. Update wit/afterburner-host.wit too."
    );
}
