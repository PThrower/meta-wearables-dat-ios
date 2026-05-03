// HomographySolver.swift
// Computes a 3x3 homography matrix from 4 point correspondences using
// Direct Linear Transform (DLT). Maps pixel coordinates to real-world
// millimeter coordinates on a coplanar surface.
// Ref: Hartley & Zisserman, "Multiple View Geometry", Ch 4.1

import Foundation
import CoreGraphics
import Accelerate

// MARK: - 3x3 Matrix

/// Row-major 3x3 matrix of Double values.
struct Matrix3x3: Sendable {
    var elements: [Double] // 9 elements, row-major

    init(_ elements: [Double]) {
        precondition(elements.count == 9)
        self.elements = elements
    }

    static let identity = Matrix3x3([1, 0, 0, 0, 1, 0, 0, 0, 1])

    subscript(row: Int, col: Int) -> Double {
        get { elements[row * 3 + col] }
        set { elements[row * 3 + col] = newValue }
    }

    /// Multiply two 3x3 matrices.
    static func * (_ a: Matrix3x3, _ b: Matrix3x3) -> Matrix3x3 {
        var result = [Double](repeating: 0, count: 9)
        for r in 0..<3 {
            for c in 0..<3 {
                result[r * 3 + c] =
                    a[r, 0] * b[0, c] +
                    a[r, 1] * b[1, c] +
                    a[r, 2] * b[2, c]
            }
        }
        return Matrix3x3(result)
    }

    /// Multiply matrix by a 3-vector.
    func transform(_ v: (x: Double, y: Double, w: Double)) -> (x: Double, y: Double, w: Double) {
        let x = self[0, 0] * v.x + self[0, 1] * v.y + self[0, 2] * v.w
        let y = self[1, 0] * v.x + self[1, 1] * v.y + self[1, 2] * v.w
        let w = self[2, 0] * v.x + self[2, 1] * v.y + self[2, 2] * v.w
        return (x, y, w)
    }
}

// MARK: - Homography Solver

/// Computes a 3x3 homography matrix H such that:
///   [x'_i]       [x_i]
///   [y'_i] = H * [y_i]
///   [1   ]       [1   ]
///
/// where (x_i, y_i) are source points and (x'_i, y'_i) are destination points.
///
/// Uses the Direct Linear Transform (DLT) algorithm:
///   1. Normalize point sets (isotropic scaling + centroid translation)
///   2. Build 2N x 9 coefficient matrix A
///   3. Solve A*h = 0 via SVD (smallest singular value = null space)
///   4. Reshape into 3x3 matrix H
///   5. Denormalize: H = T'_inv * H_normalized * T
///
/// Ref: Hartley & Zisserman, Algorithm 4.2
struct HomographySolver: Sendable {

    // MARK: - Public API

    /// Compute homography from 4 point correspondences.
    /// - Parameters:
    ///   - src: 4 source points (pixel coordinates)
    ///   - dst: 4 destination points (real-world mm coordinates)
    /// - Returns: 3x3 homography matrix, or nil if degenerate
    static func solve(src: [(x: Double, y: Double)], dst: [(x: Double, y: Double)]) -> Matrix3x3? {
        guard src.count == 4, dst.count == 4 else { return nil }

        // Step 1: Normalize both point sets
        guard let (T, srcNorm) = normalizePoints(src),
              let (Tprime, dstNorm) = normalizePoints(dst) else {
            return nil
        }

        // Step 2: Build 8x9 coefficient matrix
        var A = [Double](repeating: 0, count: 72) // 8 rows x 9 cols
        for i in 0..<4 {
            let x = srcNorm[i].x
            let y = srcNorm[i].y
            let xp = dstNorm[i].x
            let yp = dstNorm[i].y

            // Row 2*i: [0 0 0 -x -y -1 yp*x yp*y yp]
            let r1 = i * 18
            A[r1 + 3] = -x
            A[r1 + 4] = -y
            A[r1 + 5] = -1
            A[r1 + 6] = yp * x
            A[r1 + 7] = yp * y
            A[r1 + 8] = yp

            // Row 2*i+1: [x y 1 0 0 0 -xp*x -xp*y -xp]
            let r2 = i * 18 + 9
            A[r2 + 0] = x
            A[r2 + 1] = y
            A[r2 + 2] = 1
            A[r2 + 6] = -xp * x
            A[r2 + 7] = -xp * y
            A[r2 + 8] = -xp
        }

        // Step 3: SVD of A to find null space
        let h = svdNullSpace(A, rows: 8, cols: 9)
        if h == nil { return nil }

        // Step 4: Reshape into 3x3
        let H = Matrix3x3(h!)

        // Step 5: Denormalize: H = T'^-1 * H_norm * T
        guard let Tinv = invert3x3(T),
              let TpInv = invert3x3(Tprime) else {
            return nil
        }

        return TpInv * (H * T)
    }

