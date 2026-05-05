//! Daemon HTTP coordinator — host-side state that backs
//! `__host_http_listen` / `__host_http_reply`.
//!
//! Owns the axum listeners spawned by user scripts' `.listen(port)`
//! calls and the per-request reply channels that ferry
//! `ServerResponse.end(body)` output back to the waiting axum task.
//!
//! Listener binding happens synchronously so `.listen(3000)` that
//! collides with an already-used port surfaces EADDRINUSE immediately
//! (matching Node), and `server.close()` releases the port via the
//! `__host_http_close` import. The `ports_in_use` map keyed by port
//! provides O(1) within-process collision detection without racing
//! against the OS.
//!
//! The coordinator lives inside an `Arc<DaemonHttp>` attached to
//! `HostState::daemon_http` on the daemon runtime's long-lived
//! Store. One-shot UDF / script thrusts leave it as `None` so they
//! don't pay the coordinator's cost.
//!
//! Axum listener plumbing lives behind the `daemon` feature.
//! Without the feature, `DaemonHttp` is a pure-accounting stub: it
//! reserves `server_id`s and records `pending` reply slots, but
//! never binds a real socket. The `burn` CLI enables the feature;
//! library consumers who only run UDF / one-shot scripts leave it off.

use kovan_map::HopscotchMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicI64, Ordering};

/// Opaque identifier the JS side uses to key handlers and requests.
pub type ServerId = i32;
pub type ReqId = i64;

/// Per-listener state.
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

/// Incoming event dispatched from the axum listener to the daemon
/// event loop. The CLI's dispatcher thread wraps this in a
/// `{mode: "daemon-event", event: ...}` envelope for the plugin.
#[derive(Debug, Clone)]
pub struct DaemonEvent {
    pub server_id: ServerId,
    pub req_id: ReqId,
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

/// Negative return codes for `__host_http_listen`. Mirrored in
/// `polyfills/http.js` — keep them in sync.
pub const LISTEN_ERR_NO_DAEMON: i32 = -1;
pub const LISTEN_ERR_ADDR_IN_USE: i32 = -2;
pub const LISTEN_ERR_IO: i32 = -3;

/// Host-side coordinator attached to `HostState::daemon_http` when a
/// script enters daemon mode.
pub struct DaemonHttp {
    next_server_id: AtomicI32,
    next_req_id: AtomicI64,
    listeners: HopscotchMap<ServerId, ListenerSlot>,
    /// port → owning server_id. Lets the next `.listen()` on
    /// the same port fail with EADDRINUSE without racing through the
    /// OS bind, and keeps close() accounting honest.
    ports_in_use: HopscotchMap<u16, ServerId>,
    pending: HopscotchMap<ReqId, PendingReply>,
    /// When true, `bind_listener` for an already-bound port returns
    /// the existing `server_id` instead of `LISTEN_ERR_ADDR_IN_USE`.
    /// This is the multi-shard contract: every shard's daemon-init
    /// runs the same source, so each shard calls `app.listen(port)`,
    /// but only the first call binds a real socket — subsequent calls
    /// register the handler under the same id and let the dispatcher
    /// route requests to whichever shard is least busy.
    ///
    /// Off by default so single-shard daemons preserve Node's
    /// "EADDRINUSE on double-listen" semantics. Multi-shard arbitration
    /// is fully lock-free: `HopscotchMap::get_or_insert` (CAS-based
    /// in `kovan_map`) atomically resolves which shard claims the
    /// port. Losers see the winner's id without taking any lock.
    shared_listeners: AtomicBool,

    /// Daemon-feature channel — axum handlers push `DaemonEvent`s
    /// through here; the CLI's dispatcher thread pops them off and
    /// calls `DaemonRuntime::dispatch_event`. `None` in stub mode
    /// (no `with_runtime` call).
    #[cfg(feature = "daemon")]
    event_tx: Option<kovan_channel::flavors::bounded::Sender<DaemonEvent>>,
    #[cfg(feature = "daemon")]
    event_rx: Option<kovan_channel::flavors::bounded::Receiver<DaemonEvent>>,

    /// Abort handles per listener so `server.close()` can release
    /// the port cleanly. `tokio::task::AbortHandle` is `Clone` so it
    /// stores fine inside the kovan map; aborting cancels the axum
    /// `serve` future, which drops the bound `TcpListener`.
    #[cfg(feature = "daemon")]
    listener_tasks: HopscotchMap<ServerId, tokio::task::AbortHandle>,

