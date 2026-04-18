/*
 * PCMAudioProcessing.swift
 *
 * Pure, stateless functions for processing 16-bit LE mono PCM audio data.
 * Extracted from AudioRelayStage for composability and testability.
 *
 * Pipeline order:
 *   raw PCM → noise gate (RMS threshold) → noise suppression (EMA) → gain (dB)
 *
 * All functions operate on Data containing Int16 samples and return new Data.
 */

import Foundation

enum PCMAudioProcessing {
    // MARK: - Analysis

    /// Compute RMS amplitude of Int16 PCM data, normalized to 0.0..1.0.
    static func computeRMS(_ pcmData: Data) -> Float {
        guard pcmData.count >= 2 else { return 0.0 }
        let sampleCount = pcmData.count / 2
        var sumSquares: Float = 0.0
        pcmData.withUnsafeBytes { rawBuf in
            guard let samples = rawBuf.baseAddress?.assumingMemoryBound(to: Int16.self) else { return }
            for i in 0..<sampleCount {
                let normalized = Float(samples[i]) / 32768.0
                sumSquares += normalized * normalized
            }
        }
        return sqrt(sumSquares / Float(sampleCount))
    }

    // MARK: - Gain

    /// Apply gain in dB to Int16 PCM data. Returns new Data.
    static func applyGain(_ pcmData: Data, gainDb: Float) -> Data {
        let gainFactor = pow(10.0, gainDb / 20.0)
        var result = Data(count: pcmData.count)
        pcmData.withUnsafeBytes { rawSrc in
            guard let src = rawSrc.baseAddress?.assumingMemoryBound(to: Int16.self) else { return }
            result.withUnsafeMutableBytes { rawDst in
                guard let dst = rawDst.baseAddress?.assumingMemoryBound(to: Int16.self) else { return }
                let sampleCount = pcmData.count / 2
                for i in 0..<sampleCount {
                    let scaled = Float(src[i]) * gainFactor
                    dst[i] = Int16(clamp(scaled, -32768.0, 32767.0))
                }
            }
        }
        return result
    }

    // MARK: - Noise Suppression

    /// Simple noise suppression via EMA noise floor estimation and spectral subtraction.
    /// Returns processed data and updates noise floor estimate via inout.
    static func applyNoiseSuppression(_ pcmData: Data,
                                       currentFloor: Float,
                                       alpha: Float,
                                       updatedFloor: inout Float) -> Data {
        // Update noise floor estimate using minimum-statistics approach
        let rms = computeRMS(pcmData)
        if rms < currentFloor {
            updatedFloor = rms  // Floor tracks minimum
        } else {
            updatedFloor = alpha * currentFloor + (1.0 - alpha) * rms
        }

        let floor = updatedFloor
        guard floor > 0.001 else { return pcmData }  // No suppression needed

        let floorAmp = floor * 32768.0  // Convert normalized threshold to Int16 scale
        var result = Data(count: pcmData.count)
        pcmData.withUnsafeBytes { rawSrc in
            guard let src = rawSrc.baseAddress?.assumingMemoryBound(to: Int16.self) else { return }
            result.withUnsafeMutableBytes { rawDst in
                guard let dst = rawDst.baseAddress?.assumingMemoryBound(to: Int16.self) else { return }
                let sampleCount = pcmData.count / 2
                for i in 0..<sampleCount {
                    let sample = Float(src[i])
                    // Spectral subtraction: reduce amplitude by noise floor
                    let sign: Float = sample >= 0 ? 1.0 : -1.0
                    let magnitude = abs(sample)
                    let cleaned = max(0.0, magnitude - floorAmp)
                    dst[i] = Int16(clamp(sign * cleaned, -32768.0, 32767.0))
                }
            }
        }
        return result
    }

    // MARK: - Helpers

    @inline(__always)
    private static func clamp(_ value: Float, _ min: Float, _ max: Float) -> Float {
        if value < min { return min }
        if value > max { return max }
        return value
    }
}
