// OCSORT.swift
// OC-SORT (Observation-Centric SORT) multi-object tracker.
// Pure struct -- mutations protected by owning ObjectTrackingStage actor isolation.
// Kalman state: 8-dim [x, y, w, h, vx, vy, vw, vh] constant-velocity model.

import Foundation
import Accelerate

// MARK: - 8x8 Matrix

/// Fixed-size 8x8 matrix using flat array storage.
/// Used by KalmanFilter8 for state covariance operations.
struct Matrix8x8: Sendable {
    var elements: [Double]  // 64 elements, row-major

    init(zero: Void) {
        self.elements = [Double](repeating: 0, count: 64)
    }

    init(identity: Void) {
        self.elements = [Double](repeating: 0, count: 64)
        for i in 0..<8 { self.elements[i * 8 + i] = 1.0 }
    }

    init(diagonal values: [Double]) {
        self.init(zero: ())
        for i in 0..<min(8, values.count) { self.elements[i * 8 + i] = values[i] }
    }

    subscript(row: Int, col: Int) -> Double {
        get { elements[row * 8 + col] }
        set { elements[row * 8 + col] = newValue }
    }

    static func * (_ a: Matrix8x8, _ b: Matrix8x8) -> Matrix8x8 {
        var result = Matrix8x8(zero: ())
        for i in 0..<8 {
            for j in 0..<8 {
                var sum = 0.0
                for k in 0..<8 { sum += a[i, k] * b[k, j] }
                result[i, j] = sum
            }
        }
        return result
    }

    static func * (_ m: Matrix8x8, _ v: [Double]) -> [Double] {
        var result = [Double](repeating: 0, count: 8)
        for i in 0..<8 {
            for j in 0..<8 { result[i] += m[i, j] * v[j] }
        }
        return result
    }

    static func + (_ a: Matrix8x8, _ b: Matrix8x8) -> Matrix8x8 {
        var result = a
        for i in 0..<64 { result.elements[i] += b.elements[i] }
        return result
    }

    static func - (_ a: Matrix8x8, _ b: Matrix8x8) -> Matrix8x8 {
        var result = a
        for i in 0..<64 { result.elements[i] -= b.elements[i] }
        return result
    }

    func transposed() -> Matrix8x8 {
        var result = Matrix8x8(zero: ())
        for i in 0..<8 {
            for j in 0..<8 { result[j, i] = self[i, j] }
        }
        return result
    }

    /// Invert via Gauss-Jordan elimination.
    func inverse() -> Matrix8x8 {
        var aug = [Double](repeating: 0, count: 128)
        for i in 0..<8 {
            for j in 0..<8 { aug[i * 16 + j] = self[i, j] }
            aug[i * 16 + 8 + i] = 1.0
        }
        for col in 0..<8 {
            var maxRow = col
            for row in (col + 1)..<8 {
                if abs(aug[row * 16 + col]) > abs(aug[maxRow * 16 + col]) { maxRow = row }
            }
            if maxRow != col {
                for j in 0..<16 {
                    let tmp = aug[col * 16 + j]
                    aug[col * 16 + j] = aug[maxRow * 16 + j]
                    aug[maxRow * 16 + j] = tmp
                }
            }
            let pivot = aug[col * 16 + col]
            guard abs(pivot) > 1e-12 else { return Matrix8x8(identity: ()) }
            for j in 0..<16 { aug[col * 16 + j] /= pivot }
            for row in 0..<8 {
                guard row != col else { continue }
                let factor = aug[row * 16 + col]
                for j in 0..<16 { aug[row * 16 + j] -= factor * aug[col * 16 + j] }
            }
        }
        var result = Matrix8x8(zero: ())
        for i in 0..<8 {
            for j in 0..<8 { result[i, j] = aug[i * 16 + 8 + j] }
        }
        return result
    }
}

// MARK: - Kalman Filter (8-state)

/// 8-state Kalman filter: [x, y, w, h, vx, vy, vw, vh].
/// Constant-velocity model. Measurement is 4-dim [x, y, w, h].
struct KalmanFilter8: Sendable {
    var state: [Double]         // 8-element state vector
    var covariance: Matrix8x8   // 8x8 state covariance

