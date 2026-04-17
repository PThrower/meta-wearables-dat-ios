//! FRAU v1 audio frame codec + streaming resampler
//!
//! Wire layout (36 bytes):
//!   [0:4]   magic "FRAU" (0x46, 0x52, 0x41, 0x55)
//!   [4]     version    (u8) = 1
//!   [5:9]   payloadLength (u32 LE)
//!   [9]     codecType  (u8) -- 0=built-in mic, 1=glasses HFP, 2=TTS, 3=relay inbound
//!   [10:18] sequence   (u64 LE)
//!   [18:22] sampleRate (u32 LE)
//!   [22:24] channels   (u16 LE)
//!   [24:26] bitsPerSample (u16 LE)
//!   [26:34] timestamp  (u64 LE, ms)
//!   [34:36] header_crc16 (u16 LE) — CRC-16/CCITT-FALSE over bytes [0..33]
//!   [36:]   PCM payload (i16 LE interleaved)

use wasm_bindgen::prelude::*;

use crate::crc16_ccitt_false;

pub const FRAU_MAGIC: &[u8; 4] = b"FRAU";
pub const FRAU_VERSION: u8 = 1;
pub const FRAU_HEADER_SIZE: usize = 36;

// --- Codec type constants (match relay-protocol) ---

pub const CODEC_BUILTIN_MIC: u8 = 0;
pub const CODEC_GLASSES_HFP: u8 = 1;
pub const CODEC_TTS: u8 = 2;
pub const CODEC_RELAY_INBOUND: u8 = 3;

// --- Header ---

/// Audio frame metadata parsed from a FRAU v1 binary header.
#[wasm_bindgen]
#[derive(Clone, Debug)]
pub struct AudioHeader {
    pub version: u8,
    pub payload_length: u32,
    pub codec_type: u8,
    pub sequence: u64,
    pub sample_rate: u32,
    pub channels: u16,
    pub bits_per_sample: u16,
    pub timestamp_ms: u64,
}

// --- Detection ---

/// Check whether a buffer starts with the FRAU magic bytes.
#[wasm_bindgen]
pub fn is_audio_frame(buf: &[u8]) -> bool {
    buf.len() >= 4 && &buf[0..4] == FRAU_MAGIC
}

// --- Encode ---

/// Encode a complete FRAU v1 frame (36-byte header + PCM payload).
#[wasm_bindgen]
pub fn encode_audio_frame(
    codec_type: u8,
    sequence: u64,
    sample_rate: u32,
    channels: u16,
    bits_per_sample: u16,
    timestamp_ms: u64,
    pcm: &[u8],
) -> Vec<u8> {
    let mut buf = Vec::with_capacity(FRAU_HEADER_SIZE + pcm.len());
    buf.extend_from_slice(FRAU_MAGIC);
    buf.push(FRAU_VERSION);
    buf.extend_from_slice(&(pcm.len() as u32).to_le_bytes());
    buf.push(codec_type);
    buf.extend_from_slice(&sequence.to_le_bytes());
    buf.extend_from_slice(&sample_rate.to_le_bytes());
    buf.extend_from_slice(&channels.to_le_bytes());
    buf.extend_from_slice(&bits_per_sample.to_le_bytes());
    buf.extend_from_slice(&timestamp_ms.to_le_bytes());
    // CRC-16 over bytes [0..34]
    let crc = crc16_ccitt_false(&buf[0..34]);
    buf.extend_from_slice(&crc.to_le_bytes());
    buf.extend_from_slice(pcm);
    buf
}

// --- Decode ---

/// Decode a FRAU v1 header from a binary buffer.
///
/// Returns `None` if the buffer is too short, magic bytes don't match,
/// or the CRC-16 check fails.
#[wasm_bindgen]
pub fn decode_audio_header(buf: &[u8]) -> Option<AudioHeader> {
    if buf.len() < FRAU_HEADER_SIZE || &buf[0..4] != FRAU_MAGIC {
        return None;
    }
    // Verify CRC-16 over bytes [0..34]
    let expected_crc = u16::from_le_bytes(buf[34..36].try_into().ok()?);
    let computed_crc = crc16_ccitt_false(&buf[0..34]);
    if expected_crc != computed_crc {
        return None;
    }
    Some(AudioHeader {
        version: buf[4],
        payload_length: u32::from_le_bytes(buf[5..9].try_into().ok()?),
        codec_type: buf[9],
        sequence: u64::from_le_bytes(buf[10..18].try_into().ok()?),
        sample_rate: u32::from_le_bytes(buf[18..22].try_into().ok()?),
        channels: u16::from_le_bytes(buf[22..24].try_into().ok()?),
        bits_per_sample: u16::from_le_bytes(buf[24..26].try_into().ok()?),
        timestamp_ms: u64::from_le_bytes(buf[26..34].try_into().ok()?),
    })
}

/// Extract the PCM payload bytes from a FRAU v1 frame (skips 36-byte header).
#[wasm_bindgen]
pub fn extract_audio_payload(buf: &[u8]) -> Vec<u8> {
    if buf.len() <= FRAU_HEADER_SIZE {
        return vec![];
    }
    buf[FRAU_HEADER_SIZE..].to_vec()
}

