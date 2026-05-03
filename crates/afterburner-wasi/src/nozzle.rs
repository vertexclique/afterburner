//! Output deserializer — stdout bytes from the WASM guest back into a
//! `serde_json::Value`. The guest is expected to write a single JSON
//! document to stdout; trailing whitespace or newlines are tolerated.

use afterburner_core::{AfterburnerError, Result};
use serde_json::Value;

pub fn parse_output(bytes: &[u8]) -> Result<Value> {
    if bytes.is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_slice(bytes).map_err(AfterburnerError::Serialize)
}
