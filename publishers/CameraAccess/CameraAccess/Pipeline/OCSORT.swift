// OCSORT.swift
// OC-SORT (Observation-Centric SORT) multi-object tracker.
// Paper: arXiv:2203.14360 (CVPR 2023)
// Ref: noahcao/OC_SORT trackers/ocsort_tracker/ocsort.py
//
// Faithful implementation of the three OC-SORT innovations:
//   Sec 4.1: ORU — Observation-Centric Re-Update (virtual trajectory on rediscovery)
//   Sec 4.2: OCM — Observation-Centric Momentum (direction-consistent association)
//   Sec 4.3: OCR — Observation-Centric Recovery (second-round match on last_obs)
//
// Kalman state: 7-dim [x, y, s, r, vx, vy, vs] constant-velocity model.
// Observation: 4-dim [x, y, s, r] where s=area, r=aspect ratio.
// Pure struct — mutations protected by owning ObjectTrackingStage actor isolation.

import Foundation

// MARK: - 7x7 Matrix

/// Fixed-size 7x7 matrix using flat array storage.
/// Used by KalmanFilter7 for state covariance operations.
struct Matrix7x7: Sendable {
    var elements: [Double] // 49 elements, row-major

    init(zero: Void) {
        self.elements = [Double](repeating: 0, count: 49)
    }

    init(identity: Void) {
        self.elements = [Double](repeating: 0, count: 49)
        for i in 0..<7 { self.elements[i * 7 + i] = 1.0 }
    }

    init(diagonal values: [Double]) {
        self.init(zero: ())
        for i in 0..<min(7, values.count) { self.elements[i * 7 + i] = values[i] }
    }

    subscript(row: Int, col: Int) -> Double {
        get { elements[row * 7 + col] }
        set { elements[row * 7 + col] = newValue }
    }

    static func * (_ a: Matrix7x7, _ b: Matrix7x7) -> Matrix7x7 {
        var result = Matrix7x7(zero: ())
        for i in 0..<7 {
            for j in 0..<7 {
                var sum = 0.0
                for k in 0..<7 { sum += a[i, k] * b[k, j] }
                result[i, j] = sum
            }
        }
        return result
    }

    /// Matrix-vector multiply: 7x7 * [Double](7) -> [Double](7)
    static func * (_ m: Matrix7x7, _ v: [Double]) -> [Double] {
        var result = [Double](repeating: 0, count: 7)
        for i in 0..<7 {
            for j in 0..<7 { result[i] += m[i, j] * v[j] }
        }
        return result
    }

    static func + (_ a: Matrix7x7, _ b: Matrix7x7) -> Matrix7x7 {
        var result = a
        for i in 0..<49 { result.elements[i] += b.elements[i] }
        return result
    }

    static func - (_ a: Matrix7x7, _ b: Matrix7x7) -> Matrix7x7 {
        var result = a
        for i in 0..<49 { result.elements[i] -= b.elements[i] }
        return result
    }

    func transposed() -> Matrix7x7 {
        var result = Matrix7x7(zero: ())
        for i in 0..<7 {
            for j in 0..<7 { result[j, i] = self[i, j] }
        }
        return result
    }

    /// Invert via Gauss-Jordan elimination.
    func inverse() -> Matrix7x7 {
        var aug = [Double](repeating: 0, count: 98) // 7 * (7+7)
        for i in 0..<7 {
            for j in 0..<7 { aug[i * 14 + j] = self[i, j] }
            aug[i * 14 + 7 + i] = 1.0
        }
        for col in 0..<7 {
            var maxRow = col
            for row in (col + 1)..<7 {
                if abs(aug[row * 14 + col]) > abs(aug[maxRow * 14 + col]) { maxRow = row }
            }
            if maxRow != col {
                for j in 0..<14 {
                    let tmp = aug[col * 14 + j]
                    aug[col * 14 + j] = aug[maxRow * 14 + j]
                    aug[maxRow * 14 + j] = tmp
                }
            }
            let pivot = aug[col * 14 + col]
            guard abs(pivot) > 1e-12 else { return Matrix7x7(identity: ()) }
            for j in 0..<14 { aug[col * 14 + j] /= pivot }
            for row in 0..<7 {
                guard row != col else { continue }
                let factor = aug[row * 14 + col]
                for j in 0..<14 { aug[row * 14 + j] -= factor * aug[col * 14 + j] }
            }
        }
        var result = Matrix7x7(zero: ())
        for i in 0..<7 {
            for j in 0..<7 { result[i, j] = aug[i * 14 + 7 + j] }
        }
        return result
    }
}

// MARK: - 4x7 and 4x4 Matrix helpers

/// Fixed-size 4x7 matrix for the observation model H.
/// Stored row-major: 4 rows x 7 cols = 28 elements.
struct Matrix4x7: Sendable {
    var elements: [Double] // 28 elements, row-major

    init(zero: Void) {
        self.elements = [Double](repeating: 0, count: 28)
    }

    subscript(row: Int, col: Int) -> Double {
        get { elements[row * 7 + col] }
        set { elements[row * 7 + col] = newValue }
    }

    /// H * P (4x7 * 7x7) -> 4x4
    func mul7x7(_ m: Matrix7x7) -> Matrix4x4 {
        var result = Matrix4x4(zero: ())
        for i in 0..<4 {
            for j in 0..<4 {
                var sum = 0.0
                for k in 0..<7 { sum += self[i, k] * m[k, j] }
                result[i, j] = sum
            }
        }
        return result
    }

    /// H * state (4x7 * 7-vector) -> 4-vector
    func mulVec(_ v: [Double]) -> [Double] {
        var result = [Double](repeating: 0, count: 4)
        for i in 0..<4 {
            for j in 0..<7 { result[i] += self[i, j] * v[j] }
        }
        return result
    }

    func transposed() -> Matrix7x4 {
        var result = Matrix7x4(zero: ())
        for i in 0..<4 {
            for j in 0..<7 { result[j, i] = self[i, j] }
        }
        return result
    }
}

