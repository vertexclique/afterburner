//! Plugin mode dispatcher.
//!
//! The plugin's `_start` reads a JSON envelope from stdin and delegates
//! to one of the per-mode handlers below, keyed on `envelope.mode`:
//!
//! | mode            | envelope                                          | output                       |
//! |-----------------|---------------------------------------------------|------------------------------|
//! | `"compile"`     | `{ mode, source }`                                | base64(bytecode) on stdout   |
//! | `"invoke"`      | `{ mode, bytecode_b64 }`                          | wrapped script's JSON output |
//! | `"script"`      | `{ mode, source, argv?, env? }`                   | whatever top-level JS writes |
//! | `"daemon-init"` | `{ mode, source, argv?, env? }`                   | side-effect only (Store kept alive by host) |
//! | `"daemon-event"`| `{ mode, event: {kind, ...} }`                    | side-effect only (reply via `__host_http_reply`) |
//! | (omitted)       | `{ source, input }`                               | wrapped script's JSON output |

pub mod compile;
pub mod daemon_event;
pub mod daemon_init;
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
        Some("daemon-init") => daemon_init::run(envelope),
        Some("daemon-event") => daemon_event::run(envelope),
        _ => legacy::run(envelope),
    }
}
