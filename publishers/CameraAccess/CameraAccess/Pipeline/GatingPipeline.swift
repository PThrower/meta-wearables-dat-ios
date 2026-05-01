// GatingPipeline.swift
// Modular pre-gating and cost matrix computation for OC-SORT association.
//
// Hybrid gating pipeline:
//   1. MahalanobisGate — reject impossible motion matches using KF innovation covariance.
//   2. IoUGate — spatial overlap check.
//   3. Cost function — IoU+OCM (default), IoU-only (ByteTrack), or pluggable.
//   4. Hungarian/Greedy — solve assignment on gated cost matrix.
//
// Ref: arXiv:2203.14360 OC-SORT
// Ref: chi-squared gating: Bar-Shalom & Fortmann, "Tracking and Data Association" (1988)

import Foundation

// MARK: - Gating Result

/// Result of applying gates to a track-detection pair.
/// Gates are applied in order — first failure stops the chain.
struct GateResult: OptionSet, Sendable {
    let rawValue: UInt8
    static let passedMahalanobis = GateResult(rawValue: 1 << 0)
    static let passedIoU          = GateResult(rawValue: 1 << 1)
    static let passed             = GateResult([.passedMahalanobis, .passedIoU])
}

/// Boolean mask: [numTracks][numDetections] — true if the pair survived all gates.
typealias GateMask = [[Bool]]

// MARK: - Mahalanobis Gate

/// Mahalanobis distance gating using Kalman filter innovation covariance.
/// Rejects detections that are statistically too far from the predicted state.
///
/// The squared Mahalanobis distance d^2 = (z - H*x)^T * S^{-1} * (z - H*x)
/// follows a chi-squared distribution with k degrees of freedom (k = observation dim = 4).
///
/// Threshold selection (chi-squared table, 4 DOF):
///   95%: 9.49   99%: 13.28   99.5%: 14.86
///
/// Ref: Bar-Shalom & Fortmann, "Tracking and Data Association", Ch. 3
struct MahalanobisGate: Sendable {
    /// Chi-squared threshold for 4-DOF (default 9.49 = 95th percentile).
    /// Lower = stricter gating. Infinity = disabled.
    let chiSquaredThreshold: Double

    init(chiSquaredThreshold: Double = 9.49) {
        self.chiSquaredThreshold = chiSquaredThreshold
    }

    /// Check if a single track-detection pair passes.
    /// Returns true if d^2 < threshold.
    func passes(kalman: KalmanFilter7, measurement: [Double]) -> Bool {
        let d2 = kalman.mahalanobisSquared(to: measurement)
        return d2 < chiSquaredThreshold
    }

    /// Apply gate to all track-detection pairs.
    /// Returns boolean mask [numTracks][numDetections].
    func apply(
        tracks: [InternalTrack],
        predictedBoxes: [[Double]],
        detections: [TrackDetection]
    ) -> GateMask {
        let numTrks = tracks.count
        let numDets = detections.count

        guard numTrks > 0 && numDets > 0 else {
            let row = [Bool](repeating: true, count: numDets)
            return [[Bool]](repeating: row, count: numTrks)
        }

        var mask = GateMask(
            repeating: [Bool](repeating: false, count: numDets),
            count: numTrks
        )

        for t in 0..<numTrks {
            for d in 0..<numDets {
                let z = bboxToZ(detections[d].bbox)
                mask[t][d] = passes(kalman: tracks[t].kalman, measurement: z)
            }
        }
        return mask
    }
}

// MARK: - IoU Gate

/// Intersection-over-Union spatial overlap gate.
/// Rejects pairs with IoU below threshold.
struct IoUGate: Sendable {
    let threshold: Double

    init(threshold: Double = 0.3) {
        self.threshold = threshold
    }

