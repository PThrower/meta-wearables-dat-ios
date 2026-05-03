//
// StreamCoordinator.swift
//
// Central coordinator holding all domain stores and pipeline stage instances.
// Owns the control message dispatch table, background handling, and cross-store coordination.
// Single @Observable class injected into SwiftUI environment.
//

import AVFoundation
import Combine
import MediaPlayer
import MWDATCamera
import MWDATCore
import SwiftUI

@MainActor
@Observable
final class StreamCoordinator {

  // MARK: - Domain Stores

  let config: StreamConfigStore
  let errors: ErrorStore
  let recording: RecordingStore
  let audio: AudioStore
  let pipeline: PipelineStore
  let telemetry: TelemetryStore

  // MARK: - Relay + Session State (on coordinator — tightly coupled)

  var relayMode: RelayMode = .disconnected
  var isTapConnected: Bool = false
  var activeAppId: String?
  var availableApps: [AppInfo] = []
  var isLoadingApps: Bool = false
  var appFetchError: String?

  var streamingStatus: StreamingStatus = .stopped
  var hasReceivedFirstFrame: Bool = false
  var currentVideoFrame: UIImage?
  var hasActiveDevice: Bool = false
  var selectedDeviceId: DeviceIdentifier?
  var isRetrying: Bool = false
  var retryCount: Int = 0
  var isPhoneCameraMode: Bool = false

  var isStreaming: Bool { streamingStatus != .stopped }
  var isSessionReady: Bool { isPhoneCameraMode || sessionManager.isReady }

  // MARK: - Pipeline Stage Instances

  private let framePipeline: FramePipelineManager
  private let recordingStage: RecordingStage
  private let relayStage: RelayStage
  private let audioStage: AudioStage
  private let glassesAudioStage: AudioStage
  private let audioRelayStage: AudioRelayStage
  private let audioEventBus: AudioEventBus
  private let audioPlaybackStage: AudioPlaybackStage
  private let audioTapClient: AudioTapClient
  private var displayStage: DisplayStage?
  private let sensorRelayStage: SensorRelayStage
  private let memoryPressureMonitor = MemoryPressureMonitor()

  // MARK: - Session State

  private var streamSession: StreamSession?
  private let sessionManager: DeviceSessionManager
  private let wearables: WearablesInterface
  private var currentSelector: any DeviceSelector
  private var deviceMonitorTask: Task<Void, Never>?
  private var retryTask: Task<Void, Never>?
  private weak var telemetryService: TelemetryService?

  private var stateListenerToken: AnyListenerToken?
  private var errorListenerToken: AnyListenerToken?
  private var photoDataListenerToken: AnyListenerToken?

  // Background handling
  private var backgroundTaskIdentifier: UIBackgroundTaskIdentifier = .invalid
  private var wasStreamingBeforeBackground: Bool = false
  private var wakeBackgroundTask: UIBackgroundTaskIdentifier = .invalid

  // Active wearable tracking
  private var activeWearableId: DeviceIdentifier?
  private var activeWearableType: String?

  // Combine subscriptions
  private var cancellables = Set<AnyCancellable>()

  // Phone camera
  private let phoneCamera = PhoneCameraCapture()

  // Retry constants
  private static let maxRetries = 3
  private static let retryableErrors: Set<String> = [
    "internalError", "timeout", "deviceNotConnected", "videoStreamingError"
  ]

  // Preview system
  #if DEBUG
  let previewBus = PreviewBus()
  var previewStore = PreviewStore()
  var showNodePreview = false
  private var previewSubscriptionId: UUID?
  private var previewListenTask: Task<Void, Never>?
  #endif

  // MARK: - Init

