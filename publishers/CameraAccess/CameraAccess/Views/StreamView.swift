/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the
 * LICENSE file in the root directory of this source tree.
 */

//
// StreamView.swift
//
// Main UI for video streaming from Meta wearable devices using the DAT SDK.
// This view demonstrates the complete streaming API: video streaming with real-time display, photo capture,
// and error handling.
//

import MWDATCore
import SwiftUI

struct StreamView: View {
  @Environment(StreamCoordinator.self) private var coordinator
  @EnvironmentObject private var telemetryService: TelemetryService
  @State private var showErrorLog = false
  @State private var showSettings = false
  @Environment(\.scenePhase) private var scenePhase
  #if DEBUG
  @State private var showNodePreview = false
  #endif

  var body: some View {
    ZStack {
      // Black background for letterboxing/pillarboxing
      Color.black
        .edgesIgnoringSafeArea(.all)

      // Video backdrop
      if let videoFrame = coordinator.currentVideoFrame, coordinator.hasReceivedFirstFrame {
        GeometryReader { geometry in
          Image(uiImage: videoFrame)
            .resizable()
            .aspectRatio(contentMode: .fill)
            .frame(width: geometry.size.width, height: geometry.size.height)
            .clipped()
          // Bounding box overlay from AI annotations
          BoundingBoxOverlayView(
            boxes: coordinator.pipeline.boundingBoxes,
            showOverlay: coordinator.pipeline.showBboxOverlay,
            visionDetections: coordinator.pipeline.visionDetections,
            sceneLabel: coordinator.pipeline.visionSceneLabel,
            transcription: coordinator.pipeline.overlayTranscription,
            trackedItems: coordinator.pipeline.trackingTracks,
            yoloDetections: coordinator.pipeline.yoloDetections,
            zones: coordinator.pipeline.activeZones,
            zoneAnalytics: coordinator.pipeline.trackingSnapshot,
            heatMap: coordinator.pipeline.heatMap
          )
          .frame(width: geometry.size.width, height: geometry.size.height)
        }
        .edgesIgnoringSafeArea(.all)
      } else {
        VStack(spacing: 16) {
          ProgressView()
            .scaleEffect(1.5)
            .foregroundColor(.white)

          if coordinator.isRetrying {
            Text("RETRYING \(coordinator.retryCount)/3...")
              .font(.system(size: 12, weight: .bold, design: .monospaced))
              .foregroundColor(.yellow)
          } else {
            Text(String(describing: coordinator.streamingStatus).uppercased())
              .font(.system(size: 12, weight: .medium, design: .monospaced))
              .foregroundColor(.white.opacity(0.6))
          }

          if let lastError = coordinator.errors.errorLog.last {
            Text(lastError)
              .font(.system(size: 10, design: .monospaced))
              .foregroundColor(.red.opacity(0.8))
              .multilineTextAlignment(.center)
              .padding(.horizontal, 24)
          }
        }
      }

      // Settings button at top-right
      VStack {
        HStack {
          // YOLO model state badge — show when stage is configured
          if coordinator.pipeline.isYoloConfigured {
            YOLOStateBadge(state: coordinator.pipeline.yoloModelState)
              .padding(.leading, 8)
              .padding(.top, 4)
          }
          Spacer()
          #if DEBUG
          Button {
            showNodePreview.toggle()
          } label: {
            Image(systemName: showNodePreview ? "square.grid.2x2.fill" : "square.grid.2x2")
              .font(.system(size: 14))
              .foregroundColor(showNodePreview ? .cyan : .white)
              .padding(8)
              .background(.ultraThinMaterial)
              .clipShape(Circle())
          }
          .padding(.trailing, 4)
          .padding(.top, 4)
          #endif
          Button {
            showSettings = true
          } label: {
            Image(systemName: "gearshape")
              .font(.system(size: 16))
              .foregroundColor(.white)
              .padding(10)
              .background(.ultraThinMaterial)
              .clipShape(Circle())
          }
          .padding(.trailing, 8)
          .padding(.top, 4)
        }
        Spacer()
      }

      // Inline error banner at top
      if !coordinator.errors.errorMessage.isEmpty {
        VStack {
          ErrorBanner(
            message: coordinator.errors.errorMessage,
            errorCount: coordinator.errors.errorLog.count,
            onTap: { showErrorLog.toggle() }
          )
          Spacer()
        }
        .padding(.top, 8)
        .padding(.horizontal, 8)
      }

      // Bottom controls layer
      VStack {
        Spacer()
        ControlsView()
      }
      .padding(.all, 24)

      // Node preview overlay (debug)
      #if DEBUG
      if showNodePreview {
        VStack {
          Spacer()
          NodePreviewView(store: coordinator.previewStore)
            .padding(.horizontal, 8)
            .padding(.bottom, 80)
            .transition(.move(edge: .bottom).combined(with: .opacity))
        }
        .animation(.easeInOut(duration: 0.25), value: showNodePreview)
      }
      #endif
    }
    .onDisappear {
      guard scenePhase != .background else { return }
      Task {
        if coordinator.streamingStatus != .stopped {
          await coordinator.stopSession()
        }
      }
    }
    // Settings sheet
    .sheet(isPresented: $showSettings) {
      SettingsView(mode: .liveStream)
    }
    // Error log sheet
    .sheet(isPresented: $showErrorLog) {
      ErrorLogSheet(errorLog: coordinator.errors.errorLog)
    }
    // Show captured photos from DAT SDK in a preview sheet
    .sheet(isPresented: Binding(
      get: { coordinator.recording.showPhotoPreview },
      set: { if !$0 { coordinator.recording.dismissPhotoPreview() } }
    )) {
      if let photo = coordinator.recording.capturedPhoto {
        PhotoPreviewView(
          photo: photo,
          onDismiss: {
            coordinator.recording.dismissPhotoPreview()
          }
        )
      }
    }
  }
}