/// Fixed-size 7x4 matrix for H^T.
/// Stored row-major: 7 rows x 4 cols = 28 elements.
struct Matrix7x4: Sendable {
    var elements: [Double]

    init(zero: Void) {
        self.elements = [Double](repeating: 0, count: 28)
    }

    subscript(row: Int, col: Int) -> Double {
        get { elements[row * 4 + col] }
        set { elements[row * 4 + col] = newValue }
    }

    /// P * H^T (7x7 * 7x4) -> 7x4
    func mul7x7(_ m: Matrix7x7) -> Matrix7x4 {
        var result = Matrix7x4(zero: ())
        for i in 0..<7 {
            for j in 0..<4 {
                var sum = 0.0
                for k in 0..<7 { sum += m[i, k] * self[k, j] }
                result[i, j] = sum
            }
        }
        return result
    }

    /// K * innovation (7x4 * 4-vector) -> 7-vector
    func mulVec(_ v: [Double]) -> [Double] {
        var result = [Double](repeating: 0, count: 7)
        for i in 0..<7 {
            for j in 0..<4 { result[i] += self[i, j] * v[j] }
        }
        return result
    }

    /// K * H (7x4 * 4x7) -> 7x7
    func mul4x7(_ m: Matrix4x7) -> Matrix7x7 {
        var result = Matrix7x7(zero: ())
        for i in 0..<7 {
            for j in 0..<7 {
                var sum = 0.0
                for k in 0..<4 { sum += self[i, k] * m[k, j] }
                result[i, j] = sum
            }
        }
        return result
    }
}

/// Fixed-size 4x4 matrix for measurement noise and innovation covariance.
struct Matrix4x4: Sendable {
    var elements: [Double] // 16 elements, row-major

    init(zero: Void) {
        self.elements = [Double](repeating: 0, count: 16)
    }

    init(diagonal values: [Double]) {
        self.init(zero: ())
        for i in 0..<min(4, values.count) { self.elements[i * 4 + i] = values[i] }
    }

    subscript(row: Int, col: Int) -> Double {
        get { elements[row * 4 + col] }
        set { elements[row * 4 + col] = newValue }
    }

    static func + (_ a: Matrix4x4, _ b: Matrix4x4) -> Matrix4x4 {
        var result = a
        for i in 0..<16 { result.elements[i] += b.elements[i] }
        return result
    }

    func inverse() -> Matrix4x4 {
        var aug = [Double](repeating: 0, count: 32) // 4 * (4+4)
        for i in 0..<4 {
            for j in 0..<4 { aug[i * 8 + j] = self[i, j] }
            aug[i * 8 + 4 + i] = 1.0
        }
        for col in 0..<4 {
            var maxRow = col
            for row in (col + 1)..<4 {
                if abs(aug[row * 8 + col]) > abs(aug[maxRow * 8 + col]) { maxRow = row }
            }
            if maxRow != col {
                for j in 0..<8 {
                    let tmp = aug[col * 8 + j]
                    aug[col * 8 + j] = aug[maxRow * 8 + j]
                    aug[maxRow * 8 + j] = tmp
                }
            }
            let pivot = aug[col * 8 + col]
            guard abs(pivot) > 1e-12 else { return Matrix4x4(diagonal: [1, 1, 1, 1]) }
            for j in 0..<8 { aug[col * 8 + j] /= pivot }
            for row in 0..<4 {
                guard row != col else { continue }
                let factor = aug[row * 8 + col]
                for j in 0..<8 { aug[row * 8 + j] -= factor * aug[col * 8 + j] }
            }
        }
        var result = Matrix4x4(zero: ())
        for i in 0..<4 {
            for j in 0..<4 { result[i, j] = aug[i * 8 + 4 + j] }
        }
        return result
    }
}

// MARK: - Kalman Filter (7-state)

/// 7-state Kalman filter: [x, y, s, r, vx, vy, vs].
/// Constant-velocity model. Observation is 4-dim [x, y, s, r].
/// Paper: arXiv:2203.14360 — noise params from KalmanBoxTracker.__init__
struct KalmanFilter7: Sendable {
    var state: [Double]       // 7-element state vector
    var covariance: Matrix7x7 // 7x7 state covariance

    private let F: Matrix7x7  // State transition (7x7)
    private let H: Matrix4x7  // Measurement matrix (4x7)
    private let Q: Matrix7x7  // Process noise (7x7)
    private let R: Matrix4x4  // Measurement noise (4x4)

    init(z: [Double]) {
        precondition(z.count == 4, "Expected [x, y, s, r]")
        self.state = [z[0], z[1], z[2], z[3], 0, 0, 0]

        // Paper: P *= 10, P[4:,4:] *= 1000
        // Combined: diag position = 10, diag velocity = 10000
        self.covariance = Matrix7x7(diagonal: [
            10, 10, 10, 10,      // position: P *= 10
            10000, 10000, 10000   // velocity: P *= 10, then P[4:,4:] *= 1000
        ])

        // State transition: constant velocity model (7x7)
        // Paper: KalmanBoxTracker._F
        var f = Matrix7x7(identity: ())
        f[0, 4] = 1  // x += vx
        f[1, 5] = 1  // y += vy
        f[2, 6] = 1  // s += vs
        self.F = f

        // Measurement matrix: observe [x, y, s, r] (4x7)
        // Paper: KalmanBoxTracker._H
        var h = Matrix4x7(zero: ())
        h[0, 0] = 1  // observe x
        h[1, 1] = 1  // observe y
        h[2, 2] = 1  // observe s
        h[3, 3] = 1  // observe r
        self.H = h

        // Process noise: Q[-1,-1] *= 0.01, Q[4:,4:] *= 0.01
        // Start with identity, then scale
        var q = Matrix7x7(identity: ())
        q[4, 4] = 0.01
        q[5, 5] = 0.01
        q[6, 6] = 0.01 * 0.01 // Q[-1,-1] *= 0.01 on top of Q[4:,4:] *= 0.01
        self.Q = q

        // Measurement noise: R[2:,2:] *= 10
        // R starts as identity(4), then scale rows/cols 2-3 by 10
        self.R = Matrix4x4(diagonal: [1, 1, 10, 10])
    }

