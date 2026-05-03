/*
 * SpeechTypes.swift
 *
 * Shared types for on-device speech stages (STT transcription, VAD).
 * Independent of the frame pipeline -- speech stages have their own lifecycle
 * and relay results via `stt_result` / `vad_result` JSON messages through RelayStage.
 */

import Foundation

// MARK: - Speech Stage Type

/// Discriminated union for speech stage types.
enum SpeechStageType: String, Sendable, Codable, CaseIterable {
    case stt = "mobile-stt"
    case vad = "vad"
}

// MARK: - STT Transcription Result

struct TranscriptionResult: Sendable {
    let isFinal: Bool
    let text: String
    let confidence: Double
    let alternatives: [TranscriptionAlternative]
    let wordTimestamps: [WordTimestamp]
    let language: String
    let error: String?
}

struct TranscriptionAlternative: Sendable {
    let text: String
    let confidence: Double
}

struct WordTimestamp: Sendable {
    let word: String
    let startTimeMs: Double
    let endTimeMs: Double
    let confidence: Double
}

// MARK: - VAD Result

struct VADResult: Sendable {
    let eventType: String   // "speech_start" | "speech_end" | "speech_active"
    let isSpeech: Bool
    let confidence: Double
    let energyDb: Double
    let durationMs: Double
    let error: String?
}

// MARK: - SpeechStageConfig

/// Configuration for speech stages, parsed from server `speech_stage_config` WS message.
struct SpeechStageConfig: Sendable {
    let stages: [SpeechStageEntry]

    struct SpeechStageEntry: Sendable {
        let type: SpeechStageType
        let config: [String: Any]
    }

    static func fromServerConfig(_ msg: [String: Any]) -> SpeechStageConfig {
        var stages: [SpeechStageEntry] = []
        if let stageArray = msg["stages"] as? [[String: Any]] {
            for stageMsg in stageArray {
                guard let typeStr = stageMsg["speechType"] as? String,
                      let stageType = SpeechStageType(rawValue: typeStr) else { continue }
                let config = stageMsg["config"] as? [String: Any] ?? [:]
                stages.append(SpeechStageEntry(type: stageType, config: config))
            }
        }
        return SpeechStageConfig(stages: stages)
    }
}

// MARK: - JSON Serialization

extension TranscriptionResult {
    var jsonDict: [String: Any] {
        var dict: [String: Any] = [
            "type": "stt_result",
            "isFinal": isFinal,
            "text": text,
            "confidence": confidence,
            "language": language,
        ]
        if let error {
            dict["error"] = error
        }
        if !alternatives.isEmpty {
            dict["alternatives"] = alternatives.map { [
                "text": $0.text,
                "confidence": $0.confidence,
            ] }
        }
        if !wordTimestamps.isEmpty {
            dict["words"] = wordTimestamps.map { [
                "word": $0.word,
                "startTimeMs": $0.startTimeMs,
                "endTimeMs": $0.endTimeMs,
                "confidence": $0.confidence,
            ] }
        }
        return dict
    }
}

extension VADResult {
    var jsonDict: [String: Any] {
        var dict: [String: Any] = [
            "type": "vad_result",
            "eventType": eventType,
            "isSpeech": isSpeech,
            "confidence": confidence,
            "energyDb": energyDb,
            "durationMs": durationMs,
        ]
        if let error {
            dict["error"] = error
        }
        return dict
    }
}
