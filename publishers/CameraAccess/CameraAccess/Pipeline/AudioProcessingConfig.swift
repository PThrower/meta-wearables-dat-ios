/*
 * AudioProcessingConfig.swift
 *
 * Immutable, Sendable configuration for audio processing in AudioRelayStage.
 * Configured by StreamSessionViewModel in response to JSON control messages
 * from viewers. Mutated atomically via actor isolation on AudioRelayStage.
 *
 * Processing pipeline order:
 *   raw PCM → noise gate → noise suppression → gain → FRAU encode
 */

import Foundation

struct AudioProcessingConfig: Sendable {
    /// Per-source gain in dB. Key is codecType (0=built-in mic, 1=glasses HFP).
    /// Range: -20.0 to +20.0 dB. Default: 0.0 (no gain change).
    var gainDb: [UInt8: Float] = [0: 0.0, 1: 0.0]

    /// Per-source noise gate threshold (RMS amplitude).
    /// Frames with RMS below this are zeroed and skipped.
    /// Range: 0.0 (off) to 1.0. Default: 0.0 (no gating).
    var noiseGateThreshold: [UInt8: Float] = [0: 0.0, 1: 0.0]

    /// Per-source noise suppression enable.
    /// Uses EMA noise floor estimation with spectral subtraction.
    var noiseSuppressionEnabled: [UInt8: Bool] = [0: false, 1: false]

    /// When true in "all" mode, mix both sources into one FRAU stream.
    var mixEnabled: Bool = false

    /// Mix weights per source. Default equal weighting.
    /// Only used when mixEnabled=true. Must sum to ~1.0.
    var mixWeights: [UInt8: Float] = [0: 0.5, 1: 0.5]

    /// Serialize to dictionary for JSON relay to viewers.
    func toDictionary() -> [String: Any] {
        return [
            "type": "audio_config",
            "gainDb": gainDb.mapKeys { String($0) },
            "noiseGate": noiseGateThreshold.mapKeys { String($0) },
            "noiseSuppression": noiseSuppressionEnabled.mapKeys { String($0) },
            "mixEnabled": mixEnabled,
            "mixWeights": mixWeights.mapKeys { String($0) },
        ]
    }
}

// MARK: - Dictionary key mapping helper

private extension Dictionary where Key == UInt8 {
    func mapKeys<T>(_ transform: (Key) -> T) -> [T: Value] {
        var result: [T: Value] = [:]
        for (k, v) in self {
            result[transform(k)] = v
        }
        return result
    }
}
