//! Frame classification and multiplexing
//!
//! Classifies incoming binary frames by magic bytes (FRLY vs FRAU)
//! and provides batch frame splitting for stream parsing.
//!
//! Both FRLY v1 and FRAU v1 use 36-byte headers.

use wasm_bindgen::prelude::*;

use crate::audio::FRAU_HEADER_SIZE;
use crate::audio::FRAU_MAGIC;
use crate::video::FRLY_HEADER_SIZE;
use crate::video::FRLY_MAGIC;

/// Frame kind constants returned by `classify_frame`.
pub const FRAME_UNKNOWN: u8 = 0;
pub const FRAME_VIDEO: u8 = 1;
pub const FRAME_AUDIO: u8 = 2;

/// Classify a binary frame by its magic bytes.
///
/// Returns:
/// - `0` = unknown / too short
/// - `1` = video (FRLY)
/// - `2` = audio (FRAU)
#[wasm_bindgen]
pub fn classify_frame(buf: &[u8]) -> u8 {
    if buf.len() < 4 {
        return FRAME_UNKNOWN;
    }
    match &buf[0..4] {
        b"FRLY" => FRAME_VIDEO,
        b"FRAU" => FRAME_AUDIO,
        _ => FRAME_UNKNOWN,
    }
}

/// Validate a binary frame's header integrity.
///
/// Checks magic bytes and minimum header size (36 bytes for v1).
/// Returns `true` if the frame header is well-formed.
#[wasm_bindgen]
pub fn validate_frame(buf: &[u8]) -> bool {
    if buf.len() < 4 {
        return false;
    }
    match &buf[0..4] {
        m if m == FRLY_MAGIC => buf.len() >= FRLY_HEADER_SIZE,
        m if m == FRAU_MAGIC => buf.len() >= FRAU_HEADER_SIZE,
        _ => false,
    }
}
