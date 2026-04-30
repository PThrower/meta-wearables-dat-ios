// TrackingTypes.swift
// Type definitions for the OC-SORT object tracking subsystem.
// Reuses NormalizedBoundingBox from VisionTypes for coordinate consistency.

import Foundation

// MARK: - Configuration

/// Server-provided configuration for the tracking stage.
struct TrackingStageConfig: Codable, Sendable {
    /// Object classes to track (e.g. ["person", "vehicle"]).
    /// Empty array = track all detected classes.
    let targetClasses: [String]
    /// Minimum detection confidence to feed into tracker.
    let confidence: Double
    /// IoU threshold for track-detection association (default 0.3).
    let iouThreshold: Double
    /// Maximum frames a track survives without detection (default 30).
    let maxAge: Int
    /// Minimum consecutive hits before track is confirmed (default 3).
    let minHits: Int
    /// Maximum concurrent tracks (0 = unlimited).
    let maxTracks: Int
    /// Target processing FPS (0 = process every frame).
    let targetFPS: Double
    /// Confidence smoothing alpha (0-1, 1 = no smoothing).
    let smoothingAlpha: Double
    /// Zone definitions for spatial accounting.
    let zones: [ZoneDefinition]

    enum CodingKeys: String, CodingKey {
        case targetClasses, confidence, iouThreshold
        case maxAge, minHits, maxTracks, targetFPS
        case smoothingAlpha, zones
    }

    init(
        targetClasses: [String] = [],
        confidence: Double = 0.5,
        iouThreshold: Double = 0.3,
        maxAge: Int = 30,
        minHits: Int = 3,
        maxTracks: Int = 0,
        targetFPS: Double = 10,
        smoothingAlpha: Double = 0.3,
        zones: [ZoneDefinition] = []
    ) {
        self.targetClasses = targetClasses
        self.confidence = confidence
        self.iouThreshold = iouThreshold
        self.maxAge = maxAge
        self.minHits = minHits
        self.maxTracks = maxTracks
        self.targetFPS = targetFPS
        self.smoothingAlpha = smoothingAlpha
        self.zones = zones
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.targetClasses = try c.decodeIfPresent([String].self, forKey: .targetClasses) ?? []
        self.confidence = try c.decodeIfPresent(Double.self, forKey: .confidence) ?? 0.5
        self.iouThreshold = try c.decodeIfPresent(Double.self, forKey: .iouThreshold) ?? 0.3
        self.maxAge = try c.decodeIfPresent(Int.self, forKey: .maxAge) ?? 30
        self.minHits = try c.decodeIfPresent(Int.self, forKey: .minHits) ?? 3
        self.maxTracks = try c.decodeIfPresent(Int.self, forKey: .maxTracks) ?? 0
        self.targetFPS = try c.decodeIfPresent(Double.self, forKey: .targetFPS) ?? 10
        self.smoothingAlpha = try c.decodeIfPresent(Double.self, forKey: .smoothingAlpha) ?? 0.3
        self.zones = try c.decodeIfPresent([ZoneDefinition].self, forKey: .zones) ?? []
    }
}

// MARK: - Detection Input

/// Single detection fed into the OC-SORT tracker.
struct TrackDetection: Sendable {
    let bbox: NormalizedBoundingBox
    let confidence: Double
    let classLabel: String

    /// Center point of the bounding box.
    var center: (x: Double, y: Double) {
        ((bbox.x1 + bbox.x2) / 2, (bbox.y1 + bbox.y2) / 2)
    }

    /// Bounding box as [x, y, w, h] for Kalman filter input.
    var xywh: [Double] {
        let cx = (bbox.x1 + bbox.x2) / 2
        let cy = (bbox.y1 + bbox.y2) / 2
        let w = bbox.x2 - bbox.x1
        let h = bbox.y2 - bbox.y1
        return [cx, cy, w, h]
    }
}

// MARK: - Track State

/// Track lifecycle state.
enum TrackState: String, Sendable {
    case tentative   // Not enough consecutive hits yet
    case confirmed   // Meets minHits threshold
    case lost        // Missing detections but within maxAge
}

/// A tracked object with persistent identity across frames.
struct Track: Sendable {
    let trackId: Int
    let bbox: NormalizedBoundingBox
    let classLabel: String
    let confidence: Double
    let state: TrackState
    /// Number of frames since last detection match (0 = just matched).
    let age: Int
    /// Total number of successful detection matches.
    let hits: Int
    /// Frame timestamp when track was last updated.
    let lastSeenTimestamp: Double

    var displayLabel: String {
        "#\(trackId) \(classLabel)"
    }
}

// MARK: - Zone Accounting

/// Axis-aligned rectangular zone in normalized coordinates.
struct ZoneDefinition: Codable, Sendable, Identifiable {
    let id: String
    let label: String
    let x1: Double
    let y1: Double
    let x2: Double
    let y2: Double
    let color: String?

    init(id: String = UUID().uuidString, label: String, x1: Double, y1: Double, x2: Double, y2: Double, color: String? = nil) {
        self.id = id
        self.label = label
        self.x1 = x1
        self.y1 = y1
        self.x2 = x2
        self.y2 = y2
        self.color = color
    }

    func contains(center: (x: Double, y: Double)) -> Bool {
        center.x >= x1 && center.x <= x2 && center.y >= y1 && center.y <= y2
    }
}

/// An item tracked by the registry with zone custody.
struct TrackedItem: Sendable {
    let trackId: Int
    let classLabel: String
    let currentZone: String?
    let zoneHistory: [ZoneTransition]
    let firstSeenTimestamp: Double
    let lastSeenTimestamp: Double
}

/// Zone transition event for an item.
struct ZoneTransition: Codable, Sendable {
    let trackId: Int
    let classLabel: String
    let fromZone: String?
    let toZone: String?
    let timestamp: Double
}

// MARK: - Frame Result

/// Snapshot of zone occupancy counts.
struct RegistrySnapshot: Sendable {
    let zoneCounts: [String: Int]
    let recentTransitions: [ZoneTransition]
    let totalActive: Int
    let totalConfirmed: Int

    func jsonDict() -> [String: Any] {
        var dict: [String: Any] = [
            "totalActive": totalActive,
            "totalConfirmed": totalConfirmed,
        ]
        dict["zoneCounts"] = zoneCounts
        dict["recentTransitions"] = recentTransitions.map { t in
            return [
                "trackId": t.trackId,
                "classLabel": t.classLabel,
                "fromZone": t.fromZone as Any,
                "toZone": t.toZone as Any,
                "timestamp": t.timestamp,
            ] as [String: Any]
        }
        return dict
    }
}

/// Per-frame tracking result output.
struct TrackingFrameResult: Sendable {
    let tracks: [Track]
    let registry: RegistrySnapshot
    let inferenceTimeMs: Double
    let timestamp: Double

    func jsonDict() -> [String: Any] {
        return [
            "type": "tracking_result",
            "tracks": tracks.map { t in
                return [
                    "trackId": t.trackId,
                    "classLabel": t.classLabel,
                    "confidence": t.confidence,
                    "state": t.state.rawValue,
                    "bbox": [
                        "x1": t.bbox.x1,
                        "y1": t.bbox.y1,
                        "x2": t.bbox.x2,
                        "y2": t.bbox.y2,
                    ],
                    "age": t.age,
                    "hits": t.hits,
                    "displayLabel": t.displayLabel,
                ] as [String: Any]
            },
            "registry": registry.jsonDict(),
            "inferenceTimeMs": inferenceTimeMs,
            "timestamp": timestamp,
        ]
    }
}
