//! frame-relay-wasm
//!
//! Performance-critical frame relay logic compiled to WASM.
//! Provides binary frame parsing, audio resampling, throttle management, and frame classification.
//! I/O is handled by the host (Bun WebSocket server / browser viewer).
//!
//! Modules:
//! - `video`    — FRLY v1 video frame encode/decode
//! - `audio`    — FRAU v1 audio frame encode/decode + streaming resampler
//! - `mux`      — Frame classification by magic bytes
//! - `throttle` — FPS throttle with quality presets

pub mod audio;
pub mod mux;
pub mod throttle;
pub mod video;

pub use audio::*;
pub use mux::*;
pub use throttle::*;
pub use video::*;

/// CRC-16/CCITT-FALSE over the given bytes.
///
/// Parameters: polynomial 0x1021, init 0xFFFF, no reflect, no final XOR.
/// Used for header integrity in both FRLY v1 and FRAU v1 frames.
pub fn crc16_ccitt_false(data: &[u8]) -> u16 {
    let mut crc: u16 = 0xFFFF;
    for &byte in data {
        crc ^= (byte as u16) << 8;
        for _ in 0..8 {
            if crc & 0x8000 != 0 {
                crc = (crc << 1) ^ 0x1021;
            } else {
                crc <<= 1;
            }
        }
    }
    crc
}
