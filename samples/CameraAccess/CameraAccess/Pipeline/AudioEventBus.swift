/*
 * AudioEventBus.swift
 *
 * Actor-based pub/sub for AudioPacket using AsyncStream.
 * Decouples audio capture (AudioStage) from audio consumers (AudioRelayStage, etc.).
 *
 * Publishers call publish(); subscribers receive packets via AsyncStream.
 * Uses bufferingNewest(10) to drop old audio if a subscriber falls behind
 * (audio is real-time — stale samples are useless).
 *
 * Lifecycle:
 *   1. Subscriber calls subscribe() -> gets (UUID, AsyncStream<AudioPacket>)
 *   2. Subscriber iterates the stream: `for await packet in stream { ... }`
 *   3. Subscriber calls unsubscribe(id) when done
 *   4. Bus calls continuation.finish() on unsubscribe
 */

import Foundation

actor AudioEventBus {
    private var subscribers: [UUID: AsyncStream<AudioPacket>.Continuation] = [:]

    /// Subscribe to audio packets.
    /// Returns a subscription ID (for later unsubscribe) and an AsyncStream.
    /// The stream uses .bufferingNewest(10) — old packets are dropped if the
    /// subscriber can't keep up (appropriate for real-time audio).
    func subscribe() -> (id: UUID, stream: AsyncStream<AudioPacket>) {
        let id = UUID()
        let (stream, continuation) = AsyncStream<AudioPacket>.makeStream(bufferingPolicy: .bufferingNewest(10))
        subscribers[id] = continuation
        NSLog("[AudioEventBus] Subscriber added: \(id) (total: \(subscribers.count))")
        return (id, stream)
    }

    /// Unsubscribe from audio packets. Finishes the stream.
    func unsubscribe(_ id: UUID) {
        if let continuation = subscribers.removeValue(forKey: id) {
            continuation.finish()
            NSLog("[AudioEventBus] Subscriber removed: \(id) (total: \(subscribers.count))")
        }
    }

    /// Publish an audio packet to all subscribers.
    /// Dropped if no subscribers are registered (silent no-op).
    func publish(_ packet: AudioPacket) {
        for (_, continuation) in subscribers {
            continuation.yield(packet)
        }
    }

    /// Number of active subscribers.
    var subscriberCount: Int {
        subscribers.count
    }
}
