/*
 * AudioTapClient.swift
 *
 * WebSocket client that connects to the relay server's /tap/audio endpoint
 * and receives JSON audio frames. Decodes them to AudioPacket and publishes
 * to the local AudioEventBus for any consumer (transcription, VU meter, etc.)
 * to use.
 *
 * Architecture:
 *   Relay Server /tap/audio --[WebSocket JSON]--> AudioTapClient
 *     --> RemoteAudioFrame --> AudioPacket --> AudioEventBus --> subscribers
 *
 * Features:
 *   - Auto-reconnect with exponential backoff (1s, 2s, 4s, max 30s)
 *   - Multiple concurrent tap clients supported
 *   - Receives loop for URLSessionWebSocketTask protocol compliance
 *   - Ping keepalive prevents proxy/NAT idle disconnects
 *   - Non-audio messages and empty PCM silently ignored
 *
 * Runs on its own actor executor -- never blocks the main thread.
 */

import Foundation

// MARK: - WebSocket Delegate

private final class AudioTapWebSocketDelegate: NSObject, URLSessionWebSocketDelegate, Sendable {
    let onOpen: @Sendable () -> Void
    let onClose: @Sendable (Error?) -> Void

    init(onOpen: @Sendable @escaping () -> Void, onClose: @Sendable @escaping (Error?) -> Void) {
        self.onOpen = onOpen
        self.onClose = onClose
        super.init()
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol proto: String?) {
        NSLog("[AudioTapClient] WebSocket did open, protocol: \(proto ?? "none")")
        onOpen()
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        NSLog("[AudioTapClient] WebSocket closed: \(closeCode.rawValue)")
        onClose(nil)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let error {
            NSLog("[AudioTapClient] WebSocket connection failed: \(error)")
            onClose(error)
        }
    }
}

// MARK: - AudioTapClient

