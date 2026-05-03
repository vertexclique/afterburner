//! JS-side globals the plugin installs at `modify_runtime` time.
//!
//! Wizer preinit captures these — every thrust starts with all
//! `__host_*` bridges, `__AB_GET_INPUT__`, and the plenum polyfill
//! bundle already visible to user scripts. The installers are split by
//! capability group so no single file goes over the workspace line
//! ceiling.
//!
//! Call order matters:
//!
//! 1. `fs::install` / `crypto::install` / `misc::install` register the
//!    `__host_*` bridges (and `__AB_GET_INPUT__`).
//! 2. `ctx.eval(PLENUM_BUNDLE)` evaluates the Tier-1 polyfill bundle,
//!    which builds `require()` and the Node-stdlib modules on top of
//!    the bridges — so the bridges MUST exist first.

mod crypto;
mod fs;
mod misc;

use alloc::format;
use alloc::string::{String, ToString};
use alloc::vec;
use javy_plugin_api::javy::quickjs::Ctx;

use crate::host_api::host_last_error;

/// Default buffer size for variable-length host responses. The retry
/// loop in [`call_read`] doubles until the host confirms it fits.
pub(super) const DEFAULT_BUF: usize = 64 * 1024;

/// The plenum.js bundle, baked into the plugin. Evaluated once during
/// [`install`] so Wizer captures it into the preinit snapshot.
const PLENUM_BUNDLE: &str =
    include_str!("../../../afterburner-node-compat/generated/plenum_bundle.js");

/// Install every `__host_*` + `__AB_GET_INPUT__` global and then eval
/// the plenum polyfill bundle. Called from `modify_runtime`.
pub fn install(ctx: Ctx<'_>) {
    let globals = ctx.globals();
    fs::install(&globals);
    crypto::install(&globals);
    misc::install(&globals);

    // Eval the plenum bundle so Wizer preinit captures `require()` and
    // every Tier-1 polyfill into the snapshot.
    let _ = ctx.eval::<(), _>(PLENUM_BUNDLE);
}

/// Retry-doubling helper for variable-length host responses. Returns
/// the UTF-8 decoded string on success, or a human-readable error
/// message on failure — callers typically surface the latter to JS as
/// a `__HOST_ERR__:...` sentinel that a polyfill then detects.
pub(super) fn call_read<F>(mut call: F) -> Result<String, String>
where
    F: FnMut(*mut u8, u32) -> i32,
{
    let mut buf = vec![0u8; DEFAULT_BUF];
    let mut cap = buf.len();
    loop {
        let n = call(buf.as_mut_ptr(), cap as u32);
        if n >= 0 {
            buf.truncate(n as usize);
            return String::from_utf8(buf).map_err(|e| format!("utf8: {e}"));
        }
        if n == -4 {
            cap *= 2;
            if cap > 16 * 1024 * 1024 {
                return Err("output exceeded 16 MiB cap".to_string());
            }
            buf.resize(cap, 0);
            continue;
        }
        return Err(read_last_error(n));
    }
}

pub(super) fn read_last_error(code: i32) -> String {
    let mut buf = vec![0u8; 4096];
    let n = unsafe { host_last_error(buf.as_mut_ptr(), buf.len() as u32) };
    if n >= 0 {
        buf.truncate(n as usize);
        String::from_utf8_lossy(&buf).into_owned()
    } else {
        format!("host error (code {code})")
    }
}
