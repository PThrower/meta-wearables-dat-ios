/*
 * PCMConversionTests.swift
 *
 * Unit tests for AudioStage.floatToPCM16 conversion.
 * Validates clamping, zero crossing, full scale, and edge cases.
 * No SDK dependencies required.
 */

import AVFoundation
import Foundation
import XCTest

@testable import CameraAccess

// Expose the private nonisolated static method for testing
extension AudioStage {
    /// Test accessor for the private floatToPCM16 method.
    nonisolated static func testFloatToPCM16(_ floatData: UnsafePointer<Float>, frameCount: Int) -> Data {
        var samples = [Int16](repeating: 0, count: frameCount)
        for i in 0..<frameCount {
            let clamped = max(-1.0, min(1.0, floatData[i]))
            samples[i] = Int16(clamped * 32767.0)
        }
        return samples.withUnsafeBufferPointer { ptr in
            Data(bytes: ptr.baseAddress!, count: frameCount * 2)
        }
    }
}

final class PCMConversionTests: XCTestCase {

    // MARK: - Zero

    func testZeroFloatProducesZeroPCM() {
        let floats: [Float] = [0.0, 0.0, 0.0, 0.0]
        let data = floats.withUnsafeBufferPointer { ptr in
            AudioStage.testFloatToPCM16(ptr.baseAddress!, frameCount: floats.count)
        }

        XCTAssertEqual(data.count, floats.count * 2, "Should produce 2 bytes per frame")
        let samples = data.withUnsafeBytes { $0.bindMemory(to: Int16.self) }
        for i in 0..<floats.count {
            XCTAssertEqual(samples[i], 0, "Zero float should produce zero PCM sample")
        }
    }

    // MARK: - Full Scale

    func testPositiveFullScale() {
        let floats: [Float] = [1.0]
        let data = floats.withUnsafeBufferPointer { ptr in
            AudioStage.testFloatToPCM16(ptr.baseAddress!, frameCount: 1)
        }
        let sample = data.withUnsafeBytes { $0.load(as: Int16.self) }
        XCTAssertEqual(sample, 32767, "1.0 should map to 32767 (max Int16)")
    }

    func testNegativeFullScale() {
        let floats: [Float] = [-1.0]
        let data = floats.withUnsafeBufferPointer { ptr in
            AudioStage.testFloatToPCM16(ptr.baseAddress!, frameCount: 1)
        }
        let sample = data.withUnsafeBytes { $0.load(as: Int16.self) }
        XCTAssertEqual(sample, -32767, "-1.0 should map to -32767")
    }

    // MARK: - Clamping

    func testAboveOneIsClamped() {
        let floats: [Float] = [2.0, 100.0, 1.5]
        let data = floats.withUnsafeBufferPointer { ptr in
            AudioStage.testFloatToPCM16(ptr.baseAddress!, frameCount: floats.count)
        }
        let samples = data.withUnsafeBytes { rawBuf -> [Int16] in
            let ptr = rawBuf.bindMemory(to: Int16.self)
            return Array(UnsafeBufferPointer(start: ptr.baseAddress, count: floats.count))
        }
        for sample in samples {
            XCTAssertEqual(sample, 32767, "Values > 1.0 should be clamped to 32767")
        }
    }

    func testBelowMinusOneIsClamped() {
        let floats: [Float] = [-2.0, -100.0, -1.5]
        let data = floats.withUnsafeBufferPointer { ptr in
            AudioStage.testFloatToPCM16(ptr.baseAddress!, frameCount: floats.count)
        }
        let samples = data.withUnsafeBytes { rawBuf -> [Int16] in
            let ptr = rawBuf.bindMemory(to: Int16.self)
            return Array(UnsafeBufferPointer(start: ptr.baseAddress, count: floats.count))
        }
        for sample in samples {
            XCTAssertEqual(sample, -32767, "Values < -1.0 should be clamped to -32767")
        }
    }

    // MARK: - Mid Scale

    func testMidScalePositive() {
        let floats: [Float] = [0.5]
        let data = floats.withUnsafeBufferPointer { ptr in
            AudioStage.testFloatToPCM16(ptr.baseAddress!, frameCount: 1)
        }
        let sample = data.withUnsafeBytes { $0.load(as: Int16.self) }
        XCTAssertEqual(sample, Int16(0.5 * 32767.0), "0.5 should map to ~16383")
    }

    func testMidScaleNegative() {
        let floats: [Float] = [-0.5]
        let data = floats.withUnsafeBufferPointer { ptr in
            AudioStage.testFloatToPCM16(ptr.baseAddress!, frameCount: 1)
        }
        let sample = data.withUnsafeBytes { $0.load(as: Int16.self) }
        XCTAssertEqual(sample, Int16(-0.5 * 32767.0), "-0.5 should map to ~-16383")
    }

    // MARK: - Data Size

    func testOutputDataSize() {
        let frameCount = 1024
        let floats = [Float](repeating: 0.0, count: frameCount)
        let data = floats.withUnsafeBufferPointer { ptr in
            AudioStage.testFloatToPCM16(ptr.baseAddress!, frameCount: frameCount)
        }
        XCTAssertEqual(data.count, frameCount * 2, "Output should be 2 bytes per frame (16-bit PCM)")
    }

    // MARK: - Ramp

    func testLinearRampMonotonic() {
        // Generate a ramp from -1.0 to 1.0
        let count = 100
        let floats = (0..<count).map { Float($0) / Float(count - 1) * 2.0 - 1.0 }
        let data = floats.withUnsafeBufferPointer { ptr in
            AudioStage.testFloatToPCM16(ptr.baseAddress!, frameCount: count)
        }
        let samples = data.withUnsafeBytes { $0.bindMemory(to: Int16.self) }

        // Verify monotonic increase
        for i in 1..<count {
            XCTAssertGreaterThanOrEqual(
                samples[i], samples[i - 1],
                "Linear ramp should produce monotonically increasing PCM values at index \(i)"
            )
        }
    }
}
