/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the
 * LICENSE file in the root directory of this source tree.
 */

//
// NonStreamView.swift
//
// Default screen to show getting started tips after app connection
// Initiates streaming
//

import MWDATCamera
import MWDATCore
import SwiftUI

#if DEBUG
import MWDATMockDevice
#endif

struct NonStreamView: View {
  @ObservedObject var viewModel: StreamSessionViewModel
  @ObservedObject var wearablesVM: WearablesViewModel
  @ObservedObject var telemetryService: TelemetryService
  #if DEBUG
  @ObservedObject var mockDeviceVM: MockDeviceKitView.ViewModel
  #endif
  @State private var sheetHeight: CGFloat = 300
  @State private var showSettings = false

  var body: some View {
    ZStack {
      Color(UIColor.systemGroupedBackground).edgesIgnoringSafeArea(.all)

      VStack {
        HStack {
          Spacer()
          Button {
            showSettings = true
          } label: {
            Image(systemName: "gearshape")
              .resizable()
              .aspectRatio(contentMode: .fit)
              .foregroundColor(.primary)
              .frame(width: 24, height: 24)
          }
        }

        Spacer()

        VStack(spacing: 12) {
          Image(.cameraAccessIcon)
            .resizable()
            .renderingMode(.template)
            .foregroundColor(.primary)
            .aspectRatio(contentMode: .fit)
            .frame(width: 120)

          Text("Stream Your Glasses Camera")
            .font(.system(size: 20, weight: .semibold))
            .foregroundColor(.primary)

          Text("Tap the Start streaming button to stream video from your glasses or use the camera button to take a photo from your glasses.")
            .font(.system(size: 15))
            .multilineTextAlignment(.center)
            .foregroundColor(.secondary)
        }
        .padding(.horizontal, 12)

        Spacer()

        // Device picker - always show (includes mock device controls in debug)
        #if DEBUG
        DevicePickerSection(
          viewModel: viewModel,
          wearablesVM: wearablesVM,
          mockDeviceVM: mockDeviceVM
        )
        .padding(.horizontal, 24)
        .padding(.bottom, 8)
        #else
        DevicePickerSection(
          viewModel: viewModel,
          wearablesVM: wearablesVM
        )
        .padding(.horizontal, 24)
        .padding(.bottom, 8)
        #endif

        HStack(spacing: 8) {
          Image(systemName: "hourglass")
            .resizable()
            .aspectRatio(contentMode: .fit)
            .foregroundColor(.secondary)
            .frame(width: 16, height: 16)

          Text("Waiting for an active device")
            .font(.system(size: 14))
            .foregroundColor(.secondary)
        }
        .padding(.bottom, 12)
        .opacity(viewModel.hasActiveDevice ? 0 : 1)

        // Standby relay indicator
        if viewModel.relayMode == .standby {
          HStack(spacing: 6) {
            Circle()
              .fill(Color.green)
              .frame(width: 8, height: 8)
            Text("Relay: Ready")
              .font(.system(size: 12, weight: .medium, design: .monospaced))
              .foregroundColor(.green)
          }
          .padding(.bottom, 8)
        }

        CustomButton(
          title: "Start streaming",
          style: .primary,
          isDisabled: !viewModel.hasActiveDevice
        ) {
          Task {
            await viewModel.handleStartStreaming()
          }
        }
      }
      .padding(.all, 24)
    }
    .sheet(isPresented: $showSettings) {
      SettingsView(mode: .preStream, viewModel: viewModel, wearablesVM: wearablesVM, telemetryService: telemetryService)
    }
    .sheet(isPresented: $wearablesVM.showGettingStartedSheet) {
      if #available(iOS 16.0, *) {
        GettingStartedSheetView(height: $sheetHeight)
          .presentationDetents([.height(sheetHeight)])
          .presentationDragIndicator(.visible)
      } else {
        GettingStartedSheetView(height: $sheetHeight)
      }
    }
  }
}