    /// Tokio runtime handle used to spawn axum listener tasks. `None`
    /// in stub mode — any call to `bind_listener` without a handle
    /// logs and returns a negative error.
    #[cfg(feature = "daemon")]
    runtime: Option<tokio::runtime::Handle>,
}

impl fmt::Debug for DaemonHttp {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("DaemonHttp")
            .field(
                "next_server_id",
                &self.next_server_id.load(Ordering::Relaxed),
            )
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
    /// Stub-mode constructor — no runtime attached, so
    /// `bind_listener` allocates a `server_id` without binding a
    /// real socket. Used by tests that exercise the plugin ↔ host
    /// ABI directly.
    pub fn new() -> Self {
        Self {
            next_server_id: AtomicI32::new(1),
            next_req_id: AtomicI64::new(1),
            listeners: HopscotchMap::new(),
            ports_in_use: HopscotchMap::new(),
            pending: HopscotchMap::new(),
            shared_listeners: AtomicBool::new(false),
            #[cfg(feature = "daemon")]
            event_tx: None,
            #[cfg(feature = "daemon")]
            event_rx: None,
            #[cfg(feature = "daemon")]
            listener_tasks: HopscotchMap::new(),
            #[cfg(feature = "daemon")]
            runtime: None,
        }
    }

    /// Switch the coordinator into shared-listener mode. Must be
    /// called BEFORE any `bind_listener` call — flipping this mid-
    /// flight would race with in-flight binds. Multi-shard pools
    /// flip this at construction.
    pub fn enable_shared_listeners(&self) {
        self.shared_listeners.store(true, Ordering::Release);
    }

    /// Whether shared-listener mode is on.
    pub fn is_shared_listeners(&self) -> bool {
        self.shared_listeners.load(Ordering::Acquire)
    }

    pub fn shared() -> Arc<Self> {
        Arc::new(Self::new())
    }

    /// Real-mode constructor — `bind_listener` will actually bind a
    /// TCP socket and spawn an axum service on the supplied
    /// runtime. `event_queue_cap` bounds the axum→dispatcher
    /// channel; overflow backpressures incoming requests.
    #[cfg(feature = "daemon")]
    pub fn with_runtime(handle: tokio::runtime::Handle, event_queue_cap: usize) -> Arc<Self> {
        let (tx, rx) = kovan_channel::bounded(event_queue_cap);
        Arc::new(Self {
            next_server_id: AtomicI32::new(1),
            next_req_id: AtomicI64::new(1),
            listeners: HopscotchMap::new(),
            ports_in_use: HopscotchMap::new(),
            pending: HopscotchMap::new(),
            shared_listeners: AtomicBool::new(false),
            event_tx: Some(tx),
            event_rx: Some(rx),
            listener_tasks: HopscotchMap::new(),
            runtime: Some(handle),
        })
    }

    /// Number of currently-registered listeners. B2.5 uses this to
    /// decide whether `burn foo.js` should exit after running daemon-
    /// init (no listeners → plain script) or enter the event loop
    /// (listeners present → daemon).
    pub fn listener_count(&self) -> usize {
        let seen = self.next_server_id.load(Ordering::Relaxed);
        (1..seen)
            .filter(|id| self.listeners.get(id).is_some())
            .count()
    }

    /// Stub-mode listener registration — reserves a `server_id`
    /// without binding. Returned for tests / abstract drivers.
    /// Still honours within-process port collisions so stub-mode
    /// tests exercise the EADDRINUSE path.
    ///
    /// In shared-listener mode (multi-shard pool), an already-bound
    /// port returns the existing id instead of erroring — first call
    /// "binds" (registers), subsequent calls just rejoin.
    ///
    /// Lock-free port arbitration via `HopscotchMap::get_or_insert`
    /// (CAS-based in kovan_map). N shards racing on the same port
    /// converge atomically: exactly one shard's id wins; the others
    /// see it without ever taking a lock.
    pub fn register_listener(&self, port: u16) -> ServerId {
        let new_id = self.next_server_id.fetch_add(1, Ordering::Relaxed);
        let claimed = self.ports_in_use.get_or_insert(port, new_id);
        if claimed != new_id {
            // Another shard claimed first.
            if self.shared_listeners.load(Ordering::Acquire) {
                return claimed;
            }
            return LISTEN_ERR_ADDR_IN_USE;
        }
        self.listeners.insert(new_id, ListenerSlot { port });
        new_id
    }

