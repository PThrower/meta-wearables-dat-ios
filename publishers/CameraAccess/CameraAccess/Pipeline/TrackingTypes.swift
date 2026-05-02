// TrackingTypes.swift
// Type definitions for the OC-SORT object tracking subsystem.
// Reuses NormalizedBoundingBox from VisionTypes for coordinate consistency.

import Foundation

// MARK: - Gate Configuration

/// Configuration for a single gate in the association pipeline.
/// Each gate is a workflow node that connects to tracking-ocsort.
/// The server collects gate nodes from the workflow graph and sends them
/// as an ordered chain in the tracking config.
/// Ref: Bar-Shalom & Fortmann, "Tracking and Data Association" (1988)
struct GateConfig: Codable, Sendable, Equatable {
    /// Gate type identifier matching the workflow node type.
    /// "gate-mahalanobis" | "gate-iou" | future gate types.
    let gateType: String
    /// Gate-specific parameters extracted from the node's config.
    let params: [String: Double]

    enum CodingKeys: String, CodingKey {
        case gateType, params
    }
}

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

    // Ref: arXiv:2203.14360 Sec 4.2 — OCM parameters
    // Ref: noahcao/OC_SORT, KalmanBoxTracker.__init__

    /// Steps back for velocity estimation (OCM). Default 3.
    /// Ref: arXiv:2203.14360 Sec 4.2
    let deltaT: Int
    /// Direction consistency weight (OCM). Default 0.2.
    /// Ref: arXiv:2203.14360 Sec 4.2
    let inertia: Double
    /// Detection confidence threshold for first-pass association. Default 0.5.
    let detThresh: Double
    /// Enable ByteTrack two-pass: match low-confidence detections (0.1..detThresh)
    /// against remaining tracks after first + second pass association.
    /// Ref: arXiv:2110.06864 — rescues partially occluded objects. Default false.
    let useByte: Bool

    // MARK: Gating Pipeline — ordered chain from workflow nodes

    /// Ordered chain of gates from the workflow graph.
    /// Built by the server from gate-* nodes that connect to this tracker.
    /// Empty array = default gating (IoU at iouThreshold).
    let gates: [GateConfig]

    /// Cost function selector from the workflow graph.
    /// "cost-iou" = IoU-only cost (ByteTrack compatible), null = default OCM cost.
    let costFunction: String?

    // MARK: Trajectory Forecasting

    /// Number of frames to forecast ahead via KF prediction (0 = disabled).
    /// Exposes predicted positions N frames ahead for:
    /// - Pre-positioning UI elements before objects arrive
    /// - Proactive zone breach alerts before entry
    /// - Smooth overlay rendering during detection gaps
    let forecastSteps: Int

    enum CodingKeys: String, CodingKey {
        case targetClasses, confidence, iouThreshold
        case maxAge, minHits, maxTracks, targetFPS
        case smoothingAlpha, zones
        case deltaT, inertia, detThresh, useByte
        case gates, costFunction, forecastSteps
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
        zones: [ZoneDefinition] = [],
        deltaT: Int = 3,
        inertia: Double = 0.2,
        detThresh: Double = 0.5,
        useByte: Bool = false,
        gates: [GateConfig] = [],
        costFunction: String? = nil,
        forecastSteps: Int = 0
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
        self.deltaT = deltaT
        self.inertia = inertia
        self.detThresh = detThresh
        self.useByte = useByte
        self.gates = gates
        self.costFunction = costFunction
        self.forecastSteps = forecastSteps
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
        self.deltaT = try c.decodeIfPresent(Int.self, forKey: .deltaT) ?? 3
        self.inertia = try c.decodeIfPresent(Double.self, forKey: .inertia) ?? 0.2
        self.detThresh = try c.decodeIfPresent(Double.self, forKey: .detThresh) ?? 0.5
        self.useByte = try c.decodeIfPresent(Bool.self, forKey: .useByte) ?? false
        self.gates = try c.decodeIfPresent([GateConfig].self, forKey: .gates) ?? []
        self.costFunction = try c.decodeIfPresent(String.self, forKey: .costFunction)
        self.forecastSteps = try c.decodeIfPresent(Int.self, forKey: .forecastSteps) ?? 0
    }
}

// MARK: - Trajectory Forecast

/// A single predicted position from multi-step Kalman filter forecasting.
/// Computed by advancing the KF state transition without measurement updates.
/// Ref: Bar-Shalom & Fortmann, "Tracking and Data Association" Ch. 3 — prediction
struct PredictedPosition: Sendable {
    /// Frame offset from current (1 = next frame, 2 = two frames ahead, etc.).
    let step: Int
    /// Predicted center in normalized coordinates.
    let center: (x: Double, y: Double)
    /// Predicted bounding box.
    let bbox: NormalizedBoundingBox
    /// Position uncertainty radius (sqrt of position variance sum, normalized units).
    /// Grows with each forecast step as covariance propagates through F*P*F^T + Q.
    let uncertainty: Double
}

// MARK: - Detection Input

/// Single detection fed into the OC-SORT tracker.
struct TrackDetection: Sendable {
    let bbox: NormalizedBoundingBox
    let confidence: Double
    let classLabel: String
    /// HSV color histogram (on-device, Bhattacharyya gate). 24-dim normalized vector.
    let histogram: [Double]?
    /// Deep appearance embedding (server-side, ReID gate). 512-dim vector.
    let embedding: [Double]?

