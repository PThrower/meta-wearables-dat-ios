//
// StreamConfigStore.swift
//
// Persisted stream settings backed by @AppStorage (UserDefaults).
// Survives app restarts. Observable for SwiftUI reactivity.
//

import MWDATCamera
import SwiftUI

@MainActor
@Observable
final class StreamConfigStore {

  // MARK: - Persisted Settings

  var relayURL: String {
    didSet { UserDefaults.standard.set(relayURL, forKey: "stream.relayURL") }
  }

  var selectedResolution: StreamingResolution {
    didSet { UserDefaults.standard.set(selectedResolution.rawValue, forKey: "stream.resolution") }
  }

  var selectedFrameRate: UInt {
    didSet { UserDefaults.standard.set(Int(selectedFrameRate), forKey: "stream.frameRate") }
  }

  var videoCodecRaw: UInt8 {
    didSet { UserDefaults.standard.set(Int(videoCodecRaw), forKey: "stream.videoCodec") }
  }

  var audioInputModeRaw: String {
    didSet { UserDefaults.standard.set(audioInputModeRaw, forKey: "stream.audioInputMode") }
  }

  var isTTSPlaybackEnabled: Bool {
    didSet { UserDefaults.standard.set(isTTSPlaybackEnabled, forKey: "stream.ttsPlayback") }
  }

  // MARK: - Derived

  /// Expected frame dimensions for the selected resolution.
  var selectedResolutionSize: VideoFrameSize {
    selectedResolution.videoFrameSize
  }

  var videoCodec: RelayVideoCodec {
    get { RelayVideoCodec(rawValue: videoCodecRaw) ?? .jpeg }
    set { videoCodecRaw = newValue.rawValue }
  }

  var audioInputMode: AudioInputMode {
    get { AudioInputMode(rawValue: audioInputModeRaw) ?? .all }
    set { audioInputModeRaw = newValue.rawValue }
  }

  // MARK: - Init (loads from UserDefaults)

  init() {
    let defaults = UserDefaults.standard
    self.relayURL = defaults.string(forKey: "stream.relayURL") ?? "wss://relay.simulationapi.com/publish"
    self.selectedResolution = StreamingResolution(rawValue: defaults.integer(forKey: "stream.resolution")) ?? .high
    self.selectedFrameRate = UInt(defaults.integer(forKey: "stream.frameRate")).clamped(to: 1...60)
    self.videoCodecRaw = UInt8(defaults.integer(forKey: "stream.videoCodec")).clamped(to: 0...2)
    self.audioInputModeRaw = defaults.string(forKey: "stream.audioInputMode") ?? AudioInputMode.all.rawValue
    self.isTTSPlaybackEnabled = defaults.bool(forKey: "stream.ttsPlayback")
  }
}

// MARK: - StreamingResolution rawValue support

extension StreamingResolution: @retroactive RawRepresentable {
  public var rawValue: Int {
    switch self {
    case .low: return 0
    case .medium: return 1
    case .high: return 2
    @unknown default: return 2
    }
  }

  public init?(rawValue: Int) {
    switch rawValue {
    case 0: self = .low
    case 1: self = .medium
    case 2: self = .high
    default: return nil
    }
  }
}

// MARK: - Numeric clamping

private extension UInt {
  func clamped(to range: ClosedRange<UInt>) -> UInt {
    Swift.min(Swift.max(self, range.lowerBound), range.upperBound)
  }
}

private extension UInt8 {
  func clamped(to range: ClosedRange<UInt8>) -> UInt8 {
    Swift.min(Swift.max(self, range.lowerBound), range.upperBound)
  }
}

private extension Int {
  func clamped(to range: ClosedRange<Int>) -> Int {
    Swift.min(Swift.max(self, range.lowerBound), range.upperBound)
  }
}