    /// Apply gate to all pairs using predicted boxes.
    /// Returns boolean mask [numTracks][numDetections].
    func apply(
        tracks: [InternalTrack],
        predictedBoxes: [[Double]],
        detections: [TrackDetection]
    ) -> GateMask {
        let numTrks = predictedBoxes.count
        let numDets = detections.count

        guard numTrks > 0 && numDets > 0 else {
            let row = [Bool](repeating: true, count: numDets)
            return [[Bool]](repeating: row, count: numTrks)
        }

        var mask = GateMask(
            repeating: [Bool](repeating: false, count: numDets),
            count: numTrks
        )

        for t in 0..<numTrks {
            let trkBox = predictedBoxes[t]
            for d in 0..<numDets {
                let det = detections[d]
                let detBox = [det.bbox.x1, det.bbox.y1, det.bbox.x2, det.bbox.y2]
                let iou = IoUCompute.box(trkBox, detBox)
                mask[t][d] = iou >= threshold
            }
        }
        return mask
    }
}

// MARK: - Gating Pipeline

/// Composable pre-gating pipeline. Gates are applied in order.
/// Each gate can only reject (set false) — it cannot revive a pair rejected by an earlier gate.
///
/// Usage:
///   let pipeline = GatingPipeline(gates: [mahalanobisGate, iouGate])
///   let mask = pipeline.apply(tracks:tracks, predictedBoxes:boxes, detections:dets)
struct GatingPipeline: Sendable {
    let gates: [Gate]

    init(gates: [Gate]) {
        self.gates = gates
    }

    /// Apply all gates sequentially. A pair must pass ALL gates.
    func apply(
        tracks: [InternalTrack],
        predictedBoxes: [[Double]],
        detections: [TrackDetection]
    ) -> GateMask {
        let numTrks = tracks.count
        let numDets = detections.count

        guard numTrks > 0 && numDets > 0 else {
            return []
        }

        // Start with all-true mask
        var mask = GateMask(
            repeating: [Bool](repeating: true, count: numDets),
            count: numTrks
        )

        for gate in gates {
            let gateMask = gate.apply(
                tracks: tracks,
                predictedBoxes: predictedBoxes,
                detections: detections
            )
            // AND-combine: pair survives only if it passes this gate too
            for t in 0..<numTrks {
                for d in 0..<numDets {
                    mask[t][d] = mask[t][d] && gateMask[t][d]
                }
            }
        }

        return mask
    }

    /// Count surviving pairs after gating.
    func survivingCount(_ mask: GateMask) -> Int {
        mask.flatMap { $0 }.filter { $0 }.count
    }

    /// Extract surviving (trackIdx, detIdx) pairs from mask.
    func survivingPairs(_ mask: GateMask) -> [(track: Int, det: Int)] {
        var pairs: [(track: Int, det: Int)] = []
        for t in mask.indices {
            for d in mask[t].indices {
                if mask[t][d] {
                    pairs.append((track: t, det: d))
                }
            }
        }
        return pairs
    }
}

// MARK: - Gate Protocol

/// A single gate in the pipeline. Implement to create custom gates.
protocol Gate: Sendable {
    func apply(
        tracks: [InternalTrack],
        predictedBoxes: [[Double]],
        detections: [TrackDetection]
    ) -> GateMask
}

extension MahalanobisGate: Gate {}
extension IoUGate: Gate {}

// MARK: - Cost Matrix Protocol

/// Pluggable cost function for association. Computes cost for gated pairs only.
protocol CostFunction: Sendable {
    /// Compute cost matrix [numDets][numTrks] for the given pairs.
    /// Only pairs where gateMask[t][d] == true need valid costs;
    /// rejected pairs should have .greatestFiniteMagnitude.
    func compute(
        detections: [TrackDetection],
        predictedBoxes: [[Double]],
        gateMask: GateMask,
        velocities: [[Double]],
        kObservations: [[Double]],
        inertia: Double
    ) -> [[Double]]
}

// MARK: - OCM Cost (IoU + Direction Consistency)