    /// Release a listener's port + accounting. Called from
    /// `__host_http_close` via `server.close()` in JS. Returns
    /// `true` if the server_id was known.
    ///
    /// On the daemon path this also aborts the axum task so the
    /// socket is freed and a subsequent `.listen(port)` in the same
    /// process succeeds.
    pub fn close_listener(&self, id: ServerId) -> bool {
        let Some(slot) = self.listeners.remove(&id) else {
            return false;
        };
        self.ports_in_use.remove(&slot.port);
        #[cfg(feature = "daemon")]
        {
            if let Some(handle) = self.listener_tasks.remove(&id) {
                handle.abort();
            }
        }
        true
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

    /// Signal the pending reply for `req_id` with the response
    /// payload the JS side handed to `__host_http_reply`. Returns
    /// `true` if a waiter was present. Missing slots are silently
    /// dropped — the most likely cause is a stale reply after the
    /// axum task already timed out or disconnected.
    pub fn deliver_reply(&self, req_id: ReqId, reply: ReplyEnvelope) -> bool {
        if let Some(PendingReply { sender }) = self.pending.remove(&req_id) {
            sender.send(reply);
            true
        } else {
            false
        }
    }

    /// Bind a TCP listener on `port` synchronously; on success,
    /// register the accepted socket with axum on the stored runtime
    /// handle and return the new `server_id`.
    ///
    /// Returns:
    ///
    /// * positive `server_id` — bound and serving.
    /// * [`LISTEN_ERR_NO_DAEMON`] (-1) — coordinator constructed via
    ///   [`Self::new`] / [`Self::shared`] (no runtime). Stub path:
    ///   allocate id without binding, preserving ABI-test symmetry.
    /// * [`LISTEN_ERR_ADDR_IN_USE`] (-2) — port already bound, by us
    ///   or by the OS.
    /// * [`LISTEN_ERR_IO`] (-3) — any other bind failure (permission
    ///   denied on a privileged port, interface vanished, etc.).
    ///
    /// The synchronous bind closes the race where a stale axum task
    /// silently owned a port: if the OS refuses the bind we return a
    /// typed error *before* allocating a `server_id`, so JS sees
    /// the failure up front rather than via a stderr eprintln.
    #[cfg(feature = "daemon")]
    pub fn bind_listener(self: &Arc<Self>, port: u16) -> i32 {
        let (Some(runtime), Some(event_tx)) = (self.runtime.as_ref(), self.event_tx.clone()) else {
            // Stub path still enforces within-process collision so
            // the no-runtime tests exercise the same EADDRINUSE edge.
            return self.register_listener(port);
        };

        // Lock-free port arbitration. `get_or_insert` is a CAS in
        // kovan_map's HopscotchMap — N shards racing converge
        // atomically: exactly one's `new_id` becomes the claim.
        let new_id = self.next_server_id.fetch_add(1, Ordering::Relaxed);
        let claimed_id = self.ports_in_use.get_or_insert(port, new_id);
        if claimed_id != new_id {
            // Another shard claimed first.
            if self.shared_listeners.load(Ordering::Acquire) {
                return claimed_id;
            }
            return LISTEN_ERR_ADDR_IN_USE;
        }

        // We own the claim. Bind the real socket.
        let bind_addr = format!("127.0.0.1:{port}");
        let std_listener = match std::net::TcpListener::bind(&bind_addr) {
            Ok(l) => l,
            Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
                // External collision (some other OS process owns the port).
                // Release our claim so subsequent retries can try again.
                self.ports_in_use.remove(&port);
                return LISTEN_ERR_ADDR_IN_USE;
            }
            Err(_) => {
                self.ports_in_use.remove(&port);
                return LISTEN_ERR_IO;
            }
        };
        if std_listener.set_nonblocking(true).is_err() {
            self.ports_in_use.remove(&port);
            return LISTEN_ERR_IO;
        }
        // `TcpListener::from_std` registers the raw fd with the tokio
        // reactor — it panics if called outside a runtime context.
        // Enter the runtime synchronously for the duration of the
        // conversion + spawn so the host function can stay sync.
        let _enter = runtime.enter();
        let tokio_listener = match tokio::net::TcpListener::from_std(std_listener) {
            Ok(l) => l,
            Err(_) => {
                self.ports_in_use.remove(&port);
                return LISTEN_ERR_IO;
            }
        };

        // Bound. Publish the listener slot + axum task.
        self.listeners.insert(new_id, ListenerSlot { port });

        let coord = Arc::clone(self);
        let handle = runtime.spawn(axum_server::serve_listener(
            tokio_listener,
            new_id,
            coord,
            event_tx,
        ));
        self.listener_tasks.insert(new_id, handle.abort_handle());
        new_id
    }

    /// Non-daemon-feature variant — allocates an id without binding
    /// a real socket. Matches the stub behaviour pre-B2.4 so test
    /// harnesses exercising the plugin ABI still work without the
    /// `daemon` feature.
    #[cfg(not(feature = "daemon"))]
    pub fn bind_listener(self: &Arc<Self>, port: u16) -> i32 {
        self.register_listener(port)
    }