    /// Transform a point through the homography.
    /// Returns the point in destination coordinates.
    static func transformPoint(_ pt: (x: Double, y: Double), H: Matrix3x3) -> (x: Double, y: Double) {
        let result = H.transform((pt.x, pt.y, 1.0))
        guard abs(result.w) > 1e-10 else { return (0, 0) }
        return (result.x / result.w, result.y / result.w)
    }

    /// Compute Euclidean distance between two points in mm.
    static func distance(_ a: (x: Double, y: Double), _ b: (x: Double, y: Double)) -> Double {
        return sqrt((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y))
    }

    // MARK: - Normalization

    /// Isotropic normalization: translate centroid to origin, scale so avg distance = sqrt(2).
    /// Returns (3x3 transform matrix, normalized points) or nil.
    /// Ref: Hartley & Zisserman, Algorithm 4.2 step 1
    private static func normalizePoints(_ pts: [(x: Double, y: Double)]) -> (Matrix3x3, [(x: Double, y: Double)])? {
        guard pts.count >= 2 else { return nil }

        // Centroid
        let cx = pts.map(\.x).reduce(0, +) / Double(pts.count)
        let cy = pts.map(\.y).reduce(0, +) / Double(pts.count)

        // Average distance from centroid
        let avgDist = pts.map { sqrt(($0.x - cx) * ($0.x - cx) + ($0.y - cy) * ($0.y - cy)) }.reduce(0, +) / Double(pts.count)
        guard avgDist > 1e-10 else { return nil }

        let scale = sqrt(2.0) / avgDist

        // Transform matrix: [s 0 -s*cx; 0 s -s*cy; 0 0 1]
        let T = Matrix3x3([
            scale, 0, -scale * cx,
            0, scale, -scale * cy,
            0, 0, 1,
        ])

        let normalized = pts.map { T.transform(($0.x, $0.y, 1.0)) }.map { ($0.x / $0.w, $0.y / $0.w) }
        return (T, normalized)
    }

    // MARK: - SVD Null Space

