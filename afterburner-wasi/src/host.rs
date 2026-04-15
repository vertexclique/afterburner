//! Host state threaded through the Wasmtime `Store`. Holds the WASI
//! preview1 context, bounded stdin/stdout/stderr memory pipes, the
//! per-store memory limiter, and the active [`Manifold`] plus a
//! last-error slot consulted by `afterburner:host` imports.

use afterburner_core::{HostContext, Manifold, SharedStateStore};
use afterburner_node_compat::hash_handles::HashHandleStore;
use afterburner_node_compat::sign_handles::SignHandleStore;
use std::sync::Arc;
use wasmtime::{ResourceLimiter, StoreLimits, StoreLimitsBuilder};
use wasmtime_wasi::p2::pipe::{MemoryInputPipe, MemoryOutputPipe};
use wasmtime_wasi::preview1::WasiP1Ctx;

/// Per-`thrust` host state. A fresh instance is created for every call so
/// invocations are fully isolated (no shared JS globals, no stdout leak
/// between calls).
pub struct HostState {
    pub wasi: WasiP1Ctx,
    pub stdout: MemoryOutputPipe,
    pub stderr: MemoryOutputPipe,
    pub stdout_capacity: usize,
    pub limits: StoreLimits,
    /// Capability profile consulted by every `afterburner:host` import.
    pub manifold: Manifold,
    /// Cross-invocation key/value store, read by `afterburner:state`.
    pub state_store: SharedStateStore,
    /// Optional embedder-provided host context for read_column / emit_row.
    pub host_context: Option<Arc<dyn HostContext>>,
    /// Per-store streaming sign/verify handle store. Lives for the
    /// thrust's duration and is dropped with the `Store`.
    pub sign_handles: SignHandleStore,
    /// Per-store streaming createHash / createHmac handle store. Same
    /// lifetime as `sign_handles`.
    pub hash_handles: HashHandleStore,
    /// Detailed message for the last failed host call. The plugin reads
    /// this via the `host_last_error` import when a syscall returned a
    /// negative error code, and the JS glue surfaces it to the user.
    pub last_error: String,
    /// JSON-serialized input bytes for the bytecode-cache invoke path.
    /// Plugin reads this via the `host_get_input` import; lets us skip
    /// the per-thrust preamble compile that would otherwise publish the
    /// input as a JS global. Empty if the call uses the legacy envelope.
    pub pending_input: Vec<u8>,
}

impl HostState {
    /// Build a `HostState` with the given input JSON piped to stdin and
    /// bounded capture buffers for stdout and stderr.
    pub fn new(
        input: &[u8],
        memory_bytes: Option<usize>,
        stdout_capacity: usize,
        manifold: Manifold,
        state_store: SharedStateStore,
        host_context: Option<Arc<dyn HostContext>>,
    ) -> Self {
        let stdin = MemoryInputPipe::new(input.to_vec());
        let stdout = MemoryOutputPipe::new(stdout_capacity);
        // Stderr is bounded too — preserving it unbounded is a memory-
        // exhaustion vector. Surfaced to the caller via WasmTrap on error.
        let stderr = MemoryOutputPipe::new(64 * 1024);

        let wasi = wasmtime_wasi::WasiCtxBuilder::new()
            .stdin(stdin)
            .stdout(stdout.clone())
            .stderr(stderr.clone())
            .build_p1();

        let limits = match memory_bytes {
            Some(max) => StoreLimitsBuilder::new().memory_size(max).build(),
            None => StoreLimitsBuilder::new().build(),
        };

        Self {
            wasi,
            stdout,
            stderr,
            stdout_capacity,
            limits,
            manifold,
            state_store,
            host_context,
            sign_handles: SignHandleStore::new(),
            hash_handles: HashHandleStore::new(),
            last_error: String::new(),
            pending_input: Vec::new(),
        }
    }

    /// Like `new` but pre-populates `pending_input` for the bytecode-
    /// cache invoke path. The plugin reads this via `host_get_input`.
    #[allow(clippy::too_many_arguments)]
    pub fn new_with_input(
        envelope: &[u8],
        input_json: Vec<u8>,
        memory_bytes: Option<usize>,
        stdout_capacity: usize,
        manifold: Manifold,
        state_store: SharedStateStore,
        host_context: Option<Arc<dyn HostContext>>,
    ) -> Self {
        let mut s = Self::new(
            envelope,
            memory_bytes,
            stdout_capacity,
            manifold,
            state_store,
            host_context,
        );
        s.pending_input = input_json;
        s
    }

    pub fn limiter(&mut self) -> &mut dyn ResourceLimiter {
        &mut self.limits
    }
}
