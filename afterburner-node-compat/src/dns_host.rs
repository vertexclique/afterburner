//! `dns.lookup` host function. Synchronous — we have no event loop, and
//! `ToSocketAddrs` blocks on the resolver anyway. Gated by
//! `Manifold::net`: any non-`None` value unlocks DNS since the concrete
//! network operations (HTTP) already require net access.
//!
//! Returns the first resolved address, matching the ergonomics of
//! Node's `dns.lookup(host, cb)` default path (first, no ALL flag).

use afterburner_core::{AfterburnerError, Manifold, NetAccess, Result};
use std::net::ToSocketAddrs;

pub fn lookup(hostname: &str, m: &Manifold) -> Result<String> {
    if matches!(m.net, NetAccess::None) {
        return Err(AfterburnerError::PermissionDenied(format!(
            "dns.lookup({hostname})"
        )));
    }
    // ToSocketAddrs expects host:port; attach a sentinel port.
    let probe = format!("{hostname}:0");
    let mut iter = probe
        .to_socket_addrs()
        .map_err(|e| AfterburnerError::Host(format!("dns.lookup({hostname}): {e}")))?;
    iter.next()
        .map(|sa| sa.ip().to_string())
        .ok_or_else(|| AfterburnerError::Host(format!("dns.lookup({hostname}): no result")))
}
