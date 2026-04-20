/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the
 * LICENSE file in the root directory of this source tree.
 */

//
// StreamSessionViewModel.swift
//
// Core view model demonstrating video streaming from Meta wearable devices using the DAT SDK.
// Video frames are routed through FramePipelineManager to composable pipeline stages
// (DisplayStage for UI, RecordingStage for .mov capture, etc.).
//

import AVFoundation
import MediaPlayer
import MWDATCamera
import MWDATCore
import Photos
import SwiftUI

enum StreamingStatus {
  case streaming
  case waiting
  case stopped
}

/// Relay connection state — tracks WebSocket lifecycle independently from streaming.
enum RelayMode {
  case disconnected   // WebSocket not connected
  case standby        // WebSocket connected, no frames (ready for remote start_stream)
  case active         // WebSocket connected, streaming frames + audio
}

/// Audio input source for the relay stream.
/// Controls which microphone feeds get sent to the cloud relay.
enum AudioInputMode: String, CaseIterable, Identifiable {
  case builtInMic = "Phone Mic"
  case glassesMic = "Glasses Mic"
  case all = "All"

  var id: String { rawValue }

  var systemImage: String {
    switch self {
    case .builtInMic: return "iphone.radiowaves.left.and.right"
    case .glassesMic: return "headphones"
    case .all: return "waveform.badge.plus"
    }
  }
}

/// Lightweight representation of an AI app from the relay server.
struct AppInfo: Identifiable, Equatable {
  let id: String
  let name: String
  let description: String
  let icon: String  // SF Symbol name
}

@MainActor
class StreamSessionViewModel: ObservableObject {
  @Published var currentVideoFrame: UIImage?
  @Published var hasReceivedFirstFrame: Bool = false
  @Published var streamingStatus: StreamingStatus = .stopped
  @Published var showError: Bool = false
  @Published var errorMessage: String = ""
  @Published var errorLog: [String] = []
  @Published var hasActiveDevice: Bool = false
  @Published var selectedDeviceId: DeviceIdentifier?

  // Retry state
  @Published var isRetrying: Bool = false
  @Published var retryCount: Int = 0

  // Stream config (user-adjustable)
  @Published var selectedResolution: StreamingResolution = .high {
    didSet { rebuildSessionWithNewConfig() }
  }
  @Published var selectedFrameRate: UInt = 30 {
    didSet { rebuildSessionWithNewConfig() }
  }

  // TTS playback state
  @Published var isTTSPlaybackEnabled: Bool = false

  // TTS playback methods — toggled independently from streaming
  func startTTSPlayback() async {
    await audioPlaybackStage.start()
  }

  func stopTTSPlayback() async {
    await audioPlaybackStage.stop()
  }

  // Recording state
  @Published var isRecording: Bool = false

  // Relay state
  @Published var relayMode: RelayMode = .disconnected
  @Published var isTapConnected: Bool = false
  @Published var activeAppId: String?
  @Published var availableApps: [AppInfo] = []
  @Published var isLoadingApps: Bool = false
  @Published var appFetchError: String?
  @Published var relayURL: String = "wss://relay.simulationapi.com/publish"
  @Published var boundingBoxes: [BoundingBox] = []
  @Published var showBboxOverlay: Bool = true
  @Published var audioInputMode: AudioInputMode = .builtInMic {
    didSet {
      // DISABLED: Calling routeAudioInput() while the DAT SDK video stream is
      // active tears down the BT HFP link and kills video. Audio routing changes
      // must only happen before streaming starts. The mode is stored so it can
      // be applied on the next relay session if needed in the future.
    }
  }


  var isStreaming: Bool {
    streamingStatus != .stopped
  }

  // Photo capture properties
  @Published var capturedPhoto: UIImage?
  @Published var showPhotoPreview: Bool = false

  // Background handling
  private var backgroundTaskIdentifier: UIBackgroundTaskIdentifier = .invalid
  private var wasStreamingBeforeBackground: Bool = false

  // Active wearable tracking (captures device identity when using auto-select)
  private var activeWearableId: DeviceIdentifier?
  private var activeWearableType: String?

  // The core DAT SDK StreamSession - handles all streaming operations
  private var streamSession: StreamSession
  // Listener tokens for non-video-frame subscriptions (state, error, photo)
  private var stateListenerToken: AnyListenerToken?
  private var errorListenerToken: AnyListenerToken?
  private var photoDataListenerToken: AnyListenerToken?
  private let wearables: WearablesInterface
  private var currentSelector: any DeviceSelector
  private var deviceMonitorTask: Task<Void, Never>?
  private var retryTask: Task<Void, Never>?
  private weak var telemetryService: TelemetryService?

  // Pipeline
  private let pipeline = FramePipelineManager()
  private let recordingStage = RecordingStage()
  private let relayStage = RelayStage()
  private let audioStage = AudioStage(source: .builtInMic)
  private let glassesAudioStage = AudioStage(source: .bluetoothHFP)
  private let audioRelayStage = AudioRelayStage()
  private let audioEventBus = AudioEventBus()
  private let audioPlaybackStage = AudioPlaybackStage()
  private let audioTapClient: AudioTapClient
  private var displayStage: DisplayStage!
  private var inboundAudioEngine: AVAudioEngine?
  private var inboundPlayerNode: AVAudioPlayerNode?
  private var telemetryPushTimer: Task<Void, Never>?

  private var streamConfig: StreamSessionConfig {
    StreamSessionConfig(
      videoCodec: VideoCodec.raw,
      resolution: selectedResolution,
      frameRate: selectedFrameRate)
  }

  // MARK: - Retry constants

  private static let maxRetries = 3
  private static let retryableErrors: Set<String> = [
    "internalError", "timeout", "deviceNotConnected", "videoStreamingError"
  ]

