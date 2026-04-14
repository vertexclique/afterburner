//! Filesystem host functions.
//!
//! Every call takes a [`Manifold`] and refuses access when the capability
//! is not granted. Paths are resolved via [`std::fs::canonicalize`] so
//! `..`/symlink traversal cannot escape the configured roots.

use afterburner_core::{AfterburnerError, FsAccess, Manifold, Result};
use std::path::{Component, Path, PathBuf};

/// Read the entire file at `path`.
pub fn read_file_sync(path: &str, m: &Manifold) -> Result<Vec<u8>> {
    let resolved = validate_read(path, &m.fs)?;
    std::fs::read(&resolved)
        .map_err(|e| AfterburnerError::Host(format!("fs.readFileSync({path}): {e}")))
}

/// Write `data` to `path`, creating or overwriting.
pub fn write_file_sync(path: &str, data: &[u8], m: &Manifold) -> Result<()> {
    let resolved = validate_write(path, &m.fs)?;
    std::fs::write(&resolved, data)
        .map_err(|e| AfterburnerError::Host(format!("fs.writeFileSync({path}): {e}")))
}

/// `true` if the path exists and is reachable under the active FS policy.
pub fn exists_sync(path: &str, m: &Manifold) -> bool {
    validate_read(path, &m.fs).map(|p| p.exists()).unwrap_or(false)
}

/// Stat: returns (size_bytes, is_file, is_dir, mtime_ms).
pub fn stat_sync(path: &str, m: &Manifold) -> Result<FileStat> {
    let resolved = validate_read(path, &m.fs)?;
    let meta = std::fs::metadata(&resolved)
        .map_err(|e| AfterburnerError::Host(format!("fs.statSync({path}): {e}")))?;
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Ok(FileStat {
        size: meta.len(),
        is_file: meta.is_file(),
        is_dir: meta.is_dir(),
        mtime_ms,
    })
}

pub fn readdir_sync(path: &str, m: &Manifold) -> Result<Vec<String>> {
    let resolved = validate_read(path, &m.fs)?;
    let iter = std::fs::read_dir(&resolved)
        .map_err(|e| AfterburnerError::Host(format!("fs.readdirSync({path}): {e}")))?;
    let mut names = Vec::new();
    for entry in iter {
        let e =
            entry.map_err(|e| AfterburnerError::Host(format!("fs.readdirSync({path}): {e}")))?;
        names.push(e.file_name().to_string_lossy().into_owned());
    }
    names.sort();
    Ok(names)
}

pub fn mkdir_sync(path: &str, recursive: bool, m: &Manifold) -> Result<()> {
    let resolved = validate_write(path, &m.fs)?;
    let res = if recursive {
        std::fs::create_dir_all(&resolved)
    } else {
        std::fs::create_dir(&resolved)
    };
    res.map_err(|e| AfterburnerError::Host(format!("fs.mkdirSync({path}): {e}")))
}

pub fn unlink_sync(path: &str, m: &Manifold) -> Result<()> {
    let resolved = validate_write(path, &m.fs)?;
    std::fs::remove_file(&resolved)
        .map_err(|e| AfterburnerError::Host(format!("fs.unlinkSync({path}): {e}")))
}

pub fn rename_sync(from: &str, to: &str, m: &Manifold) -> Result<()> {
    let src = validate_write(from, &m.fs)?;
    let dst = validate_write(to, &m.fs)?;
    std::fs::rename(&src, &dst)
        .map_err(|e| AfterburnerError::Host(format!("fs.renameSync({from} → {to}): {e}")))
}

#[derive(Debug, Clone, Copy)]
pub struct FileStat {
    pub size: u64,
    pub is_file: bool,
    pub is_dir: bool,
    pub mtime_ms: u64,
}

/// Resolve `path` to an absolute, normalized PathBuf and ensure it lives
/// under one of the FS policy's roots. `None` / `ReadOnly` / `ReadWrite`
/// all allow reads when the policy admits it.
fn validate_read(path: &str, access: &FsAccess) -> Result<PathBuf> {
    let roots: &[PathBuf] = match access {
        FsAccess::None => {
            return Err(AfterburnerError::PermissionDenied(format!(
                "fs read of {path}"
            )));
        }
        FsAccess::ReadOnly(r) | FsAccess::ReadWrite(r) => r.as_slice(),
    };
    resolve_within(path, roots, "fs read")
}

fn validate_write(path: &str, access: &FsAccess) -> Result<PathBuf> {
    let roots: &[PathBuf] = match access {
        FsAccess::None => {
            return Err(AfterburnerError::PermissionDenied(format!(
                "fs write to {path}"
            )));
        }
        FsAccess::ReadOnly(_) => {
            return Err(AfterburnerError::PermissionDenied(format!(
                "fs write to {path} (read-only policy)"
            )));
        }
        FsAccess::ReadWrite(r) => r.as_slice(),
    };
    resolve_within(path, roots, "fs write")
}

/// Normalize `path` (absolute form, no `..`, no symlink escape) and
/// verify it is inside one of the `roots`. If `roots` is empty, no root
/// constraint is applied (open policy from `Manifold::open`).
fn resolve_within(path: &str, roots: &[PathBuf], op: &str) -> Result<PathBuf> {
    let requested = PathBuf::from(path);
    let absolute = if requested.is_absolute() {
        requested
    } else {
        std::env::current_dir()
            .map(|c| c.join(&requested))
            .map_err(|e| AfterburnerError::Host(format!("cwd: {e}")))?
    };

    // Canonicalize the path if it exists; otherwise canonicalize the
    // deepest existing ancestor and append the remainder. This lets us
    // validate write targets that don't yet exist.
    let canonical = canonicalize_with_fallback(&absolute);

    if !is_normalized(&canonical) {
        return Err(AfterburnerError::PermissionDenied(format!(
            "{op}: path {path} has unresolved components"
        )));
    }

    if roots.is_empty() {
        return Ok(canonical);
    }

    for root in roots {
        let root_canon = root.canonicalize().unwrap_or_else(|_| root.clone());
        if canonical.starts_with(&root_canon) {
            return Ok(canonical);
        }
    }

    Err(AfterburnerError::PermissionDenied(format!(
        "{op}: path {path} outside allowed roots"
    )))
}

fn canonicalize_with_fallback(path: &Path) -> PathBuf {
    if let Ok(c) = path.canonicalize() {
        return c;
    }
    let mut cursor: PathBuf = path.to_path_buf();
    let mut trailing: Vec<PathBuf> = Vec::new();
    while !cursor.exists() {
        if let Some(parent) = cursor.parent().map(|p| p.to_path_buf()) {
            let name = cursor
                .file_name()
                .map(PathBuf::from)
                .unwrap_or_default();
            trailing.push(name);
            cursor = parent;
        } else {
            return path.to_path_buf();
        }
    }
    let mut resolved = cursor.canonicalize().unwrap_or(cursor);
    while let Some(n) = trailing.pop() {
        resolved.push(n);
    }
    resolved
}

fn is_normalized(p: &Path) -> bool {
    !p.components().any(|c| matches!(c, Component::ParentDir))
}
