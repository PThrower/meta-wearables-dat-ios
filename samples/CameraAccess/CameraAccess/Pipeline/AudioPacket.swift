/*
 * AudioPacket.swift
 *
 * Immutable, Sendable audio data packet that crosses isolation boundaries.
 * Carries raw PCM data with metadata (sample rate, channels, codec type).
 *
 * Created by AudioStage on the actor executor, then published to AudioEventBus
 * where any subscriber (AudioRelayStage, future AudioRecordingStage, etc.)
 * can consume it without knowing the source.
 *
 * Wire protocol encoding (FRAU, etc.) is the subscriber's responsibility —
 * AudioPacket is transport-agnostic.
 */

import Foundation

struct AudioPacket: Sendable {
    /// Raw PCM audio data (16-bit LE mono)
    let pcmData: Data

    /// FRAU codec type: 0 = mic PCM 16-bit LE
    let codecType: UInt8

    /// Actual hardware sample rate (varies: 48000 built-in, 8000 HFP, etc.)
    let sampleRate: UInt32

    /// Number of audio channels (always 1 = mono)
    let channels: UInt16

    /// Bits per sample (always 16)
    let bitsPerSample: UInt16

    /// Monotonically increasing sequence number (assigned by AudioStage)
    let sequenceNumber: UInt64

    /// Wall-clock timestamp in milliseconds since Unix epoch
    let timestampMs: UInt64
}
