//! Crypto host functions — SHA-2 family hashes, MD5, HMAC, secure random.
//!
//! Gated behind `Manifold::crypto`; a disabled manifold returns
//! `PermissionDenied` for every operation.

use afterburner_core::{AfterburnerError, Manifold, Result};
use hmac::{Hmac, Mac};
use md5::Md5;
use sha2::{Digest, Sha256, Sha384, Sha512};

/// Hash `data` with the named algorithm. Supported: `md5`, `sha1` (no —
/// too weak, rejected), `sha256`, `sha384`, `sha512`.
pub fn hash(algorithm: &str, data: &[u8], m: &Manifold) -> Result<Vec<u8>> {
    if !m.crypto {
        return Err(AfterburnerError::PermissionDenied(format!(
            "crypto.createHash({algorithm})"
        )));
    }
    match algorithm.to_ascii_lowercase().as_str() {
        "sha256" => Ok(Sha256::digest(data).to_vec()),
        "sha384" => Ok(Sha384::digest(data).to_vec()),
        "sha512" => Ok(Sha512::digest(data).to_vec()),
        "md5" => Ok(Md5::digest(data).to_vec()),
        other => Err(AfterburnerError::Host(format!(
            "crypto: unsupported hash '{other}'"
        ))),
    }
}

/// HMAC with the named algorithm.
pub fn hmac(algorithm: &str, key: &[u8], data: &[u8], m: &Manifold) -> Result<Vec<u8>> {
    if !m.crypto {
        return Err(AfterburnerError::PermissionDenied(format!(
            "crypto.createHmac({algorithm})"
        )));
    }
    match algorithm.to_ascii_lowercase().as_str() {
        "sha256" => {
            let mut mac = Hmac::<Sha256>::new_from_slice(key)
                .map_err(|e| AfterburnerError::Host(format!("hmac key: {e}")))?;
            mac.update(data);
            Ok(mac.finalize().into_bytes().to_vec())
        }
        "sha384" => {
            let mut mac = Hmac::<Sha384>::new_from_slice(key)
                .map_err(|e| AfterburnerError::Host(format!("hmac key: {e}")))?;
            mac.update(data);
            Ok(mac.finalize().into_bytes().to_vec())
        }
        "sha512" => {
            let mut mac = Hmac::<Sha512>::new_from_slice(key)
                .map_err(|e| AfterburnerError::Host(format!("hmac key: {e}")))?;
            mac.update(data);
            Ok(mac.finalize().into_bytes().to_vec())
        }
        other => Err(AfterburnerError::Host(format!(
            "crypto: unsupported hmac '{other}'"
        ))),
    }
}

/// Fill a buffer with cryptographically strong random bytes.
pub fn random_bytes(len: usize, m: &Manifold) -> Result<Vec<u8>> {
    if !m.crypto {
        return Err(AfterburnerError::PermissionDenied(
            "crypto.randomBytes".into(),
        ));
    }
    let mut out = vec![0u8; len];
    getrandom::getrandom(&mut out)
        .map_err(|e| AfterburnerError::Host(format!("getrandom: {e}")))?;
    Ok(out)
}

/// Version-4 UUID (random).
pub fn random_uuid(m: &Manifold) -> Result<String> {
    if !m.crypto {
        return Err(AfterburnerError::PermissionDenied(
            "crypto.randomUUID".into(),
        ));
    }
    Ok(uuid::Uuid::new_v4().to_string())
}

/// Constant-time byte comparison.
pub fn timing_safe_equal(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut acc = 0u8;
    for i in 0..a.len() {
        acc |= a[i] ^ b[i];
    }
    acc == 0
}
