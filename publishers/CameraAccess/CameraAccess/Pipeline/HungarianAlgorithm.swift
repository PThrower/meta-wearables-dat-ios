// HungarianAlgorithm.swift
// Munkres/Hungarian algorithm for optimal assignment.
// O(n^3) cost -- typical tracking: n = 5-30 detections per frame.
// Pure function, no state, no actor needed.

import Foundation

/// Solve the assignment problem: match rows to columns minimizing total cost.
/// Returns matched (row, col) pairs where cost < gateThreshold.
/// Unmatched rows = new detections (no existing track).
/// Unmatched cols = lost tracks (no detection this frame).
///
/// - Parameters:
///   - costMatrix: [rows][cols] of non-negative costs (e.g. 1 - IoU).
///   - gateThreshold: Maximum acceptable cost. Pairs above this are not matched.
/// - Returns: Array of (row, col) pairs that were optimally matched.
func hungarianAssignment(
    costMatrix: [[Double]],
    gateThreshold: Double
) -> [(row: Int, col: Int)] {
    let rows = costMatrix.count
    guard rows > 0 else { return [] }
    let cols = costMatrix[0].count
    guard cols > 0 else { return [] }

    // Pad to square if needed (virtual rows/cols with high cost)
    let n = max(rows, cols)

    // Build square cost matrix
    var cost = [[Double]](repeating: [Double](repeating: Double.greatestFiniteMagnitude, count: n), count: n)
    for i in 0..<rows {
        for j in 0..<cols {
            cost[i][j] = costMatrix[i][j]
        }
    }

    // u[i] = potential of row i, v[j] = potential of col j
    var u = [Double](repeating: 0, count: n + 1)
    var v = [Double](repeating: 0, count: n + 1)
    // p[j] = row assigned to col j (1-indexed, 0 = unassigned)
    var p = [Int](repeating: 0, count: n + 1)
    // way[j] = preceding col in augmenting path
    var way = [Int](repeating: 0, count: n + 1)

    for i in 1...n {
        // Start augmenting path from row i
        p[0] = i
        var j0 = 0  // Virtual column

        var minv = [Double](repeating: Double.greatestFiniteMagnitude, count: n + 1)
        var used = [Bool](repeating: false, count: n + 1)

        repeat {
            used[j0] = true
            let i0 = p[j0]
            var delta = Double.greatestFiniteMagnitude
            var j1 = 0

            for j in 1...n {
                if used[j] { continue }
                let cur = cost[i0 - 1][j - 1] - u[i0] - v[j]
                if cur < minv[j] {
                    minv[j] = cur
                    way[j] = j0
                }
                if minv[j] < delta {
                    delta = minv[j]
                    j1 = j
                }
            }

            for j in 0...n {
                if used[j] {
                    u[p[j]] += delta
                    v[j] -= delta
                } else {
                    minv[j] -= delta
                }
            }

            j0 = j1
        } while p[j0] != 0

        // Trace back augmenting path
        repeat {
            let j1 = way[j0]
            p[j0] = p[j1]
            j0 = j1
        } while j0 != 0
    }

    // Extract matches (convert back to 0-indexed)
    var matches: [(row: Int, col: Int)] = []
    for j in 1...n {
        let i = p[j]
        if i > 0 && i - 1 < rows && j - 1 < cols {
            let c = costMatrix[i - 1][j - 1]
            if c < gateThreshold {
                matches.append((row: i - 1, col: j - 1))
            }
        }
    }

    return matches
}
