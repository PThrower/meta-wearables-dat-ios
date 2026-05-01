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

/// Preferred audio output target, determined by workflow sink nodes.
enum PreferredSpeaker: String {
  case phone      // Phone speaker (default for workflows with phone-speaker sink)
  case glasses    // Glasses HFP/A2DP speaker (only when glasses-speaker sink is present)
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
  @Published var videoCodec: RelayVideoCodec = .jpeg
  @Published var boundingBoxes: [BoundingBox] = []
  @Published var visionDetections: [VisionDetection] = []
  @Published var visionSceneLabel: String?
  @Published var showBboxOverlay: Bool = true
  @Published var overlayTranscription: String? = nil
  @Published var trackingTracks: [Track] = []
  @Published var audioInputMode: AudioInputMode = .all {
    didSet {
      // DISABLED: Calling routeAudioInput() while the DAT SDK video stream is
      // active tears down the BT HFP link and kills video. Audio routing changes
      // must only happen before streaming starts. The mode is stored so it can
      // be applied on the next relay session if needed in the future.
    }
  }

  /// Preferred audio output for inbound AI PCM audio.
  /// Set by `audio_route` JSON message from the server before each audio burst.
  /// Default: phone speaker.
  var preferredSpeaker: PreferredSpeaker = .glasses


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
  private var displayStage: DisplayStage?
  private let sensorRelayStage = SensorRelayStage()
  private var visionStage: VisionStage?
  private var enhanceStage: FrameTransformStage?
  private var audioClassificationStage: AudioClassificationStage?
  private var locationStage: LocationStage?
  private var speechRecognitionStage: SpeechRecognitionStage?
  private var voiceActivityStage: VoiceActivityStage?
  private var trackingStage: ObjectTrackingStage?

  // Preview system
  #if DEBUG
  let previewBus = PreviewBus()
  @Published var previewStore = PreviewStore()
  @Published var showNodePreview = false
  private var previewSubscriptionId: UUID?
  private var previewListenTask: Task<Void, Never>?
  #endif

  private var inboundAudioEngine: AVAudioEngine?
  private var inboundPlayerNode: AVAudioPlayerNode?
  private var inboundSampleRate: Double?
  private var hasAppliedSpeakerRoute = false
  private var isInboundAudioActive = false
  private var routeChangeObserver: NSObjectProtocol?
  private var inboundAudioRestoreTask: Task<Void, Never>?
  private var telemetryPushTimer: Task<Void, Never>?

  // Phone camera mode
  private let phoneCamera = PhoneCameraCapture()
  @Published var isPhoneCameraMode: Bool = false

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
    if let displayStage { pipeline.register(displayStage) }
    pipeline.register(recordingStage)
    pipeline.register(relayStage)

    Task {
      await audioStage.setEventBus(audioEventBus)
      await glassesAudioStage.setEventBus(audioEventBus)
      await audioPlaybackStage.setEventBus(audioEventBus)
      await audioRelayStage.setRelayStage(relayStage)
      if let telemetryService {
        await sensorRelayStage.configure(relayStage: relayStage, telemetryService: telemetryService)
      }

      #if DEBUG
      // Wire preview bus to all stages
      await displayStage?.setPreviewBus(previewBus)
      await relayStage.setPreviewBus(previewBus)
      await audioRelayStage.setPreviewBus(previewBus)
      await audioPlaybackStage.setPreviewBus(previewBus)
      await recordingStage.setPreviewBus(previewBus)
      await sensorRelayStage.setPreviewBus(previewBus)

      // Start listening for preview events
      let (subId, stream) = await previewBus.subscribe()
      previewSubscriptionId = subId
      previewListenTask = Task { [weak self] in
        for await event in stream {
          guard let self else { break }
          self.previewStore.update(event)
        }
      }
      #endif
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

    // Wire phone camera device provider for telemetry camera metrics
    self.telemetryService?.phoneCameraDeviceProvider = { [weak self] in
      guard let self else { return nil }
      return self.phoneCamera.currentDevice
    }
  }

  // MARK: - Device Selection