actor AudioTapClient {
    private let eventBus: AudioEventBus

    // Connection state
    private var webSocketTask: URLSessionWebSocketTask?
    private var session: URLSession?
    private var delegate: AudioTapWebSocketDelegate?
    private(set) var isConnected: Bool = false

    // Background tasks
    private var receiveLoopTask: Task<Void, Never>?
    private var keepAliveTask: Task<Void, Never>?
    private var reconnectTask: Task<Void, Never>?

    // Stats
    private(set) var framesReceived: UInt64 = 0

    // Reconnect config
    private var reconnectDelay: UInt64 = 1_000_000_000 // 1 second
    private let maxReconnectDelay: UInt64 = 30_000_000_000 // 30 seconds
    private var targetURL: String?
    private var targetSession: String?
    private var shouldReconnect = false

    init(eventBus: AudioEventBus) {
        self.eventBus = eventBus
    }

    // MARK: - URL Construction

    /// Build the /tap/audio URL from a base relay URL and optional session ID.
    /// Strips /publish from the base URL if present.
    nonisolated func tapURL(for baseURL: String, session: String?) -> String {
        var base = baseURL

        // Strip trailing /publish if present (user might paste the publisher URL)
        if base.hasSuffix("/publish") {
            base = String(base.dropLast("/publish".count))
        } else if base.contains("/publish?") {
            if let range = base.range(of: "/publish?") {
                base = String(base[..<range.lowerBound])
            }
        }

        let sessionId = session ?? "default"
        return "\(base)/tap/audio?session=\(sessionId)"
    }

    // MARK: - Connection

    /// Connect to the relay server's /tap/audio endpoint.
    /// Optionally auto-reconnects on disconnect.
    func connect(to relayURL: String, session: String? = nil, autoReconnect: Bool = true) async throws {
        disconnect()

        targetURL = relayURL
        targetSession = session
        shouldReconnect = autoReconnect
        reconnectDelay = 1_000_000_000

        let tapURLString = tapURL(for: relayURL, session: session)
        guard let url = URL(string: tapURLString) else {
            throw AudioTapError.invalidURL(tapURLString)
        }

        NSLog("[AudioTapClient] Connecting to \(tapURLString) ...")

        let connected = await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
            var resumed = false

            let delegate = AudioTapWebSocketDelegate(
                onOpen: {
                    guard !resumed else { return }
                    resumed = true
                    continuation.resume(returning: true)
                },
                onClose: { error in
                    guard !resumed else { return }
                    resumed = true
                    continuation.resume(returning: false)
                }
            )

            let session = URLSession(configuration: .default, delegate: delegate, delegateQueue: nil)
            let task = session.webSocketTask(with: url)

            self.session = session
            self.delegate = delegate
            self.webSocketTask = task
            task.resume()

            // 5 second timeout
            _ = Task {
                try? await Task.sleep(nanoseconds: 5_000_000_000)
                guard !resumed else { return }
                resumed = true
                NSLog("[AudioTapClient] Connection timed out after 5s")
                continuation.resume(returning: false)
            }
        }

        if connected {
            isConnected = true
            framesReceived = 0
            startReceiveLoop()
            startKeepAlive()
            NSLog("[AudioTapClient] Connected to \(tapURLString)")
        } else {
            disconnect()
            throw AudioTapError.connectionFailed(tapURLString)
        }
    }

    func disconnect() {
        shouldReconnect = false
        reconnectTask?.cancel()
        reconnectTask = nil
        receiveLoopTask?.cancel()
        keepAliveTask?.cancel()
        receiveLoopTask = nil
        keepAliveTask = nil
        webSocketTask?.cancel(with: .goingAway, reason: nil)
        webSocketTask = nil
        session?.invalidateAndCancel()
        session = nil
        delegate = nil
        isConnected = false
        NSLog("[AudioTapClient] Disconnected")
    }

    // MARK: - Frame Handling

    /// Process a received remote audio frame.
    /// Called internally when a JSON message arrives from the WebSocket.
    func handleReceivedFrame(_ frame: RemoteAudioFrame) {
        guard frame.type == "audio" else { return }

        guard let packet = frame.toAudioPacket() else { return }

        framesReceived += 1
        Task { await eventBus.publish(packet) }
    }

    // MARK: - Receive Loop

    private func startReceiveLoop() {
        receiveLoopTask = Task {
            while !Task.isCancelled {
                guard let wsTask = self.webSocketTask else { break }
                do {
                    let message = try await wsTask.receive()
                    switch message {
                    case .string(let text):
                        await self.handleTextMessage(text)
                    case .data(let data):
                        NSLog("[AudioTapClient] Received binary: \(data.count) bytes (unexpected)")
                    @unknown default:
                        break
                    }
                } catch {
                    NSLog("[AudioTapClient] Receive loop ended: \(error.localizedDescription)")
                    self.isConnected = false
                    break
                }
            }
            NSLog("[AudioTapClient] Receive loop exited")
            await self.triggerReconnect()
        }
    }

    private func handleTextMessage(_ text: String) async {
        guard let data = text.data(using: .utf8) else { return }
        guard let frame = try? JSONDecoder().decode(RemoteAudioFrame.self, from: data) else {
            NSLog("[AudioTapClient] Failed to decode audio frame: \(text.prefix(100))")
            return
        }
        handleReceivedFrame(frame)
    }

    // MARK: - Keepalive

    private func startKeepAlive() {
        keepAliveTask = Task {
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 5_000_000_000)
                guard !Task.isCancelled else { break }
                guard let wsTask = self.webSocketTask else { break }
                wsTask.sendPing { [weak self] error in
                    if let error {
                        NSLog("[AudioTapClient] Ping failed: \(error)")
                        Task { [weak self] in
                            await self?.markDisconnected()
                        }
                    }
                }
            }
        }
    }

    // MARK: - Reconnect

    private func triggerReconnect() async {
        guard shouldReconnect else { return }
        guard let relayURL = targetURL else { return }

        reconnectTask?.cancel()
        reconnectTask = Task {
            try? await Task.sleep(nanoseconds: reconnectDelay)
            guard !Task.isCancelled else { return }
            guard self.shouldReconnect else { return }

            NSLog("[AudioTapClient] Reconnecting in \(self.reconnectDelay / 1_000_000_000)s ...")

            // Exponential backoff
            self.reconnectDelay = min(self.reconnectDelay * 2, self.maxReconnectDelay)

            do {
                try await self.connect(to: relayURL, session: self.targetSession, autoReconnect: true)
            } catch {
                NSLog("[AudioTapClient] Reconnect failed: \(error)")
            }
        }
    }

    private func markDisconnected() {
        isConnected = false
    }
}

// MARK: - Errors

enum AudioTapError: LocalizedError {
    case invalidURL(String)
    case connectionFailed(String)

    var errorDescription: String? {
        switch self {
        case .invalidURL(let url): return "Invalid tap URL: \(url)"
        case .connectionFailed(let url): return "Failed to connect to tap: \(url)"
        }
    }
}
