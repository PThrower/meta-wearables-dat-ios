//! frame-relay-wasm
//!
//! Frame relay logic compiled to WASM.
//! Provides frame routing, buffering, and protocol management.
//! The actual I/O is handled by the host (Bun WebSocket server).

use wasm_bindgen::prelude::*;

/// Frame metadata passed alongside each frame buffer.
#[wasm_bindgen]
#[derive(Clone, Debug)]
pub struct FrameHeader {
    /// Monotonically increasing sequence number.
    pub sequence: u64,
    /// Frame width in pixels.
    pub width: u32,
    /// Frame height in pixels.
    pub height: u32,
    /// JPEG quality (0-100).
    pub quality: u8,
    /// Unix timestamp in milliseconds.
    pub timestamp_ms: u64,
}

/// Core relay state: tracks frame routing statistics and throttling.
#[wasm_bindgen]
#[derive(Clone, Debug)]
pub struct FrameRelay {
    pub frames_received: u64,
    pub frames_relayed: u64,
    pub frames_dropped: u64,
    pub last_relayed_sequence: u64,
    max_fps: u32,
    min_interval_ms: u64,
    last_frame_time_ms: u64,
}

#[wasm_bindgen]
impl FrameRelay {
    /// Create a new relay with a maximum FPS throttle.
    #[wasm_bindgen(constructor)]
    pub fn new(max_fps: u32) -> Self {
        let min_interval_ms = if max_fps > 0 { 1000 / max_fps as u64 } else { 0 };
        Self {
            frames_received: 0,
            frames_relayed: 0,
            frames_dropped: 0,
            last_relayed_sequence: 0,
            max_fps,
            min_interval_ms,
            last_frame_time_ms: 0,
        }
    }

    /// Decide whether a frame should be relayed or dropped.
    /// Returns true if the frame passes the throttle gate.
    pub fn should_relay(&mut self, now_ms: u64) -> bool {
        self.frames_received += 1;
        if self.min_interval_ms > 0 && now_ms - self.last_frame_time_ms < self.min_interval_ms {
            self.frames_dropped += 1;
            return false;
        }
        self.last_frame_time_ms = now_ms;
        self.frames_relayed += 1;
        true
    }

    /// Reset all counters.
    pub fn reset(&mut self) {
        self.frames_received = 0;
        self.frames_relayed = 0;
        self.frames_dropped = 0;
        self.last_relayed_sequence = 0;
        self.last_frame_time_ms = 0;
    }

    /// Get the effective relay FPS based on relayed frames.
    pub fn effective_fps(&self, elapsed_ms: u64) -> f64 {
        if elapsed_ms == 0 || self.frames_relayed == 0 {
            return 0.0;
        }
        (self.frames_relayed as f64 / elapsed_ms as f64) * 1000.0
    }
}

// --- Wire protocol helpers ---

/// Magic bytes for the frame relay protocol.
const MAGIC: &[u8; 4] = b"FRLY";

/// Encode a frame header into a binary prefix buffer.
/// Format: [4 bytes "FRLY"][8 bytes sequence][4 bytes width][4 bytes height]
///         [1 byte quality][8 bytes timestamp_ms]
/// Total: 29 bytes prefix, followed by JPEG payload.
#[wasm_bindgen]
pub fn encode_frame_prefix(header: &FrameHeader) -> Vec<u8> {
    let mut buf = Vec::with_capacity(29);
    buf.extend_from_slice(MAGIC);
    buf.extend_from_slice(&header.sequence.to_le_bytes());
    buf.extend_from_slice(&header.width.to_le_bytes());
    buf.extend_from_slice(&header.height.to_le_bytes());
    buf.push(header.quality);
    buf.extend_from_slice(&header.timestamp_ms.to_le_bytes());
    buf
}

/// Decode a frame header from a binary buffer prefix.
/// Returns JsValue (null on failure, FrameHeader on success).
#[wasm_bindgen]
pub fn decode_frame_prefix(buf: &[u8]) -> Option<FrameHeader> {
    if buf.len() < 29 {
        return None;
    }
    if &buf[0..4] != MAGIC {
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
