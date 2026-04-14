//! FRLY video frame codec
//!
//! Wire layout:
//!   [0:4]   magic "FRLY"
//!   [4:12]  sequence   (u64 LE)
//!   [12:16] width      (u32 LE)
//!   [16:20] height     (u32 LE)
//!   [20]    quality    (u8)
//!   [21:29] timestamp  (u64 LE, ms)
//!   [29:]   JPEG payload

use wasm_bindgen::prelude::*;

pub const FRLY_MAGIC: &[u8; 4] = b"FRLY";
pub const FRLY_HEADER_SIZE: usize = 29;

/// Video frame metadata parsed from a FRLY binary prefix.
#[wasm_bindgen]
#[derive(Clone, Debug)]
pub struct FrameHeader {
    pub sequence: u64,
    pub width: u32,
    pub height: u32,
    pub quality: u8,
    pub timestamp_ms: u64,
}

/// Check whether a buffer starts with the FRLY magic bytes.
#[wasm_bindgen]
pub fn is_video_frame(buf: &[u8]) -> bool {
    buf.len() >= 4 && &buf[0..4] == FRLY_MAGIC
}

/// Encode a 29-byte FRLY header prefix (no JPEG payload).
#[wasm_bindgen]
pub fn encode_frame_prefix(header: &FrameHeader) -> Vec<u8> {
    let mut buf = Vec::with_capacity(FRLY_HEADER_SIZE);
    buf.extend_from_slice(FRLY_MAGIC);
    buf.extend_from_slice(&header.sequence.to_le_bytes());
    buf.extend_from_slice(&header.width.to_le_bytes());
    buf.extend_from_slice(&header.height.to_le_bytes());
    buf.push(header.quality);
    buf.extend_from_slice(&header.timestamp_ms.to_le_bytes());
    buf
}

/// Encode a complete FRLY frame (header + JPEG payload).
#[wasm_bindgen]
pub fn encode_video_frame(
    sequence: u64,
    width: u32,
    height: u32,
    quality: u8,
    timestamp_ms: u64,
    jpeg: &[u8],
) -> Vec<u8> {
    let mut buf = Vec::with_capacity(FRLY_HEADER_SIZE + jpeg.len());
    buf.extend_from_slice(FRLY_MAGIC);
    buf.extend_from_slice(&sequence.to_le_bytes());
    buf.extend_from_slice(&width.to_le_bytes());
    buf.extend_from_slice(&height.to_le_bytes());
    buf.push(quality);
    buf.extend_from_slice(&timestamp_ms.to_le_bytes());
    buf.extend_from_slice(jpeg);
    buf
}

/// Decode a FRLY header from a binary buffer.
#[wasm_bindgen]
pub fn decode_frame_prefix(buf: &[u8]) -> Option<FrameHeader> {
    if buf.len() < FRLY_HEADER_SIZE || &buf[0..4] != FRLY_MAGIC {
        return None;
    }
    Some(FrameHeader {
        sequence: u64::from_le_bytes(buf[4..12].try_into().ok()?),
        width: u32::from_le_bytes(buf[12..16].try_into().ok()?),
        height: u32::from_le_bytes(buf[16..20].try_into().ok()?),
        quality: buf[20],
        timestamp_ms: u64::from_le_bytes(buf[21..29].try_into().ok()?),
    })
}

/// Extract the JPEG payload bytes from a FRLY frame (skips 29-byte header).
#[wasm_bindgen]
pub fn extract_video_payload(buf: &[u8]) -> Vec<u8> {
    if buf.len() <= FRLY_HEADER_SIZE {
        return vec![];
    }
    buf[FRLY_HEADER_SIZE..].to_vec()
}
