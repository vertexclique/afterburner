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
    validate_read(path, &m.fs)
        .map(|p| p.exists())
        .unwrap_or(false)
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

/// Read up to `len` bytes from `offset`. Backs `fs.createReadStream`.
pub fn read_chunk(path: &str, offset: u64, len: usize, m: &Manifold) -> Result<Vec<u8>> {
    use std::io::{Read, Seek, SeekFrom};
    let resolved = validate_read(path, &m.fs)?;
    let mut f = std::fs::File::open(&resolved)
        .map_err(|e| AfterburnerError::Host(format!("fs.read_chunk({path}): {e}")))?;
    f.seek(SeekFrom::Start(offset))
        .map_err(|e| AfterburnerError::Host(format!("fs.read_chunk({path}): seek {e}")))?;
    let mut buf = vec![0u8; len];
    let n = f
        .read(&mut buf)
        .map_err(|e| AfterburnerError::Host(format!("fs.read_chunk({path}): read {e}")))?;
    buf.truncate(n);
    Ok(buf)
}

/// Write `data` at `offset`. Creates the file when missing. Backs
/// `fs.createWriteStream` (append-style; offset is supplied by JS).
pub fn write_chunk(path: &str, offset: u64, data: &[u8], m: &Manifold) -> Result<()> {
    use std::io::{Seek, SeekFrom, Write};
    let resolved = validate_write(path, &m.fs)?;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(&resolved)
        .map_err(|e| AfterburnerError::Host(format!("fs.write_chunk({path}): {e}")))?;
    f.seek(SeekFrom::Start(offset))
        .map_err(|e| AfterburnerError::Host(format!("fs.write_chunk({path}): seek {e}")))?;
    f.write_all(data)
        .map_err(|e| AfterburnerError::Host(format!("fs.write_chunk({path}): write {e}")))
}

pub fn file_size(path: &str, m: &Manifold) -> Result<u64> {
    let resolved = validate_read(path, &m.fs)?;
    let meta = std::fs::metadata(&resolved)
        .map_err(|e| AfterburnerError::Host(format!("fs.size({path}): {e}")))?;
    Ok(meta.len())
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
///
/// Redaction policy: permission-denied messages never echo the caller's
/// path. The user already knows what they asked for; logs captured in
/// shared sinks must not leak sensitive paths (`/home/user/.ssh/*`,
/// credential-file locations, etc.).
fn validate_read(path: &str, access: &FsAccess) -> Result<PathBuf> {
    let roots: &[PathBuf] = match access {
        FsAccess::None => {
            return Err(AfterburnerError::PermissionDenied(
                "fs read denied by manifold".into(),
            ));
        }
        FsAccess::ReadOnly(r) | FsAccess::ReadWrite(r) => r.as_slice(),
    };
    resolve_within(path, roots, "fs read")
}

fn validate_write(path: &str, access: &FsAccess) -> Result<PathBuf> {
    let roots: &[PathBuf] = match access {
        FsAccess::None => {
            return Err(AfterburnerError::PermissionDenied(
                "fs write denied by manifold".into(),
            ));
        }
        FsAccess::ReadOnly(_) => {
            return Err(AfterburnerError::PermissionDenied(
                "fs write denied: read-only policy".into(),
            ));
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
            "{op}: path has unresolved components"
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
        "{op}: path outside allowed roots"
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
            let name = cursor.file_name().map(PathBuf::from).unwrap_or_default();
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