  init(wearables: WearablesInterface, telemetryService: TelemetryService? = nil) {
    self.wearables = wearables
    self.telemetryService = telemetryService
    // Start with auto-select
    self.currentSelector = AutoDeviceSelector(wearables: wearables)
    self.streamSession = StreamSession(
      streamSessionConfig: StreamSessionConfig(videoCodec: .raw, resolution: .high, frameRate: 30),
      deviceSelector: currentSelector
    )

    // Wire decoupled audio pipeline before display stage closure captures self:
    //   AudioStage(builtIn) -> AudioEventBus -> AudioRelayStage -> RelayStage -> WebSocket
    //   AudioStage(glasses) -> AudioEventBus (same bus, codecType distinguishes sources)
    //   AudioTapClient -> AudioEventBus (receives remote audio frames from /tap/audio)
    self.audioTapClient = AudioTapClient(eventBus: audioEventBus)

    // Create display stage with MainActor callback (safe to capture self after all stored props initialized)
    self.displayStage = DisplayStage { [weak self] image in
      self?.currentVideoFrame = image
      guard let self, !self.hasReceivedFirstFrame else { return }
      self.hasReceivedFirstFrame = true
      self.cancelRetry()
    }

    // Register stages
    pipeline.register(displayStage)
    pipeline.register(recordingStage)
    pipeline.register(relayStage)

    Task {
      await audioStage.setEventBus(audioEventBus)
      await glassesAudioStage.setEventBus(audioEventBus)
      await audioPlaybackStage.setEventBus(audioEventBus)
      await audioRelayStage.setRelayStage(relayStage)
    }

    setupSessionListeners()
    attachPipeline()
    telemetryService?.attachToStreamSession(streamSession)

    // Monitor device availability and capture wearable identity for auto-select
    deviceMonitorTask = Task { @MainActor [weak self] in
      guard let self else { return }
      for await device in self.currentSelector.activeDeviceStream() {
        self.hasActiveDevice = device != nil
        if let device {
          self.activeWearableId = device
          self.activeWearableType = self.wearables.deviceForIdentifier(device)?.deviceType().displayName
        }
      }
    }

    updateStatusFromState(streamSession.state)
  }

  // MARK: - Device Selection

  func selectDevice(_ deviceId: DeviceIdentifier?) {
    guard !isStreaming else { return }
    selectedDeviceId = deviceId

    // Stop monitoring old selector
    deviceMonitorTask?.cancel()

    // Create new selector
    if let deviceId {
      let selector = SpecificDeviceSelector(device: deviceId)
      currentSelector = selector
      NSLog("[StreamSession] Selected device: \(deviceId)")
    } else {
      let selector = AutoDeviceSelector(wearables: wearables)
      currentSelector = selector
      NSLog("[StreamSession] Using auto device selector")
    }

    // Rebuild session with new selector
    streamSession = StreamSession(streamSessionConfig: streamConfig, deviceSelector: currentSelector)
    setupSessionListeners()
    attachPipeline()
    telemetryService?.attachToStreamSession(streamSession)

    // Re-monitor device availability and capture wearable identity
    deviceMonitorTask = Task { @MainActor [weak self] in
      guard let self else { return }
      for await device in self.currentSelector.activeDeviceStream() {
        self.hasActiveDevice = device != nil
        if let device {
          self.activeWearableId = device
          self.activeWearableType = self.wearables.deviceForIdentifier(device)?.deviceType().displayName
        }
      }
    }

    updateStatusFromState(streamSession.state)
  }

  // MARK: - Config

  /// Attach the pipeline as the single subscriber to videoFramePublisher.
  private func attachPipeline() {
    pipeline.attachToStreamSession(streamSession)
  }

  // MARK: - Session Listeners

  private func setupSessionListeners() {
    stateListenerToken = streamSession.statePublisher.listen { [weak self] state in
      Task { @MainActor [weak self] in
        self?.updateStatusFromState(state)
      }
    }

    // Video frames are now routed through FramePipelineManager — no inline listener

    errorListenerToken = streamSession.errorPublisher.listen { [weak self] error in
      Task { @MainActor [weak self] in
        guard let self else { return }
        let rawError = String(describing: error)
        let state = String(describing: self.streamingStatus)
        let device = self.selectedDeviceId ?? "auto"
        let timestamp = DateFormatter.localizedString(from: Date(), dateStyle: .none, timeStyle: .medium)
        let logEntry = "[\(timestamp)] \(rawError) | state=\(state) | device=\(device)"
        NSLog("[StreamSession] ERROR: \(logEntry)")
        self.errorLog.append(logEntry)
        if self.errorLog.count > 50 { self.errorLog.removeFirst(self.errorLog.count - 50) }
        self.errorMessage = "\(rawError) | \(state) | \(device)"

        // Auto-retry on transient errors
        if self.shouldRetry(error: error) {
          self.scheduleRetry()
        } else {
          self.showError = true
        }

        // Forward error to relay viewers
        if self.relayMode == .active {
          await self.relayStage.sendJson([
            "type": "publisher_error",
            "error": rawError,
            "state": state,
          ])
        }
      }
    }

    photoDataListenerToken = streamSession.photoDataPublisher.listen { [weak self] photoData in
      Task { @MainActor [weak self] in
        guard let self else { return }
        if let uiImage = UIImage(data: photoData.data) {
          self.capturedPhoto = uiImage
          self.showPhotoPreview = true
        }
      }
    }
  }

  // MARK: - Recording

