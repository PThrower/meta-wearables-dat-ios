// ToolTypes.swift
// Shared types for tool identification and measurement pipeline nodes.
// Covers fastener classification, homography measurement, and tool suggestion.

import Foundation
import CoreGraphics

// MARK: - Fastener Classification

/// Known fastener head types identifiable by camera.
enum FastenerType: String, Sendable, Codable, CaseIterable {
    case hexSocket = "hex_socket"
    case hexHead = "hex_head"
    case phillips = "phillips"
    case flathead = "flathead"
    case torx = "torx"
    case robertson = "robertson"
    case nut = "nut"
    case bolt = "bolt"
    case unknown = "unknown"

    var displayName: String {
        switch self {
        case .hexSocket: return "Hex Socket (Allen)"
        case .hexHead: return "Hex Head"
        case .phillips: return "Phillips"
        case .flathead: return "Flathead / Slotted"
        case .torx: return "Torx"
        case .robertson: return "Robertson / Square"
        case .nut: return "Nut"
        case .bolt: return "Bolt (Threaded)"
        case .unknown: return "Unknown"
        }
    }

    /// The tool category used to drive this fastener.
    var toolCategory: ToolCategory {
        switch self {
        case .hexSocket: return .hexKey
        case .hexHead: return .wrench
        case .phillips: return .phillipsScrewdriver
        case .flathead: return .flatScrewdriver
        case .torx: return .torxBit
        case .robertson: return .robertsonBit
        case .nut: return .wrench
        case .bolt: return .wrench
        case .unknown: return .unknown
        }
    }
}

/// Tool categories for suggestion matching.
enum ToolCategory: String, Sendable, Codable {
    case hexKey = "hex_key"
    case wrench = "wrench"
    case phillipsScrewdriver = "phillips"
    case flatScrewdriver = "flathead"
    case torxBit = "torx"
    case robertsonBit = "robertson"
    case unknown = "unknown"
}

// MARK: - Standard Tool Size Tables

/// Standard tool size lookup tables.
/// Ref: ISO 2936, ISO 8764, ISO 10664, ISO 261
enum ToolSizeTables {
    /// Hex key (Allen) sizes in millimeters.
    static let hexKeySizesMM: [Double] = [
        0.7, 0.9, 1.3, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0, 6.0,
        7.0, 8.0, 10.0, 12.0, 14.0, 17.0, 19.0, 22.0, 24.0,
    ]

    /// Hex key sizes in inches (SAE).
    static let hexKeySizesIN: [(label: String, mm: Double)] = [
        ("1/16", 1.588), ("5/64", 1.984), ("3/32", 2.381),
        ("7/64", 2.778), ("1/8", 3.175), ("9/64", 3.572),
        ("5/32", 3.969), ("3/16", 4.763), ("7/32", 5.556),
        ("1/4", 6.350), ("5/16", 7.938), ("3/8", 9.525),
    ]

    /// Phillips screwdriver sizes by head diameter.
    /// Ref: ISO 8764, Phillips Screw Company
    static let phillipsSizes: [(size: String, headDiameter: Double)] = [
        ("PH000", 2.5), ("PH00", 3.5), ("PH0", 4.5),
        ("PH1", 5.5), ("PH2", 7.0), ("PH3", 9.5), ("PH4", 13.0),
    ]

    /// Torx bit sizes by outer diameter.
    /// Ref: ISO 10664
    static let torxSizes: [(size: String, outerDiameter: Double)] = [
        ("T1", 1.81), ("T2", 2.44), ("T3", 2.82), ("T4", 3.18),
        ("T5", 3.63), ("T6", 4.06), ("T7", 4.49), ("T8", 4.92),
        ("T9", 5.33), ("T10", 4.82), ("T15", 5.56), ("T20", 6.48),
        ("T25", 7.18), ("T27", 7.94), ("T30", 8.62), ("T40", 10.02),
        ("T45", 11.43), ("T50", 12.83), ("T55", 14.73),
    ]