  func selectDevice(_ deviceId: DeviceIdentifier?) {
    guard !isStreaming else { return }
    selectedDeviceId = deviceId

    // Clear phone camera mode when selecting a real SDK device
    isPhoneCameraMode = false

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

  // MARK: - Phone Camera Selection

  /// Select the iPhone camera as the video source (bypasses DAT SDK StreamSession).
  func selectPhoneCamera() {
    guard !isStreaming else { return }
    isPhoneCameraMode = true
    selectedDeviceId = nil
    hasActiveDevice = true

    // Cancel SDK device monitor — phone camera doesn't use it
    deviceMonitorTask?.cancel()
    deviceMonitorTask = nil

    NSLog("[StreamSession] Phone camera selected")
  }

  /// Deselect phone camera mode (return to no-device state).
  func deselectPhoneCamera() {
    guard !isStreaming else { return }
    isPhoneCameraMode = false
    hasActiveDevice = false

    NSLog("[StreamSession] Phone camera deselected")
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
    let stableDeviceId = DeviceIdentity.shared.stableDeviceId
    let separator = url.contains("?") ? "&" : "?"
    url += "\(separator)device=\(stableDeviceId)"
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
      // Set device identity on relay stage
      if isPhoneCameraMode {
        await relayStage.setDeviceIdentity(wearableId: PhoneDevice.shared.id, wearableType: "iPhone Camera")
      } else {
        let wearableId = selectedDeviceId ?? activeWearableId
        if let wearableId {
          let deviceTypeName: String? = selectedDeviceId != nil
            ? wearables.deviceForIdentifier(wearableId)?.deviceType().displayName
            : activeWearableType
          await relayStage.setDeviceIdentity(wearableId: wearableId, wearableType: deviceTypeName)
        }
      }

      // Configure encoder based on selected codec
      await configureRelayEncoder()

      // Wire control message callback
      await wireControlMessageHandler()

      await relayStage.setOnReceivedAudio { [weak self] data in
        guard let parsed = WireProtocol.parseFRAU(data) else { return }
        NSLog("[StreamSession] Server audio: \(parsed.pcmData.count) bytes, \(parsed.sampleRate)Hz, \(parsed.channels)ch, \(parsed.bitsPerSample)bit codec=\(parsed.codecType)")
        Task { @MainActor [weak self] in
          guard let self, self.isInboundAudioActive else { return }
          self.playInboundPCM(parsed.pcmData, sampleRate: parsed.sampleRate, channels: parsed.channels, bitsPerSample: parsed.bitsPerSample)
        }
      }

      isInboundAudioActive = true

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
    let stableDeviceId = DeviceIdentity.shared.stableDeviceId
    let separator = url.contains("?") ? "&" : "?"
    url += "\(separator)device=\(stableDeviceId)"
    guard !url.isEmpty else { return }

    do {
      if isPhoneCameraMode {
        await relayStage.setDeviceIdentity(wearableId: PhoneDevice.shared.id, wearableType: "iPhone Camera")
      } else {
        let wearableId = selectedDeviceId ?? activeWearableId
        if let wearableId {
          let deviceTypeName: String? = selectedDeviceId != nil
            ? wearables.deviceForIdentifier(wearableId)?.deviceType().displayName
            : activeWearableType
          await relayStage.setDeviceIdentity(wearableId: wearableId, wearableType: deviceTypeName)
        }
      }

      await wireControlMessageHandler()

      // Configure encoder based on selected codec
      await configureRelayEncoder()

      try await relayStage.connect(to: url)
      relayMode = .standby
      NSLog("[StreamSession] Standby relay connected to \(url)")

      // Announce standby state to server
      await relayStage.sendJson(["type": "standby", "status": "ready"])
    } catch {
      NSLog("[StreamSession] Standby relay connect failed (non-fatal): \(error)")
    }
  }

  /// Handle wake from APNs push notification.
  /// Connects standby relay so the server can detect the device and auto-activate.
  /// The server sends `start_stream` after auto-activation — we don't activate locally.
  @MainActor
  func handleWakeFromPush() {
    NSLog("[StreamSession] Wake push received — relayMode=\(relayMode)")

    // Already streaming — nothing to do
    guard relayMode != .active else {
      NSLog("[StreamSession] Wake push ignored — already active")
      return
    }

    // Request background execution time (~30s) to keep WebSocket alive
    if wakeBackgroundTask == .invalid {
      wakeBackgroundTask = UIApplication.shared.beginBackgroundTask(
        withName: "StreamSession.wakeStandby"
      ) { [weak self] in
        self?.endWakeBackgroundTask()
      }
      NSLog("[StreamSession] Wake background task started")
    }

    if relayMode == .standby {
      // Already connected — server will send start_stream on auto-activate
      NSLog("[StreamSession] Already in standby — waiting for server start_stream")
    } else {
      // Disconnected — connect standby so server can auto-activate
      NSLog("[StreamSession] Connecting standby for server auto-activation")
      Task {
        await startStandbyRelay()
        // Don't activate locally — the server will send start_stream
        // after detecting the device connection via pendingWakeActivations
      }
    }
  }

  private var wakeBackgroundTask: UIBackgroundTaskIdentifier = .invalid

  private func endWakeBackgroundTask() {
    guard wakeBackgroundTask != .invalid else { return }
    UIApplication.shared.endBackgroundTask(wakeBackgroundTask)
    wakeBackgroundTask = .invalid
    NSLog("[StreamSession] Wake background task ended")
  }

  /// Transition from standby to active — start camera, wait for BT link, then audio + telemetry.
  /// Called when start_stream is received while in standby, or from handleWakeFromPush().
  private func activateFromStandby() async {
    guard relayMode == .standby else { return }

    // Wake task no longer needed — streaming has its own background handling
    endWakeBackgroundTask()

    // Check mic permission
    guard await checkMicPermission() else {
      await relayStage.sendJson(["type": "publisher_error", "error": "Microphone permission required", "state": "standby"])
      return
    }

    relayMode = .active

    // Auto-detect phone camera mode if no wearable device is available.
    // On cold launch from push notification, isPhoneCameraMode resets to false
    // because it isn't persisted. If no glasses are connected, use phone camera.
    let usePhoneCamera = isPhoneCameraMode || (!hasActiveDevice && activeWearableId == nil)

    if usePhoneCamera {
      NSLog("[StreamSession] Using phone camera for activation (isPhoneCameraMode=\(isPhoneCameraMode), hasActiveDevice=\(hasActiveDevice))")

      // Phone camera path: no BT link to wait for, start directly
      await startPhoneCameraSession()

      // Wire inbound audio handler
      await relayStage.setOnReceivedAudio { [weak self] data in
        guard let parsed = WireProtocol.parseFRAU(data) else { return }
        NSLog("[StreamSession] Server audio: \(parsed.pcmData.count) bytes, \(parsed.sampleRate)Hz, \(parsed.channels)ch, \(parsed.bitsPerSample)bit codec=\(parsed.codecType)")
        Task { @MainActor [weak self] in
          guard let self, self.isInboundAudioActive else { return }
          self.playInboundPCM(parsed.pcmData, sampleRate: parsed.sampleRate, channels: parsed.channels, bitsPerSample: parsed.bitsPerSample)
        }
      }

      isInboundAudioActive = true

      await startRelayAudioAndTelemetry()
      await relayStage.sendJson(["type": "link_state_changed", "state": "connected"])
      return
    }

    // Glasses (SDK) path: start camera session and wait for BT link
    // Phase 1: Start camera session (establishes BT link to glasses)
    await startSession()

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
        guard let self, self.isInboundAudioActive else { return }
        self.playInboundPCM(parsed.pcmData, sampleRate: parsed.sampleRate, channels: parsed.channels, bitsPerSample: parsed.bitsPerSample)
      }
    }

