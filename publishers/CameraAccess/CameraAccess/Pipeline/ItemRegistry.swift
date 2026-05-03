// ItemRegistry.swift
// Stateful zone-accounting registry for tracked objects.
// Struct (not actor) -- mutations protected by owning ObjectTrackingStage actor isolation.
//
// Visual analytics:
//   - Dwell time: cumulative seconds each track spends in each zone
//   - Zone traffic: directional entry/exit counts with destination breakdown
//   - Speed summary: avg/max/min speed of tracks currently in each zone

import Foundation

/// Maintains custody of tracked objects across zones.
/// Detects zone transitions and computes running totals per zone.
struct ItemRegistry: Sendable {
    /// Maps trackId to current registry entry.
    private(set) var items: [Int: TrackedItem] = [:]
    /// Cache of dead track items for zone history restoration on reconciliation.
    private(set) var deadItems: [Int: TrackedItem] = [:]
    /// Zone definitions for containment checks.
    private(set) var zones: [ZoneDefinition] = []
    /// Recent zone transition events (last 100).
    private(set) var transitionLog: [ZoneTransition] = []

    // MARK: - Visual Analytics Accumulators

    /// Cumulative directional traffic per zone.
    /// Keyed by zone label. Updated on every ZoneTransition.
    private var trafficAccumulator: [String: TrafficAccumulator] = [:]

    /// Running accumulator for zone traffic (entries, exits, destinations).
    private struct TrafficAccumulator: Sendable {
        var entries: Int = 0
        var exits: Int = 0
        var exitDestinations: [String: Int] = [:]
    }

    mutating func setZones(_ zones: [ZoneDefinition]) {
        self.zones = zones
    }