    /// Robertson (square) bit sizes.
    static let robertsonSizes: [(size: String, width: Double)] = [
        ("#00 (Orange)", 1.77), ("#0 (Yellow)", 2.31),
        ("#1 (Green)", 2.87), ("#2 (Red)", 3.41),
        ("#3 (Black)", 4.47), ("#4 (Brown)", 5.61),
    ]

    /// Common wrench sizes (metric).
    static let wrenchSizesMM: [Double] = [
        4, 4.5, 5, 5.5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
        16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28,
        29, 30, 32, 34, 36, 38, 41, 46, 50, 55,
    ]

    /// Common bolt thread diameters (metric).
    /// Ref: ISO 261, ISO 262
    static let boltDiametersMM: [(size: String, diameter: Double)] = [
        ("M2", 2.0), ("M2.5", 2.5), ("M3", 3.0), ("M3.5", 3.5),
        ("M4", 4.0), ("M5", 5.0), ("M6", 6.0), ("M7", 7.0),
        ("M8", 8.0), ("M10", 10.0), ("M12", 12.0), ("M14", 14.0),
        ("M16", 16.0), ("M18", 18.0), ("M20", 20.0), ("M22", 22.0),
        ("M24", 24.0), ("M27", 27.0), ("M30", 30.0),
    ]
}

// MARK: - Reference Objects

/// Known-size reference objects for homography calibration.
enum ReferenceObject: String, Sendable, Codable, CaseIterable {
    case creditCard = "credit_card"
    case usQuarter = "us_quarter"
    case usPenny = "us_penny"
    case usNickel = "us_nickel"
    case usDime = "us_dime"
    case auto = "auto"

    /// Known width x height in mm (rectangular objects).
    var dimensionsMm: (width: Double, height: Double)? {
        switch self {
        case .creditCard: return (85.60, 53.98) // ISO/IEC 7810 ID-1
        default: return nil
        }
    }

    /// Known diameter in mm (circular objects).
    var diameterMm: Double? {
        switch self {
        case .usQuarter: return 24.26
        case .usPenny: return 19.05
        case .usNickel: return 21.21
        case .usDime: return 17.91
        default: return nil
        }
    }

    var displayName: String {
        switch self {
        case .creditCard: return "Credit Card"
        case .usQuarter: return "US Quarter"
        case .usPenny: return "US Penny"
        case .usNickel: return "US Nickel"
        case .usDime: return "US Dime"
        case .auto: return "Auto-detect"
        }
    }

    var isCircular: Bool { diameterMm != nil }
    var isRectangular: Bool { dimensionsMm != nil }
}

// MARK: - Tool Suggestion

/// A suggested tool based on measured dimensions.
struct ToolSuggestion: Sendable, Codable {
    let toolCategory: ToolCategory
    let sizeLabel: String       // e.g. "8mm", "PH2", "T25"
    let metricValue: Double     // mm for wrenches/hex, diameter for drivers
    let measuredValue: Double   // actual measured value in mm
    let confidence: Double      // match confidence 0-1
    let errorMm: Double         // difference between measured and standard
}

// MARK: - Measurement Result

/// Dimensions measured from a single frame.
struct MeasuredDimensions: Sendable, Codable {
    let widthMm: Double
    let heightMm: Double
    let diameterMm: Double?       // non-nil if contour is approximately circular
    let isCircular: Bool
    let aspectRatio: Double

    /// Aspect ratio threshold for considering a contour circular.
    static let circularAspectRatioThreshold: Double = 1.15
}

/// Per-frame measurement result.
struct ToolMeasureResult: Sendable {
    let dimensions: MeasuredDimensions
    let measurementErrorEstimate: Double  // estimated error in mm
    let referenceObject: ReferenceObject
    let suggestions: [ToolSuggestion]
    let fastenerType: FastenerType?     // from upstream tool-id node, if connected
    let inferenceTimeMs: Double
    let timestamp: Double

