/*
 * PCMConvert.swift
 *
 * Shared PCM audio conversion utilities.
 * Converts Float32 audio samples to signed 16-bit little-endian PCM data.
 *
 * Used by AudioStage (mic capture) and AudioPlaybackStage (TTS generation).
 */

import Foundation

enum PCMConvert {
    /// Convert Float32 audio samples to signed 16-bit PCM (little-endian).
    /// Clamps input to [-1.0, 1.0] and scales to Int16 range.
    static func floatToPCM16(_ floatData: UnsafePointer<Float>, frameCount: Int) -> Data {
        var pcmData = Data(count: frameCount * 2)
        pcmData.withUnsafeMutableBytes { rawDest in
            guard let dest = rawDest.baseAddress?.assumingMemoryBound(to: Int16.self) else { return }
            for i in 0..<frameCount {
                let clamped = max(-1.0, min(1.0, floatData[i]))
                dest[i] = Int16(clamped * 32767.0)
            }
        }
        return pcmData
    }
}