/// Default OC-SORT cost: IoU + Observation-Centric Momentum (direction consistency).
/// Ref: arXiv:2203.14360 Sec 4.2
struct OCMCostFunction: CostFunction {
    func compute(
        detections: [TrackDetection],
        predictedBoxes: [[Double]],
        gateMask: GateMask,
        velocities: [[Double]],
        kObservations: [[Double]],
        inertia: Double
    ) -> [[Double]] {
        let numDets = detections.count
        let numTrks = predictedBoxes.count
        let inf = Double.greatestFiniteMagnitude

        var cost = [[Double]](
            repeating: [Double](repeating: inf, count: numTrks),
            count: numDets
        )

        // Direction consistency: angle between track velocity and det-from-kPrevObs direction
        for t in 0..<numTrks {
            let prevObs = kObservations[t]
            let validMask = prevObs.count >= 5 && prevObs[4] >= 0

            let prevCx: Double
            let prevCy: Double
            if validMask {
                prevCx = (prevObs[0] + prevObs[2]) / 2.0
                prevCy = (prevObs[1] + prevObs[3]) / 2.0
            } else {
                prevCx = 0; prevCy = 0
            }

            for d in 0..<numDets {
                guard gateMask[t][d] else { continue }

                // IoU
                let detBox = [detections[d].bbox.x1, detections[d].bbox.y1,
                              detections[d].bbox.x2, detections[d].bbox.y2]
                let iou = IoUCompute.box(predictedBoxes[t], detBox)

                // Direction cost (OCM)
                var angleCost = 0.0
                if validMask {
                    let detCx = (detections[d].bbox.x1 + detections[d].bbox.x2) / 2.0
                    let detCy = (detections[d].bbox.y1 + detections[d].bbox.y2) / 2.0
                    let dx = detCx - prevCx
                    let dy = detCy - prevCy
                    let norm = sqrt(dx * dx + dy * dy) + 1e-6
                    let dirX = dx / norm
                    let dirY = dy / norm

                    let velY = velocities[t][0]
                    let velX = velocities[t][1]
                    let cosSim = velX * dirX + velY * dirY
                    let clippedCos = max(-1.0, min(1.0, cosSim))
                    let angle = acos(clippedCos)
                    angleCost = (Double.pi / 2.0 - abs(angle)) / Double.pi
                    angleCost *= inertia * detections[d].confidence
                }

                cost[d][t] = -(iou + angleCost)
            }
        }

        return cost
    }
}

// MARK: - IoU-Only Cost (ByteTrack second-pass)

/// Simple IoU-only cost for ByteTrack second-pass association.
struct IoUCostFunction: CostFunction {
    func compute(
        detections: [TrackDetection],
        predictedBoxes: [[Double]],
        gateMask: GateMask,
        velocities: [[Double]],
        kObservations: [[Double]],
        inertia: Double
    ) -> [[Double]] {
        let numDets = detections.count
        let numTrks = predictedBoxes.count
        let inf = Double.greatestFiniteMagnitude

        var cost = [[Double]](
            repeating: [Double](repeating: inf, count: numTrks),
            count: numDets
        )

        for t in 0..<numTrks {
            for d in 0..<numDets {
                guard gateMask[t][d] else { continue }
                let detBox = [detections[d].bbox.x1, detections[d].bbox.y1,
                              detections[d].bbox.x2, detections[d].bbox.y2]
                cost[d][t] = -IoUCompute.box(predictedBoxes[t], detBox)
            }
        }

        return cost
    }
}

// MARK: - IoU Computation (shared)

/// Shared IoU computation used by gates and cost functions.
enum IoUCompute {
    /// IoU between two [x1, y1, x2, y2] boxes.
    static func box(_ a: [Double], _ b: [Double]) -> Double {
        precondition(a.count >= 4 && b.count >= 4)
        let xx1 = max(a[0], b[0])
        let yy1 = max(a[1], b[1])
        let xx2 = min(a[2], b[2])
        let yy2 = min(a[3], b[3])

        let w = max(0.0, xx2 - xx1)
        let h = max(0.0, yy2 - yy1)
        let inter = w * h

        let area1 = (a[2] - a[0]) * (a[3] - a[1])
        let area2 = (b[2] - b[0]) * (b[3] - b[1])
        let union = area1 + area2 - inter

        guard union > 0 else { return 0 }
        return inter / union
    }
}