    func jsonDict() -> [String: Any] {
        var dims: [String: Any] = [
            "widthMm": dimensions.widthMm,
            "heightMm": dimensions.heightMm,
            "isCircular": dimensions.isCircular,
            "aspectRatio": dimensions.aspectRatio,
        ]
        if let d = dimensions.diameterMm {
            dims["diameterMm"] = d
        }
        return [
            "type": "tool_measure_result",
            "dimensions": dims,
            "measurementErrorEstimate": measurementErrorEstimate,
            "referenceObject": referenceObject.rawValue,
            "fastenerType": fastenerType?.rawValue as Any,
            "suggestions": suggestions.map { s in
                return [
                    "toolCategory": s.toolCategory.rawValue,
                    "sizeLabel": s.sizeLabel,
                    "metricValue": s.metricValue,
                    "measuredValue": s.measuredValue,
                    "confidence": s.confidence,
                    "errorMm": s.errorMm,
                ] as [String: Any]
            },
            "inferenceTimeMs": inferenceTimeMs,
            "timestamp": timestamp,
        ] as [String: Any]
    }
}

// MARK: - Measurement Config

/// Server-provided configuration for the measurement stage.
struct ToolMeasureConfig: Codable, Sendable {
    /// Which reference object to use for calibration.
    let referenceObject: String
    /// Reject measurements with error estimate above this threshold (mm).
    let maxMeasurementError: Double
    /// Analysis FPS (measurement is expensive).
    let targetFPS: Double
    /// EMA smoothing across consecutive measurements.
    let smoothingAlpha: Double
    /// Confidence threshold for fastener type classification.
    let confidence: Double

    enum CodingKeys: String, CodingKey {
        case referenceObject, maxMeasurementError
        case targetFPS, smoothingAlpha, confidence
    }

    init(
        referenceObject: String = "auto",
        maxMeasurementError: Double = 2.0,
        targetFPS: Double = 1,
        smoothingAlpha: Double = 0.5,
        confidence: Double = 0.6
    ) {
        self.referenceObject = referenceObject
        self.maxMeasurementError = maxMeasurementError
        self.targetFPS = targetFPS
        self.smoothingAlpha = smoothingAlpha
        self.confidence = confidence
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.referenceObject = try c.decodeIfPresent(String.self, forKey: .referenceObject) ?? "auto"
        self.maxMeasurementError = try c.decodeIfPresent(Double.self, forKey: .maxMeasurementError) ?? 2.0
        self.targetFPS = try c.decodeIfPresent(Double.self, forKey: .targetFPS) ?? 1
        self.smoothingAlpha = try c.decodeIfPresent(Double.self, forKey: .smoothingAlpha) ?? 0.5
        self.confidence = try c.decodeIfPresent(Double.self, forKey: .confidence) ?? 0.6
    }
}

// MARK: - Size Matching

/// Find the closest standard tool size for a given measurement.
struct ToolSizeMatcher: Sendable {
    /// Find closest match from a list of standard sizes.
    /// Returns nil if no standard size is within tolerance.
    static func closest(
        measuredMm: Double,
        standards: [(label: String, value: Double)],
        toleranceMm: Double = 1.0
    ) -> (label: String, value: Double, errorMm: Double)? {
        var best: (label: String, value: Double, errorMm: Double)?
        for standard in standards {
            let error = abs(measuredMm - standard.value)
            if error <= toleranceMm {
                if best == nil || error < best!.errorMm {
                    best = (standard.label, standard.value, error)
                }
            }
        }
        return best
    }

