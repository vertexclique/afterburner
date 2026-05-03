//! `burn` — the Afterburner command-line runtime.
//!
//! Thin entrypoint. All subcommand logic lives in [`afterburner::cli`].

fn main() {
    if let Err(e) = afterburner::cli::run() {
        eprintln!("burn: {e:#}");
        std::process::exit(1);
    }
}
