/*
 * SensorRelayStage.swift
 *
 * Standalone actor that reads TelemetrySnapshot from TelemetryService at 1Hz,
 * builds FRSE wire protocol frames, and sends them over the relay WebSocket
 * via RelayStage.sendRawData().
 *
 * Not a FramePipelineStage — sensor frames are independent of video frames.
 * Uses the existing WebSocket connection owned by RelayStage.
 */

import Foundation

actor SensorRelayStage {
    private weak var relayStage: RelayStage?
    private weak var telemetryService: TelemetryService?

    private var sequenceNumber: UInt64 = 0
    private var timerTask: Task<Void, Never>?

    /// All phone-side sensor groups enabled by default.
    static let defaultFlags: SensorFlags = [
        .motion, .gyro, .magnetometer, .barometer,
        .location, .proximity, .battery, .network,
        .thermal, .orientation, .memory, .cpu, .disk,
        .streamMetrics,
    ]

    private let flags: SensorFlags

    init(flags: SensorFlags = SensorRelayStage.defaultFlags) {
        self.flags = flags
    }

    /// Configure the relay stage and telemetry service references.
    /// Must be called before start().
    func configure(relayStage: RelayStage, telemetryService: TelemetryService) {
        self.relayStage = relayStage
        self.telemetryService = telemetryService
    }

    /// Start the 1Hz sensor relay timer.
    func start() {
        guard timerTask == nil else { return }
        NSLog("[SensorRelayStage] Starting sensor relay at 1Hz")

        timerTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.tick()
                try? await Task.sleep(nanoseconds: 1_000_000_000) // 1 second
            }
        }
    }

    /// Stop the sensor relay timer.
    func stop() {
        timerTask?.cancel()
        timerTask = nil
        NSLog("[SensorRelayStage] Stopped")
    }

    // MARK: - Private

    private func tick() async {
        guard let relayStage, let telemetryService else { return }

        // TelemetryService is @MainActor — hop to main to read snapshot
        let snapshot = await MainActor.run { telemetryService.snapshot }
        guard let snapshot else { return }

        sequenceNumber += 1
        guard let frame = SensorWireProtocol.buildFRSE(
            snapshot: snapshot,
            flags: flags,
            sequenceNumber: sequenceNumber
        ) else {
            NSLog("[SensorRelayStage] Failed to build FRSE frame")
            return
        }

        relayStage.sendRawData(frame)
    }
}
