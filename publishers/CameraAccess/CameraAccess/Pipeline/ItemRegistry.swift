// ItemRegistry.swift
// Stateful zone-accounting registry for tracked objects.
// Struct (not actor) -- mutations protected by owning ObjectTrackingStage actor isolation.

import Foundation

/// Maintains custody of tracked objects across zones.
/// Detects zone transitions and computes running totals per zone.
struct ItemRegistry: Sendable {
    /// Maps trackId to current registry entry.
    private(set) var items: [Int: TrackedItem] = [:]
    /// Zone definitions for containment checks.
    private(set) var zones: [ZoneDefinition] = []
    /// Recent zone transition events (last 100).
    private(set) var transitionLog: [ZoneTransition] = []

    mutating func setZones(_ zones: [ZoneDefinition]) {
        self.zones = zones
    }

    /// Update registry with current frame's tracks. Returns transitions detected this frame.
    mutating func update(tracks: [Track], timestamp: Double) -> [ZoneTransition] {
        var newTransitions: [ZoneTransition] = []

        for track in tracks {
            let center = ((track.bbox.x1 + track.bbox.x2) / 2, (track.bbox.y1 + track.bbox.y2) / 2)
            let matchedZone = zones.first { $0.contains(center: center) }?.label

            if let existing = items[track.trackId] {
                // Existing item -- check for zone change
                if existing.currentZone != matchedZone {
                    let transition = ZoneTransition(
                        trackId: track.trackId,
                        classLabel: track.classLabel,
                        fromZone: existing.currentZone,
                        toZone: matchedZone,
                        timestamp: timestamp
                    )
                    newTransitions.append(transition)
                    transitionLog.append(transition)

                    items[track.trackId] = TrackedItem(
                        trackId: track.trackId,
                        classLabel: track.classLabel,
                        currentZone: matchedZone,
                        zoneHistory: existing.zoneHistory + [transition],
                        firstSeenTimestamp: existing.firstSeenTimestamp,
                        lastSeenTimestamp: timestamp
                    )
                } else {
                    // Same zone, just update timestamp
                    items[track.trackId] = TrackedItem(
                        trackId: track.trackId,
                        classLabel: track.classLabel,
                        currentZone: matchedZone,
                        zoneHistory: existing.zoneHistory,
                        firstSeenTimestamp: existing.firstSeenTimestamp,
                        lastSeenTimestamp: timestamp
                    )
                }
            } else {
                // New item
                let transition = ZoneTransition(
                    trackId: track.trackId,
                    classLabel: track.classLabel,
                    fromZone: nil,
                    toZone: matchedZone,
                    timestamp: timestamp
                )
                newTransitions.append(transition)
                transitionLog.append(transition)

                items[track.trackId] = TrackedItem(
                    trackId: track.trackId,
                    classLabel: track.classLabel,
                    currentZone: matchedZone,
                    zoneHistory: [transition],
                    firstSeenTimestamp: timestamp,
                    lastSeenTimestamp: timestamp
                )
            }
        }

        // Prune items whose tracks are no longer active
        let activeIds = Set(tracks.map { $0.trackId })
        items = items.filter { activeIds.contains($0.key) }

        // Cap transition log
        if transitionLog.count > 100 {
            transitionLog.removeFirst(transitionLog.count - 100)
        }

        return newTransitions
    }

    /// Compute current snapshot of zone occupancy.
    func snapshot(tracks: [Track]) -> RegistrySnapshot {
        var zoneCounts: [String: Int] = [:]
        // Initialize all zones to 0
        for zone in zones {
            zoneCounts[zone.label] = 0
        }
        // Count items per zone
        for (_, item) in items {
            if let zone = item.currentZone {
                zoneCounts[zone, default: 0] += 1
            }
        }

        let confirmedCount = tracks.filter { $0.state == .confirmed }.count
        return RegistrySnapshot(
            zoneCounts: zoneCounts,
            recentTransitions: Array(transitionLog.suffix(20)),
            totalActive: tracks.count,
            totalConfirmed: confirmedCount
        )
    }

    /// Reset all registry state.
    mutating func reset() {
        items.removeAll()
        transitionLog.removeAll()
    }
}
