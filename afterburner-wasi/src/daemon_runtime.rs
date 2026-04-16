//! `DaemonRuntime` — long-lived `Store<HostState>` that persists JS
//! state across many `daemon_step` invocations.
//!
//! Daemon mode is what lets `burn server.js` run real Node HTTP
//! servers: after the user code registers handlers via
//! `http.createServer(cb).listen(port)`, the Store sticks around so
//! subsequent incoming HTTP requests (dispatched via
//! [`DaemonRuntime::dispatch_event`]) hit the same JS state — same
//! globals, same handler table, same plenum caches.
//!
//! This is an intentional break from the fresh-per-thrust invariant
//! that every other combustor path enforces: daemon mode is opt-in
//! (CLI-only by default per the plan's Q2-A locked decision), and
//! the library API's `Afterburner::run_script` never auto-enters it.

use crate::daemon_http::DaemonHttp;
use crate::host::HostState;
use afterburner_core::{
    AfterburnerError, HostContext, InMemoryStateStore, Manifold, Result, SharedStateStore,
};
use serde_json::Value;
use std::sync::Arc;
use wasmtime::{Engine, InstancePre, Store, Trap, TypedFunc};
use wasmtime_wasi::I32Exit;

/// Per-call stdout buffer. Matches [`wasm_engine`]'s default so
/// daemon-mode scripts don't get a surprise capacity shift.
const DAEMON_STDOUT_CAPACITY: usize = 1024 * 1024;

/// Handle to a long-lived plugin instance. Owns the Store, the
/// typed `daemon_step` function, and a reference to the HTTP
/// coordinator shared with the axum listeners the script registers.
pub struct DaemonRuntime {
    store: Store<HostState>,
    daemon_step: TypedFunc<(), ()>,
    daemon_http: Arc<DaemonHttp>,
}

impl std::fmt::Debug for DaemonRuntime {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DaemonRuntime")
            .field("daemon_http", &self.daemon_http)
            .finish_non_exhaustive()
    }
}

impl DaemonRuntime {
    /// Spawn a daemon runtime from a prepared `InstancePre` and the
    /// user's source. Runs `daemon_step` once with the daemon-init
    /// envelope — that evaluates the user source, which typically
    /// installs HTTP handlers onto `globalThis.__ab_http_handlers`
    /// and binds listeners via `__host_http_listen`.
    ///
    /// Returns a handle the caller drives via [`dispatch_event`]
    /// and [`drain_stdout`] / [`drain_stderr`].
    pub fn new(
        engine: &Engine,
        instance_pre: &InstancePre<HostState>,
        source: &str,
        manifold: Manifold,
        state_store: Option<SharedStateStore>,
        host_context: Option<Arc<dyn HostContext>>,
        daemon_http: Arc<DaemonHttp>,
    ) -> Result<Self> {
        let state_store = state_store.unwrap_or_else(InMemoryStateStore::shared);

        // daemon-init envelope — same script-mode shape, just keyed
        // "daemon-init" so the plugin knows to preserve the Store.
        let envelope = serde_json::json!({
            "mode": "daemon-init",
            "source": source,
        });
        let envelope_bytes = serde_json::to_vec(&envelope)?;

        // Stdin is unused in daemon mode (we use pending_envelope
        // instead) — hand it an empty buffer so HostState::new's
        // input pipe satisfies WASI.
        let mut state = HostState::new(
            b"",
            None,
            DAEMON_STDOUT_CAPACITY,
            manifold,
            state_store,
            host_context,
        );
        state.pending_envelope = envelope_bytes;
        state.daemon_http = Some(daemon_http.clone());

        let mut store = Store::new(engine, state);
        store.limiter(|s| &mut s.limits);
        // Daemon mode is a long-lived process — no per-call fuel cap
        // makes sense. Individual events can still be bounded by the
        // dispatch_event caller (future work: per-event timeouts).
        store
            .set_fuel(u64::MAX)
            .map_err(|e| AfterburnerError::Engine(format!("set_fuel: {e}")))?;
        store.set_epoch_deadline(u64::MAX / 2);

        let instance = instance_pre
            .instantiate(&mut store)
            .map_err(|e| AfterburnerError::Engine(format!("daemon instantiate: {e}")))?;
        let daemon_step = instance
            .get_typed_func::<(), ()>(&mut store, "daemon_step")
            .map_err(|e| AfterburnerError::Engine(format!("daemon_step lookup: {e}")))?;

        daemon_step
            .call(&mut store, ())
            .map_err(|trap| map_daemon_trap("daemon-init", trap))?;

        Ok(Self {
            store,
            daemon_step,
            daemon_http,
        })
    }