    /// Predict next state (called every frame for each track).
    mutating func predict() -> [Double] {
        // Paper: if (x[6] + x[2]) <= 0, zero out vs
        if state[6] + state[2] <= 0 {
            state[6] = 0.0
        }

        state = F * state
        covariance = F * covariance * F.transposed() + Q
        return Array(state.prefix(4)) // predicted [x, y, s, r]
    }

    /// Update with measurement [x, y, s, r].
    /// Paper: KalmanBoxTracker.update — standard KF update cycle.
    mutating func update(measurement: [Double]) {
        precondition(measurement.count == 4)
        let Ht = H.transposed() // 7x4

        // PHt = P * H^T (7x7 * 7x4 -> 7x4)
        var PHt = Matrix7x4(zero: ())
        for i in 0..<7 {
            for j in 0..<4 {
                var sum = 0.0
                for k in 0..<7 { sum += covariance[i, k] * Ht[k, j] }
                PHt[i, j] = sum
            }
        }

        // S = H * PHt + R (4x7 * 7x4 + 4x4 -> 4x4)
        var S = Matrix4x4(zero: ())
        for i in 0..<4 {
            for j in 0..<4 {
                var sum = 0.0
                for k in 0..<7 { sum += H[i, k] * PHt[k, j] }
                S[i, j] = sum + R[i, j]
            }
        }

        let SI = S.inverse() // 4x4

        // K = P * H^T * S^{-1} (7x4)
        var K = Matrix7x4(zero: ())
        for i in 0..<7 {
            for j in 0..<4 {
                var sum = 0.0
                for k in 0..<4 { sum += PHt[i, k] * SI[k, j] }
                K[i, j] = sum
            }
        }

        // Innovation: y = z - H * x (4-vector)
        let Hx = H.mulVec(state) // 4-vector
        var innovation = [Double](repeating: 0, count: 4)
        for i in 0..<4 { innovation[i] = measurement[i] - Hx[i] }

        // State update: x = x + K * y
        let gain = K.mulVec(innovation) // 7-vector
        for i in 0..<7 { state[i] += gain[i] }

        // Covariance update: P = (I - K*H)*P*(I - K*H)^T + K*R*K^T
        // Joseph form for numerical stability (matches reference kalmanfilter.py)
        let KH = K.mul4x7(H) // 7x4 * 4x7 -> 7x7
        var I_KH = Matrix7x7(identity: ())
        for i in 0..<49 { I_KH.elements[i] -= KH.elements[i] }

        let I_KH_P = I_KH * covariance // 7x7 * 7x7
        let I_KH_P_IKHt = I_KH_P * I_KH.transposed() // 7x7

        // K * R * K^T (7x4 * 4x4 * 4x7)
        // KR = K * R (7x4 * 4x4 -> 7x4)
        var KR = Matrix7x4(zero: ())
        for i in 0..<7 {
            for j in 0..<4 {
                var sum = 0.0
                for k in 0..<4 { sum += K[i, k] * R[k, j] }
                KR[i, j] = sum
            }
        }
        // KRKt = KR * K^T (7x4 * 4x7 -> 7x7)
        var KRKt = Matrix7x7(zero: ())
        for i in 0..<7 {
            for j in 0..<7 {
                var sum = 0.0
                for k in 0..<4 { sum += KR[i, k] * K[j, k] }
                KRKt[i, j] = sum
            }
        }

        covariance = I_KH_P_IKHt + KRKt
    }

    /// Current state as [x, y, s, r].
    var position: [Double] {
        Array(state.prefix(4))
    }

    // MARK: - Mahalanobis Gating

    /// Compute squared Mahalanobis distance from predicted state to measurement.
    /// d^2 = (z - H*x)^T * S^{-1} * (z - H*x), where S = H*P*H^T + R.
    /// Returns d^2 (squared distance). Compare against chi-squared threshold.
    /// Used for pre-gating: reject impossible matches before expensive Hungarian solve.
    func mahalanobisSquared(to measurement: [Double]) -> Double {
        precondition(measurement.count == 4, "Expected [x, y, s, r]")

        // Innovation: y = z - H * x
        let Hx = H.mulVec(state)
        var innov = [Double](repeating: 0, count: 4)
        for i in 0..<4 { innov[i] = measurement[i] - Hx[i] }

        // Innovation covariance: S = H * P * H^T + R
        let Ht = H.transposed() // 7x4

        // PHt = P * H^T (7x4)
        var PHt = Matrix7x4(zero: ())
        for i in 0..<7 {
            for j in 0..<4 {
                var sum = 0.0
                for k in 0..<7 { sum += covariance[i, k] * Ht[k, j] }
                PHt[i, j] = sum
            }
        }

        // S = H * PHt + R (4x4)
        var S = Matrix4x4(zero: ())
        for i in 0..<4 {
            for j in 0..<4 {
                var sum = 0.0
                for k in 0..<7 { sum += H[i, k] * PHt[k, j] }
                S[i, j] = sum + R[i, j]
            }
        }

        let SI = S.inverse()

        // d^2 = innov^T * S^{-1} * innov
        var SIy = [Double](repeating: 0, count: 4)
        for i in 0..<4 {
            for j in 0..<4 { SIy[i] += SI[i, j] * innov[j] }
        }
        var d2 = 0.0
        for i in 0..<4 { d2 += innov[i] * SIy[i] }

        // Guard against NaN from degenerate covariance
        return d2.isNaN ? .infinity : d2
    }
}

// MARK: - Bbox Conversion