    /// Pop the next event off the axum→dispatcher channel. Blocks
    /// until one arrives or the channel disconnects (all senders
    /// dropped). The CLI's dispatcher thread drives this in a loop
    /// until it receives a shutdown signal.
    #[cfg(feature = "daemon")]
    pub fn recv_event(&self) -> Option<DaemonEvent> {
        self.event_rx.as_ref().and_then(|rx| rx.recv())
    }

    /// Non-daemon-feature recv — always returns None since no axum
    /// task is pushing events.
    #[cfg(not(feature = "daemon"))]
    pub fn recv_event(&self) -> Option<DaemonEvent> {
        None
    }

    /// Non-blocking event pop. Returns `None` when the queue is
    /// empty (distinct from the channel being closed). Useful for
    /// dispatcher loops that need a shutdown signal orthogonal to
    /// the event stream.
    #[cfg(feature = "daemon")]
    pub fn try_recv_event(&self) -> Option<DaemonEvent> {
        self.event_rx.as_ref().and_then(|rx| rx.try_recv())
    }

    #[cfg(not(feature = "daemon"))]
    pub fn try_recv_event(&self) -> Option<DaemonEvent> {
        None
    }
}

#[cfg(feature = "daemon")]
mod axum_server {
    //! axum handler wiring for incoming HTTP requests. Each listener
    //! spawned by `bind_listener` runs its own `serve` task; the
    //! handler converts the request into a `DaemonEvent`, ships it
    //! to the dispatcher thread via the shared channel, and awaits
    //! the reply that `__host_http_reply` delivers.

    use super::*;
    use axum::{
        Router,
        extract::{Request, State},
        http::{HeaderMap, StatusCode},
        response::{IntoResponse, Response},
        routing::any,
    };
    use bytes::Bytes;

    /// Drive an already-bound listener through axum. Used by the
    /// path where `bind_listener` performs a synchronous bind so
    /// EADDRINUSE surfaces to JS before we ever allocate a server_id.
    pub(super) async fn serve_listener(
        listener: tokio::net::TcpListener,
        server_id: ServerId,
        coord: Arc<DaemonHttp>,
        _event_tx: kovan_channel::flavors::bounded::Sender<DaemonEvent>,
    ) {
        let state = Arc::new(ServerState {
            server_id,
            coord: Arc::clone(&coord),
        });
        let app = Router::new()
            .fallback(any(dispatch_request))
            .with_state(state);
        if let Err(e) = axum::serve(listener, app).await {
            eprintln!("burn: axum serve for server_id={server_id} exited: {e}");
        }
    }

    #[derive(Clone)]
    struct ServerState {
        server_id: ServerId,
        coord: Arc<DaemonHttp>,
    }

    async fn dispatch_request(State(state): State<Arc<ServerState>>, req: Request) -> Response {
        let (parts, body) = req.into_parts();
        let method = parts.method.to_string();
        let url = parts
            .uri
            .path_and_query()
            .map(|pq| pq.to_string())
            .unwrap_or_else(|| "/".into());
        let headers: Vec<(String, String)> = parts
            .headers
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
            .collect();
        // Bound the request body so a hostile client can't make the
        // runtime allocate unbounded memory. 16 MiB matches our stdout
        // capture ceiling elsewhere.
        const MAX_BODY: usize = 16 * 1024 * 1024;
        let body_bytes = match axum::body::to_bytes(body, MAX_BODY).await {
            Ok(b) => b,
            Err(e) => {
                return (
                    StatusCode::PAYLOAD_TOO_LARGE,
                    format!("burn: request body: {e}"),
                )
                    .into_response();
            }
        };

        // Register the per-request reply slot and send the event.
        let (reply_tx, reply_rx) = kovan_channel::bounded::<ReplyEnvelope>(1);
        let req_id = state.coord.register_pending(reply_tx);
        let event = DaemonEvent {
            server_id: state.server_id,
            req_id,
            method,
            url,
            headers,
            body: body_bytes.to_vec(),
        };

        let Some(event_tx) = state.coord.event_tx.as_ref() else {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                "burn: daemon not running\n",
            )
                .into_response();
        };
        event_tx.send_async(event).await;

        // Await the reply. kovan_channel's recv_async returns T on
        // success; disconnection is a coordinator bug, not a user-
        // facing path.
        let reply = reply_rx.recv_async().await;

        let status =
            StatusCode::from_u16(reply.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        let mut headers_out = HeaderMap::new();
        for (name, value) in &reply.headers {
            if let (Ok(name), Ok(value)) = (
                name.parse::<axum::http::HeaderName>(),
                value.parse::<axum::http::HeaderValue>(),
            ) {
                headers_out.insert(name, value);
            }
        }
        (status, headers_out, Bytes::from(reply.body)).into_response()
    }
}

use std::fmt;
