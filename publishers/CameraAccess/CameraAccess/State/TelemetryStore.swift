//
// TelemetryStore.swift
//
// Periodic telemetry and stage metrics push to relay server.
//

import SwiftUI

@MainActor
@Observable
final class TelemetryStore {

  private var telemetryPushTimer: Task<Void, Never>?
  private var stageMetricsCollector: StageMetricsCollector?
  private var stageMetricsTimer: Task<Void, Never>?

  // Weak references to avoid retain cycles (owned by coordinator)
  private weak var telemetryService: TelemetryService?
  private weak var relayStage: RelayStage?
  private weak var pipeline: FramePipelineManager?

  // References to standalone stages for metrics collection
  private weak var audioClassificationStage: AudioClassificationStage?
  private weak var speechRecognitionStage: SpeechRecognitionStage?

  init() {}

  func configure(
    telemetryService: TelemetryService,
    relayStage: RelayStage,
    pipeline: FramePipelineManager,
    audioClassificationStage: AudioClassificationStage?,
    speechRecognitionStage: SpeechRecognitionStage?
  ) {
    self.telemetryService = telemetryService
    self.relayStage = relayStage
    self.pipeline = pipeline
    self.audioClassificationStage = audioClassificationStage
    self.speechRecognitionStage = speechRecognitionStage
  }

  func startTimers() {
    stopTimers()

    telemetryPushTimer = Task { [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(nanoseconds: 2_000_000_000)
        guard let self else { return }
        await self.pushTelemetry()
      }
    }

    if let pipeline {
      stageMetricsCollector = StageMetricsCollector(pipelineManager: pipeline)
    }

    stageMetricsTimer = Task { [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(nanoseconds: 1_000_000_000)
        guard let self else { return }
        await self.pushStageMetrics()
      }
    }
  }

  func stopTimers() {
    telemetryPushTimer?.cancel()
    telemetryPushTimer = nil
    stageMetricsTimer?.cancel()
    stageMetricsTimer = nil
    stageMetricsCollector = nil
  }

  // MARK: - Private

  private func pushTelemetry() async {
    guard let snap = telemetryService?.snapshot else { return }
    guard let relayStage else { return }
    let relayStats = await relayStage.getStats()
    telemetryService?.updateRelayLatency(relayStats["latencyMs"] as? Double)
    telemetryService?.lastTotalBytesSent = relayStats["totalBytesSent"] as? UInt64 ?? 0
    var payload: [String: Any] = [
      "type": "publisher_telemetry",
      "frame": [
        "fps": snap.frame.effectiveFPS,
        "jitterMs": snap.frame.jitterMs ?? 0,
        "totalFrames": snap.frame.totalFramesReceived,
        "droppedFrames": snap.frame.droppedFrameGaps,
      ],
      "relay": relayStats,
      "session": [
        "state": String(describing: snap.session.currentState),
        "uptime": snap.session.uptime.map { Duration.seconds($0.components.seconds).description },
      ] as [String: Any],
      "errors": [
        "total": snap.errors.totalErrors,
        "recent": snap.errors.recentErrors.map { $0.errorDescription },
      ],
      "battery": [
        "level": snap.battery.level,
        "state": snap.battery.state,
        "lowPowerMode": snap.battery.lowPowerMode,
      ],
      "thermal": [
        "state": snap.thermal.state,
      ],
      "network": [
        "type": snap.network.type,
        "expensive": snap.network.expensive,
        "constrained": snap.network.constrained,
      ],
      "memory": [
        "availableMB": snap.memory.availableMB,
        "pressure": snap.memory.pressure,
      ],
      "relayLatency": [
        "ms": snap.relay?.latencyMs ?? 0,
      ],
      "disk": [
        "availableGB": snap.disk.availableGB,
        "totalGB": snap.disk.totalGB,
        "percentUsed": snap.disk.percentUsed,
      ],
      "cellular": [
        "technology": snap.cellular?.technology as Any,
        "carrier": snap.cellular?.carrier as Any,
      ],
      "display": [
        "brightness": snap.display.brightness,
      ],
      "camera": [
        "iso": snap.camera?.iso as Any,
        "exposureMs": snap.camera?.exposureMs as Any,
        "lensAperture": snap.camera?.lensAperture as Any,
      ] as [String: Any],
      "orientation": snap.orientation.orientation,
      "motion": [
        "x": snap.motion?.accelX as Any,
        "y": snap.motion?.accelY as Any,
        "z": snap.motion?.accelZ as Any,
        "stationary": snap.motion?.isStationary as Any,
      ] as [String: Any],
      "bluetooth": [
        "state": snap.bluetooth.state,
      ],
      "cpu": [
        "usagePercent": snap.cpu.usagePercent,
      ],
      "location": [
        "speed": snap.location?.speed as Any,
        "altitude": snap.location?.altitude as Any,
        "accuracy": snap.location?.accuracy as Any,
      ] as [String: Any],
      "gyro": [
        "x": snap.gyro?.rotationX as Any,
        "y": snap.gyro?.rotationY as Any,
        "z": snap.gyro?.rotationZ as Any,
      ] as [String: Any],
      "magnetometer": [
        "x": snap.magnetometer?.magX as Any,
        "y": snap.magnetometer?.magY as Any,
        "z": snap.magnetometer?.magZ as Any,
      ] as [String: Any],
      "barometer": [
        "pressureKPa": snap.barometer?.pressureKPa as Any,
      ] as [String: Any],
      "audioLevel": [
        "peakDb": snap.audioLevel?.peakDb as Any,
        "averageDb": snap.audioLevel?.averageDb as Any,
      ] as [String: Any],
      "memoryFootprint": [
        "footprintMB": snap.memoryFootprint.footprintMB,
      ],
      "proximity": [
        "near": snap.proximity.near,
      ],
      "background": [
        "foregroundSec": snap.background.foregroundSec,
        "backgroundSec": snap.background.backgroundSec,
      ],
      "throughput": [
        "bytesPerSec": snap.throughput?.bytesPerSec as Any,
        "totalMB": snap.throughput?.totalMB as Any,
      ] as [String: Any],
      "activity": [
        "type": snap.activity?.type.rawValue as Any,
        "confidence": snap.activity?.confidence as Any,
      ] as [String: Any],
    ]

    await relayStage.sendJson(payload)
  }

  private func pushStageMetrics() async {
    guard let collector = stageMetricsCollector, let relayStage else { return }
    var payload = await collector.telemetryDict()
    var standaloneSnapshots: [[String: Any]] = payload["stages"] as? [[String: Any]] ?? []
    if let audio = audioClassificationStage, let snap = await audio.collectMetrics() {
      standaloneSnapshots.append(snap.toDict())
    }
    if let speech = speechRecognitionStage, let snap = await speech.collectMetrics() {
      standaloneSnapshots.append(snap.toDict())
    }
    payload["stages"] = standaloneSnapshots
    await relayStage.sendJson(payload)
  }
}
