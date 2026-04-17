//! FRLY v1 video frame codec
//!
//! Wire layout (36 bytes):
//!   [0:4]   magic "FRLY" (0x46, 0x52, 0x4C, 0x59)
//!   [4]     version    (u8) = 1
//!   [5:9]   payloadLength (u32 LE)
//!   [9:17]  sequence   (u64 LE)
//!   [17:21] width      (u32 LE)
//!   [21:25] height     (u32 LE)
//!   [25]    quality    (u8)
//!   [26:34] timestamp  (u64 LE, ms)
//!   [34:36] header_crc16 (u16 LE) — CRC-16/CCITT-FALSE over bytes [0..33]
//!   [36:]   JPEG payload

use wasm_bindgen::prelude::*;

use crate::crc16_ccitt_false;

pub const FRLY_MAGIC: &[u8; 4] = b"FRLY";
pub const FRLY_VERSION: u8 = 1;
pub const FRLY_HEADER_SIZE: usize = 36;

/// Video frame metadata parsed from a FRLY v1 binary prefix.
#[wasm_bindgen]
#[derive(Clone, Debug)]
pub struct FrameHeader {
    pub version: u8,
    pub payload_length: u32,
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

/// Encode a 36-byte FRLY v1 header prefix (no JPEG payload).
#[wasm_bindgen]
pub fn encode_frame_prefix(header: &FrameHeader) -> Vec<u8> {
    let mut buf = Vec::with_capacity(FRLY_HEADER_SIZE);
    buf.extend_from_slice(FRLY_MAGIC);
    buf.push(FRLY_VERSION);
    buf.extend_from_slice(&header.payload_length.to_le_bytes());
    buf.extend_from_slice(&header.sequence.to_le_bytes());
    buf.extend_from_slice(&header.width.to_le_bytes());
    buf.extend_from_slice(&header.height.to_le_bytes());
    buf.push(header.quality);
    buf.extend_from_slice(&header.timestamp_ms.to_le_bytes());
    // CRC-16 over bytes [0..34] (the 34 bytes written so far)
    let crc = crc16_ccitt_false(&buf[0..34]);
    buf.extend_from_slice(&crc.to_le_bytes());
    buf
}

/// Encode a complete FRLY v1 frame (header + JPEG payload).
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
    buf.push(FRLY_VERSION);
    buf.extend_from_slice(&(jpeg.len() as u32).to_le_bytes());
    buf.extend_from_slice(&sequence.to_le_bytes());
    buf.extend_from_slice(&width.to_le_bytes());
    buf.extend_from_slice(&height.to_le_bytes());
    buf.push(quality);
    buf.extend_from_slice(&timestamp_ms.to_le_bytes());
    // CRC-16 over bytes [0..34]
    let crc = crc16_ccitt_false(&buf[0..34]);
    buf.extend_from_slice(&crc.to_le_bytes());
    buf.extend_from_slice(jpeg);
    buf
}

/// Decode a FRLY v1 header from a binary buffer.
///
/// Returns `None` if the buffer is too short, magic bytes don't match,
/// or the CRC-16 check fails.
#[wasm_bindgen]
pub fn decode_frame_prefix(buf: &[u8]) -> Option<FrameHeader> {
    if buf.len() < FRLY_HEADER_SIZE || &buf[0..4] != FRLY_MAGIC {
        return None;
    }
    // Verify CRC-16 over bytes [0..34]
    let expected_crc = u16::from_le_bytes(buf[34..36].try_into().ok()?);
    let computed_crc = crc16_ccitt_false(&buf[0..34]);
    if expected_crc != computed_crc {
        return None;
    }
    let version = buf[4];
    Some(FrameHeader {
        version,
        payload_length: u32::from_le_bytes(buf[5..9].try_into().ok()?),
        sequence: u64::from_le_bytes(buf[9..17].try_into().ok()?),
        width: u32::from_le_bytes(buf[17..21].try_into().ok()?),
        height: u32::from_le_bytes(buf[21..25].try_into().ok()?),
        quality: buf[25],
        timestamp_ms: u64::from_le_bytes(buf[26..34].try_into().ok()?),
    })
}

/// Extract the JPEG payload bytes from a FRLY v1 frame (skips 36-byte header).
#[wasm_bindgen]
pub fn extract_video_payload(buf: &[u8]) -> Vec<u8> {
    if buf.len() <= FRLY_HEADER_SIZE {
        return vec![];
    }
    buf[FRLY_HEADER_SIZE..].to_vec()
}

/// Verify the CRC-16 of a FRLY v1 frame header.
///
/// Returns `true` if the header CRC-16 matches the computed value.
#[wasm_bindgen]
pub fn verify_video_crc(buf: &[u8]) -> bool {
    if buf.len() < FRLY_HEADER_SIZE || &buf[0..4] != FRLY_MAGIC {
        return false;
    }
    let crc_bytes: [u8; 2] = match buf[34..36].try_into() {
        Ok(v) => v,
        Err(_) => return false,
    };
    let expected_crc = u16::from_le_bytes(crc_bytes);
    crc16_ccitt_false(&buf[0..34]) == expected_crc
}