// MARK: - Error Banner

struct ErrorBanner: View {
  let message: String
  let errorCount: Int
  let onTap: () -> Void

  var body: some View {
    Button(action: onTap) {
      HStack(spacing: 8) {
        Image(systemName: "exclamationmark.triangle.fill")
          .foregroundColor(.yellow)

        Text(message)
          .font(.system(size: 12, weight: .medium, design: .monospaced))
          .foregroundColor(.white)
          .lineLimit(2)
          .multilineTextAlignment(.leading)

        Spacer()

        if errorCount > 1 {
          Text("\(errorCount)")
            .font(.system(size: 10, weight: .bold, design: .monospaced))
            .foregroundColor(.white)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Color.red.opacity(0.8))
            .cornerRadius(8)
        }

        Image(systemName: "list.bullet")
          .foregroundColor(.white.opacity(0.6))
          .font(.system(size: 11))
      }
      .padding(.horizontal, 10)
      .padding(.vertical, 8)
      .background(Color.black.opacity(0.85))
      .cornerRadius(8)
      .overlay(
        RoundedRectangle(cornerRadius: 8)
          .stroke(Color.red.opacity(0.5), lineWidth: 1)
      )
    }
  }
}

// MARK: - Error Log Sheet

struct ErrorLogSheet: View {
  let errorLog: [String]
  @Environment(\.dismiss) var dismiss

  var body: some View {
    NavigationView {
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 6) {
          if errorLog.isEmpty {
            Text("No errors logged")
              .foregroundColor(.secondary)
              .padding()
          } else {
            ForEach(errorLog.reversed(), id: \.self) { entry in
              Text(entry)
                .font(.system(size: 11, design: .monospaced))
                .foregroundColor(.red)
                .padding(.horizontal, 12)
                .padding(.vertical, 4)
            }
          }
        }
      }
      .navigationTitle("Error Log")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .navigationBarTrailing) {
          Button("Done") { dismiss() }
        }
      }
    }
  }
}

