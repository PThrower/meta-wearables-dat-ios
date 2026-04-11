/*
 * RemoteAudioFrame.swift
 *
 * Codable representation of the JSON audio frame sent by the relay server's
 * /tap/audio WebSocket endpoint.
 *
 * JSON contract from server:
 *   { type, codecType, sequence, sampleRate, channels, bitsPerSample, timestampMs, pcmBase64 }
 *
 * Converted to AudioPacket for consumption by the local AudioEventBus,
 * keeping the iOS pipeline architecture consistent.
 */

import Foundation

struct RemoteAudioFrame: Codable, Sendable {
    let type: String
    let codecType: UInt8
    let sequence: UInt64
    let sampleRate: UInt32
    let channels: UInt16
    let bitsPerSample: UInt16
    let timestampMs: UInt64
    let pcmBase64: String

    /// Convert to AudioPacket for local pipeline consumption.
    /// Returns nil if pcmBase64 is empty or decoding fails.
    func toAudioPacket() -> AudioPacket? {
        guard !pcmBase64.isEmpty,
              let pcmData = Data(base64Encoded: pcmBase64),
              pcmData.count > 0 else {
            return nil
        }

        return AudioPacket(
            pcmData: pcmData,
            codecType: codecType,
            sampleRate: sampleRate,
            channels: channels,
            bitsPerSample: bitsPerSample,
            sequenceNumber: sequence,
            timestampMs: timestampMs
        )
    }
}