  func startRecording() async {
    let documentsDir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    let formatter = DateFormatter()
    formatter.dateFormat = "yyyyMMdd_HHmmss"
    let filename = "recording_\(formatter.string(from: Date())).mov"
    let url = documentsDir.appendingPathComponent(filename)

    do {
      try await recordingStage.startRecording(to: url)
      isRecording = true
      NSLog("[StreamSession] Recording started: \(filename)")
    } catch {
      NSLog("[StreamSession] Recording failed to start: \(error)")
      errorMessage = "Recording failed: \(error.localizedDescription)"
      showError = true
    }
  }

  func stopRecording() async {
    let url = await recordingStage.stopRecording()
    isRecording = false
    NSLog("[StreamSession] Recording stopped: \(url?.lastPathComponent ?? "nil")")

    // Save to Photos album
    if let url {
      do {
        try await saveToPhotos(url: url)
      } catch {
        NSLog("[StreamSession] Failed to save to Photos: \(error)")
      }
    }
  }

  private func saveToPhotos(url: URL) async throws {
    try await PHPhotoLibrary.shared().performChanges {
      PHAssetChangeRequest.creationRequestForAssetFromVideo(atFileURL: url)
    }
  }

  // MARK: - Relay (video + audio)

  // THREADING REVIEW [FIXED]:
  // Permission check runs on @MainActor here (safe for AVAudioSession APIs).
  // audioStage.start() no longer touches AVAudioSession — permission handled above.
  func startRelay() async {
    // If already in standby, just activate (start audio/telemetry without reconnecting)
    if relayMode == .standby {
      await activateFromStandby()
      return
    }

    var url = relayURL.trimmingCharacters(in: .whitespacesAndNewlines)

    // Append device identifier for stable session binding
    if let deviceId = UIDevice.current.identifierForVendor?.uuidString {
      let separator = url.contains("?") ? "&" : "?"
      url += "\(separator)device=\(deviceId)"
    }
    guard !url.isEmpty else {
      errorMessage = "Enter a relay URL (e.g. ws://192.168.1.x:3000/publish)"
      showError = true
      return
    }

    // Check mic permission on @MainActor BEFORE crossing to AudioStage actor.
    // AVAudioSession is @MainActor-isolated in iOS 17+ — must not be called from actors.
    guard await checkMicPermission() else {
      errorMessage = "Microphone permission required for audio relay"
      showError = true
      return
    }

    do {
      // Use manually selected device, or fall back to auto-selected active device
      let wearableId = selectedDeviceId ?? activeWearableId
      if let wearableId {
        let deviceTypeName: String? = selectedDeviceId != nil
          ? wearables.deviceForIdentifier(wearableId)?.deviceType().displayName
          : activeWearableType
        await relayStage.setDeviceIdentity(wearableId: wearableId, wearableType: deviceTypeName)
      }

      // Wire control message callback
      await wireControlMessageHandler()

      await relayStage.setOnReceivedAudio { [weak self] data in
        guard let parsed = WireProtocol.parseFRAU(data) else { return }
        NSLog("[StreamSession] Server audio: \(parsed.pcmData.count) bytes, \(parsed.sampleRate)Hz, \(parsed.channels)ch, \(parsed.bitsPerSample)bit codec=\(parsed.codecType)")
        Task { @MainActor [weak self] in
          guard let self else { return }
          self.playInboundPCM(parsed.pcmData, sampleRate: parsed.sampleRate, channels: parsed.channels, bitsPerSample: parsed.bitsPerSample)
        }
      }

      // On auto-reconnect, re-announce streaming state so server stops treating us as standby
      await relayStage.setOnReconnected { [weak self] in
        Task { [weak self] in
          guard let self else { return }
          let mode = await self.relayMode
          if mode == .active {
            NSLog("[StreamSession] Re-announcing active stream after auto-reconnect")
            await self.relayStage.sendJson(["type": "stream_changed", "streaming": true])
          }
        }
      }

      try await relayStage.connect(to: url)
      relayMode = .active
      NSLog("[StreamSession] Relay connected to \(url)")

      // Send initial link state to viewers (session may already be .streaming)
      let linkState: String
      switch streamSession.state {
      case .streaming: linkState = "connected"
      case .waitingForDevice: linkState = "disconnected"
      default: linkState = "unknown"
      }
      await relayStage.sendJson(["type": "link_state_changed", "state": linkState])
    } catch {
      errorMessage = "Relay failed: \(error.localizedDescription)"
      showError = true
      NSLog("[StreamSession] Relay error: \(error)")
      return
    }

    // Start audio, telemetry, and tap client
    await startRelayAudioAndTelemetry()
  }

  // MARK: - Standby Relay

  /// Connect to relay server in standby mode — ready for remote start_stream.
  /// Does NOT start audio, telemetry, or camera session.
  func startStandbyRelay() async {
    guard relayMode == .disconnected else { return }

    var url = relayURL.trimmingCharacters(in: .whitespacesAndNewlines)
    if let deviceId = UIDevice.current.identifierForVendor?.uuidString {
      let separator = url.contains("?") ? "&" : "?"
      url += "\(separator)device=\(deviceId)"
    }
    guard !url.isEmpty else { return }

    do {
      let wearableId = selectedDeviceId ?? activeWearableId
      if let wearableId {
        let deviceTypeName: String? = selectedDeviceId != nil
          ? wearables.deviceForIdentifier(wearableId)?.deviceType().displayName
          : activeWearableType
        await relayStage.setDeviceIdentity(wearableId: wearableId, wearableType: deviceTypeName)
      }

      await wireControlMessageHandler()
      try await relayStage.connect(to: url)
      relayMode = .standby
      NSLog("[StreamSession] Standby relay connected to \(url)")

      // Announce standby state to server
      await relayStage.sendJson(["type": "standby", "status": "ready"])
    } catch {
      NSLog("[StreamSession] Standby relay connect failed (non-fatal): \(error)")
    }
  }