    /// Generate tool suggestions for measured dimensions.
    static func suggest(
        dimensions: MeasuredDimensions,
        fastenerType: FastenerType?,
        toleranceMm: Double = 1.0
    ) -> [ToolSuggestion] {
        var suggestions: [ToolSuggestion] = []
        let type = fastenerType ?? .unknown

        // Use diameter for circular, width for non-circular
        let primaryMm = dimensions.diameterMm ?? dimensions.widthMm

        switch type {
        case .hexSocket:
            // Match against hex key sizes
            for sizeMm in ToolSizeTables.hexKeySizesMM {
                let error = abs(primaryMm - sizeMm)
                if error <= toleranceMm {
                    let conf = 1.0 - (error / toleranceMm)
                    suggestions.append(ToolSuggestion(
                        toolCategory: .hexKey,
                        sizeLabel: "\(Int(sizeMm))mm",
                        metricValue: sizeMm,
                        measuredValue: primaryMm,
                        confidence: conf,
                        errorMm: error
                    ))
                }
            }
            // Also check SAE hex sizes
            for sae in ToolSizeTables.hexKeySizesIN {
                let error = abs(primaryMm - sae.mm)
                if error <= toleranceMm {
                    let conf = 1.0 - (error / toleranceMm) * 0.9 // slightly lower priority
                    suggestions.append(ToolSuggestion(
                        toolCategory: .hexKey,
                        sizeLabel: "\(sae.label)in",
                        metricValue: sae.mm,
                        measuredValue: primaryMm,
                        confidence: conf,
                        errorMm: error
                    ))
                }
            }

        case .phillips:
            if let match = closest(measuredMm: primaryMm, standards: ToolSizeTables.phillipsSizes.map { ($0.size, $0.headDiameter) }, toleranceMm: toleranceMm) {
                suggestions.append(ToolSuggestion(
                    toolCategory: .phillipsScrewdriver,
                    sizeLabel: match.label,
                    metricValue: match.value,
                    measuredValue: primaryMm,
                    confidence: 1.0 - (match.errorMm / toleranceMm),
                    errorMm: match.errorMm
                ))
            }

        case .torx:
            if let match = closest(measuredMm: primaryMm, standards: ToolSizeTables.torxSizes.map { ($0.size, $0.outerDiameter) }, toleranceMm: toleranceMm) {
                suggestions.append(ToolSuggestion(
                    toolCategory: .torxBit,
                    sizeLabel: match.label,
                    metricValue: match.value,
                    measuredValue: primaryMm,
                    confidence: 1.0 - (match.errorMm / toleranceMm),
                    errorMm: match.errorMm
                ))
            }

        case .robertson:
            if let match = closest(measuredMm: primaryMm, standards: ToolSizeTables.robertsonSizes.map { ($0.size, $0.width) }, toleranceMm: toleranceMm) {
                suggestions.append(ToolSuggestion(
                    toolCategory: .robertsonBit,
                    sizeLabel: match.label,
                    metricValue: match.value,
                    measuredValue: primaryMm,
                    confidence: 1.0 - (match.errorMm / toleranceMm),
                    errorMm: match.errorMm
                ))
            }

        case .hexHead, .nut, .bolt:
            // Match against wrench sizes
            for sizeMm in ToolSizeTables.wrenchSizesMM {
                let error = abs(primaryMm - sizeMm)
                if error <= toleranceMm {
                    let conf = 1.0 - (error / toleranceMm)
                    suggestions.append(ToolSuggestion(
                        toolCategory: .wrench,
                        sizeLabel: "\(Int(sizeMm))mm",
                        metricValue: sizeMm,
                        measuredValue: primaryMm,
                        confidence: conf,
                        errorMm: error
                    ))
                }
            }
            // Also check bolt diameters
            if type == .bolt {
                for bolt in ToolSizeTables.boltDiametersMM {
                    let error = abs(primaryMm - bolt.diameter)
                    if error <= toleranceMm {
                        let conf = 1.0 - (error / toleranceMm)
                        suggestions.append(ToolSuggestion(
                            toolCategory: .wrench,
                            sizeLabel: bolt.size,
                            metricValue: bolt.diameter,
                            measuredValue: primaryMm,
                            confidence: conf,
                            errorMm: error
                        ))
                    }
                }
            }

        case .flathead:
            suggestions.append(ToolSuggestion(
                toolCategory: .flatScrewdriver,
                sizeLabel: "\(String(format: "%.1f", primaryMm))mm blade",
                metricValue: primaryMm,
                measuredValue: primaryMm,
                confidence: 0.7,
                errorMm: 0
            ))

        case .unknown:
            // Try all categories with wider tolerance
            suggestions = suggest(dimensions: dimensions, fastenerType: .hexSocket, toleranceMm: toleranceMm)
                + suggest(dimensions: dimensions, fastenerType: .phillips, toleranceMm: toleranceMm)
                + suggest(dimensions: dimensions, fastenerType: .torx, toleranceMm: toleranceMm)
                + suggest(dimensions: dimensions, fastenerType: .hexHead, toleranceMm: toleranceMm)
        }

        return suggestions.sorted { $0.confidence > $1.confidence }
    }
}