    private let F: Matrix8x8    // State transition
    private let H: Matrix8x8    // Measurement matrix (4x8, stored as 8x8 with zeros)
    private let Q: Matrix8x8   // Process noise
    private let R: Matrix8x8    // Measurement noise

    init(xywh: [Double]) {
        precondition(xywh.count == 4, "Expected [x, y, w, h]")
        self.state = [xywh[0], xywh[1], xywh[2], xywh[3], 0, 0, 0, 0]

        // High initial velocity uncertainty
        self.covariance = Matrix8x8(diagonal: [
            2, 2, 2, 2,   // position uncertainty (low)
            10, 10, 10, 10 // velocity uncertainty (high)
        ])

        // State transition: constant velocity
        var f = Matrix8x8(identity: ())
        f[0, 4] = 1; f[1, 5] = 1; f[2, 6] = 1; f[3, 7] = 1
        self.F = f

        // Measurement matrix: observe position only
        var h = Matrix8x8(zero: ())
        h[0, 0] = 1; h[1, 1] = 1; h[2, 2] = 1; h[3, 3] = 1
        self.H = h

        // Process noise
        self.Q = Matrix8x8(diagonal: [1, 1, 1, 1, 0.01, 0.01, 0.01, 0.01])

        // Measurement noise
        self.R = Matrix8x8(diagonal: [1, 1, 1, 1])
    }

    /// Predict next state (called every frame for each track).
    mutating func predict() -> [Double] {
        state = F * state
        covariance = F * covariance * F.transposed() + Q
        return Array(state.prefix(4))  // predicted [x, y, w, h]
    }

    /// Update with measurement [x, y, w, h].
    mutating func update(measurement: [Double]) {
        precondition(measurement.count == 4)
        let Ht = H.transposed()
        let S = H * covariance * Ht + R
        let K = covariance * Ht * S.inverse()

        // Innovation: measurement - predicted measurement
        var y = [Double](repeating: 0, count: 8)
        for i in 0..<4 { y[i] = measurement[i] - (H * state)[i] }

        // State update
        let gain = K * y
        for i in 0..<8 { state[i] += gain[i] }

        // Covariance update: P = (I - K*H)*P
        let I = Matrix8x8(identity: ())
        let KH = K * H  // Approximate: K is 8x4 padded to 8x8
        covariance = (I - KH) * covariance
    }

    /// Current position as [x, y, w, h].
    var position: [Double] {
        Array(state.prefix(4))
    }
}

// MARK: - Internal Track State

/// Internal track used by OCSORT. Not exposed outside the tracker.
struct InternalTrack: Sendable {
    let id: Int
    var kalman: KalmanFilter8
    var hits: Int = 1
    var age: Int = 0            // Frames since creation
    var consecutiveMisses: Int = 0  // Frames since last detection
    var classLabel: String
    var confidence: Double
    var lastBbox: NormalizedBoundingBox
    var state: TrackState = .tentative
    /// OC-SORT: buffer of recent observations for re-update on rediscovery.
    var observationHistory: [[Double]] = []

    init(id: Int, detection: TrackDetection) {
        self.id = id
        self.kalman = KalmanFilter8(xywh: detection.xywh)
        self.classLabel = detection.classLabel
        self.confidence = detection.confidence
        self.lastBbox = detection.bbox
        self.observationHistory = [detection.xywh]
    }
}

// MARK: - OC-SORT Tracker

/// OC-SORT multi-object tracker.
/// Call `update(detections:)` each frame with the current detections.
/// Returns the current set of tracks (confirmed + tentative).
struct OCSORT: Sendable {
    private var tracks: [InternalTrack] = []
    private var nextId: Int = 1
    let iouThreshold: Double
    let maxAge: Int
    let minHits: Int
    let maxTracks: Int

    init(iouThreshold: Double = 0.3, maxAge: Int = 30, minHits: Int = 3, maxTracks: Int = 0) {
        self.iouThreshold = iouThreshold
        self.maxAge = maxAge
        self.minHits = minHits
        self.maxTracks = maxTracks
    }

    // MARK: - Public Interface