  /// Transition from standby to active — start camera, wait for BT link, then audio + telemetry.
  /// Called when start_stream is received while in standby.
  private func activateFromStandby() async {
    guard relayMode == .standby else { return }

    // Check mic permission
    guard await checkMicPermission() else {
      await relayStage.sendJson(["type": "publisher_error", "error": "Microphone permission required", "state": "standby"])
      return
    }

    // Phase 1: Start camera session (establishes BT link to glasses)
    await startSession()
    relayMode = .active

    // Phase 2: Wait for DAT SDK BT video link to stabilize before touching audio.
    // Starting audio (especially HFP/Bluetooth mic) while the SDK's BT handshake
    // is in progress tears down the video link. Wait until frames are flowing.
    let linkEstablished = await waitForStreamReady(timeoutMs: 10_000)
    if !linkEstablished {
      NSLog("[StreamSession] Stream failed to establish within timeout — starting audio anyway")
    }

    // Phase 3: Wire inbound audio handler and start audio/telemetry
    await relayStage.setOnReceivedAudio { [weak self] data in
      guard let parsed = WireProtocol.parseFRAU(data) else { return }
      NSLog("[StreamSession] Server audio: \(parsed.pcmData.count) bytes, \(parsed.sampleRate)Hz, \(parsed.channels)ch, \(parsed.bitsPerSample)bit codec=\(parsed.codecType)")
      Task { @MainActor [weak self] in
        guard let self else { return }
        self.playInboundPCM(parsed.pcmData, sampleRate: parsed.sampleRate, channels: parsed.channels, bitsPerSample: parsed.bitsPerSample)
      }
    }

    await startRelayAudioAndTelemetry()

    // Send link state
    let linkState: String
    switch streamSession.state {
    case .streaming: linkState = "connected"
    case .waitingForDevice: linkState = "disconnected"
    default: linkState = "unknown"
    }
    await relayStage.sendJson(["type": "link_state_changed", "state": linkState])
  }

  /// Wait for the DAT SDK stream to be ready (first frame received or streaming state).
  /// Returns true if the stream established, false if timed out.
  private func waitForStreamReady(timeoutMs: Int64) async -> Bool {
    let deadline = ContinuousClock.Instant.now + Duration.milliseconds(timeoutMs)
    while ContinuousClock.Instant.now < deadline {
      if hasReceivedFirstFrame || streamingStatus == .streaming {
        return true
      }
      try? await Task.sleep(nanoseconds: 200_000_000) // 200ms poll
    }
    return false
  }

  /// Transition from active back to standby — stop camera/audio but keep WebSocket.
  private func backToStandby() async {
    guard relayMode == .active else { return }

    // Stop audio/telemetry but NOT the WebSocket
    telemetryPushTimer?.cancel()
    telemetryPushTimer = nil
    await audioStage.stop()
    await glassesAudioStage.stop()
    stopInboundAudioEngine()
    await audioRelayStage.detachFromEventBus(audioEventBus)
    await audioTapClient.disconnect()
    isTapConnected = false
    activeAppId = nil
    boundingBoxes = []

    relayMode = .standby
    await relayStage.sendJson(["type": "standby", "status": "ready"])
    NSLog("[StreamSession] Relayed backed to standby mode")
  }

  // MARK: - Shared Relay Helpers