// MARK: - Device Picker

struct DevicePickerSection: View {
  @ObservedObject var viewModel: StreamSessionViewModel
  @ObservedObject var wearablesVM: WearablesViewModel
  #if DEBUG
  @ObservedObject var mockDeviceVM: MockDeviceKitView.ViewModel
  #endif

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text("SELECT DEVICE")
        .font(.system(size: 11, weight: .bold, design: .monospaced))
        .foregroundColor(.secondary)

      ForEach(wearablesVM.devices, id: \.self) { deviceId in
        let info = wearablesVM.deviceInfos[deviceId]
        let isSelected = viewModel.selectedDeviceId == deviceId

        Button {
          viewModel.selectDevice(deviceId)
        } label: {
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

            if isSelected {
              Image(systemName: "checkmark.circle.fill")
                .foregroundColor(.blue)
            }
          }
          .padding(.horizontal, 12)
          .padding(.vertical, 8)
          .background(isSelected ? Color.blue.opacity(0.12) : Color(UIColor.secondarySystemGroupedBackground))
          .cornerRadius(8)
        }
      }

      // Auto-select option
      Button {
        viewModel.selectDevice(nil)
      } label: {
        HStack(spacing: 10) {
          Image(systemName: "wand.and.stars")
            .foregroundColor(.secondary)
            .frame(width: 20)

          Text("Auto-select")
            .font(.system(size: 14))
            .foregroundColor(.secondary)

          Spacer()

          if viewModel.selectedDeviceId == nil {
            Image(systemName: "checkmark.circle.fill")
              .foregroundColor(.blue)
          }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(viewModel.selectedDeviceId == nil ? Color.blue.opacity(0.12) : Color(UIColor.secondarySystemGroupedBackground))
        .cornerRadius(8)
      }

      #if DEBUG
      Divider()

      // Mock device controls
      HStack(spacing: 10) {
        Image(systemName: "ladybug.fill")
          .foregroundColor(.yellow)
          .frame(width: 20)

        Text("Mock Device")
          .font(.system(size: 14))
          .foregroundColor(.yellow.opacity(0.8))

        Spacer()

        if mockDeviceVM.cardViewModels.isEmpty {
          Button {
            mockDeviceVM.pairRaybanMeta()
          } label: {
            HStack(spacing: 4) {
              Image(systemName: "plus")
                .font(.system(size: 10, weight: .bold))
              Text("Pair")
                .font(.system(size: 12, weight: .medium))
            }
            .foregroundColor(.black)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(.yellow)
            .cornerRadius(6)
          }
        } else {
          Menu {
            ForEach(Array(mockDeviceVM.cardViewModels.enumerated()), id: \.offset) { _, cardVM in
              Button {
                mockDeviceVM.unpairDevice(cardVM.device)
              } label: {
                Label("Unpair \(cardVM.deviceName)", systemImage: "xmark.circle")
              }
            }

            if mockDeviceVM.cardViewModels.count < 3 {
              Divider()
              Button {
                mockDeviceVM.pairRaybanMeta()
              } label: {
                Label("Pair Another", systemImage: "plus.circle")
              }
            }
          } label: {
            HStack(spacing: 4) {
              Text("\(mockDeviceVM.cardViewModels.count)")
                .font(.system(size: 11, weight: .bold, design: .monospaced))
              Text("paired")
                .font(.system(size: 11))
              Image(systemName: "ellipsis.circle")
                .font(.system(size: 11))
            }
            .foregroundColor(.yellow)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(Color.yellow.opacity(0.15))
            .cornerRadius(6)
          }
        }
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 8)
      .background(Color(UIColor.secondarySystemGroupedBackground))
      .cornerRadius(8)
      #endif
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

// MARK: - Stream Config

struct StreamConfigSection: View {
  @ObservedObject var viewModel: StreamSessionViewModel

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text("STREAM SETTINGS")
        .font(.system(size: 11, weight: .bold, design: .monospaced))
        .foregroundColor(.secondary)

      // Resolution picker
      HStack(spacing: 6) {
        Text("Resolution")
          .font(.system(size: 13))
          .foregroundColor(.secondary)
          .frame(width: 80, alignment: .leading)

        ForEach(StreamingResolution.allCases, id: \.self) { res in
          Button {
            viewModel.selectedResolution = res
          } label: {
            Text(resLabel(res))
              .font(.system(size: 12, weight: viewModel.selectedResolution == res ? .bold : .regular, design: .monospaced))
              .foregroundColor(viewModel.selectedResolution == res ? .white : .secondary)
              .padding(.horizontal, 10)
              .padding(.vertical, 6)
              .background(viewModel.selectedResolution == res ? Color.blue : Color(UIColor.secondarySystemGroupedBackground))
              .cornerRadius(6)
          }
        }
      }

      // Frame rate picker
      HStack(spacing: 6) {
        Text("Frame Rate")
          .font(.system(size: 13))
          .foregroundColor(.secondary)
          .frame(width: 80, alignment: .leading)

        ForEach([UInt(24), 30, 60], id: \.self) { fps in
          Button {
            viewModel.selectedFrameRate = fps
          } label: {
            Text("\(fps) fps")
              .font(.system(size: 12, weight: viewModel.selectedFrameRate == fps ? .bold : .regular, design: .monospaced))
              .foregroundColor(viewModel.selectedFrameRate == fps ? .white : .secondary)
              .padding(.horizontal, 10)
              .padding(.vertical, 6)
              .background(viewModel.selectedFrameRate == fps ? Color.blue : Color(UIColor.secondarySystemGroupedBackground))
              .cornerRadius(6)
          }
        }
      }

      // Current config summary
      Text("\(resLabel(viewModel.selectedResolution)) \u{00B7} \(viewModel.selectedFrameRate) fps \u{00B7} RAW codec")
        .font(.system(size: 10, design: .monospaced))
        .foregroundColor(.secondary)
        .padding(.top, 2)
    }
  }

  private func resLabel(_ res: StreamingResolution) -> String {
    switch res {
    case .high: return "HIGH"
    case .medium: return "MED"
    case .low: return "LOW"
    }
  }
}