    /// Find the null space of an MxN matrix via Accelerate LAPACK SVD.
    /// Returns the N-element vector corresponding to the smallest singular value.
    private static func svdNullSpace(_ A: [Double], rows: Int, cols: Int) -> [Double]? {
        // Use Accelerate's vDSP for SVD via singular value decomposition
        // For our small matrices (8x9), we use a direct approach

        let m = rows
        let n = cols
        let minMN = min(m, n)

        // Build A^T * A (NxN) — the smallest eigenvector of A^T*A = null space of A
        var ATA = [Double](repeating: 0, count: n * n)
        for i in 0..<n {
            for j in 0..<n {
                var sum: Double = 0
                for k in 0..<m {
                    sum += A[k * n + i] * A[k * n + j]
                }
                ATA[i * n + j] = sum
            }
        }

        // Power iteration to find the eigenvector with the smallest eigenvalue.
        // Start with [1,0,...,0] and iterate inverse iteration.
        // For small matrices this is reliable.

        // First estimate largest eigenvalue for inverse iteration shift
        var v = [Double](repeating: 1.0 / Double(n), count: n)
        for _ in 0..<50 {
            var Av = [Double](repeating: 0, count: n)
            for i in 0..<n {
                for j in 0..<n {
                    Av[i] += ATA[i * n + j] * v[j]
                }
            }
            let norm = sqrt(Av.map { $0 * $0 }.reduce(0, +))
            guard norm > 1e-15 else { return nil }
            v = Av.map { $0 / norm }
        }

        // v is now the principal eigenvector. For null space we want the smallest.
        // Use Jacobi-like deflation: subtract the principal component from ATA, repeat.
        // Actually, for a 9x9 matrix, just compute all eigenpairs via Jacobi.

        // Simpler: solve the 9x9 system directly using Gaussian elimination on the
        // homogeneous system ATA*h = 0. Set h[8] = 1 and solve for the rest.
        // This works because the null space is 1-dimensional for 4-point DLT.

        // Build (N-1) x (N-1) reduced system
        let nn = n - 1
        var reduced = [Double](repeating: 0, count: nn * nn)
        var rhs = [Double](repeating: 0, count: nn)

        for i in 0..<nn {
            for j in 0..<nn {
                reduced[i * nn + j] = ATA[i * n + j]
            }
            rhs[i] = -ATA[i * n + nn] // move last column to rhs
        }

        // Gaussian elimination with partial pivoting
        for col in 0..<nn {
            // Find pivot
            var maxVal = abs(reduced[col * nn + col])
            var maxRow = col
            for row in (col + 1)..<nn {
                let val = abs(reduced[row * nn + col])
                if val > maxVal {
                    maxVal = val
                    maxRow = row
                }
            }
            guard maxVal > 1e-12 else { continue } // near-singular column

            // Swap rows
            if maxRow != col {
                for j in 0..<nn {
                    reduced.swapAt(col * nn + j, maxRow * nn + j)
                }
                rhs.swapAt(col, maxRow)
            }

            // Eliminate below
            for row in (col + 1)..<nn {
                let factor = reduced[row * nn + col] / reduced[col * nn + col]
                for j in col..<nn {
                    reduced[row * nn + j] -= factor * reduced[col * nn + j]
                }
                rhs[row] -= factor * rhs[col]
            }
        }

        // Back substitution
        var h = [Double](repeating: 0, count: n)
        h[nn] = 1.0
        for i in stride(from: nn - 1, through: 0, by: -1) {
            var sum = rhs[i]
            for j in (i + 1)..<nn {
                sum -= reduced[i * nn + j] * h[j]
            }
            if abs(reduced[i * nn + i]) > 1e-12 {
                h[i] = sum / reduced[i * nn + i]
            }
        }

        // Normalize
        let norm = sqrt(h.map { $0 * $0 }.reduce(0, +))
        guard norm > 1e-10 else { return nil }
        return h.map { $0 / norm }
    }

    // MARK: - 3x3 Inverse

    /// Compute inverse of a 3x3 matrix using cofactor expansion.
    private static func invert3x3(_ m: Matrix3x3) -> Matrix3x3? {
        let a = m[0,0], b = m[0,1], c = m[0,2]
        let d = m[1,0], e = m[1,1], f = m[1,2]
        let g = m[2,0], h = m[2,1], i = m[2,2]

        let det = a*(e*i - f*h) - b*(d*i - f*g) + c*(d*h - e*g)
        guard abs(det) > 1e-12 else { return nil }
        let invDet = 1.0 / det

        return Matrix3x3([
            (e*i - f*h) * invDet, (c*h - b*i) * invDet, (b*f - c*e) * invDet,
            (f*g - d*i) * invDet, (a*i - c*g) * invDet, (c*d - a*f) * invDet,
            (d*h - e*g) * invDet, (b*g - a*h) * invDet, (a*e - b*d) * invDet,
        ])
    }
}