  /// Wire the onControlMessage callback — shared between startRelay and startStandbyRelay.
  private func wireControlMessageHandler() async {
    await relayStage.setOnControlMessage { [weak self] msg in
      let msgType = msg["type"] as? String

      // App status updates
      if msgType == "app_status" {
        let status = msg["status"] as? String
        let appId = msg["appId"] as? String
        Task { @MainActor [weak self] in
          if status == "active" {
            self?.activeAppId = appId
            await self?.audioPlaybackStage.start()
          } else if status == "inactive" || status == "error" {
            self?.activeAppId = nil
            await self?.audioPlaybackStage.stop()
          }
        }
      }

      // Guidance text from server AI — trigger client-side TTS
      if msgType == "guidance_text",
         let text = msg["text"] as? String, !text.isEmpty {
        Task { [weak self] in
          await self?.audioPlaybackStage.speakGuidance(text)
        }
      }

      // Bounding box annotations from AI
      if msgType == "guidance_event",
         let evt = msg["event"] as? [String: Any],
         (evt["type"] as? String) == "guidance.bbox",
         let boxes = evt["boundingBoxes"] as? [[String: Any]] {
        let bboxes = boxes.compactMap { box -> BoundingBox? in
          guard let y1 = box["y1"] as? Double,
                let x1 = box["x1"] as? Double,
                let y2 = box["y2"] as? Double,
                let x2 = box["x2"] as? Double else { return nil }
          return BoundingBox(
            x1: x1 / 1024.0, y1: y1 / 1024.0,
            x2: x2 / 1024.0, y2: y2 / 1024.0,
            label: box["label"] as? String ?? "object",
            confidence: box["confidence"] as? Double ?? 0.8
          )
        }
        Task { @MainActor [weak self] in
          self?.boundingBoxes = bboxes
        }
      }

      // Audio mode change from viewer
      if msgType == "set_audio_mode", let mode = msg["mode"] as? String {
        Task { @MainActor [weak self] in
          await self?.switchAudioMode(mode)
        }
      }

      // Audio gain control from viewer
      if msgType == "set_audio_gain",
         let codecType = msg["codecType"] as? Int,
         let gainDb = msg["gainDb"] as? Double {
        Task { [weak self] in
          await self?.audioRelayStage.setGain(codecType: UInt8(codecType), gainDb: Float(gainDb))
        }
      }

      // Noise gate control from viewer
      if msgType == "set_noise_gate",
         let codecType = msg["codecType"] as? Int,
         let threshold = msg["threshold"] as? Double {
        Task { [weak self] in
          await self?.audioRelayStage.setNoiseGate(codecType: UInt8(codecType), threshold: Float(threshold))
        }
      }

      // Noise suppression toggle from viewer
      if msgType == "set_noise_suppression",
         let codecType = msg["codecType"] as? Int,
         let enabled = msg["enabled"] as? Bool {
        Task { [weak self] in
          await self?.audioRelayStage.setNoiseSuppression(codecType: UInt8(codecType), enabled: enabled)
        }
      }

      // Audio mix control from viewer
      if msgType == "set_audio_mix",
         let enabled = msg["enabled"] as? Bool {
        let weightPhone = msg["weightPhone"] as? Double ?? 0.5
        let weightGlasses = msg["weightGlasses"] as? Double ?? 0.5
        Task { [weak self] in
          await self?.audioRelayStage.setMixEnabled(enabled, weightPhone: Float(weightPhone), weightGlasses: Float(weightGlasses))
        }
      }

      // Audio config query from viewer
      if msgType == "get_audio_config" {
        Task { [weak self] in
          guard let self else { return }
          let config = await self.audioRelayStage.getCurrentConfig()
          await self.relayStage.sendJson(config.toDictionary())
        }
      }

      // Remote photo capture from viewer
      if msgType == "capture_photo" {
        Task { @MainActor [weak self] in
          self?.capturePhoto()
          await self?.relayStage.sendJson(["type": "photo_captured"])
        }
      }

      // Remote recording control from viewer
      if msgType == "start_recording" {
        Task { @MainActor [weak self] in
          await self?.startRecording()
          await self?.relayStage.sendJson(["type": "recording_changed", "recording": true])
        }
      }
      if msgType == "stop_recording" {
        Task { @MainActor [weak self] in
          await self?.stopRecording()
          await self?.relayStage.sendJson(["type": "recording_changed", "recording": false])
        }
      }

      // Remote stream control from viewer
      if msgType == "start_stream" {
        Task { @MainActor [weak self] in
          guard let self else { return }
          if self.relayMode == .standby {
            await self.activateFromStandby()
          } else if self.relayMode == .disconnected {
            await self.startSession()
            await self.startRelay()
          }
          await self.relayStage.sendJson(["type": "stream_changed", "streaming": true])
        }
      }
      if msgType == "stop_stream" {
        Task { @MainActor [weak self] in
          guard let self else { return }
          if self.relayMode == .active {
            // Stop camera, keep WebSocket in standby
            if self.isRecording { await self.stopRecording() }
            await self.backToStandby()
            await self.streamSession.stop()
            let audioSession = AVAudioSession.sharedInstance()
            try? audioSession.setActive(false, options: .notifyOthersOnDeactivation)
          }
          await self.relayStage.sendJson(["type": "stream_changed", "streaming": false])
        }
      }

      // Remote TTS from viewer
      if msgType == "speak_text", let text = msg["text"] as? String, !text.isEmpty {
        Task { @MainActor [weak self] in
          await self?.audioPlaybackStage.speakGuidance(text)
          await self?.relayStage.sendJson(["type": "spoken_text", "text": text])
        }
      }
    }
  }

  /// Start audio capture, telemetry push, and audio tap client.
  /// Shared between startRelay() and activateFromStandby().
  private func startRelayAudioAndTelemetry() async {
    // Attach relay stage to event bus before starting capture so packets flow immediately
    await audioRelayStage.attachToEventBus(audioEventBus)

    // Start audio capture based on user-selected input mode
    switch audioInputMode {
    case .builtInMic:
      await audioStage.start()
      NSLog("[StreamSession] Audio relay started (built-in mic only)")
    case .glassesMic:
      await glassesAudioStage.start()
      NSLog("[StreamSession] Audio relay started (glasses HFP mic only)")
    case .all:
      await audioStage.start()
      await glassesAudioStage.start()
      NSLog("[StreamSession] Audio relay started (built-in + glasses HFP mic)")
    }

    // Start audio tap client to receive remote audio frames from the server
    let url = relayURL.trimmingCharacters(in: .whitespacesAndNewlines)
    Task {
      do {
        try await audioTapClient.connect(to: url, session: nil, autoReconnect: true)
        isTapConnected = true
      } catch {
        NSLog("[StreamSession] Audio tap connect failed (non-fatal): \(error)")
      }
    }

    // Start periodic telemetry push (every 2s)
    telemetryPushTimer?.cancel()
    telemetryPushTimer = Task { [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(nanoseconds: 2_000_000_000)
        guard let self else { return }
        await self.pushTelemetry()
      }
    }
  }

  func stopRelay() async {
    // Cancel telemetry push timer
    telemetryPushTimer?.cancel()
    telemetryPushTimer = nil

    // Stop audio capture first (removes mic tap, does NOT deactivate audio session)
    await audioStage.stop()
    await glassesAudioStage.stop()
    stopInboundAudioEngine()
    // Detach relay stage from event bus — stops FRAU wire protocol forwarding
    await audioRelayStage.detachFromEventBus(audioEventBus)
    NSLog("[StreamSession] Audio relay stopped")

    // Stop audio tap client
    await audioTapClient.disconnect()
    isTapConnected = false

    await relayStage.disconnect()
    relayMode = .disconnected
    activeAppId = nil
    boundingBoxes = []
    NSLog("[StreamSession] Relay disconnected")
  }

  // MARK: - Telemetry Push

  private func pushTelemetry() async {
    guard relayMode == .active, let snap = telemetryService?.snapshot else { return }
    let relayStats = await relayStage.getStats()
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
    ]

    // Now Playing removed — iOS 18 blocks MediaRemote for third-party apps
    // (see NowPlayingTests, NowPlayingLowLevelTests for proof)

