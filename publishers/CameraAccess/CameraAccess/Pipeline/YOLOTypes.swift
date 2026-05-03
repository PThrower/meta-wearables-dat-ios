/*
 * YOLOTypes.swift
 *
 * Shared types for YOLO CoreML on-device inference.
 * Covers detection, segmentation, and pose estimation tasks.
 * Reuses NormalizedBoundingBox from VisionTypes for coordinate consistency.
 */

import CoreMedia
import Foundation

// MARK: - YOLO Task Type

enum YOLOTask: String, Sendable, Codable, CaseIterable {
    case detect
    case segment
    case pose
}

// MARK: - Model Loading State

enum YOLOModelState: Sendable, Equatable {
    case idle
    case downloading(modelId: String, progress: Double)   // 0.0 - 1.0
    case compiling(modelId: String)
    case ready(modelId: String, resources: YOLOResourceInfo)
    case failed(modelId: String, error: String)

    var isLoading: Bool {
        switch self {
        case .downloading, .compiling: return true
        default: return false
        }
    }

    var isFailed: Bool {
        if case .failed = self { return true }
        return false
    }

    var label: String {
        switch self {
        case .idle: return ""
        case .downloading(let id, let p): return "Downloading \(id)... \(Int(p * 100))%"
        case .compiling(let id): return "Compiling \(id)..."
        case .ready(let id, let res): return "\(id) ready (\(String(format: "%.1f", res.diskSizeMB))MB)"
        case .failed(let id, let err): return "\(id) failed: \(err)"
        }
    }
}

// MARK: - Resource Info

struct YOLOResourceInfo: Sendable, Equatable {
    let diskSizeMB: Double         // compiled .mlmodelc size on disk
    let downloadSizeMB: Double     // original download size (ZIP/archive)
    let classCount: Int            // number of class labels
    let inputSize: Int             // model input resolution (e.g. 640)
    let task: YOLOTask

    func toDict() -> [String: Any] {
        [
            "diskSizeMB": String(format: "%.1f", diskSizeMB),
            "downloadSizeMB": String(format: "%.1f", downloadSizeMB),
            "classCount": classCount,
            "inputSize": inputSize,
            "task": task.rawValue,
        ]
    }
}

// MARK: - Single Detection

struct YOLODetection: Sendable, Identifiable {
    let id = UUID()
    let bbox: NormalizedBoundingBox
    let confidence: Double
    let classIndex: Int
    let classLabel: String
    let task: YOLOTask

    // Segmentation only: 32-dim prototype coefficients
    var maskCoefficients: [Float]?

    // Pose only: 17 COCO keypoints
    var keypoints: [YOLOKeypoint]?
}

// MARK: - Keypoint (COCO 17-point)

struct YOLOKeypoint: Sendable, Identifiable {
    let id = UUID()
    let name: String   // "nose", "left_eye", etc.
    let x: Double      // normalized 0-1
    let y: Double      // normalized 0-1
    let confidence: Double
}

// MARK: - Frame Result

struct YOLOFrameResult: Sendable {
    let timestamp: Double
    let sequenceNumber: UInt64
    let detections: [YOLODetection]
    let inferenceTimeMs: Double
    let task: YOLOTask

    var isEmpty: Bool { detections.isEmpty }
}

// MARK: - Stage Config (from WS yolo_stage_config)

struct YOLOStageConfig: Sendable, Codable {
    let task: YOLOTask
    let modelId: String              // e.g. "yolo11n", "yolo11s-seg"
    let modelUrl: String?            // server download URL (nil = bundled)
    let classLabels: [String]        // class index -> label
    let confidence: Double           // detection confidence threshold
    let iouThreshold: Double         // NMS IoU threshold
    let targetFPS: UInt
    let maxDetections: Int           // cap output count
    let inputSize: Int               // 640 default
    let smoothingAlpha: Double       // EMA (reuse ConfidenceSmoother)

    static let `default` = YOLOStageConfig(
        task: .detect,
        modelId: "yolo11n",
        modelUrl: nil,
        classLabels: COCOClassLabels,
        confidence: 0.25,
        iouThreshold: 0.45,
        targetFPS: 10,
        maxDetections: 100,
        inputSize: 640,
        smoothingAlpha: 0.3
    )
}

// MARK: - COCO 80-Class Labels (standard YOLO pretrained)

let COCOClassLabels: [String] = [
    "person", "bicycle", "car", "motorcycle", "airplane", "bus", "train",
    "truck", "boat", "traffic light", "fire hydrant", "stop sign",
    "parking meter", "bench", "bird", "cat", "dog", "horse", "sheep",
    "cow", "elephant", "bear", "zebra", "giraffe", "backpack", "umbrella",
    "handbag", "tie", "suitcase", "frisbee", "skis", "snowboard",
    "sports ball", "kite", "baseball bat", "baseball glove", "skateboard",
    "surfboard", "tennis racket", "bottle", "wine glass", "cup", "fork",
    "knife", "spoon", "bowl", "banana", "apple", "sandwich", "orange",
    "broccoli", "carrot", "hot dog", "pizza", "donut", "cake", "chair",
    "couch", "potted plant", "bed", "dining table", "toilet", "tv",
    "laptop", "mouse", "remote", "keyboard", "cell phone", "microwave",
    "oven", "toaster", "sink", "refrigerator", "book", "clock", "vase",
    "scissors", "teddy bear", "hair drier", "toothbrush",
]

// MARK: - COCO Keypoint Names (17-point skeleton)

let COCOKeypointNames: [String] = [
    "nose", "left_eye", "right_eye", "left_ear", "right_ear",
    "left_shoulder", "right_shoulder", "left_elbow", "right_elbow",
    "left_wrist", "right_wrist", "left_hip", "right_hip",
    "left_knee", "right_knee", "left_ankle", "right_ankle",
]

// MARK: - Skeleton Connections (for overlay rendering)

let COCOSkeletonConnections: [(Int, Int)] = [
    // Head
    (0, 1), (0, 2), (1, 3), (2, 4),
    // Torso
    (5, 6), (5, 11), (6, 12), (11, 12),
    // Left arm
    (5, 7), (7, 9),
    // Right arm
    (6, 8), (8, 10),
    // Left leg
    (11, 13), (13, 15),
    // Right leg
    (12, 14), (14, 16),
]

// MARK: - JSON Serialization (for server relay)

extension YOLOFrameResult {
    func jsonDict() -> [String: Any] {
        var detectionsJson: [[String: Any]] = []
        for detection in detections {
            var entry: [String: Any] = [
                "type": "yolo-\(detection.task.rawValue)",
                "classIndex": detection.classIndex,
                "classLabel": detection.classLabel,
                "confidence": detection.confidence,
                "bbox": [
                    "x1": detection.bbox.x1, "y1": detection.bbox.y1,
                    "x2": detection.bbox.x2, "y2": detection.bbox.y2,
                ],
            ]
            if let keypoints = detection.keypoints {
                entry["keypoints"] = keypoints.map { [
                    "name": $0.name,
                    "x": $0.x,
                    "y": $0.y,
                    "confidence": $0.confidence,
                ] }
            }
            detectionsJson.append(entry)
        }
        return [
            "type": "yolo_result",
            "task": task.rawValue,
            "timestamp": timestamp,
            "inferenceTimeMs": inferenceTimeMs,
            "detectionCount": detections.count,
            "detections": detectionsJson,
        ] as [String: Any]
    }
}
