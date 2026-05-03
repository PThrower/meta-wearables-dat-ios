/*
 * FramePipelineManagerTests.swift
 *
 * Unit tests for FramePipelineManager — stage registration, lifecycle, and dispatch.
 * Uses a mock stage to verify correct call ordering.
 * No SDK dependencies required.
 */

import CoreMedia
import Foundation
import XCTest

@testable import CameraAccess

// MARK: - Mock Stage

/// Mock pipeline stage that records lifecycle calls and frame processing.
actor MockPipelineStage: @preconcurrency FramePipelineStage {
    nonisolated let stageId: String
    var config: FrameStageConfig

    private(set) var startCallCount = 0
    private(set) var stopCallCount = 0
    private(set) var processedFrames: [UInt64] = []

    init(stageId: String, config: FrameStageConfig = .maxFPS) {
        self.stageId = stageId
        self.config = config
    }

    func processFrame(_ packet: FramePacket) async {
        processedFrames.append(packet.sequenceNumber)
    }

    func start() async {
        startCallCount += 1
    }

    func stop() async {
        stopCallCount += 1
    }

    /// Expose counts for non-isolated assertion helpers.
    func getCounts() -> (start: Int, stop: Int, frames: [UInt64]) {
        (startCallCount, stopCallCount, processedFrames)
    }
}

// MARK: - Tests

@MainActor
final class FramePipelineManagerTests: XCTestCase {

    private var pipeline: FramePipelineManager!

    override func setUp() async throws {
        try await super.setUp()
        pipeline = FramePipelineManager()
    }

    override func tearDown() async throws {
        pipeline = nil
        try await super.tearDown()
    }

    // MARK: - Registration

    func testRegisterAddsStage() async {
        let stage = MockPipelineStage(stageId: "mock-1")
        pipeline.register(stage)

        await pipeline.startAll()
        let counts = await stage.getCounts()
        XCTAssertEqual(counts.start, 1)
    }

    func testUnregisterRemovesStage() async {
        let stage = MockPipelineStage(stageId: "mock-1")
        pipeline.register(stage)
        pipeline.unregister(stageId: "mock-1")

        await pipeline.startAll()
        let counts = await stage.getCounts()
        XCTAssertEqual(counts.start, 0, "Unregistered stage should not be started")
    }

    func testUnregisterUnknownStageIsNoOp() async {
        let stage = MockPipelineStage(stageId: "mock-1")
        pipeline.register(stage)

        pipeline.unregister(stageId: "nonexistent")

        await pipeline.startAll()
        let counts = await stage.getCounts()
        XCTAssertEqual(counts.start, 1, "Other stages should still be started")
    }

    // MARK: - Lifecycle

    func testStartAllStartsAllStages() async {
        let stage1 = MockPipelineStage(stageId: "a")
        let stage2 = MockPipelineStage(stageId: "b")

        pipeline.register(stage1)
        pipeline.register(stage2)
        await pipeline.startAll()

        let counts1 = await stage1.getCounts()
        let counts2 = await stage2.getCounts()
        XCTAssertEqual(counts1.start, 1)
        XCTAssertEqual(counts2.start, 1)
    }

    func testStopAllStopsAllStages() async {
        let stage1 = MockPipelineStage(stageId: "a")
        let stage2 = MockPipelineStage(stageId: "b")

        pipeline.register(stage1)
        pipeline.register(stage2)
        await pipeline.stopAll()

        let counts1 = await stage1.getCounts()
        let counts2 = await stage2.getCounts()
        XCTAssertEqual(counts1.stop, 1)
        XCTAssertEqual(counts2.stop, 1)
    }

    // MARK: - Multiple Stages

    func testMultipleStagesAreIndependent() async {
        let stages = (1...5).map { MockPipelineStage(stageId: "stage-\($0)") }
        for stage in stages {
            pipeline.register(stage)
        }

        await pipeline.startAll()
        await pipeline.stopAll()

        for stage in stages {
            let counts = await stage.getCounts()
            XCTAssertEqual(counts.start, 1)
            XCTAssertEqual(counts.stop, 1)
        }
    }
}