    /// Dispatch one event to the running daemon. Event shape:
    /// `{ kind: "http-request", server_id, req_id, req: {...} }` —
    /// the plugin's `daemon_event` mode looks the handler up on
    /// `globalThis.__ab_http_handlers[server_id]` and invokes it.
    pub fn dispatch_event(&mut self, event: Value) -> Result<()> {
        let envelope = serde_json::json!({
            "mode": "daemon-event",
            "event": event,
        });
        let envelope_bytes = serde_json::to_vec(&envelope)?;
        self.store.data_mut().pending_envelope = envelope_bytes;
        self.daemon_step
            .call(&mut self.store, ())
            .map_err(|trap| map_daemon_trap("daemon-event", trap))?;
        Ok(())
    }

    /// Snapshot of captured stdout. Cumulative — the caller is
    /// responsible for tracking a high-water mark if it wants
    /// per-event deltas. B2.4 will route stdout to the real process
    /// in the long-running CLI case.
    pub fn drain_stdout(&self) -> Vec<u8> {
        self.store.data().stdout.contents().to_vec()
    }

    /// Snapshot of captured stderr. Same cumulative semantics.
    pub fn drain_stderr(&self) -> Vec<u8> {
        self.store.data().stderr.contents().to_vec()
    }

    /// Access the HTTP coordinator — B2.4 uses this to register axum
    /// listener sockets keyed to the `server_id`s the script
    /// produced during daemon-init.
    pub fn http(&self) -> &Arc<DaemonHttp> {
        &self.daemon_http
    }

    /// `true` if the script installed at least one HTTP listener via
    /// `.listen(port)`. The CLI uses this to decide between exiting
    /// cleanly after daemon-init (no listener → script was one-shot)
    /// and entering the event loop.
    pub fn has_listeners(&self) -> bool {
        self.daemon_http.listener_count() > 0
    }
}

fn map_daemon_trap(phase: &'static str, trap: anyhow::Error) -> AfterburnerError {
    // WASI `proc_exit(N)` propagates as I32Exit. Daemon mode doesn't
    // use proc_exit as a control-flow signal, but scripts that call
    // `process.exit` will land here — treat 0 as clean return, non-
    // zero as an error the CLI should propagate via its own exit.
    if let Some(exit) = trap.downcast_ref::<I32Exit>() {
        if exit.0 == 0 {
            return AfterburnerError::Engine(format!(
                "{phase}: unexpected proc_exit(0) — daemon mode doesn't support process.exit yet"
            ));
        }
        return AfterburnerError::WasmTrap(format!("{phase}: process.exit({})", exit.0));
    }
    if let Some(t) = trap.downcast_ref::<Trap>() {
        match t {
            Trap::Interrupt => return AfterburnerError::Timeout,
            Trap::OutOfFuel => return AfterburnerError::FuelExhausted,
            other => return AfterburnerError::WasmTrap(format!("{phase}: {other}")),
        }
    }
    // Fall through: bundle the chain so the caller can see what
    // actually went wrong (often a JS-side exception that propagated
    // back through `invoke`).
    let chain: Vec<String> = trap.chain().map(|e| format!("{e}")).collect();
    AfterburnerError::WasmTrap(format!("{phase}: {}", chain.join(" => ")))
}