/// [x1, y1, x2, y2] -> [x, y, s, r] where x,y is center, s=area, r=aspect ratio.
/// Ref: noahcao/OC_SORT convert_bbox_to_z
func bboxToZ(_ bbox: NormalizedBoundingBox) -> [Double] {
    let w = bbox.x2 - bbox.x1
    let h = bbox.y2 - bbox.y1
    let cx = bbox.x1 + w / 2.0
    let cy = bbox.y1 + h / 2.0
    let s = w * h // scale = area
    let r = w / (h + 1e-6) // aspect ratio
    return [cx, cy, s, r]
}

/// [x, y, s, r] -> NormalizedBoundingBox [x1, y1, x2, y2].
/// Ref: noahcao/OC_SORT convert_x_to_bbox
func zToBbox(_ z: [Double]) -> NormalizedBoundingBox {
    precondition(z.count >= 4, "Expected [x, y, s, r]")
    let w = sqrt(z[2] * z[3]) // w = sqrt(s * r)
    let h = z[2] / (w + 1e-6)  // h = s / w
    return NormalizedBoundingBox(
        x1: z[0] - w / 2.0,
        y1: z[1] - h / 2.0,
        x2: z[0] + w / 2.0,
        y2: z[1] + h / 2.0
    )
}

/// Convert [x, y, s, r] state to [x1, y1, x2, y2] array.
/// Ref: noahcao/OC_SORT convert_x_to_bbox (without score)
func stateToBboxArray(_ z: [Double]) -> [Double] {
    precondition(z.count >= 4)
    let w = sqrt(z[2] * z[3])
    let h = z[2] / (w + 1e-6)
    return [z[0] - w / 2.0, z[1] - h / 2.0, z[0] + w / 2.0, z[1] + h / 2.0]
}

// MARK: - Internal Track State

/// Internal track used by OCSORT. Not exposed outside the tracker.
/// Paper: arXiv:2203.14360 — KalmanBoxTracker
struct InternalTrack: Sendable {
    let id: Int
    var kalman: KalmanFilter7

    /// Total frames since track creation (incremented in predict).
    var age: Int = 0

    /// Frames since last detection match.
    var timeSinceUpdate: Int = 0

    /// Total successful detection matches.
    var hits: Int = 0

    /// Consecutive frames with detection (reset to 0 on miss).
    var hitStreak: Int = 0

    /// Detection class label.
    var classLabel: String

    /// Most recent detection confidence.
    var confidence: Double

    // Paper Sec 4.1: observations keyed by age, value is [x1, y1, x2, y2, score]
    var observations: [Int: [Double]] = [:]

    // Paper Sec 4.1: most recent detection bbox [x1, y1, x2, y2].
    // nil if never observed. Stored WITHOUT score (just 4 coords).
    var lastObservation: [Double]?

    // Paper Sec 4.2: velocity direction from observations, NOT from KF state.
    // [dy, dx] normalized direction vector. nil if not yet computed.
    var velocity: [Double]?

    /// The delta_t parameter for velocity estimation.
    let deltaT: Int

    /// Track state for external reporting.
    var state: TrackState = .tentative

    /// Trail of center points for visualization. Max 30 points.
    var trail: [(x: Double, y: Double)] = []

    /// Appearance gallery for Bhattacharyya and ReID gates.
    /// nil when no appearance gates are configured (zero overhead).
    var appearanceGallery: AppearanceGallery?

    /// Whether this track has been observed at least once (for ORU).
    var hasBeenObserved: Bool = false

    init(id: Int, detection: TrackDetection, deltaT: Int = 3) {
        self.id = id
        self.classLabel = detection.classLabel
        self.confidence = detection.confidence
        self.deltaT = deltaT

        // Initialize KF with z-vector from detection bbox
        let z = bboxToZ(detection.bbox)
        self.kalman = KalmanFilter7(z: z)

        // Store initial observation as [x1, y1, x2, y2, score]
        // age starts at 0, will be incremented in predict before first observation key
        self.observations = [0: [
            detection.bbox.x1, detection.bbox.y1,
            detection.bbox.x2, detection.bbox.y2,
            detection.confidence
        ]]
        self.lastObservation = [
            detection.bbox.x1, detection.bbox.y1,
            detection.bbox.x2, detection.bbox.y2
        ]
        self.hasBeenObserved = true
        self.hits = 1
        self.hitStreak = 1

        // Trail: store center
        let cx = (detection.bbox.x1 + detection.bbox.x2) / 2.0
        let cy = (detection.bbox.y1 + detection.bbox.y2) / 2.0
        self.trail = [(x: cx, y: cy)]
    }
}

// MARK: - OC-SORT Tracker

/// OC-SORT multi-object tracker.
/// Paper: arXiv:2203.14360 (CVPR 2023)
/// Ref: noahcao/OC_SORT trackers/ocsort_tracker/ocsort.py
struct OCSORT: Sendable {
    private var tracks: [InternalTrack] = []
    private var nextId: Int = 1
    private var frameCount: Int = 0

    // Paper: key parameters from OCSort.__init__
    let detThresh: Double       // 0.5 — detection confidence threshold
    let maxAge: Int             // 30 — frames before track deletion
    let minHits: Int            // 3 — consecutive hits to confirm
    let iouThreshold: Double    // 0.3 — IoU gate for association
    let deltaT: Int             // 3 — steps back for velocity estimation
    let inertia: Double         // 0.2 — OCM direction weight
    let maxTracks: Int          // 0 — unlimited
    // ByteTrack: match low-confidence detections against remaining tracks.
    // Ref: arXiv:2110.06864 — two-pass association rescues partially occluded objects.
    let useByte: Bool           // false — disabled by default

    // Gating pipeline
    let gatingPipeline: GatingPipeline
    let activeCostFunction: CostFunction
    let iouCostFunction: IoUCostFunction
    let ocmCostFunction: OCMCostFunction

