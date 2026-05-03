// HeatMapBuffer.swift
// Grid-based density heat map accumulator for cheap on-device visualization.
// ~0.1ms per frame for a 40x30 grid (1200 cells). No GPU needed.
// Used within ObjectTrackingStage actor isolation — struct, not actor.

import Foundation
import CoreGraphics

// MARK: - Configuration

/// Heat map accumulation mode.
enum HeatMapMode: String, Codable, Sendable {
    /// Accumulate time-weighted presence (dwell density).
    case dwell
    /// Accumulate transition counts per cell.
    case traffic
    /// Accumulate raw detection count (hot spots).
    case detection
}

/// Configuration for the heat map overlay.
struct HeatMapConfig: Codable, Sendable {
    let enabled: Bool
    let resolution: Int       // Grid width (height derived from aspect ratio 4:3)
    let decayRate: Double     // Per-frame exponential decay (0.97 = slow fade)
    let gaussianRadius: Int   // Splat kernel radius (1 = 3x3, 2 = 5x5)
    let opacity: Double       // Overlay alpha (0.0-1.0)
    let mode: HeatMapMode

    init(
        enabled: Bool = false,
        resolution: Int = 40,
        decayRate: Double = 0.97,
        gaussianRadius: Int = 1,
        opacity: Double = 0.4,
        mode: HeatMapMode = .detection
    ) {
        self.enabled = enabled
        self.resolution = max(10, min(100, resolution))
        self.decayRate = decayRate
        self.gaussianRadius = max(1, min(5, gaussianRadius))
        self.opacity = max(0.1, min(0.8, opacity))
        self.mode = mode
    }

    /// Grid height derived from 4:3 aspect ratio (camera frame).
    var gridHeight: Int {
        let aspect: Double = 3.0 / 4.0  // height/width for portrait
        return max(1, Int(Double(resolution) * aspect))
    }
}

// MARK: - Grid Snapshot (for overlay rendering)

/// Snapshot of the heat map grid state for rendering in SwiftUI.
struct HeatMapSnapshot: Sendable {
    let width: Int
    let height: Int
    let values: [Double]
    let maxValue: Double
    let opacity: Double
}

// MARK: - Heat Map Buffer

/// Grid-based density accumulator with exponential decay.
/// Each tracked object splats a Gaussian-weighted contribution per frame.
/// Old data fades via per-frame decay multiplication.
struct HeatMapBuffer: Sendable {
    private let config: HeatMapConfig
    private let width: Int
    private let height: Int
    private(set) var grid: [Double]
    private let kernel: [Double]  // Precomputed Gaussian kernel (flattened 2D)
    private let kernelSize: Int   // Side length of kernel (2*radius+1)
    private(set) var maxValue: Double = 0

    init(config: HeatMapConfig) {
        self.config = config
        self.width = config.resolution
        self.height = config.gridHeight
        self.grid = [Double](repeating: 0, count: width * height)
        self.kernelSize = 2 * config.gaussianRadius + 1
        // Precompute normalized Gaussian kernel
        let sigma = Double(config.gaussianRadius) / 2.0
        var k = [Double]()
        var sum = 0.0
        let r = config.gaussianRadius
        for dy in -r...r {
            for dx in -r...r {
                let val = exp(-(Double(dx * dx + dy * dy)) / (2.0 * sigma * sigma + 1e-6))
                k.append(val)
                sum += val
            }
        }
        // Normalize so kernel sums to 1
        self.kernel = k.map { $0 / (sum + 1e-6) }
    }

    // MARK: - Accumulation

    /// Add Gaussian-weighted contribution at normalized position (0-1).
    mutating func splat(x: Double, y: Double, weight: Double = 1.0) {
        let cx = Int(x * Double(width))
        let cy = Int(y * Double(height))
        let r = config.gaussianRadius

        for ky in -r...r {
            for kx in -r...r {
                let gx = cx + kx
                let gy = cy + ky
                guard gx >= 0, gx < width, gy >= 0, gy < height else { continue }
                let kIdx = (ky + r) * kernelSize + (kx + r)
                grid[gy * width + gx] += kernel[kIdx] * weight
            }
        }
    }

    /// Apply exponential decay to all cells.
    mutating func decay() {
        let rate = config.decayRate
        for i in grid.indices {
            grid[i] *= rate
        }
        // Track max for normalization
        maxValue = grid.max() ?? 0
        if maxValue < 1e-6 { maxValue = 1.0 }
    }

    /// Reset all cells to zero.
    mutating func reset() {
        for i in grid.indices { grid[i] = 0 }
        maxValue = 0
    }

    // MARK: - Snapshot

    /// Current grid snapshot for overlay rendering.
    var snapshot: HeatMapSnapshot {
        HeatMapSnapshot(
            width: width,
            height: height,
            values: grid,
            maxValue: maxValue,
            opacity: config.opacity
        )
    }
}

// MARK: - Color Mapping

/// Maps a normalized value (0-1) to a heat map RGBA color.
/// Gradient: transparent -> blue -> cyan -> green -> yellow -> red
enum HeatMapColor {
    /// Returns (r, g, b, a) tuple for a value in 0...1 range.
    static func color(for value: Double, alpha: Double = 1.0) -> (r: Double, g: Double, b: Double, a: Double) {
        let v = max(0, min(1, value))
        // 5-stop gradient
        let stops: [(Double, Double, Double, Double)] = [
            (0.0, 0.0, 0.5, 1.0),   // dark blue
            (0.0, 0.7, 1.0, 1.0),   // cyan
            (0.0, 1.0, 0.3, 1.0),   // green
            (1.0, 1.0, 0.0, 1.0),   // yellow
            (1.0, 0.2, 0.0, 1.0),   // red
        ]
        // Map v to segment index
        let segment = v * Double(stops.count - 1)
        let idx = Int(segment)
        let frac = segment - Double(idx)
        let safeIdx = min(idx, stops.count - 2)

        let s0 = stops[safeIdx]
        let s1 = stops[safeIdx + 1]
        let r = s0.0 + (s1.0 - s0.0) * frac
        let g = s0.1 + (s1.1 - s0.1) * frac
        let b = s0.2 + (s1.2 - s0.2) * frac
        return (r, g, b, alpha)
    }
}
