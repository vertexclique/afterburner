# Wasmtime Pooling Allocator

Sources:
- https://docs.wasmtime.dev/examples-fast-instantiation.html
- https://docs.rs/wasmtime/latest/wasmtime/struct.PoolingAllocationConfig.html
- https://docs.rs/wasmtime/latest/wasmtime/enum.InstanceAllocationStrategy.html
- https://docs.wasmtime.dev/contributing-architecture.html

## Why pooling

Default (`OnDemand`) allocator mmap/munmaps linear memory on every instantiation. The pooling allocator pre-reserves slab-allocated memories, tables, stacks up front; instantiation becomes "take pre-allocated slot", deinstantiation is a single `madvise(MADV_DONTNEED)` to reset the memory, with an optional `mprotect` during the next instantiation to shrink protection back down.

Compared to on-demand this avoids one mmap + one munmap + multiple mprotects per call.

## Configuration builder (all have defaults)

| Method                          | Purpose                                             | Default |
|---------------------------------|-----------------------------------------------------|---------|
| `total_memories`                | Max concurrent linear memories in pool              | 1000    |
| `total_tables`                  | Max concurrent tables                               | 1000    |
| `total_core_instances`          | Max concurrent core instances                       | 1000    |
| `total_stacks`                  | Max concurrent async stacks (needs `async` feature) | 1000    |
| `total_component_instances`     | Max concurrent component instances                  | 1000    |
| `max_memory_size`               | Upper bound per linear memory                       | 4 GiB   |
| `max_memories_per_module`       | Memories defined per module                         | 1       |
| `linear_memory_keep_resident`   | Bytes to keep resident on reset (Linux, uses memset)| 0       |
| `table_keep_resident`           | Bytes to keep resident on table reset               | 0       |
| `async_stack_keep_resident`     | Same for async stacks                               | 0       |
| `memory_protection_keys`        | Auto / Yes / No — enable MPK                        | No      |

## Example

```rust
let mut pool = PoolingAllocationConfig::new();
pool.total_memories(100);
pool.max_memory_size(1 << 31); // 2 GiB
pool.total_tables(100);
pool.table_elements(5000);
pool.total_core_instances(100);

let mut config = Config::new();
config.allocation_strategy(InstanceAllocationStrategy::Pooling(pool));
let engine = Engine::new(&config)?;
```

## Affine slots

"With pooled allocation it's possible to create 'affine slots' to a particular WebAssembly module or component over time. If the same module is instantiated multiple times over time the pooling allocator will, by default, attempt to reuse the same slot." → re-instantiation becomes near-free (memory pages often still warm).

## Memory protection keys (MPK)

Colors pool slots with different PKRU keys so guard pages between linear memories can be elided. Reduces virtual address space consumption. Linux-only, requires Intel MPK.

## Constraints

- Memory growth: "memories are never allowed to move so requests for growth are instead rejected with an error" → set `max_memory_size` generously.
- Large virtual-memory reservation up front (can be tens of GiB depending on config × max size). Virtual only; physical is only dirtied on use.
- `total_core_instances` bounds concurrency. If you want N parallel calls in flight, set this >= N.
- `total_stacks` is separate from instances; if using async, size it >= N too.

## Thread interaction

- Pool lives inside `Engine`. Any thread instantiating from a shared `InstancePre`/`Module` consults the same pool under an internal lock.
- Slot checkout/return is fast (freelist) but is serialized; at very high throughput the slot-list mutex can become a contention point. Mitigate by over-provisioning `total_core_instances` and avoiding tight instantiate-return loops (e.g. reuse Store where business logic allows).

## Implications for Afterburner

- With per-call fresh `Store`, enabling pooling is the single largest instantiation speedup.
- Size `total_core_instances` and `total_memories` to `worker_count × in_flight_per_worker` with headroom.
- Because each Javy plugin module writes its JS source into linear memory then deinstantiates, `linear_memory_keep_resident` (e.g. a few MB) cuts the cold-miss cost.
- MPK optional — gives sub-linear virtual memory scaling when instances-per-box reaches thousands.
