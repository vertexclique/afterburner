//! Outbound HTTP via `ureq`. Synchronous API — fits Afterburner's
//! single-threaded, no-event-loop execution model.
//!
//! Gated behind `Manifold::net`. Hosts outside the policy allow-list
//! (when present) are rejected before the request is even constructed.
//!
//! ### Per-call timeouts (T6.2 stopgap)
//!
//! Every call has a 30-second hard deadline applied via `ureq::Request::timeout`.
//! That bounds the worst case of a compute worker wedging on a slow URL.
//! The proper fix — moving HTTP to a dirty I/O pool with async-Wasmtime host
//! imports — is plan §7.1 / T6.1. Until then, this timeout is the only thing
//! between a slow upstream and a thrust hanging beyond its `FuelGauge::timeout_ms`.

use afterburner_core::{AfterburnerError, Manifold, NetAccess, Result};
use std::time::Duration;

/// Hard ceiling on per-request wall clock. Below this every individual
/// thrust's `FuelGauge::timeout_ms` is the active bound; above this we
/// trip the ureq timeout and surface a host error.
const HTTP_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone)]
pub struct HttpResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

pub fn request(
    method: &str,
    url: &str,
    headers: &[(String, String)],
    body: Option<&[u8]>,
    m: &Manifold,
) -> Result<HttpResponse> {
    let host = extract_host(url).ok_or_else(|| {
        AfterburnerError::Host(format!("http.request: cannot parse host from {url}"))
    })?;

    match &m.net {
        NetAccess::None => {
            return Err(AfterburnerError::PermissionDenied(format!(
                "http.{method} {url}"
            )));
        }
        NetAccess::OutboundHttp(allow) | NetAccess::OutboundFull(allow) => {
            if let Some(list) = allow
                && !list.iter().any(|h| host_matches(&host, h))
            {
                return Err(AfterburnerError::PermissionDenied(format!(
                    "http.{method} {url}: host not in allow-list"
                )));
            }
        }
    }

    let mut req = ureq::request(method, url).timeout(HTTP_REQUEST_TIMEOUT);
    for (k, v) in headers {
        req = req.set(k, v);
    }
    let resp = match body {
        Some(b) => req.send_bytes(b),
        None => req.call(),
    };
    match resp {
        Ok(r) => {
            let status = r.status();
            let hdrs: Vec<(String, String)> = r
                .headers_names()
                .into_iter()
                .filter_map(|n| r.header(&n).map(|v| (n.clone(), v.to_string())))
                .collect();
            let mut buf = Vec::new();
            r.into_reader()
                .read_to_end(&mut buf)
                .map_err(|e| AfterburnerError::Host(format!("http read: {e}")))?;
            Ok(HttpResponse {
                status,
                headers: hdrs,
                body: buf,
            })
        }
        Err(ureq::Error::Status(code, r)) => {
            let mut buf = Vec::new();
            let _ = r.into_reader().read_to_end(&mut buf);
            Ok(HttpResponse {
                status: code,
                headers: Vec::new(),
                body: buf,
            })
        }
        Err(e) => Err(AfterburnerError::Host(format!("http: {e}"))),
    }
}

fn extract_host(url: &str) -> Option<String> {
    let rest = url.split_once("://").map(|(_, r)| r).unwrap_or(url);
    let host_end = rest.find(['/', '?', '#', ':']).unwrap_or(rest.len());
    let host = &rest[..host_end];
    if host.is_empty() {
        None
    } else {
        Some(host.to_string())
    }
}

fn host_matches(host: &str, pattern: &str) -> bool {
    if let Some(suffix) = pattern.strip_prefix("*.") {
        host == suffix || host.ends_with(&format!(".{suffix}"))
    } else {
        host == pattern
    }
}
