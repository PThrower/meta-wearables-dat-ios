/*
 * ConfidenceSmoother.swift
 *
 * Exponential Moving Average (EMA) for detection confidence values.
 * Used within VisionStage and AudioClassificationStage actor isolation —
 * not an actor itself, mutations are protected by the owning actor.
 *
 * Two key strategies:
 *   1. Spatial matching — for face/person/body-pose, matches detections
 *      across frames by bounding box proximity (nearest-center matching).
 *   2. Label matching — for scene/sound/barcode/OCR, uses the label or
 *      text content as a stable key across frames.
 *
 * Alpha (smoothing factor):
 *   0.3 = heavy smoothing (slower response, less flicker)
 *   0.7 = light smoothing (faster response, more flicker)
 *   1.0 = disabled (raw confidence passed through)
 */

import Foundation

struct ConfidenceSmoother {
    // MARK: - Types

    private struct BboxCoords {
        let x1: Double, y1: Double, x2: Double, y2: Double
        var centerX: Double { (x1 + x2) / 2 }
        var centerY: Double { (y1 + y2) / 2 }
    }

    private struct Entry {
        var smoothedValue: Double
        var lastSeen: ContinuousClock.Instant
        var bbox: BboxCoords?
    }

    // MARK: - State

    private var entries: [String: Entry] = [:]

    /// EMA alpha: weight of new observation vs history.
    /// 0.3 means 30% new + 70% history (heavy smoothing).
    var alpha: Double

    init(alpha: Double = 0.3) {
        self.alpha = alpha
    }

    // MARK: - Smoothing

    /// Apply EMA to a raw confidence value identified by key.
    /// First-seen values pass through unsmoothed (no history to blend).
    mutating func smooth(key: String, raw: Double, bbox: NormalizedBoundingBox? = nil) -> Double {
        if var entry = entries[key] {
            entry.smoothedValue = alpha * raw + (1 - alpha) * entry.smoothedValue
            entry.lastSeen = .now
            if let bbox {
                entry.bbox = BboxCoords(x1: bbox.x1, y1: bbox.y1, x2: bbox.x2, y2: bbox.y2)
            }
            entries[key] = entry
            return entry.smoothedValue
        }
        entries[key] = Entry(
            smoothedValue: raw,
            lastSeen: .now,
            bbox: bbox.map { BboxCoords(x1: $0.x1, y1: $0.y1, x2: $0.x2, y2: $0.y2) }
        )
        return raw
    }

    // MARK: - Spatial Matching

    /// Find or create a tracking key for a spatial detection by matching
    /// bounding box center to previously tracked detections of the same type.
    ///
    /// Uses nearest-center matching with a maximum distance threshold.
    /// Detections closer than `maxDistance` (normalized units, default 0.2)
    /// are considered the same object and reuse the existing key.
    mutating func spatialKey(type: String, bbox: NormalizedBoundingBox, maxDistance: Double = 0.2) -> String {
        let center = BboxCoords(x1: bbox.x1, y1: bbox.y1, x2: bbox.x2, y2: bbox.y2)
        let prefix = "\(type)-"
        let threshold = maxDistance * maxDistance
        var bestKey: String?
        var bestDist = threshold

        for (key, entry) in entries where key.hasPrefix(prefix) {
            guard let eb = entry.bbox else { continue }
            let dx = center.centerX - eb.centerX
            let dy = center.centerY - eb.centerY
            let dist = dx * dx + dy * dy
            if dist < bestDist {
                bestDist = dist
                bestKey = key
            }
        }

        if let match = bestKey {
            entries[match]?.bbox = center
            return match
        }

        // New object — generate unique key
        let newKey = "\(type)-\(UUID().uuidString.prefix(8))"
        return newKey
    }

    // MARK: - Maintenance

    /// Remove entries not seen within `maxAge` (default 500ms).
    /// Call once per frame to prevent stale state from accumulating.
    mutating func prune(maxAge: Duration = .milliseconds(500)) {
        let cutoff = ContinuousClock.Instant.now - maxAge
        entries = entries.filter { $0.value.lastSeen > cutoff }
    }

    /// Clear all smoothing state (e.g., on stage stop or config change).
    mutating func reset() {
        entries.removeAll()
    }
}