    isInboundAudioActive = true

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

  // MARK: - Vision Stage

  /// Configure and register a VisionStage based on server-sent config.
  private func configureVisionStage(config: [String: Any]) async {
    // Unregister existing vision stage if any
    if let existing = visionStage {
      await existing.stop()
      pipeline.unregister(stageId: existing.stageId)
      visionStage = nil
      visionDetections = []
      visionSceneLabel = nil
    }

    // Parse detection types — server sends combined array for all active vision nodes
    let detectionTypeStrings = config["detectionTypes"] as? [String]
      ?? ((config["nodeType"] as? String).map { [$0] } ?? [])
    let detectionTypes = detectionTypeStrings.compactMap { VisionDetectionType(rawValue: $0) }
    guard !detectionTypes.isEmpty else { return }

    let confidence = config["confidence"] as? Double ?? 0.5
    let smoothingAlpha = config["smoothingAlpha"] as? Double ?? 0.3
    let targetFPS = config["targetFPS"] as? UInt ?? 5
    let maxResults = config["maxResults"] as? Int ?? 0
    let language = config["language"] as? String ?? "en-US"
    let maxLabels = config["maxLabels"] as? Int ?? 5

    let symbologies: [String] = (config["symbologies"] as? [String]) ?? ["qr"]

    // Thumbnail extraction config
    let thumbnailsEnabled = config["thumbnailsEnabled"] as? Bool ?? false
    let thumbnailSize = config["thumbnailSize"] as? Int ?? 64
    let thumbnailMaxCount = config["thumbnailMaxCount"] as? Int ?? 4
    let thumbnailQuality = config["thumbnailQuality"] as? Double ?? 0.6

    let visionConfig = VisionStageConfig(
      detectionTypes: detectionTypes,
      confidence: confidence,
      targetFPS: targetFPS,
      maxResults: maxResults,
      smoothingAlpha: smoothingAlpha,
      language: language,
      symbologies: symbologies,
      maxLabels: maxLabels,
      thumbnailsEnabled: thumbnailsEnabled,
      thumbnailSize: thumbnailSize,
      thumbnailMaxCount: thumbnailMaxCount,
      thumbnailQuality: CGFloat(thumbnailQuality)
    )

    let stage = VisionStage(config: visionConfig)

    // Wire result callback to update overlay AND relay to server
    await stage.setOnResult { [weak self] (result: VisionFrameResult, thumbnails: [(Int, String)]?) in
      await MainActor.run {
        // When tracking is active, suppress raw vision boxes —
        // the tracker will emit tracked items with persistent IDs instead.
        if self?.trackingStage != nil {
          // Only keep non-bbox detections (scene labels)
          self?.visionDetections = result.detections.filter { $0.boundingBox == nil }
        } else {
          self?.visionDetections = result.detections
        }
        // Extract scene label if present
        for det in result.detections {
          if case .scene(let cls) = det, let first = cls.labels.first {
            self?.visionSceneLabel = "\(first.label) \(Int(first.confidence * 100))%"
          }
        }
      }
      // Relay detection JSON to server for downstream AI context injection
      if !result.isEmpty {
        await self?.relayStage.sendJson(result.jsonDict(thumbnails: thumbnails))
      }
      // Feed detections into tracking stage if active
      if let trackingStage = await self?.trackingStage {
        let trackDets: [TrackDetection] = result.detections.compactMap { det in
          guard let bbox = det.boundingBox else { return nil }
          return TrackDetection(
            bbox: bbox,
            confidence: det.confidence,
            classLabel: det.displayLabel
          )
        }
        if !trackDets.isEmpty {
          await trackingStage.feedDetections(trackDets, timestamp: CFAbsoluteTimeGetCurrent())
        }
      }
    }

    #if DEBUG
    await stage.setPreviewBus(previewBus)
    #endif

    pipeline.register(stage)
    await stage.start()
    visionStage = stage

    NSLog("[StreamSession] VisionStage registered: \(detectionTypes.map { $0.rawValue }) confidence=\(confidence) fps=\(targetFPS)")
  }

