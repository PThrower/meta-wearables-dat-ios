/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the
 * LICENSE file in the root directory of this source tree.
 */

//
// SettingsView.swift
//
// Layered settings: BaseSettingsContent (shared primitives) composed into
// context-specific settings for pre-stream and live-stream experiences.
//

import MWDATCamera
import MWDATCore
import SwiftUI

// MARK: - Settings Mode

enum SettingsMode {
  case preStream
  case liveStream
}

// MARK: - Settings Container

struct SettingsView: View {
  let mode: SettingsMode
  @Environment(StreamCoordinator.self) private var coordinator
  @EnvironmentObject private var wearablesVM: WearablesViewModel
  @EnvironmentObject private var telemetryService: TelemetryService
  @Environment(\.dismiss) var dismiss

  var body: some View {
    @Bindable var coordinator = coordinator
    NavigationView {
      ScrollView {
        VStack(spacing: 20) {
          // Base primitives (shared across all modes)
          relaySection
          deviceInfoSection

          // Mode-specific sections
          switch mode {
          case .preStream:
            streamConfigSection
            ttsSection
          case .liveStream:
            codecSection
            audioInputSection
          }

          // More base primitives
          telemetrySection
          errorLogSection

          #if DEBUG
          debugSection
          #endif

          // Mode-specific footer actions
          switch mode {
          case .preStream:
            disconnectSection
          case .liveStream:
            stopStreamSection
          }
        }
        .padding(.horizontal, 20)
        .padding(.bottom, 40)
      }
      .background(Color(UIColor.systemGroupedBackground))
      .navigationTitle(mode == .liveStream ? "Live Settings" : "Settings")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .navigationBarTrailing) {
          Button("Done") { dismiss() }
            .foregroundColor(.blue)
        }
      }
    }
  }

  // MARK: - Base: Relay

  private var relaySection: some View {
    VStack(alignment: .leading, spacing: 10) {
      sectionHeader("RELAY")

      VStack(alignment: .leading, spacing: 4) {
        Text("Server URL")
          .font(.system(size: 11))
          .foregroundColor(.secondary)
        TextField("wss://relay.example.com/publish", text: Binding(
          get: { coordinator.config.relayURL },
          set: { coordinator.config.relayURL = $0 }
        ))
          .font(.system(size: 13, design: .monospaced))
          .foregroundColor(.primary)
          .padding(10)
          .background(Color(UIColor.secondarySystemGroupedBackground))
          .cornerRadius(8)
          .autocapitalization(.none)
          .disableAutocorrection(true)
          .keyboardType(.URL)
          .disabled(coordinator.relayMode == .active)
      }
    }
  }

  // MARK: - Base: Device Info

  private var deviceInfoSection: some View {
    VStack(alignment: .leading, spacing: 8) {
      sectionHeader("DEVICE")

      if wearablesVM.devices.isEmpty {
        Text("No devices connected")
          .font(.system(size: 13))
          .foregroundColor(.secondary)
      } else {
        ForEach(wearablesVM.devices, id: \.self) { deviceId in
          let info = wearablesVM.deviceInfos[deviceId]
          HStack(spacing: 10) {
            Image(systemName: deviceIcon(for: info?.type))
              .foregroundColor(.primary)
              .frame(width: 20)

            VStack(alignment: .leading, spacing: 2) {
              Text(info?.name ?? deviceId)
                .font(.system(size: 14, weight: .medium))
                .foregroundColor(.primary)
              HStack(spacing: 6) {
                Text(info?.type.displayName ?? "Unknown")
                  .font(.system(size: 11))
                  .foregroundColor(.secondary)
                linkStateBadge(info?.linkState)
              }
            }

            Spacer()

            if coordinator.selectedDeviceId == deviceId || (coordinator.selectedDeviceId == nil && deviceId == wearablesVM.devices.first) {
              Image(systemName: "checkmark.circle.fill")
                .foregroundColor(.blue)
                .font(.system(size: 14))
            }
          }
          .padding(.horizontal, 12)
          .padding(.vertical, 8)
          .background(Color(UIColor.secondarySystemGroupedBackground))
          .cornerRadius(8)
        }
      }
    }
  }

  // MARK: - Base: Telemetry

  private var telemetrySection: some View {
    VStack(alignment: .leading, spacing: 8) {
      sectionHeader("TELEMETRY")

      HStack {
        telemetryRow("State", telemetryService.sessionStateText)
        telemetryRow("Uptime", telemetryService.uptimeText)
        telemetryRow("TTFF", telemetryService.ttffText)
      }

      HStack {
        telemetryRow("FPS", telemetryService.fpsText)
        telemetryRow("Jitter", telemetryService.jitterText)
        telemetryRow("Frames", telemetryService.frameCountText)
      }

      HStack {
        telemetryRow("Drops", telemetryService.droppedFramesText)
        telemetryRow("Link", telemetryService.connectionText)
        if !telemetryService.deviceInfoText.isEmpty {
          telemetryRow("Device", telemetryService.deviceInfoText)
        }
      }

      if telemetryService.totalErrors > 0 {
        HStack {
          telemetryRow("Errors", telemetryService.errorCountText)
          if telemetryService.photoLatencyText != "--" {
            telemetryRow("Photo", telemetryService.photoLatencyText)
          }
        }
      }
    }
  }

  private func telemetryRow(_ label: String, _ value: String) -> some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(label)
        .font(.system(size: 9, weight: .bold, design: .monospaced))
        .foregroundColor(.secondary)
      Text(value)
        .font(.system(size: 12, design: .monospaced))
        .foregroundColor(.primary)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  // MARK: - Base: Error Log

  private var errorLogSection: some View {
    VStack(alignment: .leading, spacing: 8) {
      sectionHeader("ERRORS (\(coordinator.errors.errorLog.count))")

      if coordinator.errors.errorLog.isEmpty {
        Text("No errors logged")
          .font(.system(size: 13))
          .foregroundColor(.secondary)
      } else {
        ForEach(coordinator.errors.errorLog.suffix(5).reversed(), id: \.self) { entry in
          Text(entry)
            .font(.system(size: 10, design: .monospaced))
            .foregroundColor(.red)
            .lineLimit(2)
            .padding(8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.red.opacity(0.06))
            .cornerRadius(6)
        }
      }
    }
  }

  // MARK: - Base: Debug (DEBUG only)

  #if DEBUG
  private var debugSection: some View {
    VStack(alignment: .leading, spacing: 8) {
      sectionHeader("DEBUG")

      row("Registration", String(describing: wearablesVM.registrationState))
      row("Active Device", coordinator.hasActiveDevice ? "YES" : "NO")
      row("Selected", coordinator.selectedDeviceId ?? "auto")
      if coordinator.isRetrying {
        row("Retry", "\(coordinator.retryCount)/3")
      }
      row("Relay", coordinator.relayMode == .active ? "ACTIVE" : coordinator.relayMode == .standby ? "STANDBY" : "OFF")
      row("Recording", coordinator.recording.isRecording ? "YES" : "NO")
      row("Tap Connected", coordinator.isTapConnected ? "YES" : "NO")
    }
  }
  #endif

  // MARK: - Pre-Stream: Stream Config

  private var streamConfigSection: some View {
    VStack(alignment: .leading, spacing: 10) {
      sectionHeader("STREAM SETTINGS")

      HStack(spacing: 6) {
        Text("Resolution")
          .font(.system(size: 13))
          .foregroundColor(.secondary)
          .frame(width: 80, alignment: .leading)

        ForEach(StreamingResolution.allCases, id: \.self) { res in
          Button {
            coordinator.config.selectedResolution = res
          } label: {
            Text(resLabel(res))
              .font(.system(size: 12, weight: coordinator.config.selectedResolution == res ? .bold : .regular, design: .monospaced))
              .foregroundColor(coordinator.config.selectedResolution == res ? .white : .secondary)
              .padding(.horizontal, 10)
              .padding(.vertical, 6)
              .background(coordinator.config.selectedResolution == res ? Color.blue : Color(UIColor.secondarySystemGroupedBackground))
              .cornerRadius(6)
          }
        }
      }

      HStack(spacing: 6) {
        Text("Frame Rate")
          .font(.system(size: 13))
          .foregroundColor(.secondary)
          .frame(width: 80, alignment: .leading)

        ForEach([UInt(24), 30, 60], id: \.self) { fps in
          Button {
            coordinator.config.selectedFrameRate = fps
          } label: {
            Text("\(fps) fps")
              .font(.system(size: 12, weight: coordinator.config.selectedFrameRate == fps ? .bold : .regular, design: .monospaced))
              .foregroundColor(coordinator.config.selectedFrameRate == fps ? .white : .secondary)
              .padding(.horizontal, 10)
              .padding(.vertical, 6)
              .background(coordinator.config.selectedFrameRate == fps ? Color.blue : Color(UIColor.secondarySystemGroupedBackground))
              .cornerRadius(6)
          }
        }
      }

      Text("\(resLabel(coordinator.config.selectedResolution)) \u{00B7} \(coordinator.config.selectedFrameRate) fps \u{00B7} RAW codec")
        .font(.system(size: 10, design: .monospaced))
        .foregroundColor(.secondary)
    }
  }

  // MARK: - Pre-Stream: TTS

  private var ttsSection: some View {
    VStack(alignment: .leading, spacing: 10) {
      sectionHeader("AUDIO")

      HStack {
        VStack(alignment: .leading, spacing: 2) {
          Text("TTS Playback")
            .font(.system(size: 14, weight: .medium))
            .foregroundColor(.primary)
          Text("Play hello world through glasses speaker")
            .font(.system(size: 11))
            .foregroundColor(.secondary)
        }
        Spacer()
        Toggle("", isOn: Binding(
          get: { coordinator.config.isTTSPlaybackEnabled },
          set: { coordinator.config.isTTSPlaybackEnabled = $0 }
        ))
          .labelsHidden()
          .tint(.blue)
          .onChange(of: coordinator.config.isTTSPlaybackEnabled) { enabled in
            Task {
              if enabled { await coordinator.startTTSPlayback() }
              else { await coordinator.stopTTSPlayback() }
            }
          }
      }
    }
  }

  // MARK: - Live: Codec

  private var codecSection: some View {
    VStack(alignment: .leading, spacing: 10) {
      sectionHeader("VIDEO CODEC")

      VStack(alignment: .leading, spacing: 2) {
        Text("Relay Encoding")
          .font(.system(size: 13, weight: .medium))
          .foregroundColor(.primary)
        Text("JPEG: universal, larger frames. H.264: 5-10x smaller, needs WebCodecs viewer.")
          .font(.system(size: 11))
          .foregroundColor(.secondary)
      }

      ForEach(RelayVideoCodec.allCases, id: \.self) { codec in
        Button {
          Task { await coordinator.switchCodec(codec) }
        } label: {
          HStack(spacing: 10) {
            Image(systemName: codec == .h264 ? "bolt.horizontal.icloud.fill" : "photo")
              .font(.system(size: 14))
              .foregroundColor(coordinator.config.videoCodec == codec ? .blue : .secondary)
              .frame(width: 24)

            VStack(alignment: .leading, spacing: 2) {
              Text(codec.displayName)
                .font(.system(size: 14, weight: coordinator.config.videoCodec == codec ? .medium : .regular))
                .foregroundColor(coordinator.config.videoCodec == codec ? .primary : .secondary)
            }

            Spacer()

            if coordinator.config.videoCodec == codec {
              Image(systemName: "checkmark")
                .font(.system(size: 12, weight: .bold))
                .foregroundColor(.blue)
            }
          }
          .padding(.horizontal, 12)
          .padding(.vertical, 10)
          .background(coordinator.config.videoCodec == codec ? Color.blue.opacity(0.08) : Color(UIColor.secondarySystemGroupedBackground))
          .cornerRadius(8)
        }
      }
    }
  }

  // MARK: - Live: Audio Input

  private var audioInputSection: some View {
    VStack(alignment: .leading, spacing: 10) {
      sectionHeader("MICROPHONE")

      VStack(alignment: .leading, spacing: 2) {
        Text("Audio Input")
          .font(.system(size: 13, weight: .medium))
          .foregroundColor(.primary)
        Text("Source for relay audio stream")
          .font(.system(size: 11))
          .foregroundColor(.secondary)
      }

      ForEach(AudioInputMode.allCases) { mode in
        Button {
          coordinator.config.audioInputMode = mode
        } label: {
          HStack(spacing: 10) {
            Image(systemName: mode.systemImage)
              .font(.system(size: 14))
              .foregroundColor(coordinator.config.audioInputMode == mode ? .blue : .secondary)
              .frame(width: 24)

            Text(mode.rawValue)
              .font(.system(size: 14, weight: coordinator.config.audioInputMode == mode ? .medium : .regular))
              .foregroundColor(coordinator.config.audioInputMode == mode ? .primary : .secondary)

            Spacer()

            if coordinator.config.audioInputMode == mode {
              Image(systemName: "checkmark")
                .font(.system(size: 12, weight: .bold))
                .foregroundColor(.blue)
            }
          }
          .padding(.horizontal, 12)
          .padding(.vertical, 10)
          .background(coordinator.config.audioInputMode == mode ? Color.blue.opacity(0.08) : Color(UIColor.secondarySystemGroupedBackground))
          .cornerRadius(8)
        }
      }
    }
  }

  // MARK: - Pre-Stream: Disconnect

  private var disconnectSection: some View {
    VStack(spacing: 12) {
      Divider()

      Button(role: .destructive) {
        wearablesVM.disconnectGlasses()
        dismiss()
      } label: {
        HStack {
          Image(systemName: "link.badge.minus")
          Text("Disconnect Glasses")
        }
        .font(.system(size: 14, weight: .medium))
        .foregroundColor(.red)
        .frame(maxWidth: .infinity)
        .padding(.vertical, 12)
        .background(Color.red.opacity(0.08))
        .cornerRadius(10)
      }
      .disabled(wearablesVM.registrationState != .registered)
    }
  }

  // MARK: - Live: Stop Stream

  private var stopStreamSection: some View {
    VStack(spacing: 12) {
      Divider()

      Button(role: .destructive) {
        Task {
          await coordinator.stopSession()
          dismiss()
        }
      } label: {
        HStack {
          Image(systemName: "xmark.circle")
          Text("Stop Streaming")
        }
        .font(.system(size: 14, weight: .medium))
        .foregroundColor(.red)
        .frame(maxWidth: .infinity)
        .padding(.vertical, 12)
        .background(Color.red.opacity(0.08))
        .cornerRadius(10)
      }
    }
  }

  // MARK: - Helpers

  private func sectionHeader(_ title: String) -> some View {
    Text(title)
      .font(.system(size: 11, weight: .bold, design: .monospaced))
      .foregroundColor(.secondary)
  }

  private func row(_ label: String, _ value: String) -> some View {
    HStack {
      Text(label)
        .font(.system(size: 12))
        .foregroundColor(.secondary)
      Spacer()
      Text(value)
        .font(.system(size: 12, design: .monospaced))
        .foregroundColor(.primary)
    }
  }

  private func resLabel(_ res: StreamingResolution) -> String {
    switch res {
    case .high: return "HIGH"
    case .medium: return "MED"
    case .low: return "LOW"
    }
  }

  private func deviceIcon(for type: DeviceType?) -> String {
    switch type {
    case .rayBanMeta, .metaRayBanDisplay: return "sunglasses"
    case .oakleyMetaHSTN, .oakleyMetaVanguard: return "goggles"
    default: return "questionmark.glasses"
    }
  }

  @ViewBuilder
  private func linkStateBadge(_ state: LinkState?) -> some View {
    let (color, label) = linkStateColorLabel(state)
    Text(label)
      .font(.system(size: 9, weight: .semibold, design: .monospaced))
      .foregroundColor(color)
      .padding(.horizontal, 4)
      .padding(.vertical, 1)
      .background(color.opacity(0.2))
      .cornerRadius(3)
  }

  private func linkStateColorLabel(_ state: LinkState?) -> (Color, String) {
    switch state {
    case .connected: return (.green, "CONNECTED")
    case .connecting: return (.orange, "CONNECTING")
    case .disconnected: return (.red, "DISCONNECTED")
    case nil: return (.gray, "UNKNOWN")
    }
  }
}
