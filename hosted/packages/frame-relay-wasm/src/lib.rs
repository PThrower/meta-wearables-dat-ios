//! frame-relay-wasm
//!
//! Performance-critical frame relay logic compiled to WASM.
//! Provides binary frame parsing, audio resampling, throttle management, and frame classification.
//! I/O is handled by the host (Bun WebSocket server / browser viewer).
//!
//! Modules:
//! - `video`    — FRLY video frame encode/decode
//! - `audio`    — FRAU audio frame encode/decode + streaming resampler
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
