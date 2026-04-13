//! Host state threaded through the Wasmtime `Store`. Holds the WASI
//! preview1 context plus bounded stdin/stdout/stderr memory pipes and the
//! per-store memory limiter.

use wasmtime::{ResourceLimiter, StoreLimits, StoreLimitsBuilder};
use wasmtime_wasi::preview1::WasiP1Ctx;
use wasmtime_wasi::pipe::{MemoryInputPipe, MemoryOutputPipe};

/// Per-`thrust` host state. A fresh instance is created for every call so
/// invocations are fully isolated (no shared JS globals, no stdout leak
/// between calls).
pub struct HostState {
    pub wasi: WasiP1Ctx,
    pub stdout: MemoryOutputPipe,
    pub stderr: MemoryOutputPipe,
    pub stdout_capacity: usize,
    pub limits: StoreLimits,
}

impl HostState {
    /// Build a `HostState` with the given input JSON piped to stdin and
    /// bounded capture buffers for stdout and stderr.
    pub fn new(input: &[u8], memory_bytes: Option<usize>, stdout_capacity: usize) -> Self {
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
        }
    }

    pub fn limiter(&mut self) -> &mut dyn ResourceLimiter {
        &mut self.limits
    }
}
