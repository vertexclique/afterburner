//! JS → WASM stub compilation. For v0.1 we shell out to the `javy` CLI.
//!
//! Future work: link Javy as a library so we don't depend on a CLI on
//! `PATH`. Shelling out is tracked as tech debt.

use afterburner_core::AfterburnerError;
use std::io::Write;
use std::path::Path;
use std::process::Command;

/// Compile a JS source string to a self-contained WASM module via the
/// Javy CLI at `javy_binary`.
///
/// We use **static linking** (default `javy build`): each user script
/// produces a self-contained ~1.3 MB module with the full Javy runtime
/// embedded. Dynamic linking yields ~500 B stubs that share a plugin,
/// but the Wasmtime linker wiring for that pattern wasn't reliable on
/// Javy 8.1.1 and the size win evaporates once compiled
/// `wasmtime::Module`s are cached behind `Arc`.
pub fn compile_js_to_wasm(
    javy_binary: &Path,
    source: &str,
) -> Result<Vec<u8>, AfterburnerError> {
    let tmp = tempfile::tempdir()
        .map_err(|e| AfterburnerError::Engine(format!("tempdir: {e}")))?;
    let in_path = tmp.path().join("input.js");
    let out_path = tmp.path().join("stub.wasm");

    {
        let mut f = std::fs::File::create(&in_path)
            .map_err(|e| AfterburnerError::Engine(format!("write input: {e}")))?;
        f.write_all(source.as_bytes())
            .map_err(|e| AfterburnerError::Engine(format!("write input: {e}")))?;
    }

    let output = Command::new(javy_binary)
        .arg("build")
        .arg(&in_path)
        .arg("-o")
        .arg(&out_path)
        .output()
        .map_err(|e| AfterburnerError::Engine(format!("spawn javy: {e}")))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(AfterburnerError::CompileFailed(stderr.into_owned()));
    }

    std::fs::read(&out_path).map_err(|e| AfterburnerError::Engine(format!("read stub: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support;

    #[test]
    fn compile_trivial_script() {
        let Some(javy) = test_support::resolve_javy() else {
            return;
        };
        let out = compile_js_to_wasm(&javy, "const x = 1 + 2;").unwrap();
        assert!(out.starts_with(b"\0asm"), "expected WASM magic header");
        assert!(
            out.len() > 500_000,
            "expected substantial module; got {} bytes",
            out.len()
        );
    }

    #[test]
    fn compile_syntax_error_returns_compile_failed() {
        let Some(javy) = test_support::resolve_javy() else {
            return;
        };
        let err = compile_js_to_wasm(&javy, "const x = (").unwrap_err();
        assert!(matches!(err, AfterburnerError::CompileFailed(_)));
    }
}
