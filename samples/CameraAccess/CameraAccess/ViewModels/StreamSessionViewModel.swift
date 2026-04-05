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
import MWDATCamera
import MWDATCore
import Photos
import SwiftUI

enum StreamingStatus {
  case streaming
  case waiting
  case stopped
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

  // Recording state
  @Published var isRecording: Bool = false

  // Relay state
  @Published var isRelaying: Bool = false
  @Published var relayURL: String = "wss://relay.simulationapi.com/publish"
  @Published var audioInputMode: AudioInputMode = .builtInMic {
    didSet {
      // Re-route audio immediately when user changes mode while relay is active.
      // "All" restores HFP so glasses mic picks up TTS hello world from the speaker.
      guard isRelaying else { return }
      routeAudioInput()
    }
  }

  var isStreaming: Bool {
    streamingStatus != .stopped
  }

  // Photo capture properties
  @Published var capturedPhoto: UIImage?
  @Published var showPhotoPreview: Bool = false

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
  private let audioStage = AudioStage()
  private let audioPlaybackStage = AudioPlaybackStage()
  private var displayStage: DisplayStage!

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

    // Wire audio stage to relay stage for FRAU binary sending
    Task { await audioStage.setRelayStage(relayStage) }

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
    let url = relayURL.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !url.isEmpty else {
      errorMessage = "Enter a relay URL (e.g. ws://192.168.1.x:8080/publish)"
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
      try await relayStage.connect(to: url)
      isRelaying = true
      NSLog("[StreamSession] Relay connected to \(url)")
    } catch {
      errorMessage = "Relay failed: \(error.localizedDescription)"
      showError = true
      NSLog("[StreamSession] Relay error: \(error)")
      return
    }

    // Start audio engine first, THEN route input.
    // Routing before engine start triggers a session reconfiguration that
    // disrupts DAT SDK audio and can pause the glasses' audio path.
    await audioStage.start()
    NSLog("[StreamSession] Audio relay started")

    // Route mic input after engine is running — less disruptive to existing audio.
    routeAudioInput()
  }

  func stopRelay() async {
    // Stop audio first (removes mic tap, does NOT deactivate audio session)
    await audioStage.stop()
    NSLog("[StreamSession] Audio relay stopped")

    await relayStage.disconnect()
    isRelaying = false
    NSLog("[StreamSession] Relay disconnected")
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
    // DISABLED: AudioPlaybackStage.tryRouteToGlasses() conflicts with relay audio.
    // It calls setPreferredInput(hfp) which triggers route changes that kill mic capture.
    // Re-enable only when relay audio route conflicts are resolved.
    // await audioPlaybackStage.start()
  }

  private func showError(_ message: String) {
    errorMessage = message
    showError = true
  }

  func stopSession() async {
    if isRecording {
      await stopRecording()
    }
    if isRelaying {
      await stopRelay()
    }
    cancelRetry()
    await streamSession.stop()

    // Stop TTS playback stage.
    await audioPlaybackStage.stop()

    // [SAFE] AVAudioSession.sharedInstance() called from @MainActor (this ViewModel).
    // This is the correct isolation context — not inside an actor.
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
