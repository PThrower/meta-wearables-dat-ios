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
  @ObservedObject var viewModel: StreamSessionViewModel
  @ObservedObject var wearablesVM: WearablesViewModel
  @ObservedObject var telemetryService: TelemetryService
  @State private var showErrorLog = false
  @State private var showSettings = false
  @Environment(\.scenePhase) private var scenePhase

  var body: some View {
    ZStack {
      // Black background for letterboxing/pillarboxing
      Color.black
        .edgesIgnoringSafeArea(.all)

      // Video backdrop
      if let videoFrame = viewModel.currentVideoFrame, viewModel.hasReceivedFirstFrame {
        GeometryReader { geometry in
          Image(uiImage: videoFrame)
            .resizable()
            .aspectRatio(contentMode: .fill)
            .frame(width: geometry.size.width, height: geometry.size.height)
            .clipped()
        }
        .edgesIgnoringSafeArea(.all)
      } else {
        VStack(spacing: 16) {
          ProgressView()
            .scaleEffect(1.5)
            .foregroundColor(.white)

          if viewModel.isRetrying {
            Text("RETRYING \(viewModel.retryCount)/3...")
              .font(.system(size: 12, weight: .bold, design: .monospaced))
              .foregroundColor(.yellow)
          } else {
            Text(String(describing: viewModel.streamingStatus).uppercased())
              .font(.system(size: 12, weight: .medium, design: .monospaced))
              .foregroundColor(.white.opacity(0.6))
          }

          if let lastError = viewModel.errorLog.last {
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
          Spacer()
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
      if !viewModel.errorMessage.isEmpty {
        VStack {
          ErrorBanner(
            message: viewModel.errorMessage,
            errorCount: viewModel.errorLog.count,
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
        ControlsView(viewModel: viewModel)
      }
      .padding(.all, 24)
    }
    .onDisappear {
      guard scenePhase != .background else { return }
      Task {
        if viewModel.streamingStatus != .stopped {
          await viewModel.stopSession()
        }
      }
    }
    // Settings sheet
    .sheet(isPresented: $showSettings) {
      SettingsView(mode: .liveStream, viewModel: viewModel, wearablesVM: wearablesVM, telemetryService: telemetryService)
    }
    // Error log sheet
    .sheet(isPresented: $showErrorLog) {
      ErrorLogSheet(errorLog: viewModel.errorLog)
    }
    // Show captured photos from DAT SDK in a preview sheet
    .sheet(isPresented: $viewModel.showPhotoPreview) {
      if let photo = viewModel.capturedPhoto {
        PhotoPreviewView(
          photo: photo,
          onDismiss: {
            viewModel.dismissPhotoPreview()
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
  @ObservedObject var viewModel: StreamSessionViewModel
  var body: some View {
    HStack(spacing: 8) {
      // Stop button
      CircleButton(
        icon: "xmark",
        text: nil
      ) {
        Task {
          await viewModel.stopSession()
        }
      }
      .shadow(color: .red.opacity(0.4), radius: 6)

      // Record button
      CircleButton(
        icon: viewModel.isRecording ? "stop.circle.fill" : "record.circle",
        text: nil
      ) {
        Task {
          if viewModel.isRecording {
            await viewModel.stopRecording()
          } else {
            await viewModel.startRecording()
          }
        }
      }
      .foregroundColor(viewModel.isRecording ? .red : .white)
      .shadow(color: viewModel.isRecording ? .red.opacity(0.5) : .clear, radius: viewModel.isRecording ? 8 : 0)
      .animation(.easeInOut(duration: 0.2), value: viewModel.isRecording)
      .accessibilityIdentifier("record_button")

      // Relay button (starts/stops both video + audio relay)
      CircleButton(
        icon: viewModel.isRelaying ? "antenna.radiowaves" : "dot.radiowaves.up.forward",
        text: nil
      ) {
        Task {
          if viewModel.isRelaying {
            await viewModel.stopRelay()
          } else {
            await viewModel.startRelay()
          }
        }
      }
      .foregroundColor(viewModel.isRelaying ? .green : .white)
      .shadow(color: viewModel.isRelaying ? .green.opacity(0.5) : .clear, radius: viewModel.isRelaying ? 8 : 0)
      .animation(.easeInOut(duration: 0.2), value: viewModel.isRelaying)
      .accessibilityIdentifier("relay_button")

      // Photo button
      CircleButton(icon: "camera.fill", text: nil) {
        viewModel.capturePhoto()
      }
      .accessibilityIdentifier("capture_photo_button")

      // AI app toggle — only when relaying
      if viewModel.isRelaying {
        CircleButton(
          icon: viewModel.activeAppId != nil ? "brain.head.profile.fill" : "brain.head.profile",
          text: nil
        ) {
          if viewModel.activeAppId != nil {
            viewModel.deactivateApp()
          } else {
            viewModel.activateApp("spanish-co-pilot")
          }
        }
        .foregroundColor(viewModel.activeAppId != nil ? .cyan : .white)
        .shadow(color: viewModel.activeAppId != nil ? .cyan.opacity(0.5) : .clear, radius: viewModel.activeAppId != nil ? 8 : 0)
        .animation(.easeInOut(duration: 0.2), value: viewModel.activeAppId)
        .accessibilityIdentifier("ai_app_toggle")
      }
    }
  }
}
