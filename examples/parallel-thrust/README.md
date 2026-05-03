# parallel-thrust

Multi-worker scheduler demo. Uses `Afterburner::builder().threaded(N)`
to spin up an `N`-worker pool (Chase-Lev-style steal-when-idle,
bounded queues + injector, graceful-drain shutdown).

```bash
cargo run --release
```

Prints something like:

```
parallel-thrust: 8 workers × 2000 iters = 16000 thrusts
done in 4.12s  →  3886/sec  p50=1890us  p99=4200us
```

The p50/p99 spread is mostly queue wait time; the actual CPU work per
call is ~500 µs.
