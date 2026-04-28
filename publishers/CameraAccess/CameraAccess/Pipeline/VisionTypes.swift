/*
 * VisionTypes.swift
 *
 * Shared types for Apple Vision framework detection results.
 * All coordinates are normalized 0-1 for resolution-independent rendering.
 * Used by VisionStage (production), BoundingBoxOverlayView (rendering),
 * and server relay (JSON control messages).
 */

import Foundation

// MARK: - Vision Detection Type

/// Discriminated union for Vision framework detection results.
/// Each case maps to a specific VNRequest type in VisionStage.
enum VisionDetectionType: String, Sendable, Codable, CaseIterable {
    case faceDetect = "vision-face-detect"
    case barcodeScan = "vision-barcode-scan"
    case ocr = "vision-ocr"
    case sceneClassify = "vision-scene-classify"
    case personDetect = "vision-person-detect"
    case bodyPose = "vision-body-pose"
}

// MARK: - Bounding Box (normalized 0-1)

struct NormalizedBoundingBox: Sendable, Codable, Identifiable {
    let id = UUID()
    let x1: Double  // left, 0-1
    let y1: Double  // top, 0-1
    let x2: Double  // right, 0-1
    let y2: Double  // bottom, 0-1

    var width: Double { x2 - x1 }
    var height: Double { y2 - y1 }
    var centerX: Double { (x1 + x2) / 2 }
    var centerY: Double { (y1 + y2) / 2 }
}

// MARK: - Detection Results

struct FaceDetection: Sendable, Codable, Identifiable {
    let id = UUID()
    let boundingBox: NormalizedBoundingBox
    let confidence: Double
    /// Face landmarks count (0 if landmarks not requested)
    let landmarkCount: Int
}

struct BarcodeDetection: Sendable, Codable, Identifiable {
    let id = UUID()
    let boundingBox: NormalizedBoundingBox
    let payloadString: String
    let symbology: String
    let confidence: Double
}

struct OCRResult: Sendable, Codable, Identifiable {
    let id = UUID()
    let boundingBox: NormalizedBoundingBox
    let text: String
    let confidence: Double
}

struct SceneLabel: Sendable, Codable, Identifiable {
    let id = UUID()
    let label: String
    let confidence: Double
}

struct SceneClassification: Sendable, Codable {
    let labels: [SceneLabel]
}

struct PersonDetection: Sendable, Codable, Identifiable {
    let id = UUID()
    let boundingBox: NormalizedBoundingBox
    let confidence: Double
}

struct JointPoint: Sendable, Codable, Identifiable {
    let id = UUID()
    let name: String
    let x: Double  // normalized 0-1
    let y: Double  // normalized 0-1
    let confidence: Double
}

struct BodyPoseDetection: Sendable, Codable, Identifiable {
    let id = UUID()
    let boundingBox: NormalizedBoundingBox
    let confidence: Double
    let joints: [JointPoint]
}

// MARK: - VisionDetection (discriminated union)

/// Single detection result from any Vision request.
enum VisionDetection: Sendable {
    case face(FaceDetection)
    case barcode(BarcodeDetection)
    case ocr(OCRResult)
    case scene(SceneClassification)
    case person(PersonDetection)
    case bodyPose(BodyPoseDetection)

    var detectionType: VisionDetectionType {
        switch self {
        case .face: return .faceDetect
        case .barcode: return .barcodeScan
        case .ocr: return .ocr
        case .scene: return .sceneClassify
        case .person: return .personDetect
        case .bodyPose: return .bodyPose
        }
    }

    /// Bounding box if this detection has one (nil for scene classification).
    var boundingBox: NormalizedBoundingBox? {
        switch self {
        case .face(let d): return d.boundingBox
        case .barcode(let d): return d.boundingBox
        case .ocr(let d): return d.boundingBox
        case .scene: return nil
        case .person(let d): return d.boundingBox
        case .bodyPose(let d): return d.boundingBox
        }
    }

    /// Display label for overlays.
    var displayLabel: String {
        switch self {
        case .face: return "Face"
        case .barcode(let d): return d.symbology
        case .ocr(let d): return d.text
        case .scene(let d): return d.labels.first?.label ?? "Scene"
        case .person: return "Person"
        case .bodyPose: return "Body Pose"
        }
    }

    /// Confidence value.
    var confidence: Double {
        switch self {
        case .face(let d): return d.confidence
        case .barcode(let d): return d.confidence
        case .ocr(let d): return d.confidence
        case .scene(let d): return d.labels.first?.confidence ?? 0
        case .person(let d): return d.confidence
        case .bodyPose(let d): return d.confidence
        }
    }
}

// MARK: - VisionFrameResult

/// Aggregated results from a single frame's Vision analysis.
struct VisionFrameResult: Sendable {
    let timestamp: ContinuousClock.Instant
    let sequenceNumber: UInt64
    let detections: [VisionDetection]
    let inferenceTimeMs: Double

    var isEmpty: Bool { detections.isEmpty }
}

// MARK: - VisionStageConfig

/// Configuration for VisionStage, derived from workflow node config.
struct VisionStageConfig: Sendable, Codable {
    let detectionTypes: [VisionDetectionType]
    let confidence: Double
    let targetFPS: UInt
    let maxResults: Int  // 0 = unlimited

    // OCR-specific
    let language: String

    // Barcode-specific
    let symbologies: [String]

    // Scene-specific
    let maxLabels: Int

    static let `default` = VisionStageConfig(
        detectionTypes: [.faceDetect],
        confidence: 0.5,
        targetFPS: 5,
        maxResults: 0,
        language: "en-US",
        symbologies: ["QR"],
        maxLabels: 5
    )
}

// MARK: - JSON Serialization (for server relay)

extension VisionFrameResult {
    /// Convert to JSON-compatible dictionary for control message relay.
    var jsonDict: [String: Any] {
        var detectionsJson: [[String: Any]] = []
        for detection in detections {
            var entry: [String: Any] = [
                "type": detection.detectionType.rawValue,
                "label": detection.displayLabel,
                "confidence": detection.confidence,
            ]
            if let bb = detection.boundingBox {
                entry["bbox"] = [
                    "x1": bb.x1, "y1": bb.y1,
                    "x2": bb.x2, "y2": bb.y2,
                ]
            }
            // Scene classification includes all labels
            if case .scene(let cls) = detection {
                entry["labels"] = cls.labels.map { [
                    "label": $0.label,
                    "confidence": $0.confidence,
                ] }
            }
            // Body pose includes joint points
            if case .bodyPose(let pose) = detection {
                entry["joints"] = pose.joints.map { [
                    "name": $0.name,
                    "x": $0.x,
                    "y": $0.y,
                    "confidence": $0.confidence,
                ] }
            }
            detectionsJson.append(entry)
        }
        return [
            "type": "vision_result",
            "inferenceTimeMs": inferenceTimeMs,
            "detectionCount": detections.count,
            "detections": detectionsJson,
        ] as [String: Any]
    }
}