    await relayStage.sendJson(payload)
  }

  // MARK: - AI App Activation

  func activateApp(_ appId: String) {
    guard relayMode == .active else { return }
    activeAppId = appId
    Task { await relayStage.sendJson(["type": "activate_app", "appId": appId]) }
  }

  func deactivateApp() {
    guard relayMode == .active else { return }
    let _ = activeAppId
    activeAppId = nil
    Task { await relayStage.sendJson(["type": "deactivate_app"]) }
  }

  // MARK: - App Discovery

  enum AppFetchError: LocalizedError {
    case invalidURL
    case serverError(Int)
    case parseError

    var errorDescription: String? {
      switch self {
      case .invalidURL: return "Invalid relay URL"
      case .serverError(let code): return "Server error (\(code))"
      case .parseError: return "Failed to parse app list"
      }
    }
  }

  /// Fetch available AI apps from the relay server's GET /apps endpoint.
  /// Skips if already populated (cache). Converts wss:// URL to https://.
  func fetchApps() async {
    guard availableApps.isEmpty else { return }
    isLoadingApps = true
    appFetchError = nil

    do {
      guard let wsURL = URL(string: relayURL),
            let host = wsURL.host
      else {
        throw AppFetchError.invalidURL
      }

      let scheme = wsURL.scheme == "wss" ? "https" : "http"
      let appsURL = URL(string: "\(scheme)://\(host)/apps")!

      let (data, response) = try await URLSession.shared.data(from: appsURL)

      guard let httpResponse = response as? HTTPURLResponse,
            (200...299).contains(httpResponse.statusCode)
      else {
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        throw AppFetchError.serverError(code)
      }

      guard let json = try JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
        throw AppFetchError.parseError
      }

      let apps = json.compactMap { item -> AppInfo? in
        guard let id = item["id"] as? String else { return nil }
        return AppInfo(
          id: id,
          name: (item["name"] as? String) ?? id,
          description: (item["description"] as? String) ?? "",
          icon: (item["icon"] as? String) ?? "app"
        )
      }

      availableApps = apps
    } catch {
      appFetchError = error.localizedDescription
    }

    isLoadingApps = false
  }

  // MARK: - Remote Audio Mode Switching

  /// Switch audio input mode from viewer. Safe during streaming — only
  /// starts/stops AudioStage instances without touching AVAudioSession routing.
  func switchAudioMode(_ mode: String) async {
    guard relayMode == .active else { return }

    // Stop all audio stages
    await audioStage.stop()
    await glassesAudioStage.stop()

    // Start the requested stages
    switch mode {
    case "phone":
      audioInputMode = .builtInMic
      await audioStage.start()
      NSLog("[StreamSession] Audio mode switched: phone mic")
    case "glasses":
      audioInputMode = .glassesMic
      await glassesAudioStage.start()
      NSLog("[StreamSession] Audio mode switched: glasses mic")
    case "all":
      audioInputMode = .all
      await audioStage.start()
      await glassesAudioStage.start()
      NSLog("[StreamSession] Audio mode switched: all mics")
    default:
      // Unknown mode — restart phone mic as fallback
      audioInputMode = .builtInMic
      await audioStage.start()
      NSLog("[StreamSession] Unknown audio mode '\(mode)' — fell back to phone mic")
      return
    }

    // Acknowledge back to server so all viewers update their UI
    await relayStage.sendJson(["type": "audio_mode_changed", "mode": mode])
  }

  // MARK: - Microphone Permission

  /// Check/request mic permission on @MainActor and route input to built-in mic.
  /// AVAudioSession is @MainActor-isolated in iOS 17+ — must be called from here,
  /// never from an actor executor.
  ///
  /// When glasses are connected via HFP, iOS defaults to their mic.
  /// Using the glasses' HFP mic conflicts with the DAT SDK's BT video stream.
  /// Force input to the built-in phone mic to avoid the conflict.
  private func checkMicPermission() async -> Bool {
    let session = AVAudioSession.sharedInstance()
    if session.recordPermission == .granted { return true }

    NSLog("[StreamSession] Requesting microphone permission")
    return await withCheckedContinuation { cont in
      session.requestRecordPermission { granted in
        cont.resume(returning: granted)
      }
    }
  }

  /// Route audio input based on user-selected `audioInputMode`.
  /// Must be called on @MainActor (AVAudioSession isolation in iOS 17+).
  private func routeAudioInput() {
    let session = AVAudioSession.sharedInstance()
    let inputs = session.availableInputs ?? []

    switch audioInputMode {
    case .builtInMic:
      // Use phone's built-in mic. Avoids HFP conflict with DAT SDK BT video stream.
      if let builtIn = inputs.first(where: { $0.portType == .builtInMic }) {
        do {
          try session.setPreferredInput(builtIn)
          NSLog("[StreamSession] Routed input to built-in mic")
        } catch {
          NSLog("[StreamSession] Failed to route to built-in mic: \(error)")
        }
      }

    case .glassesMic:
      // Use glasses' HFP mic. Warning: may conflict with active BT video stream.
      if let hfp = inputs.first(where: { $0.portType == .bluetoothHFP }) {
        do {
          try session.setPreferredInput(hfp)
          NSLog("[StreamSession] Routed input to glasses HFP mic: \(hfp.portName)")
        } catch {
          NSLog("[StreamSession] Failed to route to glasses mic: \(error)")
        }
      } else {
        NSLog("[StreamSession] No glasses HFP input found — falling back to default")
      }

    case .all:
      // Reset to auto-route. When glasses are connected via HFP:
      //   - Glasses speaker plays TTS hello world (output)
      //   - Glasses mic picks up TTS + ambient audio (input)
      //   - Both get captured by AudioStage and sent to relay.
      // WARNING: may conflict with DAT SDK's active BT video stream.
      do {
        try session.setPreferredInput(nil)
        NSLog("[StreamSession] All mode — auto-route (HFP if connected, includes TTS)")
      } catch {
        NSLog("[StreamSession] Failed to reset input: \(error)")
      }
    }

    NSLog("[StreamSession] Audio input route: \(session.currentRoute.inputs.map { "\($0.portName)(\($0.portType.rawValue))" })")
  }

  // MARK: - Background Handling

  func handleEnterBackground() {
    guard isStreaming else { return }
    wasStreamingBeforeBackground = true

    // Request ~30s background grace for pending frames to flush
    backgroundTaskIdentifier = UIApplication.shared.beginBackgroundTask(
      withName: "StreamSession.backgroundFlush"
    ) { [weak self] in
      self?.endBackgroundTask()
    }

    telemetryService?.pauseUptimeAccumulation()
    NSLog("[StreamSession] Entered background — background task started")
  }

  func handleEnterForeground() {
    endBackgroundTask()

    // Reconnect standby relay if it was disconnected during background
    if relayMode == .disconnected && !isStreaming {
      Task { await startStandbyRelay() }
    }

    guard wasStreamingBeforeBackground else { return }
    wasStreamingBeforeBackground = false

    telemetryService?.resumeUptimeAccumulation()

    // Staleness check: if last frame is >5s stale, attempt reconnection
    if let lastFrame = telemetryService?.lastFrameTime {
      let staleness = ContinuousClock.Instant.now - lastFrame
      let stalenessMs = durationToMs(staleness)
      if stalenessMs > TelemetryService.staleThresholdMs {
        NSLog("[StreamSession] Stream stale (\(String(format: "%.1f", stalenessMs))ms) — reconnecting relay")

        Task {
          // Relay was connected: reconnect it
          if relayMode == .active, await relayStage.connected {
            do {
              try await relayStage.reconnect()
              // After reconnect, server registers us as standby.
              // If we were active, re-announce as streaming.
              await relayStage.sendJson(["type": "stream_changed", "streaming": true])
              NSLog("[StreamSession] Relay reconnected on foreground recovery")
            } catch {
              NSLog("[StreamSession] Relay reconnect failed: \(error)")
            }
          }

          // Session reports streaming but no frames: let auto-retry handle restart
          if streamingStatus == .streaming && !hasReceivedFirstFrame {
            await stopSession()
            // Auto-retry will pick up the restart
          }
        }
      }
    }
    NSLog("[StreamSession] Entered foreground — uptime resumed")
  }

  private func endBackgroundTask() {
    guard backgroundTaskIdentifier != .invalid else { return }
    UIApplication.shared.endBackgroundTask(backgroundTaskIdentifier)
    backgroundTaskIdentifier = .invalid
  }

  private func durationToMs(_ duration: Duration) -> Double {
    let components = duration.components
    return Double(components.seconds) * 1000.0 + Double(components.attoseconds) / 1_000_000_000_000_000.0
  }

  // MARK: - Auto-Retry

  private func shouldRetry(error: StreamSessionError) -> Bool {
    let errorStr = String(describing: error)
    return Self.retryableErrors.contains(errorStr) && retryCount < Self.maxRetries
  }

  private func scheduleRetry() {
    cancelRetry()
    retryCount += 1
    isRetrying = true
    let delay = UInt64(pow(2.0, Double(retryCount))) * 500_000_000 // exponential: 1s, 2s, 4s

    NSLog("[StreamSession] Auto-retry \(retryCount)/\(Self.maxRetries) in \(delay / 1_000_000_000)s")

    retryTask = Task { @MainActor [weak self] in
      guard let self else { return }
      try? await Task.sleep(nanoseconds: delay)
      guard !Task.isCancelled else { return }
      NSLog("[StreamSession] Executing retry \(self.retryCount)/\(Self.maxRetries)")
      await self.streamSession.start()
    }
  }

  private func cancelRetry() {
    retryTask?.cancel()
    retryTask = nil
    isRetrying = false
    retryCount = 0
  }

  // MARK: - Config

  private func rebuildSessionWithNewConfig() {
    guard !isStreaming else { return }
    NSLog("[StreamSession] Rebuilding session with resolution=\(String(describing: selectedResolution)) fps=\(selectedFrameRate)")

    deviceMonitorTask?.cancel()

    streamSession = StreamSession(streamSessionConfig: streamConfig, deviceSelector: currentSelector)
    setupSessionListeners()
    attachPipeline()
    telemetryService?.attachToStreamSession(streamSession)

    deviceMonitorTask = Task { @MainActor [weak self] in
      guard let self else { return }
      for await device in self.currentSelector.activeDeviceStream() {
        self.hasActiveDevice = device != nil
        if let device {
          self.activeWearableId = device
          self.activeWearableType = self.wearables.deviceForIdentifier(device)?.deviceType().displayName
        }
      }
    }

    updateStatusFromState(streamSession.state)
  }

  // MARK: - Config

  func handleStartStreaming() async {
    let permission = Permission.camera
    do {
      let status = try await wearables.checkPermissionStatus(permission)
      if status == .granted {
        await startSession()
        return
      }
      let requestStatus = try await wearables.requestPermission(permission)
      if requestStatus == .granted {
        await startSession()
        return
      }
      showError("Permission denied")
    } catch {
      showError("Permission error: \(error.description)")
    }
  }

  func startSession() async {
    cancelRetry()
    await streamSession.start()
  }

  private func showError(_ message: String) {
    errorMessage = message
    showError = true
  }

  func stopSession() async {
    if isRecording {
      await stopRecording()
    }
    if relayMode == .active {
      // Stop audio/telemetry but keep WebSocket in standby
      telemetryPushTimer?.cancel()
      telemetryPushTimer = nil
      await audioStage.stop()
      await glassesAudioStage.stop()
      stopInboundAudioEngine()
      await audioRelayStage.detachFromEventBus(audioEventBus)
      await audioTapClient.disconnect()
      isTapConnected = false
      activeAppId = nil
      boundingBoxes = []
      relayMode = .standby
      await relayStage.sendJson(["type": "standby", "status": "ready"])
      NSLog("[StreamSession] Stopped session, relay in standby")
    }
    cancelRetry()
    await streamSession.stop()

    // Notify OS to restore background music that was ducked during streaming
    let audioSession = AVAudioSession.sharedInstance()
    try? audioSession.setActive(false, options: .notifyOthersOnDeactivation)
  }

  func dismissError() {
    showError = false
    errorMessage = ""
  }

  func capturePhoto() {
    telemetryService?.recordPhotoRequest()
    streamSession.capturePhoto(format: .jpeg)
  }

  func dismissPhotoPreview() {
    showPhotoPreview = false
    capturedPhoto = nil
  }

  // MARK: - State

  private func updateStatusFromState(_ state: StreamSessionState) {
    NSLog("[StreamSession] State: \(String(describing: state)) | device=\(selectedDeviceId ?? "auto")")

    // Relay BT link state to viewers
    if relayMode == .active {
      let linkState: String
      switch state {
      case .streaming:
        linkState = "connected"
      case .waitingForDevice:
        linkState = "disconnected"
      case .stopped:
        linkState = "disconnected"
      case .starting, .stopping, .paused:
        linkState = "unknown"
      }
      Task { await relayStage.sendJson(["type": "link_state_changed", "state": linkState]) }
    }

    switch state {
    case .stopped:
      currentVideoFrame = nil
      hasReceivedFirstFrame = false
      streamingStatus = .stopped
    case .waitingForDevice, .starting, .stopping, .paused:
      streamingStatus = .waiting
    case .streaming:
      streamingStatus = .streaming
      cancelRetry()
    }
  }

  // MARK: - Inbound Audio Playback (AVAudioEngine)

  /// Play raw Int16 PCM via AVAudioEngine. Works reliably with .playAndRecord sessions.
  private func playInboundPCM(_ pcm: Data, sampleRate: UInt32, channels: UInt16, bitsPerSample: UInt16) {
    let sr = Double(sampleRate)
    let ch = UInt32(channels)

    // Lazy-init engine + player node on first call
    if inboundAudioEngine == nil {
      let engine = AVAudioEngine()
      let player = AVAudioPlayerNode()
      engine.attach(player)

      guard let format = AVAudioFormat(standardFormatWithSampleRate: sr, channels: ch) else {
        NSLog("[StreamSession] Failed to create audio format for \(sr)Hz/\(ch)ch")
        return
      }
      engine.connect(player, to: engine.mainMixerNode, format: format)

      do {
        try engine.start()

        // Route output to glasses HFP speaker if available.
        // Setting preferredInput to a BT HFP port routes both input and output there.
        // This is the only reliable way to play audio through the glasses speaker on iOS.
        let audioSession = AVAudioSession.sharedInstance()
        if let btHFP = audioSession.availableInputs?.first(where: { $0.portType == .bluetoothHFP }) {
          try audioSession.setPreferredInput(btHFP)
          NSLog("[StreamSession] Inbound engine: routed to HFP \(btHFP.portName)")
        }

        let outputs = audioSession.currentRoute.outputs.map { "\($0.portName)(\($0.portType.rawValue))" }
        NSLog("[StreamSession] Inbound audio engine started at \(sr)Hz, output: \(outputs)")
      } catch {
        NSLog("[StreamSession] Audio engine start failed: \(error)")
        return
      }

      inboundAudioEngine = engine
      inboundPlayerNode = player
    }

    guard let player = inboundPlayerNode else { return }

    // Convert Int16 PCM → Float32 for AVAudioPlayerNode
    let frameCount = UInt32(pcm.count) / (ch * 2)  // frames = bytes / (channels * bytesPerSample)
    guard frameCount > 0,
          let format = AVAudioFormat(standardFormatWithSampleRate: sr, channels: ch),
          let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frameCount)
    else { return }

    buffer.frameLength = frameCount
    pcm.withUnsafeBytes { rawPtr in
      guard let base = rawPtr.baseAddress?.assumingMemoryBound(to: Int16.self) else { return }
      guard let floatChannel = buffer.floatChannelData?[0] else { return }
      for i in 0..<Int(frameCount) {
        floatChannel[i] = Float(base[i]) / 32768.0
      }
    }

    player.scheduleBuffer(buffer)
    if !player.isPlaying { player.play() }
  }

  /// Stop and tear down the inbound audio engine.
  private func stopInboundAudioEngine() {
    inboundPlayerNode?.stop()
    inboundAudioEngine?.stop()
    inboundPlayerNode = nil
    inboundAudioEngine = nil
  }

  private static func formatStreamingError(_ error: StreamSessionError) -> String {
    switch error {
    case .internalError:
      return "An internal error occurred. Please try again."
    case .deviceNotFound:
      return "Device not found. Please ensure your device is connected."
    case .deviceNotConnected:
      return "Device not connected. Please check your connection and try again."
    case .timeout:
      return "The operation timed out. Please try again."
    case .videoStreamingError:
      return "Video streaming failed. Please try again."
    case .permissionDenied:
      return "Camera permission denied. Please grant permission in Settings."
    case .hingesClosed:
      return "The hinges on the glasses were closed. Please open the hinges and try again."
    case .thermalCritical:
      return "Device is overheating. Streaming has been paused to protect the device."
    @unknown default:
      return "An unknown streaming error occurred."
    }
  }

}
