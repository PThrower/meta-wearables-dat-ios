//
// AudioStore.swift
//
// Inbound audio playback engine (PCM from relay server).
// Manages AVAudioEngine for playing AI TTS/system audio received over WebSocket.
//

import AVFoundation
import SwiftUI

@MainActor
@Observable
final class AudioStore {

  /// Preferred audio output target, set by `audio_route` server message.
  var preferredSpeaker: PreferredSpeaker = .glasses

  // Inbound audio engine (lazily created)
  private var inboundAudioEngine: AVAudioEngine?
  private var inboundPlayerNode: AVAudioPlayerNode?
  private var inboundSampleRate: Double?
  private var hasAppliedSpeakerRoute = false
  private var isInboundAudioActive = false
  private var routeChangeObserver: NSObjectProtocol?
  private var inboundAudioRestoreTask: Task<Void, Never>?

  init() {}

  // MARK: - Inbound PCM Playback

  /// Play raw Int16 PCM via AVAudioEngine. Works with .playAndRecord sessions.
  func playInboundPCM(_ pcm: Data, sampleRate: UInt32, channels: UInt16, bitsPerSample: UInt16) {
    let sr = Double(sampleRate)
    let ch = UInt32(channels)

    // Tear down and rebuild engine if sample rate changed
    if let currentSR = inboundSampleRate, currentSR != sr {
      NSLog("[AudioStore] Inbound sample rate changed \(currentSR) -> \(sr), rebuilding engine")
      stopInboundAudioEngine()
    }
    inboundSampleRate = sr

    // Lazy-init engine + player node on first call
    if inboundAudioEngine == nil {
      let engine = AVAudioEngine()
      let player = AVAudioPlayerNode()
      engine.attach(player)

      guard let format = AVAudioFormat(standardFormatWithSampleRate: sr, channels: ch) else {
        NSLog("[AudioStore] Failed to create audio format for \(sr)Hz/\(ch)ch")
        return
      }
      engine.connect(player, to: engine.mainMixerNode, format: format)

      do {
        try engine.start()

        applySpeakerRoute()
        hasAppliedSpeakerRoute = true

        routeChangeObserver = NotificationCenter.default.addObserver(
          forName: AVAudioSession.routeChangeNotification,
          object: nil,
          queue: .main
        ) { [weak self] _ in
          self?.hasAppliedSpeakerRoute = false
        }

        let audioSession = AVAudioSession.sharedInstance()
        let outputs = audioSession.currentRoute.outputs.map { "\($0.portName)(\($0.portType.rawValue))" }
        NSLog("[AudioStore] Inbound audio engine started at \(sr)Hz, output: \(outputs)")
      } catch {
        NSLog("[AudioStore] Audio engine start failed: \(error)")
        return
      }

      inboundAudioEngine = engine
      inboundPlayerNode = player
    } else {
      if !hasAppliedSpeakerRoute {
        applySpeakerRoute()
        hasAppliedSpeakerRoute = true
      }
    }

    guard let player = inboundPlayerNode else { return }

    // Convert Int16 PCM -> Float32 for AVAudioPlayerNode
    let frameCount = UInt32(pcm.count) / (ch * 2)
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
        NSLog("[AudioStore] Auto-restored glasses route after inbound audio silence")
      }
    }
  }

  // MARK: - Speaker Routing

  func applySpeakerRoute() {
    let audioSession = AVAudioSession.sharedInstance()
    do {
      if preferredSpeaker == .glasses {
        try audioSession.overrideOutputAudioPort(.none)
        if let btHFP = audioSession.availableInputs?.first(where: { $0.portType == .bluetoothHFP }) {
          try audioSession.setPreferredInput(btHFP)
        }
      } else {
        try audioSession.overrideOutputAudioPort(.speaker)
      }
    } catch {
      NSLog("[AudioStore] Speaker route failed: \(error)")
    }
  }

  func restoreSpeakerRoute() {
    let audioSession = AVAudioSession.sharedInstance()
    do {
      try audioSession.overrideOutputAudioPort(.none)
      try audioSession.setPreferredInput(nil)
    } catch {
      NSLog("[AudioStore] Restore speaker route failed: \(error)")
    }
  }

  // MARK: - Engine Lifecycle

  func stopInboundAudioEngine() {
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
}