    init(
        detThresh: Double = 0.5,
        maxAge: Int = 30,
        minHits: Int = 3,
        iouThreshold: Double = 0.3,
        deltaT: Int = 3,
        inertia: Double = 0.2,
        maxTracks: Int = 0,
        useByte: Bool = false,
        gates: [GateConfig] = [],
        costFunctionType: String? = nil
    ) {
        self.detThresh = detThresh
        self.maxAge = maxAge
        self.minHits = minHits
        self.iouThreshold = iouThreshold
        self.deltaT = deltaT
        self.inertia = inertia
        self.maxTracks = maxTracks
        self.useByte = useByte

        // Build gating pipeline from workflow gate chain.
        // If no gates provided, use default IoU gating at iouThreshold.
        let builtGates: [Gate]
        if gates.isEmpty {
            builtGates = [IoUGate(threshold: iouThreshold)]
        } else {
            builtGates = gates.map { gateConfig in
                switch gateConfig.gateType {
                case "gate-mahalanobis":
                    let chiSq = gateConfig.params["chiSquaredThreshold"] ?? 9.49
                    return MahalanobisGate(chiSquaredThreshold: chiSq) as Gate
                case "gate-iou":
                    let threshold = gateConfig.params["iouThreshold"] ?? iouThreshold
                    return IoUGate(threshold: threshold) as Gate
                case "gate-bhattacharyya":
                    let dist = gateConfig.params["histDistance"] ?? 0.5
                    let cs = gateConfig.params["colorSpace"] == 1 ? "rgb" : "hsv"
                    return BhattacharyyaGate(histDistance: dist, colorSpace: cs) as Gate
                case "gate-reid":
                    let embedDist = gateConfig.params["embedDistance"] ?? 0.5
                    let model = gateConfig.params["model"] == 0 ? "osnet-x025" :
                                gateConfig.params["model"] == 2 ? "osnet-x10" : "osnet-x05"
                    let gallery = Int(gateConfig.params["gallerySize"] ?? 10)
                    return ReIDGate(embedDistance: embedDist, model: model, gallerySize: gallery) as Gate
                default:
                    // Unknown gate type — fall through to IoU
                    return IoUGate(threshold: iouThreshold) as Gate
                }
            }
        }
        self.gatingPipeline = GatingPipeline(gates: builtGates)
        self.ocmCostFunction = OCMCostFunction()
        self.iouCostFunction = IoUCostFunction()
        switch costFunctionType {
        case "cost-iou":
            self.activeCostFunction = iouCostFunction
        default:
            self.activeCostFunction = ocmCostFunction
        }
    }

    // MARK: - Public Interface