  // MARK: - Enhance Stage

  /// Configure the frame enhancement transform chain from server-sent config.
  private func configureEnhanceStage(config: [String: Any]) {
    let enhanceConfig = EnhanceStageConfig.fromServerConfig(config)

    if enhanceConfig.filters.isEmpty {
      // No filters — remove transform stage
      pipeline.transformStage = nil
      enhanceStage = nil
      NSLog("[StreamSession] EnhanceStage removed (no filters)")
      return
    }

    let stage = FrameTransformStage(config: enhanceConfig)
    pipeline.transformStage = stage
    enhanceStage = stage

    NSLog("[StreamSession] EnhanceStage configured: \(enhanceConfig.filters.count) filters")
  }

  // MARK: - Sensor Stages

  /// Configure sensor stages (sound classification, GPS location) from server-sent config.
  private func configureSensorStage(config: [String: Any]) async {
    let sensorConfig = SensorStageConfig.fromServerConfig(config)

    // Stop existing stages
    if let audioStage = audioClassificationStage {
      await audioStage.stop()
      audioClassificationStage = nil
    }
    if let locStage = locationStage {
      await locStage.stop()
      locationStage = nil
    }

    for sensor in sensorConfig.sensors {
      switch sensor.type {
      case .sound:
        let stage = AudioClassificationStage()
        let cfg = sensor.config
        let targetLabels = cfg["targetLabels"] as? [String]
        // Resolve audio source from server-sent config (derived from workflow edges)
        let audioSource: AudioSource? = {
          if let sourceStr = cfg["audioSource"] as? String, sourceStr == "glasses" {
            return .bluetoothHFP
          }
          return .builtInMic
        }()
        await stage.configure(
          windowDuration: cfg["windowDuration"] as? Double ?? 1.5,
          overlapFactor: cfg["overlapFactor"] as? Double ?? 0.5,
          confidence: cfg["confidence"] as? Double ?? 0.3,
          maxLabels: cfg["maxLabels"] as? Int ?? 5,
          targetLabels: targetLabels,
          smoothingAlpha: cfg["smoothingAlpha"] as? Double ?? 0.3,
          source: audioSource
        )
        await stage.setOnResult { [weak self] classification in
          await self?.relayStage.sendJson(classification.jsonDict)
        }
        await stage.start()
        audioClassificationStage = stage
        NSLog("[StreamSession] AudioClassificationStage started source=\(audioSource?.displayName ?? "Phone Mic")")

      case .location, .locationSignificant, .locationVisits, .locationGeofence:
        let stage = LocationStage()
        let cfg = sensor.config
        let resolvedMode = cfg["mode"] as? String ?? sensor.type.locationMode ?? "continuous"
        await stage.configure(
          accuracy: cfg["accuracy"] as? String ?? "best",
          minDistance: cfg["minDistance"] as? Double ?? 5,
          updateIntervalSec: cfg["updateIntervalSec"] as? Double ?? 5,
          mode: resolvedMode,
          geofences: cfg["geofences"] as? [[String: Any]]
        )
        await stage.setOnResult { [weak self] update in
          await self?.relayStage.sendJson(update.jsonDict)
        }
        await stage.start()
        locationStage = stage
        NSLog("[StreamSession] LocationStage started mode=\(resolvedMode)")
      }
    }
  }

  // MARK: - Speech Stages