    init(bbox: NormalizedBoundingBox, confidence: Double, classLabel: String,
         histogram: [Double]? = nil, embedding: [Double]? = nil) {
        self.bbox = bbox
        self.confidence = confidence
        self.classLabel = classLabel
        self.histogram = histogram
        self.embedding = embedding
    }

    /// Center point of the bounding box.
    var center: (x: Double, y: Double) {
        ((bbox.x1 + bbox.x2) / 2, (bbox.y1 + bbox.y2) / 2)
    }

    /// Bounding box as [x, y, w, h] — used for logging only.
    var xywh: [Double] {
        let cx = (bbox.x1 + bbox.x2) / 2
        let cy = (bbox.y1 + bbox.y2) / 2
        let w = bbox.x2 - bbox.x1
        let h = bbox.y2 - bbox.y1
        return [cx, cy, w, h]
    }

    /// Convert to 7-state KF observation vector [x, y, s, r] where s=area, r=aspect.
    /// Ref: arXiv:2203.14360, convert_bbox_to_z
    var zVector: [Double] {
        let w = bbox.x2 - bbox.x1
        let h = bbox.y2 - bbox.y1
        let cx = (bbox.x1 + bbox.x2) / 2
        let cy = (bbox.y1 + bbox.y2) / 2
        let s = w * h  // scale = area
        let r = w / (h + 1e-6)  // aspect ratio
        return [cx, cy, s, r]
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
    // Ref: Ultralytics YOLO tracking modes — trajectory visualization
    /// Trajectory trail: center points of last N observations for polyline rendering.
    /// Ref: Ultralytics tracking docs — draw movement paths of tracked objects.
    let trail: [(x: Double, y: Double)]
    /// Kalman filter velocity estimates (normalized coords/frame).
    /// vx, vy = center velocity; vs = scale (area) velocity.
    let velocity: (vx: Double, vy: Double, vs: Double)
    /// Trajectory forecast: predicted positions N frames ahead from KF state.
    /// Empty when forecasting is disabled (forecastSteps = 0).
    let forecast: [PredictedPosition]

    /// Magnitude of center velocity in normalized coords/frame.
    var speed: Double {
        sqrt(velocity.vx * velocity.vx + velocity.vy * velocity.vy)
    }

    /// Heading in degrees [0, 360). 0 = right, 90 = down (image coords).
    /// nil when speed is near zero (< 1e-4).
    var heading: Double? {
        guard speed > 1e-4 else { return nil }
        let radians = atan2(velocity.vy, velocity.vx)
        let degrees = radians * 180.0 / .pi
        return degrees < 0 ? degrees + 360.0 : degrees
    }

    var displayLabel: String {
        "#\(trackId) \(classLabel) \(Int(confidence * 100))%"
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
    /// True if this transition was predicted from trajectory forecast, not observed.
    let predicted: Bool

    init(trackId: Int, classLabel: String, fromZone: String?, toZone: String?, timestamp: Double, predicted: Bool = false) {
        self.trackId = trackId
        self.classLabel = classLabel
        self.fromZone = fromZone
        self.toZone = toZone
        self.timestamp = timestamp
        self.predicted = predicted
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        trackId = try c.decode(Int.self, forKey: .trackId)
        classLabel = try c.decode(String.self, forKey: .classLabel)
        fromZone = try c.decodeIfPresent(String.self, forKey: .fromZone)
        toZone = try c.decodeIfPresent(String.self, forKey: .toZone)
        timestamp = try c.decode(Double.self, forKey: .timestamp)
        predicted = try c.decodeIfPresent(Bool.self, forKey: .predicted) ?? false
    }
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
                "predicted": t.predicted,
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
    /// Zone breaches predicted from trajectory forecasts (empty when forecast disabled).
    let predictedZoneBreaches: [ZoneTransition]

    func jsonDict() -> [String: Any] {
        return [
            "type": "tracking_result",
            "tracks": tracks.map { t in
                var trackDict: [String: Any] = [
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
                    "trail": t.trail.map { ["x": $0.x, "y": $0.y] },
                    "displayLabel": t.displayLabel,
                    "velocity": [
                        "vx": t.velocity.vx,
                        "vy": t.velocity.vy,
                        "vs": t.velocity.vs,
                    ],
                    "speed": t.speed,
                    "forecast": t.forecast.map { p in
                        return [
                            "step": p.step,
                            "center": ["x": p.center.x, "y": p.center.y],
                            "uncertainty": p.uncertainty,
                            "bbox": [
                                "x1": p.bbox.x1,
                                "y1": p.bbox.y1,
                                "x2": p.bbox.x2,
                                "y2": p.bbox.y2,
                            ],
                        ] as [String: Any]
                    },
                ]
                if let heading = t.heading {
                    trackDict["heading"] = heading
                }
                return trackDict
            },
            "registry": registry.jsonDict(),
            "inferenceTimeMs": inferenceTimeMs,
            "timestamp": timestamp,
            "predictedZoneBreaches": predictedZoneBreaches.map { t in
                return [
                    "trackId": t.trackId,
                    "classLabel": t.classLabel,
                    "fromZone": t.fromZone as Any,
                    "toZone": t.toZone as Any,
                    "timestamp": t.timestamp,
                    "predicted": t.predicted,
                ] as [String: Any]
            },
        ]
    }
}