    /// Process one frame of detections. Returns all active tracks.
    /// Paper: OCSort.update() — splits detections by detThresh for association.
    mutating func update(detections: [TrackDetection], timestamp: Double) -> [Track] {
        frameCount += 1

        // Paper: split detections by confidence threshold.
        // High-confidence (> detThresh) used for first-pass association.
        // Low-confidence (0.1..detThresh) optionally used for ByteTrack second-pass.
        // Ref: arXiv:2203.14360 Sec 3.3, noahcao/OC_SORT OCSort.update
        // Ref: arXiv:2110.06864 ByteTrack — low-confidence rescues partially occluded objects.
        let highConfDets = detections.filter { $0.confidence > detThresh }
        let lowConfDets = useByte ? detections.filter { $0.confidence > 0.1 && $0.confidence <= detThresh } : []

        // Step 1: Predict all existing tracks forward
        // Paper: "get predicted locations from existing trackers"
        var predictedBoxes: [[Double]] = [] // [x1, y1, x2, y2] per track
        var toDelete: [Int] = []

        for i in tracks.indices {
            let pred = tracks[i].kalman.predict()
            let bboxArray = stateToBboxArray(pred)
            predictedBoxes.append(bboxArray)
            tracks[i].age += 1
            tracks[i].timeSinceUpdate += 1

            // Reset hit streak on miss
            if tracks[i].timeSinceUpdate > 1 {
                tracks[i].hitStreak = 0
            }

            // Remove tracks with NaN predictions
            if bboxArray.contains(where: { $0.isNaN }) {
                toDelete.append(i)
            }
        }

        // Remove invalid tracks (reversed to preserve indices)
        for idx in toDelete.reversed() {
            tracks.remove(at: idx)
            predictedBoxes.remove(at: idx)
        }

        guard !detections.isEmpty || !tracks.isEmpty else {
            return []
        }

        // Step 2: Collect track metadata for association
        // Paper Sec 4.2: velocities from observations
        var velocities: [[Double]] = [] // [dy, dx] per track
        var lastBoxes: [[Double]] = []  // last_observation [x1,y1,x2,y2] per track
        var kObservations: [[Double]] = [] // observation delta_t steps back

        for i in tracks.indices {
            // Velocity from InternalTrack (computed during update)
            if let vel = tracks[i].velocity {
                velocities.append(vel)
            } else {
                velocities.append([0, 0])
            }

            // Last observation for OCR (Sec 4.3)
            if let last = tracks[i].lastObservation {
                lastBoxes.append(last)
            } else {
                // Placeholder: [-1, -1, -1, -1] means no previous observation
                lastBoxes.append([-1, -1, -1, -1])
            }

            // k_previous_obs: observation delta_t steps back
            kObservations.append(kPreviousObs(for: tracks[i]))
        }

        // Step 3: First association with OCM (high-confidence detections only)
        // Paper Sec 4.2: OCM — Observation-Centric Momentum
        // Paper Sec 3.3: only detections above detThresh enter first-round matching
        let (matched, unmatchedDets, unmatchedTrks) = associate(
            detections: highConfDets,
            trackers: predictedBoxes,
            iouThreshold: iouThreshold,
            velocities: velocities,
            kObservations: kObservations,
            inertia: inertia
        )

        // Step 4: Update matched tracks
        var matchedTrackIndices = Set<Int>()
        var matchedDetIndices = Set<Int>()

        for m in matched {
            let detIdx = m.0
            let trkIdx = m.1
            guard trkIdx < tracks.count && detIdx < highConfDets.count else { continue }

            let det = highConfDets[detIdx]
            // Extract-modify-assign to avoid exclusive access violation
            var trk = tracks[trkIdx]
            updateTrack(&trk, with: det)
            tracks[trkIdx] = trk

            matchedTrackIndices.insert(trkIdx)
            matchedDetIndices.insert(detIdx)
        }

        // Step 5: Second association — OCR (Observation-Centric Recovery)
        // Paper Sec 4.3: match unmatched detections against last observations of unmatched tracks
        var unmatchedDetsAfterOCR = unmatchedDets
        var unmatchedTrksAfterOCR = unmatchedTrks

        if !unmatchedDets.isEmpty && !unmatchedTrks.isEmpty {
            let leftDets = unmatchedDets.map { highConfDets[$0] }
            let leftTrks = unmatchedTrks.map { lastBoxes[$0] }

            // IoU between unmatched detections and last observations
            let iouLeft = iouBatch(detections: leftDets, trackerBoxes: leftTrks)

            if iouLeft.count > 0 && iouLeft[0].count > 0 {
                let maxIou = iouLeft.flatMap { $0 }.max() ?? 0
                if maxIou > iouThreshold {
                    // Hungarian matching on -IoU
                    let costMatrix = iouLeft.map { row in row.map { -$0 } }
                    let rematched = hungarianAssignment(
                        costMatrix: costMatrix,
                        gateThreshold: 1.0 // We gate manually below
                    )

                    var toRemoveDet = Set<Int>()
                    var toRemoveTrk = Set<Int>()

                    for m in rematched {
                        let detIdx = unmatchedDets[m.row]
                        let trkIdx = unmatchedTrks[m.col]

                        if iouLeft[m.row][m.col] < iouThreshold {
                            continue
                        }

                        // Paper Sec 4.3: recover lost track
                        var trk = tracks[trkIdx]
                        updateTrack(&trk, with: highConfDets[detIdx])
                        tracks[trkIdx] = trk
                        toRemoveDet.insert(m.row)
                        toRemoveTrk.insert(m.col)
                    }

                    unmatchedDetsAfterOCR = unmatchedDets.enumerated()
                        .filter { !toRemoveDet.contains($0.offset) }
                        .map { $0.element }
                    unmatchedTrksAfterOCR = unmatchedTrks.enumerated()
                        .filter { !toRemoveTrk.contains($0.offset) }
                        .map { $0.element }
                }
            }
        }

        // Step 6: Update unmatched tracks with nil (KF predict only)
        for trkIdx in unmatchedTrksAfterOCR {
            guard trkIdx < tracks.count else { continue }
            // No observation — just increment miss counters (already done in predict)
        }

        // Step 6.5: ByteTrack two-pass — low-confidence detection association.
        // Ref: arXiv:2110.06864 — associate low-score detections with remaining tracks.
        // After first-pass (OCM) and second-pass (OCR), any still-unmatched tracks
        // get a final chance to match against low-confidence detections (0.1..detThresh).
        // Uses IoU-only matching (no OCM direction cost — low-conf detections have
        // unreliable position, so simpler cost function is more robust).
        var byteUnmatchedTrks = unmatchedTrksAfterOCR
        if useByte && !lowConfDets.isEmpty && !unmatchedTrksAfterOCR.isEmpty {
            let bytePredictedBoxes = unmatchedTrksAfterOCR.map { predictedBoxes[$0] }
            let iouByte = iouBatch(detections: lowConfDets, trackerBoxes: bytePredictedBoxes)

            if iouByte.count > 0 && iouByte[0].count > 0 {
                let maxIou = iouByte.flatMap { $0 }.max() ?? 0
                if maxIou > iouThreshold {
                    let costMatrix = iouByte.map { row in row.map { -$0 } }
                    let byteMatched = hungarianAssignment(
                        costMatrix: costMatrix,
                        gateThreshold: 1.0
                    )

                    var byteMatchedTrks = Set<Int>()
                    for m in byteMatched {
                        guard iouByte[m.row][m.col] >= iouThreshold else { continue }
                        let trkIdx = unmatchedTrksAfterOCR[m.col]
                        guard trkIdx < tracks.count else { continue }

                        // Update track with low-confidence detection
                        var trk = tracks[trkIdx]
                        updateTrack(&trk, with: lowConfDets[m.row])
                        tracks[trkIdx] = trk
                        byteMatchedTrks.insert(m.col)
                    }

                    byteUnmatchedTrks = unmatchedTrksAfterOCR.enumerated()
                        .filter { !byteMatchedTrks.contains($0.offset) }
                        .map { $0.element }
                }
            }
        }

        // Step 7: Create new tracks for remaining unmatched high-confidence detections
        // Paper: unmatched detections above detThresh become new tentative tracks
        if maxTracks == 0 || tracks.count < maxTracks {
            for detIdx in unmatchedDetsAfterOCR {
                let newTrack = InternalTrack(
                    id: nextId,
                    detection: highConfDets[detIdx],
                    deltaT: deltaT
                )
                tracks.append(newTrack)
                nextId += 1
            }
        }

        // Step 8: Collect output and delete dead tracks
        // Paper: "remove dead tracklet" where timeSinceUpdate > maxAge
        var results: [Track] = []
        var i = tracks.count - 1
        while i >= 0 {
            let trk = tracks[i]

            if trk.timeSinceUpdate > maxAge {
                tracks.remove(at: i)
                i -= 1
                continue
            }

            // Use lastObservation bbox when available, else KF prediction
            // Paper: "this is optional to use the recent observation or the kalman filter prediction"
            let outputBbox: NormalizedBoundingBox
            if let lastObs = trk.lastObservation {
                outputBbox = NormalizedBoundingBox(
                    x1: lastObs[0], y1: lastObs[1],
                    x2: lastObs[2], y2: lastObs[3]
                )
            } else {
                outputBbox = zToBbox(trk.kalman.position)
            }

            // Only output tracks that were recently matched and have enough hits
            if trk.timeSinceUpdate < 1 &&
                (trk.hitStreak >= minHits || frameCount <= minHits) {
                let track = Track(
                    trackId: trk.id,
                    bbox: outputBbox,
                    classLabel: trk.classLabel,
                    confidence: trk.confidence,
                    state: resolveState(for: trk),
                    age: trk.timeSinceUpdate,
                    hits: trk.hits,
                    lastSeenTimestamp: timestamp,
                    trail: trk.trail
                )
                results.append(track)
            }
            i -= 1
        }

        return results.reversed() // Maintain ID order
    }

