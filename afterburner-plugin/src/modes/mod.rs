//! Plugin mode dispatcher.
//!
//! The plugin's `_start` reads a JSON envelope from stdin and delegates
//! to one of the per-mode handlers below, keyed on `envelope.mode`:
//!
//! | mode        | envelope                                      | output                       |
//! |-------------|-----------------------------------------------|------------------------------|
//! | `"compile"` | `{ mode, source }`                            | base64(bytecode) on stdout   |
//! | `"invoke"`  | `{ mode, bytecode_b64 }`                      | wrapped script's JSON output |
//! | `"script"`  | `{ mode, source }`                            | whatever top-level JS writes |
//! | (omitted)   | `{ source, input }`                           | wrapped script's JSON output |

pub mod compile;
pub mod invoke;
pub mod legacy;
pub mod script;

/// Dispatch on `envelope.mode`. `_start` in the crate root calls this
/// exactly once per plugin instantiation.
pub fn dispatch(envelope: &serde_json::Value) {
    let mode = envelope.get("mode").and_then(|v| v.as_str());
    match mode {
        Some("compile") => compile::run(envelope),
        Some("invoke") => invoke::run(envelope),
        Some("script") => script::run(envelope),
        _ => legacy::run(envelope),
    }
}
