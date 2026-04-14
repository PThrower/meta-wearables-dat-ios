//! FPS throttle with quality presets
//!
//! Provides frame rate limiting for relay fanout.
//! The server instantiates one `FrameRelay` per session.

use wasm_bindgen::prelude::*;

/// Quality presets matching relay-protocol's QUALITY_PRESETS.
pub const PRESET_HIGH_MAX_FPS: u32 = 30;
pub const PRESET_MEDIUM_MAX_FPS: u32 = 15;
pub const PRESET_LOW_MAX_FPS: u32 = 8;
pub const PRESET_MINI_MAX_FPS: u32 = 4;

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

    /// Create a relay from a quality preset name.
    /// Returns `null` if the preset is not recognized.
    #[wasm_bindgen]
    pub fn from_preset(preset: &str) -> Option<FrameRelay> {
        let fps = match preset {
            "high" => PRESET_HIGH_MAX_FPS,
            "medium" => PRESET_MEDIUM_MAX_FPS,
            "low" => PRESET_LOW_MAX_FPS,
            "mini" => PRESET_MINI_MAX_FPS,
            _ => return None,
        };
        Some(Self::new(fps))
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

    /// Update the max FPS at runtime (e.g., when viewer changes quality preset).
    pub fn set_max_fps(&mut self, fps: u32) {
        self.max_fps = fps;
        self.min_interval_ms = if fps > 0 { 1000 / fps as u64 } else { 0 };
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

    /// Get the configured max FPS.
    pub fn max_fps(&self) -> u32 {
        self.max_fps
    }

    /// Get the minimum interval in milliseconds between relayed frames.
    pub fn min_interval_ms(&self) -> u64 {
        self.min_interval_ms
    }
}