// MARK: - Getting Started Sheet

struct GettingStartedSheetView: View {
  @Environment(\.dismiss) var dismiss
  @Binding var height: CGFloat

  var body: some View {
    VStack(spacing: 24) {
      Text("Getting started")
        .font(.system(size: 18, weight: .semibold))
        .foregroundColor(.primary)

      VStack(spacing: 12) {
        TipItemView(
          resource: .videoIcon,
          text: "First, Camera Access needs permission to use your glasses camera."
        )
        TipItemView(
          resource: .tapIcon,
          text: "Capture photos by tapping the camera button."
        )
        TipItemView(
          resource: .smartGlassesIcon,
          text: "The capture LED lets others know when you're capturing content or going live."
        )
      }
      .padding(.bottom, 16)

      CustomButton(
        title: "Continue",
        style: .primary,
        isDisabled: false
      ) {
        dismiss()
      }
    }
    .padding(.all, 24)
    .background(
      GeometryReader { geo -> Color in
        DispatchQueue.main.async {
          height = geo.size.height
        }
        return Color.clear
      }
    )
  }
}

struct TipItemView: View {
  let resource: ImageResource
  let text: String

  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      Image(resource)
        .resizable()
        .renderingMode(.template)
        .foregroundColor(.primary)
        .aspectRatio(contentMode: .fit)
        .frame(width: 24)
        .padding(.leading, 4)
        .padding(.top, 4)

      Text(text)
        .font(.system(size: 15))
        .foregroundColor(.primary)
        .fixedSize(horizontal: false, vertical: true)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}
