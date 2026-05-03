/*
 * EnhanceTypes.swift
 *
 * Types for on-device frame enhancement via CoreImage CIFilter chain.
 * Configured from workflow nodes (enhance-brightness, enhance-sharpen, etc.)
 * and applied as a pre-broadcast transform in FramePipelineManager.
 */

import CoreMedia
import CoreVideo
import Foundation

// MARK: - Filter Types

/// Supported CIFilter-based enhancement types.
/// Each maps to one or more CIFilter instances with configurable parameters.
enum EnhanceFilterType: String, Sendable, CaseIterable {
    case brightness    = "enhance-brightness"
    case sharpen       = "enhance-sharpen"
    case whiteBalance  = "enhance-white-balance"
    case noiseReduce   = "enhance-noise-reduce"
    case edgeDetect    = "enhance-edge-detect"
    case nightMode     = "enhance-night-mode"
}

// MARK: - Filter Config

/// Configuration for a single CIFilter in the enhancement chain.
struct EnhanceFilterConfig: Sendable, Identifiable {
    let id: UUID
    let type: EnhanceFilterType
    var params: [String: Double]

    init(type: EnhanceFilterType, params: [String: Double] = [:]) {
        self.id = UUID()
        self.type = type
        self.params = params
    }

    /// Default parameters per filter type.
    static func defaultParams(for type: EnhanceFilterType) -> [String: Double] {
        switch type {
        case .brightness:
            return ["brightness": 0.1, "contrast": 1.0, "saturation": 1.0]
        case .sharpen:
            return ["sharpness": 0.4]
        case .whiteBalance:
            return ["warmth": 5500, "tint": 0]
        case .noiseReduce:
            return ["noiseLevel": 0.02, "sharpness": 0.4]
        case .edgeDetect:
            return ["intensity": 1.0]
        case .nightMode:
            return ["brightness": 0.15, "gamma": 0.8, "highlightAmount": 1.5]
        }
    }
}

// MARK: - Stage Config

/// Full enhancement chain configuration, sent from server as enhance_stage_config.
struct EnhanceStageConfig: Sendable {
    var filters: [EnhanceFilterConfig]
    var isEnabled: Bool

    static let empty = EnhanceStageConfig(filters: [], isEnabled: false)

    static func fromServerConfig(_ config: [String: Any]) -> EnhanceStageConfig {
        guard let filterList = config["filters"] as? [[String: Any]] else {
            return .empty
        }

        var filters: [EnhanceFilterConfig] = []
        for entry in filterList {
            guard let typeStr = entry["type"] as? String,
                  let type = EnhanceFilterType(rawValue: typeStr) else { continue }
            var params = EnhanceFilterConfig.defaultParams(for: type)
            if let overrides = entry["params"] as? [String: Double] {
                params.merge(overrides) { _, new in new }
            }
            filters.append(EnhanceFilterConfig(type: type, params: params))
        }

        return EnhanceStageConfig(
            filters: filters,
            isEnabled: config["enabled"] as? Bool ?? true
        )
    }
}
