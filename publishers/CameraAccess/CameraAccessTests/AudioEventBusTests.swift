/*
 * AudioEventBusTests.swift
 *
 * Unit tests for AudioEventBus actor — subscribe, publish, unsubscribe, buffering.
 * No SDK dependencies required.
 */

import Foundation
import XCTest

@testable import CameraAccess

final class AudioEventBusTests: XCTestCase {

    private var bus: AudioEventBus!

    override func setUp() async throws {
        try await super.setUp()
        bus = AudioEventBus()
    }

    override func tearDown() async throws {
        bus = nil
        try await super.tearDown()
    }

    // MARK: - Subscribe / Unsubscribe

    func testSubscribeReturnsUniqueIDs() async {
        let (id1, _) = await bus.subscribe()
        let (id2, _) = await bus.subscribe()

        XCTAssertNotEqual(id1, id2, "Each subscription should have a unique ID")
        let count = await bus.subscriberCount
        XCTAssertEqual(count, 2, "Should have 2 subscribers")
    }

    func testUnsubscribeRemovesSubscriber() async {
        let (id, _) = await bus.subscribe()
        let countBefore = await bus.subscriberCount
        XCTAssertEqual(countBefore, 1)

        await bus.unsubscribe(id)
        let countAfter = await bus.subscriberCount
        XCTAssertEqual(countAfter, 0, "Unsubscribe should remove the subscriber")
    }

    func testUnsubscribeUnknownIdIsNoOp() async {
        let (id, _) = await bus.subscribe()
        await bus.unsubscribe(UUID()) // unknown ID
        let count = await bus.subscriberCount
        XCTAssertEqual(count, 1, "Unsubscribe with unknown ID should not affect count")
        await bus.unsubscribe(id)
    }

    // MARK: - Publish

    func testPublishDeliversToSingleSubscriber() async {
        let (_, stream) = await bus.subscribe()

        let packet = AudioPacket(
            pcmData: Data([0x01, 0x02]),
            codecType: 0,
            sampleRate: 48000,
            channels: 1,
            bitsPerSample: 16,
            sequenceNumber: 1,
            timestampMs: 1000
        )

        await bus.publish(packet)

        var received: AudioPacket?
        for await p in stream {
            received = p
            break
        }

        XCTAssertNotNil(received, "Subscriber should receive published packet")
        XCTAssertEqual(received?.sequenceNumber, 1)
        XCTAssertEqual(received?.sampleRate, 48000)
        XCTAssertEqual(received?.pcmData, Data([0x01, 0x02]))
    }

    func testPublishDeliversToMultipleSubscribers() async {
        let (_, stream1) = await bus.subscribe()
        let (_, stream2) = await bus.subscribe()

        let packet = AudioPacket(
            pcmData: Data([0xAA]),
            codecType: 0,
            sampleRate: 8000,
            channels: 1,
            bitsPerSample: 16,
            sequenceNumber: 42,
            timestampMs: 5000
        )

        await bus.publish(packet)

        var received1: AudioPacket?
        var received2: AudioPacket?

        await withTaskGroup(of: AudioPacket?.self) { group in
            group.addTask {
                for await p in stream1 { return p }
                return nil
            }
            group.addTask {
                for await p in stream2 { return p }
                return nil
            }
            received1 = await group.next()!
            received2 = await group.next()!
        }

        XCTAssertEqual(received1?.sequenceNumber, 42, "First subscriber should receive packet")
        XCTAssertEqual(received2?.sequenceNumber, 42, "Second subscriber should receive packet")
    }

    func testPublishWithNoSubscribersIsNoOp() async {
        // Publishing with zero subscribers should not crash
        let packet = AudioPacket(
            pcmData: Data(),
            codecType: 0,
            sampleRate: 48000,
            channels: 1,
            bitsPerSample: 16,
            sequenceNumber: 1,
            timestampMs: 0
        )
        await bus.publish(packet) // Should not crash
    }

    // MARK: - Stream Lifecycle

    func testUnsubscribeFinishesStream() async {
        let (id, stream) = await bus.subscribe()

        await bus.unsubscribe(id)

        // Stream should finish after unsubscribe
        var count = 0
        for await _ in stream {
            count += 1
        }
        XCTAssertEqual(count, 0, "Stream should finish with no items after unsubscribe without publish")
    }

    func testStreamReceivesMultiplePackets() async {
        let (_, stream) = await bus.subscribe()

        for i in 1...5 {
            let packet = AudioPacket(
                pcmData: Data([UInt8(i)]),
                codecType: 0,
                sampleRate: 48000,
                channels: 1,
                bitsPerSample: 16,
                sequenceNumber: UInt64(i),
                timestampMs: UInt64(i * 100)
            )
            await bus.publish(packet)
        }

        var received: [UInt64] = []
        for await packet in stream {
            received.append(packet.sequenceNumber)
            if received.count == 5 { break }
        }

        XCTAssertEqual(received, [1, 2, 3, 4, 5], "Should receive all 5 packets in order")
    }
}