  init(wearables: WearablesInterface, telemetryService: TelemetryService? = nil) {
    self.wearables = wearables
    self.telemetryService = telemetryService

    // Pipeline stages
    self.framePipeline = FramePipelineManager()
    self.recordingStage = RecordingStage()
    self.relayStage = RelayStage()
    self.audioStage = AudioStage(source: .builtInMic)
    self.glassesAudioStage = AudioStage(source: .bluetoothHFP)
    self.audioRelayStage = AudioRelayStage()
    self.audioEventBus = AudioEventBus()
    self.audioPlaybackStage = AudioPlaybackStage()
    self.audioTapClient = AudioTapClient(eventBus: audioEventBus)
    self.sensorRelayStage = SensorRelayStage()

    // Device session manager
    let selector = AutoDeviceSelector(wearables: wearables)
    self.currentSelector = selector
    self.sessionManager = DeviceSessionManager(wearables: wearables, selector: selector)

    // Stores
    self.config = StreamConfigStore()
    self.errors = ErrorStore()
    self.recording = RecordingStore(recordingStage: recordingStage)
    self.audio = AudioStore()
    self.pipeline = PipelineStore(pipeline: framePipeline, relayStage: relayStage)
    self.telemetry = TelemetryStore()

    // Wire display stage
    self.displayStage = DisplayStage { [weak self] image in
      self?.currentVideoFrame = image
      guard let self, !self.hasReceivedFirstFrame else { return }
      self.hasReceivedFirstFrame = true
      self.cancelRetry()
    }

    // Wire memory pressure
    self.memoryPressureMonitor.onPressureChange = { [weak self] actions in
      await self?.pipeline.handleMemoryPressure(actions)
    }

    // Register core pipeline stages
    if let displayStage { framePipeline.register(displayStage) }
    framePipeline.register(recordingStage)
    framePipeline.register(relayStage)

    // Wire audio pipeline
    Task {
      await audioStage.setEventBus(audioEventBus)
      await glassesAudioStage.setEventBus(audioEventBus)
      await audioPlaybackStage.setEventBus(audioEventBus)
      await audioRelayStage.setRelayStage(relayStage)
      if let telemetryService {
        await sensorRelayStage.configure(relayStage: relayStage, telemetryService: telemetryService)
      }

      #if DEBUG
      await displayStage?.setPreviewBus(previewBus)
      await relayStage.setPreviewBus(previewBus)
      await audioRelayStage.setPreviewBus(previewBus)
      await audioPlaybackStage.setPreviewBus(previewBus)
      await recordingStage.setPreviewBus(previewBus)
      await sensorRelayStage.setPreviewBus(previewBus)

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

    // Forward DeviceSessionManager state
    sessionManager.$hasActiveDevice
      .receive(on: DispatchQueue.main)
      .sink { [weak self] value in
        self?.hasActiveDevice = value
      }
      .store(in: &cancellables)

    // Monitor device availability
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

    // Wire phone camera device provider for telemetry
    self.telemetryService?.phoneCameraDeviceProvider = { [weak self] in
      guard let self else { return nil }
      return self.phoneCamera.currentDevice
    }
  }

  // MARK: - Stream Config

  private var streamConfig: StreamSessionConfig {
    StreamSessionConfig(
      videoCodec: VideoCodec.raw,
      resolution: config.selectedResolution,
      frameRate: config.selectedFrameRate)
  }

  func rebuildSessionWithNewConfig() {
    // No-op while streaming — config applied on next session start
    guard streamingStatus == .stopped else { return }
  }

  // MARK: - Device Selection

  func selectDevice(_ deviceId: DeviceIdentifier?) {
    guard !isStreaming else { return }
    selectedDeviceId = deviceId
    isPhoneCameraMode = false

    deviceMonitorTask?.cancel()

    if let deviceId {
      let selector = SpecificDeviceSelector(device: deviceId)
      currentSelector = selector
    } else {
      let selector = AutoDeviceSelector(wearables: wearables)
      currentSelector = selector
    }

    sessionManager.updateSelector(currentSelector)

    if let stream = streamSession {
      streamSession = nil
      clearListeners()
      streamingStatus = .stopped
    }

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

    streamingStatus = .stopped
  }

  func selectPhoneCamera() {
    guard !isStreaming else { return }
    isPhoneCameraMode = true
    selectedDeviceId = nil
    hasActiveDevice = true
    deviceMonitorTask?.cancel()
    deviceMonitorTask = nil
  }

  func deselectPhoneCamera() {
    guard !isStreaming else { return }
    isPhoneCameraMode = false
    hasActiveDevice = false
  }

  // MARK: - TTS Playback

  func startTTSPlayback() async {
    await audioPlaybackStage.start()
  }

  func stopTTSPlayback() async {
    await audioPlaybackStage.stop()
  }

  // MARK: - Session Lifecycle

  func handleStartStreaming() async {
    if isPhoneCameraMode {
      await startPhoneCameraSession()
      await startRelay()
    } else {
      await startSession()
      await startRelay()
    }
  }

  func startSession() async {
    cancelRetry()

    // Check mic permission before starting
    guard await checkMicPermission() else {
      errors.present("Microphone permission required for streaming")
      return
    }

    // Request DAT SDK camera permission if not already granted
    do {
      let status = try await wearables.checkPermissionStatus(.camera)
      if status != .granted {
        let requested = try await wearables.requestPermission(.camera)
        if requested != .granted {
          errors.present("Camera permission denied. Please grant permission in the Meta app.")
          return
        }
      }
    } catch {
      errors.present("Permission check failed: \(error.localizedDescription)")
      return
    }

    // DAT SDK 0.6.0: Get DeviceSession from manager, then add a StreamSession
    guard let deviceSession = await sessionManager.getSession() else {
      NSLog("[StreamCoordinator] No DeviceSession available")
      errors.present("Glasses not ready — please wait a moment and try again")
      return
    }
    guard deviceSession.state == .started else {
      NSLog("[StreamCoordinator] DeviceSession not started: \(deviceSession.state)")
      errors.present("Glasses session not started — ensure glasses are connected and try again")
      return
    }

    let config = streamConfig
    guard let stream = try? deviceSession.addStream(config: config) else {
      NSLog("[StreamCoordinator] addStream(config:) returned nil")
      errors.present("Failed to start stream — ensure glasses are connected and try again")
      return
    }

    streamSession = stream
    streamingStatus = .waiting
    setupSessionListeners(for: stream)
    framePipeline.attachToStreamSession(stream)
    telemetryService?.attachToStreamSession(stream)

    await stream.start()
  }

  func stopSession() async {
    if recording.isRecording {
      await recording.stopRecording()
    }

    if isPhoneCameraMode {
      if relayMode == .active {
        await deactivateToStandby()
      }
      await stopPhoneCameraSession()
      let audioSession = AVAudioSession.sharedInstance()
      try? audioSession.setActive(false, options: .notifyOthersOnDeactivation)
      return
    }

    if relayMode == .active {
      await deactivateToStandby()
    }

    cancelRetry()
    if let stream = streamSession {
      streamSession = nil
      clearListeners()
      await stream.stop()
    }

    let audioSession = AVAudioSession.sharedInstance()
    try? audioSession.setActive(false, options: .notifyOthersOnDeactivation)
  }

  // MARK: - Relay Lifecycle

  func startRelay() async {
    if relayMode == .standby {
      await activateFromStandby()
      return
    }

    var url = config.relayURL.trimmingCharacters(in: .whitespacesAndNewlines)
    let stableDeviceId = DeviceIdentity.shared.stableDeviceId
    let separator = url.contains("?") ? "&" : "?"
    url += "\(separator)device=\(stableDeviceId)"
    guard !url.isEmpty else {
      errors.present("Enter a relay URL (e.g. ws://192.168.1.x:3000/publish)")
      return
    }

    guard await checkMicPermission() else {
      errors.present("Microphone permission required for audio relay")
      return
    }

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

      await configureRelayEncoder()
      await wireControlMessageHandler()

      await relayStage.setOnReceivedAudio { [weak self] data in
        guard let parsed = WireProtocol.parseFRAU(data) else { return }
        Task { @MainActor [weak self] in
          guard let self else { return }
          self.audio.playInboundPCM(parsed.pcmData, sampleRate: parsed.sampleRate, channels: parsed.channels, bitsPerSample: parsed.bitsPerSample)
        }
      }

      await relayStage.setOnReconnected { [weak self] in
        Task { @MainActor [weak self] in
          guard let self else { return }
          if self.relayMode == .active {
            NSLog("[StreamCoordinator] Re-announcing active stream after auto-reconnect")
            await self.relayStage.sendJson(["type": "stream_changed", "streaming": true])
          }
        }
      }

      try await relayStage.connect(to: url)
      relayMode = .active

      let linkState: String
      switch streamSession?.state {
      case .streaming: linkState = "connected"
      case .waitingForDevice: linkState = "disconnected"
      case nil: linkState = "disconnected"
      default: linkState = "unknown"
      }
      await relayStage.sendJson(["type": "link_state_changed", "state": linkState])
    } catch {
      errors.present("Relay failed: \(error.localizedDescription)")
      return
    }

    await startRelayAudioAndTelemetry()
  }

