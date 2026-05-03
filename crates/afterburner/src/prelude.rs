//! Common imports, re-exported as a single glob target.
//!
//! ```no_run
//! use afterburner::prelude::*;
//!
//! let ab = Afterburner::new()?;
//! # Ok::<_, AfterburnerError>(())
//! ```

pub use crate::{
    Afterburner, AfterburnerBuilder, AfterburnerError, FuelGauge, HostContext, Manifold, Mode,
    Result, ScriptId,
};
