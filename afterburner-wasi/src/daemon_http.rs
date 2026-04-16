//! Daemon HTTP coordinator — host-side state that backs
//! `__host_http_listen` / `__host_http_reply`.
//!
//! Owns the axum listeners spawned by user scripts' `.listen(port)`
//! calls and the per-request reply channels that ferry
//! `ServerResponse.end(body)` output back to the waiting axum task.
//!
//! B2 ships an A-style (per-script-port) listener topology; the plan
//! calls out B2b as the refactor to a host-wide multiplex table
//! keyed by (host, port). The public API here is already shaped for
//! that refactor — it talks in terms of `server_id` and `req_id`, so
//! a later host-wide variant can reuse the same contract.
//!
//! The coordinator lives inside an `Arc<DaemonHttp>` attached to
//! `HostState::daemon_http` on the daemon runtime's long-lived
//! Store. One-shot UDF / script thrusts leave it as `None` so they
//! don't pay the coordinator's cost.

use kovan_map::HopscotchMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicI32, AtomicI64, Ordering};

/// Opaque identifier the JS side uses to key handlers and requests.
/// We use signed types on the JS side (`__host_http_listen` returns
/// an `i32`; `__host_http_reply` takes an `i64`) so negative values
/// can double as error codes.
pub type ServerId = i32;
pub type ReqId = i64;

/// Per-listener state: the port the host bound, plus any metadata
/// the coordinator needs to route incoming requests. Concrete axum
/// wiring lives in B2.4; this struct is the forward-compatible slot.
#[derive(Debug, Clone)]
pub struct ListenerSlot {
    pub port: u16,
}

/// Per-request state the host keeps while an in-flight request is
/// waiting on JS to call `res.end()`. Populated when axum receives
/// the request; consumed by `__host_http_reply`.
#[derive(Clone)]
pub struct PendingReply {
    pub sender: kovan_channel::flavors::bounded::Sender<ReplyEnvelope>,
}

/// Response payload the JS side hands back via `__host_http_reply`.
#[derive(Debug, Clone)]
pub struct ReplyEnvelope {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

/// Host-side coordinator attached to `HostState::daemon_http` when a
/// script enters daemon mode.
pub struct DaemonHttp {
    /// Monotonic `server_id` counter; increments on each accepted
    /// `__host_http_listen` call.
    next_server_id: AtomicI32,
    /// Monotonic `req_id` counter.
    next_req_id: AtomicI64,
    /// Active listeners keyed by `server_id`. Removed when the
    /// daemon shuts down.
    listeners: HopscotchMap<ServerId, ListenerSlot>,
    /// In-flight requests awaiting `__host_http_reply`. Keyed by
    /// `req_id`.
    pending: HopscotchMap<ReqId, PendingReply>,
}

impl fmt::Debug for DaemonHttp {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("DaemonHttp")
            .field("next_server_id", &self.next_server_id.load(Ordering::Relaxed))
            .field("next_req_id", &self.next_req_id.load(Ordering::Relaxed))
            .finish_non_exhaustive()
    }
}

impl Default for DaemonHttp {
    fn default() -> Self {
        Self::new()
    }
}

impl DaemonHttp {
    pub fn new() -> Self {
        Self {
            next_server_id: AtomicI32::new(1),
            next_req_id: AtomicI64::new(1),
            listeners: HopscotchMap::new(),
            pending: HopscotchMap::new(),
        }
    }

    pub fn shared() -> Arc<Self> {
        Arc::new(Self::new())
    }

    /// Reserve a fresh `server_id` and record the listener slot. The
    /// actual socket bind + axum spawn happens in B2.4; this just
    /// threads the accounting so the JS side gets a stable id back.
    pub fn register_listener(&self, port: u16) -> ServerId {
        let id = self.next_server_id.fetch_add(1, Ordering::Relaxed);
        self.listeners.insert(id, ListenerSlot { port });
        id
    }

    /// Fetch (and remove) a pending reply slot. Called from
    /// `__host_http_reply` to signal the axum task.
    pub fn take_reply(&self, req_id: ReqId) -> Option<PendingReply> {
        self.pending.remove(&req_id)
    }

    /// Install a pending reply slot; returns the `req_id` the JS
    /// side should later hand to `__host_http_reply`.
    pub fn register_pending(
        &self,
        sender: kovan_channel::flavors::bounded::Sender<ReplyEnvelope>,
    ) -> ReqId {
        let id = self.next_req_id.fetch_add(1, Ordering::Relaxed);
        self.pending.insert(id, PendingReply { sender });
        id
    }
}

use std::fmt;
