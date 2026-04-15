//! `dns.lookup` host function. Synchronous — we have no event loop, and
//! `ToSocketAddrs` blocks on the resolver anyway. Gated by
//! `Manifold::net`: any non-`None` value unlocks DNS since the concrete
//! network operations (HTTP) already require net access.
//!
//! Returns the first resolved address, matching the ergonomics of
//! Node's `dns.lookup(host, cb)` default path (first, no ALL flag).
//!
//! ### Timeouts (P5)
//!
//! A hung resolver can otherwise wedge the calling thread forever —
//! `ToSocketAddrs` doesn't honor any timeout. We run the lookup on a
//! short-lived worker thread and `kovan_channel::select!` on the
//! result vs. an `after()` timer. The configurable cap lives on the
//! `Manifold` (`http_timeout_ms` is shared across all network-adjacent
//! host ops; DNS piggybacks on it). If the timeout fires, we return
//! a typed `AfterburnerError::Host` — the detached worker thread is
//! orphaned and cleans itself up when the OS resolver eventually
//! returns.

use afterburner_core::{AfterburnerError, Manifold, NetAccess, Result};
use kovan_channel::flavors::after::after;
use kovan_channel::{bounded, select};
use std::net::ToSocketAddrs;
use std::thread;
use std::time::Duration;

/// Default per-call resolver timeout when the Manifold doesn't supply
/// one. Matches the HTTP default (30 s) — DNS is usually sub-second,
/// but adversarial or misconfigured resolvers can stall indefinitely
/// without a hard cap.
const DEFAULT_DNS_TIMEOUT: Duration = Duration::from_secs(30);

pub fn lookup(hostname: &str, m: &Manifold) -> Result<String> {
    if matches!(m.net, NetAccess::None) {
        return Err(AfterburnerError::PermissionDenied(format!(
            "dns.lookup({hostname})"
        )));
    }

    let timeout = m
        .http_timeout_ms
        .map(Duration::from_millis)
        .unwrap_or(DEFAULT_DNS_TIMEOUT);

    // One-shot channel for the result. `bounded(1)` — we send exactly
    // one value.
    let (tx, rx) = bounded::<Result<String>>(1);
    let probe = format!("{hostname}:0");
    let hn = hostname.to_string();
    thread::spawn(move || {
        let r = probe
            .to_socket_addrs()
            .map_err(|e| AfterburnerError::Host(format!("dns.lookup({hn}): {e}")))
            .and_then(|mut iter| {
                iter.next()
                    .map(|sa| sa.ip().to_string())
                    .ok_or_else(|| AfterburnerError::Host(format!("dns.lookup({hn}): no result")))
            });
        // If the receiver timed out and got dropped, this send is a
        // no-op — the worker thread leaks for a bounded duration (the
        // OS resolver's own internal timeout), then completes and
        // returns.
        tx.send(r);
    });

    let timer = after(timeout);
    // `select!` unwraps `Option<T>` from each Receiver's `try_recv`
    // and binds the inner `T` to the branch name. So `got: Result<String>`
    // (since rx is `Receiver<Result<String>>`), and the timer binding is
    // the fired `Instant` (unused).
    select! {
        got = rx => got,
        _tick = timer => Err(AfterburnerError::Host(format!(
            "dns.lookup({hostname}): timed out after {}ms",
            timeout.as_millis()
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[test]
    fn denied_when_net_is_none() {
        let m = Manifold::sealed();
        let result = lookup("example.com", &m);
        assert!(matches!(result, Err(AfterburnerError::PermissionDenied(_))));
    }

    #[test]
    fn localhost_resolves_quickly() {
        let mut m = Manifold::open();
        m.http_timeout_ms = Some(2_000);
        let t0 = Instant::now();
        let result = lookup("localhost", &m);
        let elapsed = t0.elapsed();
        assert!(result.is_ok(), "localhost should resolve: {result:?}");
        assert!(
            elapsed < Duration::from_millis(500),
            "localhost resolution took {elapsed:?} — unusually slow"
        );
    }

    #[test]
    fn short_timeout_bounds_unresolvable() {
        // An unreachable TLD that the resolver may dither on. We set
        // a 500 ms timeout and assert we either succeed promptly
        // (resolver NXDOMAINs fast) or time out within 1.5s — never
        // hang. This is the production gate.
        let mut m = Manifold::open();
        m.http_timeout_ms = Some(500);
        let t0 = Instant::now();
        let _ = lookup("afterburner-test-unreachable-nonexistent-host.invalid", &m);
        let elapsed = t0.elapsed();
        assert!(
            elapsed < Duration::from_millis(1_500),
            "hung past 1.5 s ({elapsed:?}); timeout knob not honored"
        );
    }
}