    /// Reset tracker state.
    mutating func reset() {
        tracks.removeAll()
        nextId = 1
        frameCount = 0
    }

    // MARK: - Track Update with ORU

    /// Update a track with a new detection.
    /// Paper Sec 4.1: ORU — Observation-Centric Re-Update
    /// Ref: noahcao/OC_SORT KalmanBoxTracker.update — ORU replaces the final KF update
    private mutating func updateTrack(_ track: inout InternalTrack, with detection: TrackDetection) {
        let detBbox = [
            detection.bbox.x1, detection.bbox.y1,
            detection.bbox.x2, detection.bbox.y2,
            detection.confidence
        ]

        // Paper Sec 4.2: compute velocity from observations delta_t steps apart
        if track.lastObservation != nil {
            var previousBox: [Double]? = nil
            for i in 0..<track.deltaT {
                let dt = track.deltaT - i
                if let obs = track.observations[track.age - dt] {
                    previousBox = obs
                    break
                }
            }
            if previousBox == nil {
                previousBox = track.lastObservation
            }
            if let prev = previousBox {
                track.velocity = speedDirection(prev: prev, curr: detBbox)
            }
        }

        // Paper Sec 4.1: ORU — re-update with virtual trajectory when rediscovered.
        // The last virtual step updates KF with the new observation, so we skip
        // the separate KF update below. Ref: noahcao/OC_SORT unfreeze()
        let oruApplied = track.timeSinceUpdate > 0 && track.hasBeenObserved
        if oruApplied {
            applyORU(&track, newObservation: detBbox)
        }

        // Store observation
        track.lastObservation = [detBbox[0], detBbox[1], detBbox[2], detBbox[3]]
        track.observations[track.age] = detBbox
        track.hasBeenObserved = true

        track.timeSinceUpdate = 0
        track.hits += 1
        track.hitStreak += 1
        track.confidence = detection.confidence
        track.classLabel = detection.classLabel

        // KF update with z-vector — only when ORU did NOT already update
        // (ORU's last virtual step incorporates the new observation)
        if !oruApplied {
            let z = bboxToZ(detection.bbox)
            track.kalman.update(measurement: z)
        }

        // Trail: append center point
        let cx = (detection.bbox.x1 + detection.bbox.x2) / 2.0
        let cy = (detection.bbox.y1 + detection.bbox.y2) / 2.0
        track.trail.append((x: cx, y: cy))
        if track.trail.count > 30 {
            track.trail.removeFirst()
        }
    }

    // MARK: - ORU: Observation-Centric Re-Update
    // Paper Sec 4.1: When a track is rediscovered after being lost,
    // create virtual trajectory via linear interpolation and re-update KF.

    private mutating func applyORU(_ track: inout InternalTrack, newObservation: [Double]) {
        // Find the last observation before the gap
        // We need the last real observation (not the new one)
        guard let lastObs = track.lastObservation else { return }

        // Linearly interpolate between last observation and new observation
        // Ref: noahcao/OC_SORT kalmanfilter.py unfreeze()
        let gap = track.timeSinceUpdate
        guard gap > 0 else { return }

        // Convert bboxes to [x, y, s, r]
        let box1 = lastObs // [x1, y1, x2, y2]
        let box2 = [newObservation[0], newObservation[1],
                     newObservation[2], newObservation[3]] // [x1, y1, x2, y2]

        let cx1 = (box1[0] + box1[2]) / 2.0
        let cy1 = (box1[1] + box1[3]) / 2.0
        let w1 = box1[2] - box1[0]
        let h1 = box1[3] - box1[1]

        let cx2 = (box2[0] + box2[2]) / 2.0
        let cy2 = (box2[1] + box2[3]) / 2.0
        let w2 = box2[2] - box2[0]
        let h2 = box2[3] - box2[1]

        let dx = (cx2 - cx1) / Double(gap)
        let dy = (cy2 - cy1) / Double(gap)
        let dw = (w2 - w1) / Double(gap)
        let dh = (h2 - h1) / Double(gap)

        // Virtual trajectory: predict + update for each virtual step
        for step in 0..<(gap) {
            let vx = cx1 + Double(step + 1) * dx
            let vy = cy1 + Double(step + 1) * dy
            let vw = w1 + Double(step + 1) * dw
            let vh = h1 + Double(step + 1) * dh
            let vs = vw * vh
            let vr = vw / (vh + 1e-6)

            // Predict then update for each virtual step
            let _ = track.kalman.predict()
            track.kalman.update(measurement: [vx, vy, vs, vr])
        }
    }

    // MARK: - OCM: Observation-Centric Momentum
    // Paper Sec 4.2: direction consistency cost added to IoU in association.

    /// Compute speed direction from two bboxes [x1, y1, x2, y2, ...].
    /// Returns [dy, dx] normalized direction vector.
    /// Ref: noahcao/OC_SORT association.py speed_direction
    private func speedDirection(prev: [Double], curr: [Double]) -> [Double] {
        let cx1 = (prev[0] + prev[2]) / 2.0
        let cy1 = (prev[1] + prev[3]) / 2.0
        let cx2 = (curr[0] + curr[2]) / 2.0
        let cy2 = (curr[1] + curr[3]) / 2.0
        let dy = cy2 - cy1
        let dx = cx2 - cx1
        let norm = sqrt(dy * dy + dx * dx) + 1e-6
        return [dy / norm, dx / norm]
    }

