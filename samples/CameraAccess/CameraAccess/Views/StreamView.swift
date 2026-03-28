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
// error handling, and TRIBE v2 brain prediction visualization.
//

import MWDATCore
import SwiftUI

struct StreamView: View {
  @ObservedObject var viewModel: StreamSessionViewModel
  @ObservedObject var wearablesVM: WearablesViewModel
  @State private var showTelemetryDebug = false

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
        ProgressView()
          .scaleEffect(1.5)
          .foregroundColor(.white)
      }

      // TRIBE v2 Brain Activity Overlay
      if viewModel.showBrainOverlay && viewModel.brainService.isEnabled {
        VStack {
          BrainActivityOverlay(
            prediction: viewModel.brainService.currentPrediction,
            isMockMode: viewModel.brainService.isMockMode,
            connectionStatus: viewModel.brainService.connectionStatus
          )
          .padding()
          .padding(.top, 40)

          Spacer()
        }
      }

      // Bottom controls layer

      VStack {
        Spacer()
        ControlsView(viewModel: viewModel, showTelemetryDebug: $showTelemetryDebug)
      }
      .padding(.all, 24)
    }
    .onDisappear {
      Task {
        if viewModel.streamingStatus != .stopped {
          await viewModel.stopSession()
        }
      }
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
    // Telemetry debug sheet
    .sheet(isPresented: $showTelemetryDebug) {
      TelemetryDebugView(brainService: viewModel.brainService)
    }
  }
}

// Extracted controls for clarity
struct ControlsView: View {
  @ObservedObject var viewModel: StreamSessionViewModel
  @Binding var showTelemetryDebug: Bool

  var body: some View {
    VStack(spacing: 12) {
      // Brain service controls row
      HStack(spacing: 12) {
        // Toggle brain overlay
        Button(action: {
          viewModel.showBrainOverlay.toggle()
        }) {
          Label(
            viewModel.showBrainOverlay ? "Hide Brain" : "Show Brain",
            systemImage: viewModel.showBrainOverlay ? "brain" : "brain.slash"
          )
          .font(.caption)
          .foregroundColor(.white)
        }
        .buttonStyle(.bordered)
        .tint(.blue)

        // Status indicator
        if viewModel.brainService.isEnabled {
          HStack(spacing: 4) {
            Circle()
              .fill(viewModel.brainService.isMockMode ? Color.orange : Color.green)
              .frame(width: 8, height: 8)
            Text(viewModel.brainService.isMockMode ? "Mock" : "Live")
              .font(.caption2)
              .foregroundColor(.gray)
          }
        }

        Spacer()

        // Telemetry debug button
        Button(action: {
          showTelemetryDebug = true
        }) {
          Image(systemName: "chart.bar.fill")
            .foregroundColor(.white)
        }
        .buttonStyle(.bordered)
        .tint(.purple)
      }

      // Main controls row
      HStack(spacing: 8) {
        CustomButton(
          title: "Stop streaming",
          style: .destructive,
          isDisabled: false
        ) {
          Task {
            await viewModel.stopSession()
          }
        }

        // Photo button
        CircleButton(icon: "camera.fill", text: nil) {
          viewModel.capturePhoto()
        }
        .accessibilityIdentifier("capture_photo_button")
      }
    }
    .padding(16)
    .background(Color.black.opacity(0.6))
    .cornerRadius(16)
  }
}
