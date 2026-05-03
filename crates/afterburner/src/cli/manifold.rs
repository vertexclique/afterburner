//! `--allow-*` flag translation into a [`Manifold`].
//!
//! * `--allow-all` / `-A` → `Manifold::open()` (every flap wide open).
//! * Each of `--allow-net`, `--allow-fs`, `--allow-env` grants exactly
//!   the capability it names. Absent flags stay at the `sealed()`
//!   default — `PermissionDenied` on use.
//! * `*` in the value = unrestricted for that capability. Otherwise
//!   the value is a comma-separated allow-list (hosts / paths / var
//!   names).

use crate::{EnvAccess, FsAccess, Manifold, NetAccess};
use std::path::PathBuf;

use super::args::Cli;

/// Assemble the Manifold the CLI will run under, per Q1-D:
///
/// * No flags at all → `Manifold::open()` (CLI-only default — the
///   library API still defaults to `sealed`). [`banner::maybe_show`]
///   prints a one-time warning at startup.
/// * `--sandbox` or any `--allow-*` flag → start from `sealed()` and
///   apply the specific grants. Presence of `--allow-*` implicitly
///   sandboxes; you don't need to repeat `--sandbox` alongside it.
/// * `-A` / `--allow-all` → explicit `open()`; no banner (user opted
///   in).
pub fn build_manifold(cli: &Cli) -> Manifold {
    if cli.allow_all {
        return Manifold::open();
    }
    let any_allow = cli.allow_net.is_some() || cli.allow_fs.is_some() || cli.allow_env.is_some();
    let explicit_sandbox = cli.sandbox || any_allow;
    if !explicit_sandbox {
        // The CLI-flip: implicit open. Banner triggers separately in
        // `maybe_show_open_banner` when this path is taken.
        return Manifold::open();
    }
    let mut m = Manifold::sealed();

    if let Some(s) = cli.allow_net.as_deref() {
        let hosts = parse_allow_list(s);
        // Wildcard or empty list → unrestricted. We keep `OutboundFull`
        // rather than `OutboundHttp` so scripts that talk raw TCP in a
        // future host expansion don't need a migration.
        m.net = if hosts.is_empty() || has_wildcard(&hosts) {
            NetAccess::OutboundFull(None)
        } else {
            NetAccess::OutboundFull(Some(hosts))
        };
    }

    if let Some(s) = cli.allow_fs.as_deref() {
        let paths = parse_allow_list(s);
        // `*` or empty = full FS access. We model that as a ReadWrite
        // rooted at `/`; host fs code canonicalizes and checks path
        // containment, which trivially passes against root.
        let roots: Vec<PathBuf> = if paths.is_empty() || has_wildcard(&paths) {
            vec![PathBuf::from("/")]
        } else {
            paths.into_iter().map(PathBuf::from).collect()
        };
        m.fs = FsAccess::ReadWrite(roots);
    }

    if let Some(s) = cli.allow_env.as_deref() {
        let vars = parse_allow_list(s);
        m.env = if vars.is_empty() || has_wildcard(&vars) {
            EnvAccess::Full
        } else {
            EnvAccess::AllowList(vars)
        };
    }

    m
}

/// Split `"a,b, c"` into `["a", "b", "c"]`, trimming whitespace and
/// dropping empty segments. `""` returns `[]`.
pub fn parse_allow_list(s: &str) -> Vec<String> {
    s.split(',')
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(String::from)
        .collect()
}

pub fn has_wildcard(list: &[String]) -> bool {
    list.iter().any(|s| s == "*")
}

/// True when the CLI is running under the implicit open-capabilities
/// default — i.e. the user supplied neither `--sandbox` nor any
/// `--allow-*` flag and didn't explicitly set `-A`. The banner shows
/// only in this case, so callers who set `-A` don't get warned twice.
pub fn is_implicit_open(cli: &Cli) -> bool {
    if cli.allow_all {
        return false;
    }
    let any_allow = cli.allow_net.is_some() || cli.allow_fs.is_some() || cli.allow_env.is_some();
    !(cli.sandbox || any_allow)
}