    /// Get observation delta_t steps back from current age.
    /// Ref: noahcao/OC_SORT k_previous_obs
    private func kPreviousObs(for track: InternalTrack) -> [Double] {
        for i in 0..<track.deltaT {
            let dt = track.deltaT - i
            if let obs = track.observations[track.age - dt] {
                return obs
            }
        }
        // Fallback to most recent observation
        if let last = track.lastObservation {
            return [last[0], last[1], last[2], last[3], 0]
        }
        return [-1, -1, -1, -1, -1]
    }

    // MARK: - Association (First Round with OCM + Pre-Gating)
    // Paper Sec 4.2: associate() from association.py
    // Extended with Mahalanobis pre-gating to reject impossible matches before Hungarian.

    private func associate(
        detections: [TrackDetection],
        trackers: [[Double]],        // predicted [x1,y1,x2,y2] per track
        iouThreshold: Double,
        velocities: [[Double]],      // [dy, dx] per track
        kObservations: [[Double]],   // [x1,y1,x2,y2,score] per track (delta_t back)
        inertia: Double
    ) -> (matched: [(Int, Int)], unmatchedDets: [Int], unmatchedTrks: [Int]) {
        let numDets = detections.count
        let numTrks = trackers.count

        if numTrks == 0 {
            return ([], Array(0..<numDets), [])
        }
        if numDets == 0 {
            return ([], [], Array(0..<numTrks))
        }

        // --- Pre-gating: reject impossible matches before cost computation ---
        let gateMask = gatingPipeline.apply(
            tracks: tracks,
            predictedBoxes: trackers,
            detections: detections
        )

        // --- Cost matrix: OCM (IoU + direction consistency) on gated pairs only ---
        let costMatrix = activeCostFunction.compute(
            detections: detections,
            predictedBoxes: trackers,
            gateMask: gateMask,
            velocities: velocities,
            kObservations: kObservations,
            inertia: inertia
        )

        // --- Hungarian matching on gated cost matrix ---
        let matchedIndices = hungarianAssignment(
            costMatrix: costMatrix,
            gateThreshold: 1.0 // Gating already applied via gateMask
        )

        // Collect matches (pairs already passed all gates)
        var matches: [(Int, Int)] = []
        var matchedDetSet = Set<Int>()
        var matchedTrkSet = Set<Int>()

        for m in matchedIndices {
            let detIdx = m.row
            let trkIdx = m.col
            // Double-check gate mask (should always be true after gated cost)
            guard gateMask[trkIdx][detIdx] else { continue }
            matches.append((detIdx, trkIdx))
            matchedDetSet.insert(detIdx)
            matchedTrkSet.insert(trkIdx)
        }

        let unmatchedDets = Array(0..<numDets).filter { !matchedDetSet.contains($0) }
        let unmatchedTrks = Array(0..<numTrks).filter { !matchedTrkSet.contains($0) }

        return (matches, unmatchedDets, unmatchedTrks)
    }

    // MARK: - IoU Computation

    /// IoU between two [x1, y1, x2, y2] boxes.
    private func iou(box1: [Double], box2: [Double]) -> Double {
        precondition(box1.count >= 4 && box2.count >= 4)
        let xx1 = max(box1[0], box2[0])
        let yy1 = max(box1[1], box2[1])
        let xx2 = min(box1[2], box2[2])
        let yy2 = min(box1[3], box2[3])

        let w = max(0.0, xx2 - xx1)
        let h = max(0.0, yy2 - yy1)
        let inter = w * h

        let area1 = (box1[2] - box1[0]) * (box1[3] - box1[1])
        let area2 = (box2[2] - box2[0]) * (box2[3] - box2[1])
        let union = area1 + area2 - inter

        guard union > 0 else { return 0 }
        return inter / union
    }

    /// Batch IoU: tracker predictions vs detections.
    /// Returns [numTrks][numDets] IoU matrix.
    /// Ref: noahcao/OC_SORT association.py iou_batch
    private func iouBatchDetections(
        detections: [TrackDetection],
        trackerBoxes: [[Double]]
    ) -> [[Double]] {
        let numTrks = trackerBoxes.count
        let numDets = detections.count
        guard numTrks > 0 && numDets > 0 else { return [] }

        var result = [[Double]](
            repeating: [Double](repeating: 0, count: numDets),
            count: numTrks
        )

        for trkIdx in 0..<numTrks {
            let trkBbox = trackerBoxes[trkIdx]
            for detIdx in 0..<numDets {
                let det = detections[detIdx]
                let detBbox = [det.bbox.x1, det.bbox.y1, det.bbox.x2, det.bbox.y2]
                result[trkIdx][detIdx] = iou(box1: trkBbox, box2: detBbox)
            }
        }
        return result
    }

    /// Batch IoU between detection bboxes and arbitrary [x1,y1,x2,y2] boxes.
    /// Used for OCR second-round matching against last observations.
    private func iouBatch(
        detections: [TrackDetection],
        trackerBoxes: [[Double]]
    ) -> [[Double]] {
        let numDets = detections.count
        let numTrks = trackerBoxes.count
        guard numDets > 0 && numTrks > 0 else { return [] }

        var result = [[Double]](
            repeating: [Double](repeating: 0, count: numTrks),
            count: numDets
        )

        for detIdx in 0..<numDets {
            let det = detections[detIdx]
            let detBbox = [det.bbox.x1, det.bbox.y1, det.bbox.x2, det.bbox.y2]
            for trkIdx in 0..<numTrks {
                result[detIdx][trkIdx] = iou(box1: detBbox, box2: trackerBoxes[trkIdx])
            }
        }
        return result
    }

    // MARK: - State Resolution

    private func resolveState(for track: InternalTrack) -> TrackState {
        if track.timeSinceUpdate == 0 && track.hitStreak >= minHits {
            return .confirmed
        } else if track.timeSinceUpdate > 0 {
            return .lost
        } else {
            return .tentative
        }
    }
}
