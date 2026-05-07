//! `zlib.*` host functions. Compute-only; no `Manifold` gate. Covers the
//! four sync variants `scripts` actually reach for: raw deflate/inflate
//! and gzip/gunzip. Async callback + stream variants layer on top in the
//! JS polyfill.

use afterburner_core::{AfterburnerError, Result};
use flate2::Compression;
use flate2::read::{DeflateDecoder, GzDecoder};
use flate2::write::{DeflateEncoder, GzEncoder};
use std::io::{Read, Write};

pub fn deflate_sync(data: &[u8]) -> Result<Vec<u8>> {
    let mut enc = DeflateEncoder::new(Vec::new(), Compression::default());
    enc.write_all(data)
        .map_err(|e| AfterburnerError::Host(format!("zlib.deflateSync: {e}")))?;
    enc.finish()
        .map_err(|e| AfterburnerError::Host(format!("zlib.deflateSync: {e}")))
}

pub fn inflate_sync(data: &[u8]) -> Result<Vec<u8>> {
    let mut dec = DeflateDecoder::new(data);
    let mut out = Vec::with_capacity(data.len() * 2);
    dec.read_to_end(&mut out)
        .map_err(|e| AfterburnerError::Host(format!("zlib.inflateSync: {e}")))?;
    Ok(out)
}

pub fn gzip_sync(data: &[u8]) -> Result<Vec<u8>> {
    let mut enc = GzEncoder::new(Vec::new(), Compression::default());
    enc.write_all(data)
        .map_err(|e| AfterburnerError::Host(format!("zlib.gzipSync: {e}")))?;
    enc.finish()
        .map_err(|e| AfterburnerError::Host(format!("zlib.gzipSync: {e}")))
}

pub fn gunzip_sync(data: &[u8]) -> Result<Vec<u8>> {
    let mut dec = GzDecoder::new(data);
    let mut out = Vec::with_capacity(data.len() * 2);
    dec.read_to_end(&mut out)
        .map_err(|e| AfterburnerError::Host(format!("zlib.gunzipSync: {e}")))?;
    Ok(out)
}

/// `zlib.zstdCompressSync` (Node 24+ stable). Default compression
/// level (3) matches Node's default. The host-side `zstd` crate
/// links a statically-bundled libzstd, so no system dependency.
pub fn zstd_compress_sync(data: &[u8]) -> Result<Vec<u8>> {
    zstd::stream::encode_all(data, 3)
        .map_err(|e| AfterburnerError::Host(format!("zlib.zstdCompressSync: {e}")))
}

/// `zlib.zstdDecompressSync` (Node 24+ stable).
pub fn zstd_decompress_sync(data: &[u8]) -> Result<Vec<u8>> {
    zstd::stream::decode_all(data)
        .map_err(|e| AfterburnerError::Host(format!("zlib.zstdDecompressSync: {e}")))
}
