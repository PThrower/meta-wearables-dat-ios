/*
 * ThrottledStageTests.swift
 *
 * Unit tests for FrameStageConfig and ThrottledStage lifecycle.
 * ThrottledStage.processThrottledFrame is internal (not open), so we test
 * the public protocol conformance: stageId, config, start/stop lifecycle,
 * and processFrame doesn't crash.
 *
 * The throttle timing logic is implicitly tested via the existing integration
 * tests. These unit tests verify config semantics and lifecycle.
 * No SDK dependencies required.
 */

import CoreMedia
import Foundation
import XCTest

@testable import CameraAccess

final class ThrottledStageTests: XCTestCase {

    // MARK: - FrameStageConfig

    func testDefaultConfig() {
        let config = FrameStageConfig()
        XCTAssertTrue(config.isEnabled)
        XCTAssertEqual(config.targetFPS, 30)
    }

    func testMaxFPSConfig() {
        let config = FrameStageConfig.maxFPS
        XCTAssertEqual(config.targetFPS, .max)
        XCTAssertTrue(config.isEnabled)
    }

    func testCustomConfig() {
        let config = FrameStageConfig(targetFPS: 60, isEnabled: false)
        XCTAssertEqual(config.targetFPS, 60)
        XCTAssertFalse(config.isEnabled)
    }

    func testConfigIsSendable() {
        // FrameStageConfig conforms to Sendable — verify it compiles
        let config = FrameStageConfig(targetFPS: 30, isEnabled: true)
        let _: any Sendable = config
    }

    // MARK: - ThrottledStage Lifecycle

    func testStageIdIsAccessible() async {
        let stage = ThrottledStage(stageId: "test-stage", config: .maxFPS)
        XCTAssertEqual(stage.stageId, "test-stage")
    }

    func testConfigIsAccessible() async {
        let stage = ThrottledStage(stageId: "test", config: FrameStageConfig(targetFPS: 30))
        let config = await stage.config
        XCTAssertEqual(config.targetFPS, 30)
        XCTAssertTrue(config.isEnabled)
    }

    func testStartStopDoesNotCrash() async {
        let stage = ThrottledStage(stageId: "test", config: .maxFPS)
        await stage.start()
        await stage.stop()
        // Should complete without error
    }

    func testProcessFrameDoesNotCrash() async {
        let stage = ThrottledStage(stageId: "test", config: .maxFPS)
        await stage.start()

        let packet = FramePacket(
            sampleBuffer: Self.makeMinimalSampleBuffer(),
            timestamp: .now,
            sequenceNumber: 1
        )
        await stage.processFrame(packet)
        await stage.stop()
    }

    func testMultipleProcessFramesDoNotCrash() async {
        let stage = ThrottledStage(stageId: "test", config: FrameStageConfig(targetFPS: 30))
        await stage.start()

        for i in 1...10 {
            let packet = FramePacket(
                sampleBuffer: Self.makeMinimalSampleBuffer(),
                timestamp: .now,
                sequenceNumber: UInt64(i)
            )
            await stage.processFrame(packet)
        }
        await stage.stop()
    }

    func testStopWithoutStartDoesNotCrash() async {
        let stage = ThrottledStage(stageId: "test", config: .maxFPS)
        await stage.stop()
    }

    // MARK: - Helpers

    private static func makeMinimalSampleBuffer() -> CMSampleBuffer {
        var pixelBuffer: CVPixelBuffer?
        let attrs: [String: Any] = [
            kCVPixelBufferIOSurfacePropertiesKey as String: [:] as [String: Any]
        ]
        CVPixelBufferCreate(kCFAllocatorDefault, 1, 1, kCVPixelFormatType_32BGRA, attrs as CFDictionary, &pixelBuffer)

        var formatDescription: CMVideoFormatDescription?
        CMVideoFormatDescriptionCreateForImageBuffer(
            allocator: kCFAllocatorDefault,
            imageBuffer: pixelBuffer!,
            formatDescriptionOut: &formatDescription
        )

        var sampleBuffer: CMSampleBuffer?
        var timing = CMSampleTimingInfo(
            duration: CMTime(value: 1, timescale: 30),
            presentationTimeStamp: .zero,
            decodeTimeStamp: .invalid
        )

        CMSampleBufferCreateForImageBuffer(
            allocator: kCFAllocatorDefault,
            imageBuffer: pixelBuffer!,
            dataReady: true,
            makeDataReadyCallback: nil,
            refcon: nil,
            formatDescription: formatDescription!,
            sampleTiming: &timing,
            sampleBufferOut: &sampleBuffer
        )

        return sampleBuffer!
    }
}