// Extracted controls for clarity — mic/audio picker moved to live settings
struct ControlsView: View {
  @Environment(StreamCoordinator.self) private var coordinator
  @State private var showAppPicker = false
  var body: some View {
    HStack(spacing: 8) {
      // Stop button
      CircleButton(
        icon: "xmark",
        text: nil
      ) {
        Task {
          await coordinator.stopSession()
        }
      }
      .shadow(color: .red.opacity(0.4), radius: 6)

      // Record button
      CircleButton(
        icon: coordinator.recording.isRecording ? "stop.circle.fill" : "record.circle",
        text: nil
      ) {
        Task {
          if coordinator.recording.isRecording {
            await coordinator.recording.stopRecording()
          } else {
            try? await coordinator.recording.startRecording()
          }
        }
      }
      .foregroundColor(coordinator.recording.isRecording ? .red : .white)
      .shadow(color: coordinator.recording.isRecording ? .red.opacity(0.5) : .clear, radius: coordinator.recording.isRecording ? 8 : 0)
      .animation(.easeInOut(duration: 0.2), value: coordinator.recording.isRecording)
      .accessibilityIdentifier("record_button")

      // Relay button (starts/stops both video + audio relay)
      CircleButton(
        icon: coordinator.relayMode == .active ? "antenna.radiowaves" : "dot.radiowaves.up.forward",
        text: nil
      ) {
        Task {
          if coordinator.relayMode == .active {
            await coordinator.stopRelay()
          } else {
            await coordinator.startRelay()
          }
        }
      }
      .foregroundColor(coordinator.relayMode == .active ? .green : coordinator.relayMode == .standby ? .orange : .white)
      .shadow(color: coordinator.relayMode == .active ? .green.opacity(0.5) : .clear, radius: coordinator.relayMode == .active ? 8 : 0)
      .animation(.easeInOut(duration: 0.2), value: coordinator.relayMode == .active)
      .accessibilityIdentifier("relay_button")

      // Photo button
      CircleButton(icon: "camera.fill", text: nil) {
        coordinator.capturePhoto()
      }
      .accessibilityIdentifier("capture_photo_button")

      // AI app toggle — only when relaying
      if coordinator.relayMode == .active {
        CircleButton(
          icon: coordinator.activeAppId != nil ? "brain.head.profile.fill" : "brain.head.profile",
          text: nil
        ) {
          if coordinator.activeAppId != nil {
            coordinator.deactivateApp()
          } else {
            showAppPicker = true
          }
        }
        .foregroundColor(coordinator.activeAppId != nil ? .cyan : .white)
        .shadow(color: coordinator.activeAppId != nil ? .cyan.opacity(0.5) : .clear, radius: coordinator.activeAppId != nil ? 8 : 0)
        .animation(.easeInOut(duration: 0.2), value: coordinator.activeAppId)
        .accessibilityIdentifier("ai_app_toggle")
      }
    }
    .sheet(isPresented: $showAppPicker) {
      AppPickerSheet()
    }
  }
}

// MARK: - YOLO Model State Badge

struct YOLOStateBadge: View {
  let state: YOLOModelState

  var body: some View {
    HStack(spacing: 6) {
      switch state {
      case .downloading(_, let progress):
        ProgressView(value: progress)
          .progressViewStyle(CircularProgressViewStyle(tint: .cyan))
          .frame(width: 14, height: 14)
        Text(state.label)
          .font(.system(size: 10, weight: .medium, design: .monospaced))
          .foregroundColor(.cyan)
      case .compiling:
        ProgressView()
          .progressViewStyle(CircularProgressViewStyle(tint: .yellow))
          .frame(width: 14, height: 14)
          .scaleEffect(0.7)
        Text(state.label)
          .font(.system(size: 10, weight: .medium, design: .monospaced))
          .foregroundColor(.yellow)
      case .ready(let modelId, let resources):
        Image(systemName: "checkmark.circle.fill")
          .font(.system(size: 11))
          .foregroundColor(.green)
        Text("\(modelId) \(String(format: "%.1f", resources.diskSizeMB))MB")
          .font(.system(size: 10, weight: .medium, design: .monospaced))
          .foregroundColor(.green)
      case .idle:
        Image(systemName: "brain.head.profile")
          .font(.system(size: 11))
          .foregroundColor(.white.opacity(0.6))
        Text("YOLO idle")
          .font(.system(size: 10, weight: .medium, design: .monospaced))
          .foregroundColor(.white.opacity(0.6))
      case .failed(_, let error):
        Image(systemName: "exclamationmark.triangle.fill")
          .font(.system(size: 11))
          .foregroundColor(.red)
        Text(error)
          .font(.system(size: 10, weight: .medium, design: .monospaced))
          .foregroundColor(.red)
          .lineLimit(1)
      }
    }
    .padding(.horizontal, 8)
    .padding(.vertical, 5)
    .background(.ultraThinMaterial)
    .clipShape(Capsule())
  }
}
