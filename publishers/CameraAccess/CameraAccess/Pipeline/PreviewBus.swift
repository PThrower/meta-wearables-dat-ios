/*
 * PreviewBus.swift
 *
 * Actor-based pub/sub for PreviewEvent using AsyncStream.
 * Decouples pipeline stage outputs from the preview UI.
 *
 * Stages publish typed preview events (text, numeric, image, waveform, status).
 * The NodePreviewView subscribes and renders them in a debug overlay.
 *
 * Lifecycle:
 *   1. Stage calls publish() with a PreviewEvent
 *   2. Subscriber calls subscribe() -> gets (UUID, AsyncStream<PreviewEvent>)
 *   3. Subscriber iterates the stream: `for await event in stream { ... }`
 *   4. Subscriber calls unsubscribe(id) when done
 *
 * Uses bufferingNewest(50) -- stale previews are dropped since only
 * the latest state matters for UI rendering.
 */

import Foundation
import UIKit

// MARK: - PreviewSource

/// Identifies which pipeline stage produced a preview event.
struct PreviewSource: Hashable, Sendable, Identifiable {
    let stageId: String
    let label: String

    var id: String { stageId }
}

// MARK: - PreviewEvent

/// Typed output from a pipeline stage, suitable for debug preview rendering.
enum PreviewEvent: Sendable {
    /// A text string (e.g., guidance text, TTS queue, display mirror, error).
    case text(source: PreviewSource, value: String)

    /// A single numeric value with optional unit (e.g., FPS, latency, battery).
    case numeric(source: PreviewSource, label: String, value: Double, unit: String)

    /// An image (e.g., camera frame snapshot).
    case image(source: PreviewSource, value: UIImage)

    /// Audio waveform data (Int16 PCM samples).
    case waveform(source: PreviewSource, data: Data, sampleRate: UInt32)

    /// A structured JSON-like dictionary (e.g., relay stats, sensor snapshot).
    case json(source: PreviewSource, value: [String: Any])

    /// A status indicator with semantic color.
    case status(source: PreviewSource, label: String, state: PreviewState)

    var source: PreviewSource {
        switch self {
        case .text(let s, _): return s
        case .numeric(let s, _, _, _): return s
        case .image(let s, _): return s
        case .waveform(let s, _, _): return s
        case .json(let s, _): return s
        case .status(let s, _, _): return s
        }
    }
}

// MARK: - PreviewState

/// Semantic state for status indicators.
enum PreviewState: String, Sendable {
    case nominal    // Green -- normal operation
    case active     // Cyan -- actively processing
    case warning    // Yellow -- degraded
    case error      // Red -- failure
    case idle       // Gray -- not running
    case disabled   // Dimmed -- intentionally off

    var colorName: String {
        switch self {
        case .nominal: return "green"
        case .active: return "cyan"
        case .warning: return "yellow"
        case .error: return "red"
        case .idle: return "gray"
        case .disabled: return "dimmed"
        }
    }
}

// MARK: - PreviewBus

actor PreviewBus {
    private var subscribers: [UUID: AsyncStream<PreviewEvent>.Continuation] = [:]

    /// Latest event per source (for snapshot queries without streaming).
    private var latest: [String: PreviewEvent] = [:]

    /// Subscribe to preview events.
    /// Returns a subscription ID and an AsyncStream.
    func subscribe() -> (id: UUID, stream: AsyncStream<PreviewEvent>) {
        let id = UUID()
        let (stream, continuation) = AsyncStream<PreviewEvent>.makeStream(bufferingPolicy: .bufferingNewest(50))
        subscribers[id] = continuation
        return (id, stream)
    }

    /// Unsubscribe from preview events. Finishes the stream.
    func unsubscribe(_ id: UUID) {
        if let continuation = subscribers.removeValue(forKey: id) {
            continuation.finish()
        }
    }

    /// Publish a preview event to all subscribers.
    /// Also stores the latest event per source for snapshot queries.
    func publish(_ event: PreviewEvent) {
        latest[event.source.stageId] = event
        for (_, continuation) in subscribers {
            continuation.yield(event)
        }
    }

    /// Get the latest event for a specific source (snapshot query).
    func getLatest(for stageId: String) -> PreviewEvent? {
        latest[stageId]
    }

    /// Get all latest events (snapshot of current state).
    func getAllLatest() -> [String: PreviewEvent] {
        latest
    }

    /// Number of active subscribers.
    var subscriberCount: Int {
        subscribers.count
    }

    /// Clear all stored latest events.
    func reset() {
        latest.removeAll()
    }
}