  /// Configure speech stages (STT, VAD) from server-sent config.
  private func configureSpeechStage(config: [String: Any]) async {
    let speechConfig = SpeechStageConfig.fromServerConfig(config)

    // Stop existing stages
    if let sttStage = speechRecognitionStage {
      await sttStage.stop()
      speechRecognitionStage = nil
    }
    if let vadStage = voiceActivityStage {
      await vadStage.stop()
      voiceActivityStage = nil
    }

    for stage in speechConfig.stages {
      switch stage.type {
      case .stt:
        let sttStage = SpeechRecognitionStage()
        let cfg = stage.config
        await sttStage.configure(
          language: cfg["language"] as? String ?? "en-US",
          onDeviceOnly: (cfg["recognitionMode"] as? String ?? "onDevice") == "onDevice",
          partialResults: cfg["partialResults"] as? Bool ?? true
        )
        await sttStage.setOnResult { [weak self] result in
          await self?.relayStage.sendJson(result.jsonDict)
          // Update overlay transcription for on-device display
          if !result.text.isEmpty {
            await MainActor.run { [weak self] in
              self?.overlayTranscription = result.text
            }
          }
          if result.error != nil {
            await MainActor.run { [weak self] in
              self?.overlayTranscription = nil
            }
          }
        }
        await sttStage.setEventBus(audioEventBus)
        await sttStage.start()
        speechRecognitionStage = sttStage
        NSLog("[StreamSession] SpeechRecognitionStage started")

      case .vad:
        let vadStage = VoiceActivityStage()
        let cfg = stage.config
        await vadStage.configure(
          energyThreshold: cfg["energyThreshold"] as? Float ?? -40.0,
          speechDurationMs: cfg["speechDurationMs"] as? Double ?? 100.0,
          silenceDurationMs: cfg["silenceDurationMs"] as? Double ?? 300.0,
          cooldownMs: cfg["cooldownMs"] as? Double ?? 200.0
        )
        await vadStage.setEventBus(audioEventBus)
        await vadStage.setOnResult { [weak self] result in
          await self?.relayStage.sendJson(result.jsonDict)
        }
        await vadStage.start()
        voiceActivityStage = vadStage
        NSLog("[StreamSession] VoiceActivityStage started")
      }
    }
  }

  // MARK: - Tracking Stage

  /// Configure OC-SORT tracking stage from server-sent config.
  private func configureTrackingStage(config: [String: Any]) async {
    // Unregister existing tracking stage if any
    if let existing = trackingStage {
      await existing.stop()
      pipeline.unregister(stageId: existing.stageId)
      trackingStage = nil
      trackingTracks = []
    }

    let trackingConfig = TrackingStageConfig(
      targetClasses: config["targetClasses"] as? [String] ?? [],
      confidence: config["confidence"] as? Double ?? 0.5,
      iouThreshold: config["iouThreshold"] as? Double ?? 0.3,
      maxAge: config["maxAge"] as? Int ?? 30,
      minHits: config["minHits"] as? Int ?? 3,
      maxTracks: config["maxTracks"] as? Int ?? 0,
      targetFPS: config["targetFPS"] as? Double ?? 10,
      smoothingAlpha: config["smoothingAlpha"] as? Double ?? 0.3,
      zones: (config["zones"] as? [[String: Any]])?.compactMap { z -> ZoneDefinition? in
        guard let label = z["label"] as? String,
              let x1 = z["x1"] as? Double,
              let y1 = z["y1"] as? Double,
              let x2 = z["x2"] as? Double,
              let y2 = z["y2"] as? Double else { return nil }
        return ZoneDefinition(
          id: z["id"] as? String ?? UUID().uuidString,
          label: label, x1: x1, y1: y1, x2: x2, y2: y2,
          color: z["color"] as? String
        )
      } ?? [],
      deltaT: config["deltaT"] as? Int ?? 3,
      inertia: config["inertia"] as? Double ?? 0.2,
      detThresh: config["detThresh"] as? Double ?? 0.5,
      useByte: config["useByte"] as? Bool ?? false
    )

    let stage = ObjectTrackingStage(config: trackingConfig)

    // Wire result callback to update overlay AND relay to server
    await stage.setOnResult { [weak self] result in
      await MainActor.run {
        self?.trackingTracks = result.tracks
      }
      // Relay tracking result JSON to server
      await self?.relayStage.sendJson(result.jsonDict())
    }

    #if DEBUG
    await stage.setPreviewBus(previewBus)
    #endif

    pipeline.register(stage)
    await stage.start()
    trackingStage = stage

    NSLog("[StreamSession] ObjectTrackingStage registered: confidence=\(trackingConfig.confidence) iou=\(trackingConfig.iouThreshold) maxAge=\(trackingConfig.maxAge) zones=\(trackingConfig.zones.count)")
  }

  // MARK: - Shared Relay Helpers

  /// Configure the relay encoder based on the selected videoCodec.
  func configureRelayEncoder() async {
    switch videoCodec {
    case .jpeg:
      await relayStage.setEncoder(JPEGFrameEncoder(quality: 0.5))
    case .h264:
      do {
        let h264Encoder = try H264FrameEncoder(config: .default)
        await relayStage.setEncoder(h264Encoder)
        NSLog("[StreamSession] H.264 encoder configured")
      } catch {
        NSLog("[StreamSession] H.264 encoder init failed, falling back to JPEG: \(error)")
        await relayStage.setEncoder(JPEGFrameEncoder(quality: 0.5))
      }
    }
  }