/// Verify the CRC-16 of a FRAU v1 frame header.
///
/// Returns `true` if the header CRC-16 matches the computed value.
#[wasm_bindgen]
pub fn verify_audio_crc(buf: &[u8]) -> bool {
    if buf.len() < FRAU_HEADER_SIZE || &buf[0..4] != FRAU_MAGIC {
        return false;
    }
    let crc_bytes: [u8; 2] = match buf[34..36].try_into() {
        Ok(v) => v,
        Err(_) => return false,
    };
    let expected_crc = u16::from_le_bytes(crc_bytes);
    crc16_ccitt_false(&buf[0..34]) == expected_crc
}

// --- Streaming Audio Resampler ---

/// Streaming audio resampler with linear interpolation.
///
/// Maintains phase continuity across chunks for glitch-free streaming.
/// Input/output are raw PCM bytes (i16 LE interleaved).
///
/// Common use cases in this system:
/// - 8kHz  -> 16kHz (glasses HFP mic upsample)
/// - 16kHz -> 48kHz (mic to AudioContext)
/// - 48kHz -> 16kHz (browser mic capture downsample)
#[wasm_bindgen]
pub struct AudioResampler {
    ratio: f64,          // input_rate / output_rate (input samples per output sample)
    cursor: f64,         // cumulative fractional position in the input stream
    frames_seen: u64,    // total input frames processed (for global coordinate calculation)
    channels: usize,
    last_frame: Vec<f64>, // last input frame values, one per channel (for cross-chunk interpolation)
}

#[wasm_bindgen]
impl AudioResampler {
    /// Create a new resampler.
    /// `channels` is typically 1 (mono) for this system.
    #[wasm_bindgen(constructor)]
    pub fn new(from_rate: u32, to_rate: u32, channels: u16) -> Self {
        let ch = channels.max(1) as usize;
        Self {
            ratio: from_rate as f64 / to_rate as f64,
            cursor: 0.0,
            frames_seen: 0,
            channels: ch,
            last_frame: vec![0.0; ch],
        }
    }

    /// Process a chunk of interleaved PCM i16 LE bytes.
    /// Returns resampled PCM i16 LE bytes.
    pub fn process(&mut self, pcm_bytes: &[u8]) -> Vec<u8> {
        let input = bytes_to_i16(pcm_bytes);
        let ch = self.channels;
        let frames_in = input.len() / ch;
        if frames_in == 0 {
            return vec![];
        }

        let global_start = self.frames_seen as f64;
        let p0 = self.cursor - global_start; // local fractional position in this chunk

        // Calculate upper bound on output frames
        // We can produce output as long as: p < frames_in - 1 (need frame at p+1 for interpolation)
        let max_output = if p0 >= frames_in as f64 - 1.0 {
            0
        } else {
            ((frames_in as f64 - 1.0 - p0) / self.ratio).ceil() as usize + 1
        };

        let mut out_samples: Vec<i16> = Vec::with_capacity(max_output * ch);
        let mut n_output = 0usize;

        for i in 0..max_output {
            let p = p0 + i as f64 * self.ratio;
            if p >= frames_in as f64 - 1.0 {
                break;
            }
            let a = p.floor() as isize; // frame index before (can be -1 for cross-chunk)
            let b = (a + 1) as usize;   // frame index after (always >= 0, < frames_in)
            let frac = p - a as f64;     // 0.0..1.0

            for c in 0..ch {
                let s0 = if a < 0 {
                    self.last_frame[c]
                } else {
                    input[a as usize * ch + c] as f64
                };
                let s1 = input[b * ch + c] as f64;
                out_samples.push(clamp_i16(s0 + (s1 - s0) * frac));
            }
            n_output += 1;
        }

        // Advance cursor by the number of output frames produced
        self.cursor += n_output as f64 * self.ratio;

        // Save last input frame for cross-chunk interpolation
        for c in 0..ch {
            self.last_frame[c] = input[(frames_in - 1) * ch + c] as f64;
        }
        self.frames_seen += frames_in as u64;

        i16_to_bytes(&out_samples)
    }

    /// Reset resampler state (e.g., on stream reconnect).
    pub fn reset(&mut self) {
        self.cursor = 0.0;
        self.frames_seen = 0;
        for v in &mut self.last_frame {
            *v = 0.0;
        }
    }

    /// Get the input-to-output sample rate ratio.
    pub fn ratio(&self) -> f64 {
        self.ratio
    }
}

// --- Internal helpers ---

fn bytes_to_i16(bytes: &[u8]) -> Vec<i16> {
    bytes
        .chunks_exact(2)
        .map(|chunk| i16::from_le_bytes([chunk[0], chunk[1]]))
        .collect()
}

fn i16_to_bytes(samples: &[i16]) -> Vec<u8> {
    samples.iter().flat_map(|s| s.to_le_bytes()).collect()
}

fn clamp_i16(v: f64) -> i16 {
    if v >= 32767.0 {
        32767
    } else if v <= -32768.0 {
        -32768
    } else {
        v as i16
    }
}