    /// Update registry with current frame's tracks. Returns transitions detected this frame.
    /// - Parameter lostTrackIds: Track IDs that are still alive but unmatched this frame.
    ///   These are preserved in the registry for zone history continuity during occlusion.
    mutating func update(tracks: [Track], timestamp: Double, lostTrackIds: Set<Int> = []) -> [ZoneTransition] {
        var newTransitions: [ZoneTransition] = []
        let activeIds = Set(tracks.map { $0.trackId })

        for track in tracks {
            let center = ((track.bbox.x1 + track.bbox.x2) / 2, (track.bbox.y1 + track.bbox.y2) / 2)
            let matchedZone = zones.first { $0.contains(center: center) }?.label

            if let existing = items[track.trackId] {
                // Compute dwell time delta since last update
                let dt = timestamp - existing.lastSeenTimestamp
                // Accumulate dwell time for the zone the item was in
                var updatedDwell = existing.zoneDwellTimes
                if let prevZone = existing.currentZone, dt > 0 {
                    updatedDwell[prevZone, default: 0] += dt
                }

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

                    // Update traffic accumulator
                    recordTraffic(transition: transition)

                    items[track.trackId] = TrackedItem(
                        trackId: track.trackId,
                        classLabel: track.classLabel,
                        currentZone: matchedZone,
                        zoneHistory: existing.zoneHistory + [transition],
                        firstSeenTimestamp: existing.firstSeenTimestamp,
                        lastSeenTimestamp: timestamp,
                        zoneDwellTimes: updatedDwell
                    )
                } else {
                    // Same zone, just update timestamp + dwell
                    items[track.trackId] = TrackedItem(
                        trackId: track.trackId,
                        classLabel: track.classLabel,
                        currentZone: matchedZone,
                        zoneHistory: existing.zoneHistory,
                        firstSeenTimestamp: existing.firstSeenTimestamp,
                        lastSeenTimestamp: timestamp,
                        zoneDwellTimes: updatedDwell
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

                // Record entry traffic
                recordTraffic(transition: transition)

                items[track.trackId] = TrackedItem(
                    trackId: track.trackId,
                    classLabel: track.classLabel,
                    currentZone: matchedZone,
                    zoneHistory: [transition],
                    firstSeenTimestamp: timestamp,
                    lastSeenTimestamp: timestamp,
                    zoneDwellTimes: [:]
                )
            }
        }

        // Prune items whose tracks are no longer active AND not in lost set.
        // Lost tracks (within maxAge but unmatched this frame) are kept for
        // zone history continuity during temporary occlusion.
        // Dead tracks (removed from tracker) are cached in deadItems for reconciliation.
        let survivingIds = activeIds.union(lostTrackIds)
        let prunedIds = items.keys.filter { !survivingIds.contains($0) }
        for id in prunedIds {
            if let item = items[id] {
                deadItems[id] = item
            }
        }
        // Cap deadItems cache (max 50 entries, FIFO eviction)
        if deadItems.count > 50 {
            let excess = deadItems.count - 50
            let keysToRemove = Array(deadItems.keys.prefix(excess))
            for key in keysToRemove { deadItems.removeValue(forKey: key) }
        }
        items = items.filter { survivingIds.contains($0.key) }

        // Cap transition log
        if transitionLog.count > 100 {
            transitionLog.removeFirst(transitionLog.count - 100)
        }

        return newTransitions
    }

    /// Record a zone transition into the traffic accumulator.
    private mutating func recordTraffic(transition: ZoneTransition) {
        // Entry: fromZone=null means entering from outside, toZone means entering a zone
        if let toZone = transition.toZone {
            trafficAccumulator[toZone, default: TrafficAccumulator()].entries += 1
        }
        // Exit: fromZone set, toZone different or null means leaving
        if let fromZone = transition.fromZone {
            let acc = trafficAccumulator[fromZone, default: TrafficAccumulator()]
            // Only count as exit if leaving to a different zone or outside
            if transition.toZone != fromZone {
                trafficAccumulator[fromZone]!.exits += 1
                if let dest = transition.toZone {
                    trafficAccumulator[fromZone]!.exitDestinations[dest, default: 0] += 1
                }
            }
        }
    }

    /// Compute current snapshot of zone occupancy with enriched analytics.
    /// - Parameter tracks: Current frame's tracks (used for speed computation).
    func snapshot(tracks: [Track]) -> RegistrySnapshot {
        var zoneCounts: [String: Int] = [:]
        // Initialize all zones to 0
        for zone in zones {
            zoneCounts[zone.label] = 0
        }

        // Count items per zone + aggregate dwell times
        var aggregatedDwell: [String: Double] = [:]
        for zone in zones {
            aggregatedDwell[zone.label] = 0
        }
        for (_, item) in items {
            if let zone = item.currentZone {
                zoneCounts[zone, default: 0] += 1
                aggregatedDwell[zone, default: 0] += item.zoneDwellTimes[zone, default: 0]
            }
        }

        // Speed summary per zone
        var zoneSpeeds: [String: ZoneSpeedSummary] = [:]
        // Build speed lookup from tracks
        var speedsByZone: [String: [Double]] = [:]
        for zone in zones {
            speedsByZone[zone.label] = []
        }
        for track in tracks {
            // Find which zone this track is in
            let center = ((track.bbox.x1 + track.bbox.x2) / 2, (track.bbox.y1 + track.bbox.y2) / 2)
            if let zoneLabel = zones.first(where: { $0.contains(center: center) })?.label {
                speedsByZone[zoneLabel, default: []].append(track.speed)
            }
        }
        for (zoneLabel, speeds) in speedsByZone {
            guard !speeds.isEmpty else {
                zoneSpeeds[zoneLabel] = ZoneSpeedSummary(avgSpeed: 0, maxSpeed: 0, minSpeed: 0, trackCount: 0)
                continue
            }
            zoneSpeeds[zoneLabel] = ZoneSpeedSummary(
                avgSpeed: speeds.reduce(0, +) / Double(speeds.count),
                maxSpeed: speeds.max() ?? 0,
                minSpeed: speeds.min() ?? 0,
                trackCount: speeds.count
            )
        }

        // Build traffic snapshot
        var zoneTraffic: [String: ZoneTrafficEntry] = [:]
        for zone in zones {
            let acc = trafficAccumulator[zone.label] ?? TrafficAccumulator()
            zoneTraffic[zone.label] = ZoneTrafficEntry(
                entries: acc.entries,
                exits: acc.exits,
                exitDestinations: acc.exitDestinations
            )
        }

        let confirmedCount = tracks.filter { $0.state == .confirmed }.count
        return RegistrySnapshot(
            zoneCounts: zoneCounts,
            recentTransitions: Array(transitionLog.suffix(20)),
            totalActive: tracks.count,
            totalConfirmed: confirmedCount,
            zoneDwellTimes: aggregatedDwell,
            zoneTraffic: zoneTraffic,
            zoneSpeeds: zoneSpeeds
        )
    }

    /// Restore a dead item back to active items on reconciliation.
    /// Moves the TrackedItem from deadItems cache to items dictionary.
    /// Returns the restored item, or nil if not found in dead cache.
    @discardableResult
    mutating func restoreItem(trackId: Int) -> TrackedItem? {
        guard let item = deadItems.removeValue(forKey: trackId) else { return nil }
        items[trackId] = item
        return item
    }

    /// Reset all registry state.
    mutating func reset() {
        items.removeAll()
        deadItems.removeAll()
        transitionLog.removeAll()
        trafficAccumulator.removeAll()
    }
}
