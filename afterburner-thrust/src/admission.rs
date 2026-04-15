//! Token-bucket admission control — plan §8, T4.
//!
//! Per-tenant GCRA (Generic Cell Rate Algorithm — semantically a leaky
//! bucket) implemented lock-free over a single `AtomicU64` per tenant.
//! Nothing here uses `std::sync::Mutex` or `parking_lot`; tenant state
//! lives in a `kovan_map::HopscotchMap` keyed by `TenantId`.
//!
//! ### Capabilities note
//!
//! No POSIX real-time scheduling, no signals, no `timerfd` — just
//! `Instant::now()`. Safe under default Docker capability set. See
//! project memory `project_docker_cap_constraint`.
//!
//! ### TODO
//!
//! * Periodic sweep of tenants that haven't been seen in a while
//!   (the map grows unbounded today). Not in scope for T4.

use kovan_map::HopscotchMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

use crate::TenantId;

/// Lock-free per-tenant GCRA. Cheap to construct; one atomic RMW on
/// the common accept path.
pub(crate) struct TokenBucketAdmission {
    /// Nanoseconds per token (≈ 1 / rate).
    period_ns: u64,
    /// How far ahead of `now` the theoretical-arrival-time may drift
    /// before a request is rejected. Equivalently: the burst capacity
    /// expressed in nanoseconds.
    burst_ns: u64,
    /// Monotonic anchor for TAT (theoretical arrival time) values.
    epoch: Instant,
    /// Per-tenant TAT (ns since `epoch`). `Arc<AtomicU64>` so every
    /// caller hitting the same tenant CASes the same slot.
    buckets: HopscotchMap<TenantId, Arc<AtomicU64>>,
}

impl TokenBucketAdmission {
    /// Build with `tokens_per_sec` refill rate and `burst_tokens` burst
    /// capacity. A `burst_tokens` of `0` is treated as `1` so a tenant
    /// that arrives exactly on the refill boundary isn't falsely
    /// rejected by rounding.
    pub fn new(tokens_per_sec: u64, burst_tokens: u64) -> Self {
        let tokens_per_sec = tokens_per_sec.max(1);
        let burst_tokens = burst_tokens.max(1);
        let period_ns = 1_000_000_000u64 / tokens_per_sec;
        let burst_ns = burst_tokens.saturating_mul(period_ns);
        Self {
            period_ns,
            burst_ns,
            epoch: Instant::now(),
            buckets: HopscotchMap::new(),
        }
    }

    #[inline]
    fn now_ns(&self) -> u64 {
        // Instant::elapsed is monotonic on Linux; safe against wall-clock
        // jumps. u128 → u64 truncation gives ~584 years of headroom from
        // process start, which is comfortably plenty.
        self.epoch.elapsed().as_nanos() as u64
    }

    /// Lookup-or-initialize a tenant's TAT slot. Safe against races —
    /// two concurrent first-touches coalesce onto whichever
    /// `insert_if_absent` won the insert.
    fn bucket(&self, tenant: TenantId) -> Arc<AtomicU64> {
        if let Some(b) = self.buckets.get(&tenant) {
            return b;
        }
        let fresh = Arc::new(AtomicU64::new(self.now_ns()));
        match self.buckets.insert_if_absent(tenant, fresh.clone()) {
            None => fresh,
            Some(existing) => existing,
        }
    }

    /// Attempt to admit one request. `Ok(())` = allowed;
    /// `Err(retry_after_ms)` = rate-limited.
    ///
    /// GCRA step:
    /// ```text
    /// tat_new = max(tat, now) + period
    /// if (tat_new - now) > burst: reject, retry after (tat_new - now - burst) ms
    /// else: CAS tat -> tat_new
    /// ```
    pub fn try_acquire(&self, tenant: TenantId) -> Result<(), u64> {
        let bucket = self.bucket(tenant);
        loop {
            let now = self.now_ns();
            let tat = bucket.load(Ordering::Relaxed);
            let tat_base = tat.max(now);
            let tat_new = tat_base.saturating_add(self.period_ns);
            let ahead = tat_new.saturating_sub(now);
            if ahead > self.burst_ns {
                let over_ns = ahead - self.burst_ns;
                // Round up to next ms so callers don't retry 0 ms early.
                let retry_ms = over_ns.div_ceil(1_000_000).max(1);
                return Err(retry_ms);
            }
            match bucket.compare_exchange(tat, tat_new, Ordering::AcqRel, Ordering::Relaxed) {
                Ok(_) => return Ok(()),
                // Contention: another thread updated tat. Retry with the
                // fresher value.
                Err(_) => continue,
            }
        }
    }
}

impl std::fmt::Debug for TokenBucketAdmission {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TokenBucketAdmission")
            .field("period_ns", &self.period_ns)
            .field("burst_ns", &self.burst_ns)
            .finish_non_exhaustive()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;
    use std::time::Duration;

    fn tid(n: u32) -> TenantId {
        TenantId::new(n).unwrap()
    }

    #[test]
    fn allows_up_to_burst_then_rejects() {
        // 1000 tokens/sec, burst 5: five immediate allowances, then
        // reject until refill kicks in.
        let adm = TokenBucketAdmission::new(1_000, 5);
        let t = tid(1);
        for i in 0..5 {
            adm.try_acquire(t)
                .unwrap_or_else(|_| panic!("call {i} should allow"));
        }
        // The 6th is over the burst and must be rejected.
        assert!(adm.try_acquire(t).is_err());
    }

    #[test]
    fn distinct_tenants_are_isolated() {
        // 10 tokens/sec, burst 1: each tenant allowed once, then rejected.
        let adm = TokenBucketAdmission::new(10, 1);
        let a = tid(1);
        let b = tid(2);
        adm.try_acquire(a).unwrap();
        assert!(adm.try_acquire(a).is_err());
        // b is untouched — must still have one token.
        adm.try_acquire(b).unwrap();
        assert!(adm.try_acquire(b).is_err());
    }

    #[test]
    fn reports_sensible_retry_after() {
        // 100 tokens/sec → 10ms period. burst 1. Reject → retry ≤ 10ms.
        let adm = TokenBucketAdmission::new(100, 1);
        let t = tid(3);
        adm.try_acquire(t).unwrap();
        let ms = adm.try_acquire(t).unwrap_err();
        assert!(
            (1..=15).contains(&ms),
            "retry_after_ms out of expected band: {ms}"
        );
    }

    #[test]
    fn refill_allows_retry_after_waiting() {
        // 500 tokens/sec, burst 1.
        let adm = TokenBucketAdmission::new(500, 1);
        let t = tid(4);
        adm.try_acquire(t).unwrap();
        // Wait for one refill period (2ms) plus slack.
        thread::sleep(Duration::from_millis(10));
        adm.try_acquire(t).unwrap();
    }

    #[test]
    fn zero_rate_does_not_panic() {
        // Sanity: constructor normalizes zero to 1, never divides by 0.
        let adm = TokenBucketAdmission::new(0, 0);
        let t = tid(5);
        // First call allowed (single burst slot). Second rejected.
        adm.try_acquire(t).unwrap();
        assert!(adm.try_acquire(t).is_err());
    }
}
