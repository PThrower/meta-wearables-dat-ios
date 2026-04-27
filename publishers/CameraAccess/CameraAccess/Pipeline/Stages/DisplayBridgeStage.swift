/*
 * DisplayBridgeStage.swift
 *
 * Pipeline stage that receives display_frame JSON messages from the relay server
 * and forwards them to the EvenRealitiesManager for BLE transmission to glasses.
 *
 * Flow:
 *   Server -> display_frame JSON -> RelayStage (receive loop)
 *     -> onDisplayFrame callback -> DisplayBridgeStage
 *     -> EvenRealitiesManager.sendDisplayContent(lines:)
 *     -> BLE -> Glasses display
 *
 * Throttles display updates to prevent overwhelming BLE bandwidth.
 * Runs on its own actor executor — never blocks the main thread.
 */

import Foundation

actor DisplayBridgeStage: @preconcurrency FramePipelineStage {
    nonisolated let stageId = "display-bridge"
    var config: FrameStageConfig

    // Reference to the BLE manager for sending display content
    private var manager: EvenRealitiesManager?

    // Throttle: minimum interval between display updates
    private let minIntervalMs: Double = 250 // ms
    private var lastUpdateTime: ContinuousClock.Instant?

    init(config: FrameStageConfig = FrameStageConfig(targetFPS: 4, isEnabled: true)) {
        self.config = config
    }

    func setManager(_ manager: EvenRealitiesManager) {
        self.manager = manager
    }

    // MARK: - FramePipelineStage

    nonisolated func processFrame(_ packet: FramePacket) async {
        // Display bridge does not process video frames
    }

    func start() async {
        lastUpdateTime = nil
    }

    func stop() async {
        // Clear the glasses display on pipeline stop
        await manager?.clearDisplay()
    }

    // MARK: - Display Frame Handling

    /// Handle a display_frame message from the relay server.
    /// Extracts text lines and sends to the BLE manager.
    func handleDisplayFrame(_ json: [String: Any]) {
        NSLog("[DisplayBridge] handleDisplayFrame called: \(json)")

        guard let manager = manager else {
            NSLog("[DisplayBridge] ERROR: manager is nil — setManager was never called")
            return
        }

        // Throttle check
        let now = ContinuousClock.Instant.now
        if let last = lastUpdateTime {
            let elapsed = now - last
            let elapsedMs = Double(elapsed.components.seconds) * 1000.0
                + Double(elapsed.components.attoseconds) / 1e15
            if elapsedMs < minIntervalMs {
                NSLog("[DisplayBridge] Throttled — skipping")
                return
            }
        }
        lastUpdateTime = now

        // Extract lines from display_frame
        guard let lines = json["lines"] as? [String], !lines.isEmpty else {
            NSLog("[DisplayBridge] ERROR: no lines in display_frame")
            return
        }

        NSLog("[DisplayBridge] Forwarding \(lines.count) lines to BLE manager: \(lines)")
        Task {
            await manager.sendDisplayContent(lines: lines)
        }
    }
}