  /// Switch video codec mid-stream and notify viewers.
  func switchCodec(_ codec: RelayVideoCodec) async {
    guard codec != videoCodec else { return }
    videoCodec = codec
    await configureRelayEncoder()
    await relayStage.sendJson(["type": "codec_changed", "codec": codec == .h264 ? "h264" : "jpeg"])
    NSLog("[StreamSession] Codec switched to \(codec)")
  }

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
      // Per-message preferGlasses comes from the processor's downstream sink config
      if msgType == "guidance_text",
         let text = msg["text"] as? String, !text.isEmpty {
        Task { [weak self] in
          let preferGlasses = msg["preferGlasses"] as? Bool ?? false
          await self?.audioPlaybackStage.speakGuidance(text, preferGlasses: preferGlasses)
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

      // Codec change from viewer
      if msgType == "set_codec", let codec = msg["codec"] as? String {
        Task { @MainActor [weak self] in
          guard let self else { return }
          let newCodec: RelayVideoCodec
          switch codec {
          case "h264": newCodec = .h264
          default: newCodec = .jpeg
          }
          guard newCodec != self.videoCodec else { return }
          self.videoCodec = newCodec
          await self.configureRelayEncoder()
          await self.relayStage.sendJson(["type": "codec_changed", "codec": newCodec == .h264 ? "h264" : "jpeg"])
          NSLog("[StreamSession] Codec switched to \(newCodec) by viewer")
        }
      }

      // Audio route from server — sets preferred speaker for subsequent inbound AI PCM
      // Sent before each AI audio burst so per-thread routing works correctly
      if msgType == "audio_route" {
        let preferPhone = msg["preferPhone"] as? Bool ?? false
        Task { @MainActor [weak self] in
          self?.preferredSpeaker = preferPhone ? .phone : .glasses
          NSLog("[StreamSession] Audio route: preferPhone=\(preferPhone) -> \(self?.preferredSpeaker)")
        }
      }

      // Workflow config from server — sets mobile-side pipeline config (input modality, sinks)
      // For passive workflows (no AI). Active AI workflows use per-message audio_route instead.
      if msgType == "workflow_config", let config = msg["config"] as? [String: Any] {
        let sinks = config["sinks"] as? [[String: Any]] ?? []
        let sinkTypes = sinks.compactMap { $0["type"] as? String }
        NSLog("[StreamSession] Workflow config: sinks=\(sinkTypes)")
      }

      // Vision stage config from server — register on-device VisionStage
      if msgType == "vision_stage_config" {
        let enabled = msg["enabled"] as? Bool ?? true
        if !enabled {
          Task { @MainActor [weak self] in
            guard let self, let existing = visionStage else { return }
            await existing.stop()
            pipeline.unregister(stageId: existing.stageId)
            visionStage = nil
            visionDetections = []
            visionSceneLabel = nil
            NSLog("[StreamSession] VisionStage disabled by server")
          }
        } else {
          Task { @MainActor [weak self] in
            guard let self else { return }
            await self.configureVisionStage(config: msg)
          }
        }
      }

      // Enhance stage config from server — configure CIFilter transform chain
      if msgType == "enhance_stage_config" {
        let enabled = msg["enabled"] as? Bool ?? true
        if !enabled {
          Task { @MainActor [weak self] in
            self?.pipeline.transformStage = nil
            self?.enhanceStage = nil
            NSLog("[StreamSession] EnhanceStage disabled by server")
          }
        } else {
          Task { @MainActor [weak self] in
            self?.configureEnhanceStage(config: msg)
          }
        }
      }

      // Sensor stage config from server — configure sound/location stages
      if msgType == "sensor_stage_config" {
        let enabled = msg["enabled"] as? Bool ?? true
        if !enabled {
          Task { @MainActor [weak self] in
            if let audioStage = self?.audioClassificationStage {
              await audioStage.stop()
              self?.audioClassificationStage = nil
            }
            if let locStage = self?.locationStage {
              await locStage.stop()
              self?.locationStage = nil
            }
            NSLog("[StreamSession] Sensor stages disabled by server")
          }
        } else {
          Task { @MainActor [weak self] in
            await self?.configureSensorStage(config: msg)
          }
        }
      }

      // Speech stage config from server — configure STT / VAD stages
      if msgType == "speech_stage_config" {
        let enabled = msg["enabled"] as? Bool ?? true
        if !enabled {
          Task { @MainActor [weak self] in
            if let sttStage = self?.speechRecognitionStage {
              await sttStage.stop()
              self?.speechRecognitionStage = nil
            }
            if let vadStage = self?.voiceActivityStage {
              await vadStage.stop()
              self?.voiceActivityStage = nil
            }
            NSLog("[StreamSession] Speech stages disabled by server")
          }
        } else {
          Task { @MainActor [weak self] in
            await self?.configureSpeechStage(config: msg)
          }
        }
      }

      // Tracking stage config from server -- register ObjectTrackingStage
      if msgType == "tracking_stage_config" {
        let enabled = msg["enabled"] as? Bool ?? true
        if !enabled {
          Task { @MainActor [weak self] in
            guard let self, let existing = trackingStage else { return }
            await existing.stop()
            pipeline.unregister(stageId: existing.stageId)
            trackingStage = nil
            trackingTracks = []
            NSLog("[StreamSession] ObjectTrackingStage disabled by server")
          }
        } else {
          Task { @MainActor [weak self] in
            guard let self else { return }
            await self.configureTrackingStage(config: msg)
          }
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

      // Workflow node execution states (log for now)
      if msgType == "node_states",
         let workflowId = msg["workflowId"] as? String,
         let nodes = msg["nodes"] as? [[String: Any]] {
        let states = nodes.compactMap { node -> String? in
          guard let nodeId = node["nodeId"] as? String,
                let state = node["state"] as? String else { return nil }
          let label = node["label"] as? String ?? nodeId
          return "\(label): \(state)"
        }
        NSLog("[StreamSession] node_states for workflow \(workflowId): \(states.joined(separator: ", "))")
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
            if self.isPhoneCameraMode {
              await self.startPhoneCameraSession()
              await self.startRelay()
            } else {
              await self.startSession()
              await self.startRelay()
            }
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
            if self.isPhoneCameraMode {
              await self.stopPhoneCameraSession()
            } else {
              await self.streamSession.stop()
            }
            let audioSession = AVAudioSession.sharedInstance()
            try? audioSession.setActive(false, options: .notifyOthersOnDeactivation)
          }
          await self.relayStage.sendJson(["type": "stream_changed", "streaming": false])
        }
      }

      // Remote TTS from viewer — uses current audio_route setting
      if msgType == "speak_text", let text = msg["text"] as? String, !text.isEmpty {
        Task { @MainActor [weak self] in
          let preferGlasses = self?.preferredSpeaker == .glasses
          await self?.audioPlaybackStage.speakGuidance(text, preferGlasses: preferGlasses)
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
        // TODO: telemetry push interval subject to review (currently 2s)
        try? await Task.sleep(nanoseconds: 2_000_000_000)
        guard let self else { return }
        await self.pushTelemetry()
      }
    }

    // Start sensor relay (FRSE frames at 1Hz)
    await sensorRelayStage.start()
  }

  func stopRelay() async {
    // Cancel telemetry push timer
    telemetryPushTimer?.cancel()
    telemetryPushTimer = nil

    // Stop sensor stages (sound classification, GPS location)
    if let audioStage = audioClassificationStage {
      await audioStage.stop()
      audioClassificationStage = nil
    }
    if let locStage = locationStage {
      await locStage.stop()
      locationStage = nil
    }

    // Stop speech stages (STT, VAD)
    if let sttStage = speechRecognitionStage {
      await sttStage.stop()
      speechRecognitionStage = nil
    }
    overlayTranscription = nil

    // Stop tracking stage
    if let trackStage = trackingStage {
      await trackStage.stop()
      trackingStage = nil
    }
    trackingTracks = []
    if let vadStage = voiceActivityStage {
      await vadStage.stop()
      voiceActivityStage = nil
    }

    // Stop sensor relay (FRSE frames)
    await sensorRelayStage.stop()

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
    endWakeBackgroundTask()
    NSLog("[StreamSession] Relay disconnected")
  }

  // MARK: - Telemetry Push

  private func pushTelemetry() async {
    guard relayMode == .active, let snap = telemetryService?.snapshot else { return }
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
      guard let appsURL = URL(string: "\(scheme)://\(host)/apps") else {
        throw AppFetchError.invalidURL
      }

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
    if isPhoneCameraMode {
      await startPhoneCameraSession()
      return
    }

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

  // MARK: - Phone Camera Session

  /// Start the phone camera capture session. Checks iOS camera permission,
  /// wires frame callback to pipeline, and starts all pipeline stages.
  private func startPhoneCameraSession() async {
    // Check camera permission
    let authStatus = AVCaptureDevice.authorizationStatus(for: .video)
    if authStatus == .notDetermined {
      let granted = await withCheckedContinuation { cont in
        AVCaptureDevice.requestAccess(for: .video) { granted in
          cont.resume(returning: granted)
        }
      }
      guard granted else {
        showError("Camera permission denied")
        return
      }
    } else if authStatus != .authorized {
      showError("Camera permission required. Enable in Settings.")
      return
    }

    // Start pipeline stages
    await pipeline.startAll()
    streamingStatus = .streaming

    // Wire phone camera frames -> pipeline
    do {
      try await phoneCamera.start { [weak self] sampleBuffer in
        Task { @MainActor [weak self] in
          self?.pipeline.onRawSampleBuffer(sampleBuffer)
        }
      }
      NSLog("[StreamSession] Phone camera session started")
    } catch {
      streamingStatus = .stopped
      await pipeline.stopAll()
      showError("Phone camera failed: \(error.localizedDescription)")
    }
  }

  /// Stop the phone camera capture session and pipeline stages.
  private func stopPhoneCameraSession() async {
    await phoneCamera.stop()
    await pipeline.stopAll()
    streamingStatus = .stopped
    currentVideoFrame = nil
    hasReceivedFirstFrame = false
    NSLog("[StreamSession] Phone camera session stopped")
  }

  private func showError(_ message: String) {
    errorMessage = message
    showError = true
  }

  func stopSession() async {
    if isRecording {
      await stopRecording()
    }

    // Phone camera path
    if isPhoneCameraMode {
      if relayMode == .active {
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
      }
      await stopPhoneCameraSession()
      let audioSession = AVAudioSession.sharedInstance()
      try? audioSession.setActive(false, options: .notifyOthersOnDeactivation)
      return
    }

    // Glasses (SDK) path
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

    if isPhoneCameraMode {
      // Phone camera has no SDK capturePhoto — use the current displayed frame
      if let frame = currentVideoFrame {
        capturedPhoto = frame
        showPhotoPreview = true
      }
      return
    }

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

    // M-4: Tear down and rebuild engine if sample rate changed
    if let currentSR = inboundSampleRate, currentSR != sr {
      NSLog("[StreamSession] Inbound sample rate changed \(currentSR) -> \(sr), rebuilding engine")
      stopInboundAudioEngine()
    }
    inboundSampleRate = sr

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

        // H-10: Apply route once at engine start
        applySpeakerRoute()
        hasAppliedSpeakerRoute = true

        // H-10: Observe system route changes to re-apply
        routeChangeObserver = NotificationCenter.default.addObserver(
          forName: AVAudioSession.routeChangeNotification,
          object: nil,
          queue: .main
        ) { [weak self] _ in
          self?.hasAppliedSpeakerRoute = false
        }

        let audioSession = AVAudioSession.sharedInstance()
        let outputs = audioSession.currentRoute.outputs.map { "\($0.portName)(\($0.portType.rawValue))" }
        NSLog("[StreamSession] Inbound audio engine started at \(sr)Hz, output: \(outputs)")
      } catch {
        NSLog("[StreamSession] Audio engine start failed: \(error)")
        return
      }

      inboundAudioEngine = engine
      inboundPlayerNode = player
    } else {
      // H-10: Only re-apply route if a system route change reset the flag
      if !hasAppliedSpeakerRoute {
        applySpeakerRoute()
        hasAppliedSpeakerRoute = true
      }
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

    // Auto-restore glasses route when inbound audio stops (1.5s silence)
    if preferredSpeaker != .glasses {
      inboundAudioRestoreTask?.cancel()
      inboundAudioRestoreTask = Task { @MainActor [weak self] in
        try? await Task.sleep(nanoseconds: 1_500_000_000)
        guard !Task.isCancelled else { return }
        self?.restoreSpeakerRoute()
        NSLog("[StreamSession] Auto-restored glasses route after inbound audio silence")
      }
    }
  }

  /// Apply current preferredSpeaker to AVAudioSession output route.
  private func applySpeakerRoute() {
    let audioSession = AVAudioSession.sharedInstance()
    do {
      if preferredSpeaker == .glasses {
        // Remove any previous phone-speaker override so system uses Bluetooth
        try audioSession.overrideOutputAudioPort(.none)
        if let btHFP = audioSession.availableInputs?.first(where: { $0.portType == .bluetoothHFP }) {
          try audioSession.setPreferredInput(btHFP)
        }
      } else {
        try audioSession.overrideOutputAudioPort(.speaker)
      }
    } catch {
      NSLog("[StreamSession] Speaker route failed: \(error)")
    }
  }

  /// Restore audio route to default (Bluetooth A2DP) after inbound audio stops.
  /// Clears phone-speaker override and preferred input so system auto-routes to glasses.
  private func restoreSpeakerRoute() {
    let audioSession = AVAudioSession.sharedInstance()
    do {
      try audioSession.overrideOutputAudioPort(.none)
      try audioSession.setPreferredInput(nil)
    } catch {
      NSLog("[StreamSession] Restore speaker route failed: \(error)")
    }
  }

  /// Stop and tear down the inbound audio engine.
  private func stopInboundAudioEngine() {
    inboundAudioRestoreTask?.cancel()
    inboundAudioRestoreTask = nil
    inboundPlayerNode?.stop()
    inboundAudioEngine?.stop()
    inboundPlayerNode = nil
    inboundAudioEngine = nil
    inboundSampleRate = nil
    hasAppliedSpeakerRoute = false
    isInboundAudioActive = false
    if let observer = routeChangeObserver {
      NotificationCenter.default.removeObserver(observer)
      routeChangeObserver = nil
    }
    restoreSpeakerRoute()
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