  func startStandbyRelay() async {
    guard relayMode == .disconnected else { return }

    var url = config.relayURL.trimmingCharacters(in: .whitespacesAndNewlines)
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
      await configureRelayEncoder()

      try await relayStage.connect(to: url)
      relayMode = .standby

      await relayStage.sendJson(["type": "standby", "status": "ready"])
      NSLog("[StreamCoordinator] Standby relay connected")
    } catch {
      NSLog("[StreamCoordinator] Standby relay connect failed (non-fatal): \(error)")
    }
  }

  func stopRelay() async {
    if relayMode == .active, activeAppId != nil {
      await relayStage.sendJson(["type": "deactivate_app"])
    }

    telemetry.stopTimers()
    memoryPressureMonitor.stop()

    await pipeline.stopAllPipelineStages()

    await audioStage.stop()
    await glassesAudioStage.stop()
    audio.stopInboundAudioEngine()
    await audioRelayStage.detachFromEventBus(audioEventBus)
    await audioTapClient.disconnect()
    await audioPlaybackStage.stop()

    await sensorRelayStage.stop()

    await relayStage.disconnect()
    relayMode = .disconnected
    activeAppId = nil
    endWakeBackgroundTask()
    NSLog("[StreamCoordinator] Relay disconnected")
  }

  // MARK: - Standby / Wake

  func handleWakeFromPush() {
    guard relayMode != .active else { return }

    if wakeBackgroundTask == .invalid {
      wakeBackgroundTask = UIApplication.shared.beginBackgroundTask(
        withName: "StreamCoordinator.wakeStandby"
      ) { [weak self] in
        self?.endWakeBackgroundTask()
      }
    }

    if relayMode == .standby {
      NSLog("[StreamCoordinator] Already in standby — waiting for server start_stream")
    } else {
      Task { await startStandbyRelay() }
    }
  }

  // MARK: - AI App Activation

  func activateApp(_ appId: String) {
    guard relayMode == .active else { return }
    activeAppId = appId
    Task { await relayStage.sendJson(["type": "activate_app", "appId": appId]) }
  }

  func deactivateApp() {
    guard relayMode == .active else { return }
    activeAppId = nil
    Task { await relayStage.sendJson(["type": "deactivate_app"]) }
  }

  // MARK: - App Discovery

  func fetchApps() async {
    guard availableApps.isEmpty else { return }
    isLoadingApps = true
    appFetchError = nil

    do {
      guard let wsURL = URL(string: config.relayURL), let host = wsURL.host else {
        throw AppFetchError.invalidURL
      }
      let scheme = wsURL.scheme == "wss" ? "https" : "http"
      guard let appsURL = URL(string: "\(scheme)://\(host)/apps") else {
        throw AppFetchError.invalidURL
      }
      let (data, response) = try await URLSession.shared.data(from: appsURL)
      guard let httpResponse = response as? HTTPURLResponse, (200...299).contains(httpResponse.statusCode) else {
        throw AppFetchError.serverError((response as? HTTPURLResponse)?.statusCode ?? 0)
      }
      guard let json = try JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
        throw AppFetchError.parseError
      }
      availableApps = json.compactMap { item -> AppInfo? in
        guard let id = item["id"] as? String else { return nil }
        return AppInfo(
          id: id,
          name: (item["name"] as? String) ?? id,
          description: (item["description"] as? String) ?? "",
          icon: (item["icon"] as? String) ?? "app"
        )
      }
    } catch {
      appFetchError = error.localizedDescription
    }
    isLoadingApps = false
  }

  // MARK: - Codec Switching

  func switchCodec(_ codec: RelayVideoCodec) async {
    guard codec != config.videoCodec else { return }
    config.videoCodec = codec
    await configureRelayEncoder()
    await relayStage.sendJson(["type": "codec_changed", "codec": codec == .h264 ? "h264" : "jpeg"])
  }

  // MARK: - Audio Mode Switching

  func switchAudioMode(_ mode: String) async {
    guard relayMode == .active else { return }

    await audioStage.stop()
    await glassesAudioStage.stop()

    switch mode {
    case "phone":
      config.audioInputMode = .builtInMic
      await audioStage.start()
    case "glasses":
      config.audioInputMode = .glassesMic
      await glassesAudioStage.start()
    default:
      config.audioInputMode = .all
      await audioStage.start()
      await glassesAudioStage.start()
    }
    NSLog("[StreamCoordinator] Audio mode switched: \(mode)")
  }

  // MARK: - Photo Capture

  func capturePhoto() {
    telemetryService?.recordPhotoRequest()
    recording.capturePhoto(
      from: streamSession,
      phoneFrame: currentVideoFrame,
      isPhoneCamera: isPhoneCameraMode
    )
  }

  // MARK: - Background Handling

  func handleEnterBackground() {
    guard isStreaming else { return }
    wasStreamingBeforeBackground = true

    backgroundTaskIdentifier = UIApplication.shared.beginBackgroundTask(
      withName: "StreamCoordinator.backgroundFlush"
    ) { [weak self] in
      self?.endBackgroundTask()
    }

    telemetryService?.pauseUptimeAccumulation()
  }

  func handleEnterForeground() {
    endBackgroundTask()

    if relayMode == .disconnected && !isStreaming {
      Task { await startStandbyRelay() }
    }

    guard wasStreamingBeforeBackground else { return }
    wasStreamingBeforeBackground = false

    telemetryService?.resumeUptimeAccumulation()

    if let lastFrame = telemetryService?.lastFrameTime {
      let staleness = ContinuousClock.Instant.now - lastFrame
      let stalenessMs = durationToMs(staleness)
      if stalenessMs > TelemetryService.staleThresholdMs {
        NSLog("[StreamCoordinator] Stream stale (\(String(format: "%.1f", stalenessMs))ms) — reconnecting relay")
        Task {
          if relayMode == .active, await relayStage.connected {
            do {
              try await relayStage.reconnect()
              await relayStage.sendJson(["type": "stream_changed", "streaming": true])
            } catch {
              NSLog("[StreamCoordinator] Relay reconnect failed: \(error)")
            }
          }
          if streamingStatus == .streaming && !hasReceivedFirstFrame {
            await stopSession()
          }
        }
      }
    }
  }

  // MARK: - Control Message Handler

  private func wireControlMessageHandler() async {
    await relayStage.setOnControlMessage { [weak self] msg in
      let msgType = msg["type"] as? String

      // App status updates
      if msgType == "app_status" {
        let status = msg["status"] as? String
        let appId = msg["appId"] as? String
        let errorMsg = msg["error"] as? String
        Task { @MainActor [weak self] in
          guard let self else { return }
          if status == "active" {
            self.activeAppId = appId
            await self.audioPlaybackStage.start()
          } else if status == "inactive" || status == "error" {
            self.activeAppId = nil
            await self.audioPlaybackStage.stop()
            await self.pipeline.stopAllPipelineStages()
            if status == "error", let err = errorMsg {
              self.errors.logError("App error (\(appId ?? "unknown")): \(err)")
              self.errors.present("App error: \(err)")
            }
          }
        }
      }

      if msgType == "workflow_error", let error = msg["error"] as? String {
        Task { @MainActor [weak self] in
          self?.errors.logError("Workflow error: \(error)")
          self?.errors.present("Workflow error: \(error)")
        }
      }

      if msgType == "server_error", let message = msg["message"] as? String {
        let source = msg["source"] as? String ?? "unknown"
        let severity = msg["severity"] as? String ?? "warning"
        Task { @MainActor [weak self] in
          self?.errors.logError("[\(source)/\(severity)] \(message)")
          if severity == "critical" {
            self?.errors.present("[\(source)] \(message)")
          }
        }
      }

      if msgType == "reid_error", let error = msg["error"] as? String {
        let cropCount = msg["cropCount"] as? Int ?? 0
        Task { @MainActor [weak self] in
          self?.errors.logError("ReID error (\(cropCount) crops): \(error)")
        }
      }

      if msgType == "guidance_text", let text = msg["text"] as? String, !text.isEmpty {
        Task { [weak self] in
          let preferGlasses = msg["preferGlasses"] as? Bool ?? false
          await self?.audioPlaybackStage.speakGuidance(text, preferGlasses: preferGlasses)
        }
      }

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
          self?.pipeline.boundingBoxes = bboxes
        }
      }

      if msgType == "set_audio_mode", let mode = msg["mode"] as? String {
        Task { @MainActor [weak self] in
          await self?.switchAudioMode(mode)
        }
      }

      if msgType == "set_codec", let codec = msg["codec"] as? String {
        Task { @MainActor [weak self] in
          guard let self else { return }
          let newCodec: RelayVideoCodec = codec == "h264" ? .h264 : .jpeg
          guard newCodec != self.config.videoCodec else { return }
          self.config.videoCodec = newCodec
          await self.configureRelayEncoder()
          await self.relayStage.sendJson(["type": "codec_changed", "codec": newCodec == .h264 ? "h264" : "jpeg"])
        }
      }

      if msgType == "audio_route" {
        let preferPhone = msg["preferPhone"] as? Bool ?? false
        Task { @MainActor [weak self] in
          self?.audio.preferredSpeaker = preferPhone ? .phone : .glasses
        }
      }

      if msgType == "workflow_config", let config = msg["config"] as? [String: Any] {
        let sinks = config["sinks"] as? [[String: Any]] ?? []
        let sinkTypes = sinks.compactMap { $0["type"] as? String }
        NSLog("[StreamCoordinator] Workflow config: sinks=\(sinkTypes)")
      }

      if msgType == "vision_stage_config" {
        let enabled = msg["enabled"] as? Bool ?? true
        if !enabled {
          Task { @MainActor [weak self] in
            await self?.pipeline.disableVisionStage()
          }
        } else {
          Task { @MainActor [weak self] in
            await self?.pipeline.configureVisionStage(config: msg)
          }
        }
      }

      if msgType == "enhance_stage_config" {
        let enabled = msg["enabled"] as? Bool ?? true
        if !enabled {
          Task { @MainActor [weak self] in
            self?.pipeline.disableEnhanceStage()
          }
        } else {
          Task { @MainActor [weak self] in
            self?.pipeline.configureEnhanceStage(config: msg)
          }
        }
      }

      if msgType == "sensor_stage_config" {
        let enabled = msg["enabled"] as? Bool ?? true
        if !enabled {
          Task { @MainActor [weak self] in
            await self?.pipeline.disableSensorStages()
          }
        } else {
          Task { @MainActor [weak self] in
            await self?.pipeline.configureSensorStage(config: msg)
          }
        }
      }

      if msgType == "speech_stage_config" {
        let enabled = msg["enabled"] as? Bool ?? true
        if !enabled {
          Task { @MainActor [weak self] in
            await self?.pipeline.disableSpeechStages()
          }
        } else {
          Task { @MainActor [weak self] in
            guard let self else { return }
            await self.pipeline.configureSpeechStage(config: msg, audioEventBus: self.audioEventBus)
          }
        }
      }

      if msgType == "tracking_stage_config" {
        let enabled = msg["enabled"] as? Bool ?? true
        if !enabled {
          Task { @MainActor [weak self] in
            await self?.pipeline.disableTrackingStage()
          }
        } else {
          Task { @MainActor [weak self] in
            await self?.pipeline.configureTrackingStage(config: msg)
          }
        }
      }

      if msgType == "reid_embeddings", let embeddings = msg["embeddings"] as? [[String: Any]] {
        Task { @MainActor [weak self] in
          self?.pipeline.injectReidEmbeddings(embeddings)
        }
      }

      if msgType == "measure_stage_config" {
        let enabled = msg["enabled"] as? Bool ?? true
        if !enabled {
          Task { @MainActor [weak self] in
            await self?.pipeline.disableMeasureStage()
          }
        } else {
          Task { @MainActor [weak self] in
            await self?.pipeline.configureMeasureStage(config: msg)
          }
        }
      }

      if msgType == "yolo_stage_config" {
        let enabled = msg["enabled"] as? Bool ?? true
        if !enabled {
          Task { @MainActor [weak self] in
            await self?.pipeline.disableYOLOStage()
          }
        } else {
          Task { @MainActor [weak self] in
            guard let self else { return }
            do {
              try await self.pipeline.configureYOLOStage(config: msg)
            } catch {
              NSLog("[StreamCoordinator] YOLO configuration failed: \(error.localizedDescription)")
              self.pipeline.yoloModelState = .failed(modelId: msg["modelId"] as? String ?? "unknown", error: error.localizedDescription)
            }
          }
        }
      }

      if msgType == "set_audio_gain",
         let codecType = msg["codecType"] as? Int,
         let gainDb = msg["gainDb"] as? Double {
        Task { [weak self] in
          await self?.audioRelayStage.setGain(codecType: UInt8(codecType), gainDb: Float(gainDb))
        }
      }

      if msgType == "set_noise_gate",
         let codecType = msg["codecType"] as? Int,
         let threshold = msg["threshold"] as? Double {
        Task { [weak self] in
          await self?.audioRelayStage.setNoiseGate(codecType: UInt8(codecType), threshold: Float(threshold))
        }
      }

      if msgType == "set_noise_suppression",
         let codecType = msg["codecType"] as? Int,
         let enabled = msg["enabled"] as? Bool {
        Task { [weak self] in
          await self?.audioRelayStage.setNoiseSuppression(codecType: UInt8(codecType), enabled: enabled)
        }
      }

      if msgType == "set_audio_mix", let enabled = msg["enabled"] as? Bool {
        let weightPhone = msg["weightPhone"] as? Double ?? 0.5
        let weightGlasses = msg["weightGlasses"] as? Double ?? 0.5
        Task { [weak self] in
          await self?.audioRelayStage.setMixEnabled(enabled, weightPhone: Float(weightPhone), weightGlasses: Float(weightGlasses))
        }
      }

      if msgType == "node_states",
         let workflowId = msg["workflowId"] as? String,
         let nodes = msg["nodes"] as? [[String: Any]] {
        let states = nodes.compactMap { node -> String? in
          guard let nodeId = node["nodeId"] as? String,
                let state = node["state"] as? String else { return nil }
          let label = node["label"] as? String ?? nodeId
          return "\(label): \(state)"
        }
        NSLog("[StreamCoordinator] node_states for workflow \(workflowId): \(states.joined(separator: ", "))")
      }

      if msgType == "get_audio_config" {
        Task { [weak self] in
          guard let self else { return }
          let config = await self.audioRelayStage.getCurrentConfig()
          await self.relayStage.sendJson(config.toDictionary())
        }
      }

      if msgType == "capture_photo" {
        Task { @MainActor [weak self] in
          self?.capturePhoto()
          await self?.relayStage.sendJson(["type": "photo_captured"])
        }
      }

      if msgType == "start_recording" {
        Task { @MainActor [weak self] in
          do {
            try await self?.recording.startRecording()
          } catch {
            self?.errors.present(error.localizedDescription)
          }
          await self?.relayStage.sendJson(["type": "recording_changed", "recording": true])
        }
      }
      if msgType == "stop_recording" {
        Task { @MainActor [weak self] in
          await self?.recording.stopRecording()
          await self?.relayStage.sendJson(["type": "recording_changed", "recording": false])
        }
      }

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
            if self.recording.isRecording { await self.recording.stopRecording() }
            await self.backToStandby()
            if self.isPhoneCameraMode {
              await self.stopPhoneCameraSession()
            } else {
              await self.streamSession?.stop()
            }
            let audioSession = AVAudioSession.sharedInstance()
            try? audioSession.setActive(false, options: .notifyOthersOnDeactivation)
          }
          await self.relayStage.sendJson(["type": "stream_changed", "streaming": false])
        }
      }

      if msgType == "speak_text", let text = msg["text"] as? String, !text.isEmpty {
        Task { @MainActor [weak self] in
          let preferGlasses = self?.audio.preferredSpeaker == .glasses
          await self?.audioPlaybackStage.speakGuidance(text, preferGlasses: preferGlasses)
          await self?.relayStage.sendJson(["type": "spoken_text", "text": text])
        }
      }
    }
  }

  // MARK: - Private Helpers

  private func attachPipeline() {
    if let stream = streamSession {
      framePipeline.attachToStreamSession(stream)
    }
  }

  private func clearListeners() {
    stateListenerToken = nil
    errorListenerToken = nil
    photoDataListenerToken = nil
  }

  private func setupSessionListeners(for stream: StreamSession) {
    stateListenerToken = stream.statePublisher.listen { [weak self] state in
      Task { @MainActor [weak self] in
        self?.updateStatusFromState(state)
      }
    }

    errorListenerToken = stream.errorPublisher.listen { [weak self] error in
      Task { @MainActor [weak self] in
        guard let self else { return }
        let rawError = String(describing: error)
        let state = String(describing: self.streamingStatus)
        let device = self.selectedDeviceId ?? "auto"
        self.errors.logError("\(rawError) | state=\(state) | device=\(device)")

        if self.shouldRetry(error: error) {
          self.scheduleRetry()
        } else {
          self.errors.present(Self.formatStreamingError(error))
        }
      }
    }

    photoDataListenerToken = stream.photoDataPublisher.listen { [weak self] photoData in
      Task { @MainActor [weak self] in
        guard let self else { return }
        if let uiImage = UIImage(data: photoData.data) {
          self.recording.handleCapturedPhoto(uiImage)
        }
      }
    }
  }

  private static func formatStreamingError(_ error: StreamSessionError) -> String {
    switch error {
    case .internalError:       return "An internal error occurred. Please try again."
    case .deviceNotFound:      return "Device not found. Please ensure your glasses are connected."
    case .deviceNotConnected:  return "Glasses disconnected. Please check your connection and try again."
    case .timeout:             return "The operation timed out. Please try again."
    case .videoStreamingError: return "Video streaming failed. Please try again."
    case .permissionDenied:    return "Camera permission denied. Please grant permission in the Meta app."
    case .hingesClosed:        return "Open the glasses hinges to start streaming."
    case .thermalCritical:     return "Glasses are overheating. Streaming paused to protect the device."
    @unknown default:          return "An unexpected streaming error occurred."
    }
  }

  private func updateStatusFromState(_ state: StreamSessionState) {
    NSLog("[StreamCoordinator] State: \(String(describing: state)) | device=\(selectedDeviceId ?? "auto")")

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

  private func configureRelayEncoder() async {
    switch config.videoCodec {
    case .jpeg:
      await relayStage.setEncoder(JPEGFrameEncoder(ciContext: PipelineCIContext.shared, quality: 0.5))
    case .h264:
      do {
        let h264Encoder = try H264FrameEncoder(config: .default)
        await relayStage.setEncoder(h264Encoder)
      } catch {
        NSLog("[StreamCoordinator] H.264 encoder init failed, falling back to JPEG: \(error)")
        await relayStage.setEncoder(JPEGFrameEncoder(ciContext: PipelineCIContext.shared, quality: 0.5))
      }
    }
  }

  private func startRelayAudioAndTelemetry() async {
    memoryPressureMonitor.start()
    await audioRelayStage.attachToEventBus(audioEventBus)

    switch config.audioInputMode {
    case .builtInMic:
      await audioStage.start()
    case .glassesMic:
      await glassesAudioStage.start()
    case .all:
      await audioStage.start()
      await glassesAudioStage.start()
    }

    let url = config.relayURL.trimmingCharacters(in: .whitespacesAndNewlines)
    Task {
      do {
        try await audioTapClient.connect(to: url, session: nil, autoReconnect: true)
        isTapConnected = true
      } catch {
        NSLog("[StreamCoordinator] Audio tap connect failed (non-fatal): \(error)")
      }
    }

    await sensorRelayStage.start()

    if let telemetryService {
      telemetry.configure(
        telemetryService: telemetryService,
        relayStage: relayStage,
        pipeline: framePipeline,
        audioClassificationStage: nil,
        speechRecognitionStage: nil
      )
      telemetry.startTimers()
    }
  }

  private func activateFromStandby() async {
    guard relayMode == .standby else { return }

    endWakeBackgroundTask()

    guard await checkMicPermission() else {
      await relayStage.sendJson(["type": "publisher_error", "error": "Microphone permission required", "state": "standby"])
      return
    }

    relayMode = .active

    if !isStreaming && !isPhoneCameraMode {
      await startSession()
    }

    let ready = await waitForStreamReady(timeoutMs: 5000)
    if !ready {
      NSLog("[StreamCoordinator] Stream not ready within timeout — activating anyway")
    }

    await startRelayAudioAndTelemetry()
    await relayStage.sendJson(["type": "stream_changed", "streaming": true])
    NSLog("[StreamCoordinator] Activated from standby")
  }

  private func backToStandby() async {
    telemetry.stopTimers()
    memoryPressureMonitor.stop()
    await pipeline.stopAllPipelineStages()

    await audioStage.stop()
    await glassesAudioStage.stop()
    audio.stopInboundAudioEngine()
    await audioRelayStage.detachFromEventBus(audioEventBus)
    await audioTapClient.disconnect()
    isTapConnected = false
    activeAppId = nil
    pipeline.boundingBoxes = []
    relayMode = .standby
    await relayStage.sendJson(["type": "standby", "status": "ready"])
    NSLog("[StreamCoordinator] Back to standby")
  }

  private func deactivateToStandby() async {
    telemetry.stopTimers()
    memoryPressureMonitor.stop()
    await pipeline.stopAllPipelineStages()

    await audioStage.stop()
    await glassesAudioStage.stop()
    audio.stopInboundAudioEngine()
    await audioRelayStage.detachFromEventBus(audioEventBus)
    await audioTapClient.disconnect()
    isTapConnected = false
    activeAppId = nil
    pipeline.boundingBoxes = []
    relayMode = .standby
    await relayStage.sendJson(["type": "standby", "status": "ready"])
  }

  private func waitForStreamReady(timeoutMs: Int) async -> Bool {
    let deadline = CFAbsoluteTimeGetCurrent() + Double(timeoutMs) / 1000.0
    while CFAbsoluteTimeGetCurrent() < deadline {
      if streamingStatus == .streaming { return true }
      try? await Task.sleep(nanoseconds: 100_000_000)
    }
    return streamingStatus == .streaming
  }

  // MARK: - Phone Camera

  private func startPhoneCameraSession() async {
    do {
      try await phoneCamera.start { [weak self] sampleBuffer in
        Task { @MainActor [weak self] in
          guard let self else { return }
          // Feed into pipeline for display + relay
          self.framePipeline.onRawSampleBuffer(sampleBuffer)
        }
      }
      streamingStatus = .streaming
      hasReceivedFirstFrame = false
      NSLog("[StreamCoordinator] Phone camera session started")
    } catch {
      errors.present("Phone camera failed: \(error.localizedDescription)")
    }
  }

  private func stopPhoneCameraSession() async {
    await phoneCamera.stop()
    streamingStatus = .stopped
    currentVideoFrame = nil
    hasReceivedFirstFrame = false
  }

  // MARK: - Mic Permission

  private func checkMicPermission() async -> Bool {
    let audioSession = AVAudioSession.sharedInstance()
    switch audioSession.recordPermission {
    case .granted:
      return true
    case .denied:
      return false
    case .undetermined:
      return await withCheckedContinuation { continuation in
        audioSession.requestRecordPermission { granted in
          continuation.resume(returning: granted)
        }
      }
    @unknown default:
      return false
    }
  }

  // MARK: - Retry

  private func shouldRetry(error: StreamSessionError) -> Bool {
    let errorStr = String(describing: error)
    return Self.retryableErrors.contains(errorStr) && retryCount < Self.maxRetries
  }

  private func scheduleRetry() {
    isRetrying = true
    retryCount += 1
    let delay = UInt64(min(pow(2.0, Double(retryCount)), 8.0) * 1_000_000_000)

    retryTask = Task { @MainActor [weak self] in
      try? await Task.sleep(nanoseconds: delay)
      guard let self, self.isRetrying else { return }
      NSLog("[StreamCoordinator] Auto-retry attempt \(self.retryCount)")
      await self.stopSession()
      await self.handleStartStreaming()
      self.isRetrying = false
    }
  }

  private func cancelRetry() {
    retryTask?.cancel()
    retryTask = nil
    isRetrying = false
    retryCount = 0
  }

  // MARK: - Background Tasks

  private func endBackgroundTask() {
    guard backgroundTaskIdentifier != .invalid else { return }
    UIApplication.shared.endBackgroundTask(backgroundTaskIdentifier)
    backgroundTaskIdentifier = .invalid
  }

  private func endWakeBackgroundTask() {
    guard wakeBackgroundTask != .invalid else { return }
    UIApplication.shared.endBackgroundTask(wakeBackgroundTask)
    wakeBackgroundTask = .invalid
  }

  private func durationToMs(_ duration: Duration) -> Double {
    let components = duration.components
    return Double(components.seconds) * 1000.0 + Double(components.attoseconds) / 1_000_000_000_000_000.0
  }
}

// MARK: - App Fetch Error

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