    /// Process one frame of detections. Returns all active tracks.
    mutating func update(detections: [TrackDetection], timestamp: Double) -> [Track] {
        // Step 1: Predict all existing tracks forward
        var predictedBoxes: [[Double]] = []
        for i in tracks.indices {
            let pred = tracks[i].kalman.predict()
            predictedBoxes.append(pred)
            tracks[i].age += 1
            tracks[i].consecutiveMisses += 1
        }

        // Step 2: Build cost matrix (1 - IoU) between predicted and detected
        let costMatrix = buildCostMatrix(predicted: predictedBoxes, detections: detections)

        // Step 3: Hungarian assignment
        let matched = hungarianAssignment(costMatrix: costMatrix, gateThreshold: 1.0 - iouThreshold)

        // Track which rows/cols were matched
        var matchedTrackIndices = Set<Int>()
        var matchedDetIndices = Set<Int>()

        // Step 4: Update matched tracks
        for match in matched {
            guard match.row < tracks.count && match.col < detections.count else { continue }
            let trackIdx = match.row
            let det = detections[match.col]

            tracks[trackIdx].kalman.update(measurement: det.xywh)
            tracks[trackIdx].hits += 1
            tracks[trackIdx].consecutiveMisses = 0
            tracks[trackIdx].confidence = det.confidence
            tracks[trackIdx].lastBbox = det.bbox
            tracks[trackIdx].classLabel = det.classLabel
            tracks[trackIdx].observationHistory.append(det.xywh)
            if tracks[trackIdx].observationHistory.count > 50 {
                tracks[trackIdx].observationHistory.removeFirst()
            }
            // OC-SORT: re-update with observation history when rediscovered
            if tracks[trackIdx].state == .lost {
                tracks[trackIdx].state = .confirmed
            }
            if tracks[trackIdx].hits >= minHits {
                tracks[trackIdx].state = .confirmed
            }
            matchedTrackIndices.insert(trackIdx)
            matchedDetIndices.insert(match.col)
        }

        // Step 5: Mark unmatched tracks as lost
        for i in tracks.indices where !matchedTrackIndices.contains(i) {
            tracks[i].consecutiveMisses += 1
            if tracks[i].state == .confirmed {
                tracks[i].state = .lost
            }
        }

        // Step 6: Create new tracks for unmatched detections
        if maxTracks == 0 || tracks.count < maxTracks {
            for detIdx in detections.indices where !matchedDetIndices.contains(detIdx) {
                let newTrack = InternalTrack(id: nextId, detection: detections[detIdx])
                tracks.append(newTrack)
                nextId += 1
            }
        }

        // Step 7: Delete old tracks that exceeded maxAge
        tracks.removeAll { $0.consecutiveMisses > maxAge }

        // Build result
        return tracks.map { t in
            Track(
                trackId: t.id,
                bbox: t.lastBbox,
                classLabel: t.classLabel,
                confidence: t.confidence,
                state: t.state,
                age: t.consecutiveMisses,
                hits: t.hits,
                lastSeenTimestamp: timestamp
            )
        }
    }

    /// Reset tracker state.
    mutating func reset() {
        tracks.removeAll()
        nextId = 1
    }

    // MARK: - IoU Computation

    private func buildCostMatrix(predicted: [[Double]], detections: [TrackDetection]) -> [[Double]] {
        guard !predicted.isEmpty && !detections.isEmpty else { return [] }
        var cost = [[Double]](
            repeating: [Double](repeating: 1.0, count: detections.count),
            count: predicted.count
        )
        for (i, pred) in predicted.enumerated() {
            for (j, det) in detections.enumerated() {
                cost[i][j] = 1.0 - iou(box1: pred, box2: det.xywh)
            }
        }
        return cost
    }

    /// IoU between two [x, y, w, h] boxes.
    private func iou(box1: [Double], box2: [Double]) -> Double {
        let x1 = max(box1[0] - box1[2] / 2, box2[0] - box2[2] / 2)
        let y1 = max(box1[1] - box1[3] / 2, box2[1] - box2[3] / 2)
        let x2 = min(box1[0] + box1[2] / 2, box2[0] + box2[2] / 2)
        let y2 = min(box1[1] + box1[3] / 2, box2[1] + box2[3] / 2)

        let interW = max(0, x2 - x1)
        let interH = max(0, y2 - y1)
        let inter = interW * interH

        let area1 = box1[2] * box1[3]
        let area2 = box2[2] * box2[3]
        let union = area1 + area2 - inter

        guard union > 0 else { return 0 }
        return inter / union
    }
}
