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

    /// Return a copy with a modified top-level confidence.
    /// Used by ConfidenceSmoother to apply EMA before threshold filtering.
    /// For scene classification, smooths each label's confidence individually.
    func withConfidence(_ newConfidence: Double) -> VisionDetection {
        switch self {
        case .face(let d):
            return .face(FaceDetection(boundingBox: d.boundingBox, confidence: newConfidence, landmarkCount: d.landmarkCount))
        case .barcode(let d):
            return .barcode(BarcodeDetection(boundingBox: d.boundingBox, payloadString: d.payloadString, symbology: d.symbology, confidence: newConfidence))
        case .ocr(let d):
            return .ocr(OCRResult(boundingBox: d.boundingBox, text: d.text, confidence: newConfidence))
        case .scene:
            // Scene smoothing is handled per-label externally; top-level uses first label
            return self
        case .person(let d):
            return .person(PersonDetection(boundingBox: d.boundingBox, confidence: newConfidence))
        case .bodyPose(let d):
            return .bodyPose(BodyPoseDetection(boundingBox: d.boundingBox, confidence: newConfidence, joints: d.joints))
        }
    }

    /// Return a copy with smoothed per-label confidences (scene classification).
    func withSmoothedLabels(_ smoothedLabels: [SceneLabel]) -> VisionDetection {
        if case .scene = self {
            return .scene(SceneClassification(labels: smoothedLabels))
        }
        return self
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
    let smoothingAlpha: Double  // EMA factor: 0.3=heavy, 1.0=disabled

    // OCR-specific
    let language: String

    // Barcode-specific
    let symbologies: [String]

    // Scene-specific
    let maxLabels: Int

    // Thumbnail extraction config
    let thumbnailsEnabled: Bool
    let thumbnailSize: Int       // px, default 64
    let thumbnailMaxCount: Int   // 0 = unlimited, default 4
    let thumbnailQuality: CGFloat // JPEG quality 0-1, default 0.6

    static let `default` = VisionStageConfig(
        detectionTypes: [.faceDetect],
        confidence: 0.5,
        targetFPS: 5,
        maxResults: 0,
        smoothingAlpha: 0.3,
        language: "en-US",
        symbologies: ["QR"],
        maxLabels: 5,
        thumbnailsEnabled: false,
        thumbnailSize: 64,
        thumbnailMaxCount: 4,
        thumbnailQuality: 0.6
    )
}

// MARK: - JSON Serialization (for server relay)

extension VisionFrameResult {
    /// Convert to JSON-compatible dictionary for control message relay.
    /// thumbnails: array of (detectionIndex, base64JPEG) pairs to embed in detection entries.
    func jsonDict(thumbnails: [(Int, String)]? = nil) -> [String: Any] {
        // Build lookup from detection index to base64 thumbnail
        var thumbByIndex: [Int: String] = [:]
        if let thumbnails {
            for (idx, b64) in thumbnails {
                thumbByIndex[idx] = b64
            }
        }

        var detectionsJson: [[String: Any]] = []
        for (i, detection) in detections.enumerated() {
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
            // Embed thumbnail base64 if provided for this detection
            if let thumb = thumbByIndex[i] {
                entry["thumbnail"] = thumb
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
