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

import MWDATCore
import SwiftUI

struct NonStreamView: View {
  @ObservedObject var viewModel: StreamSessionViewModel
  @ObservedObject var wearablesVM: WearablesViewModel
  @State private var sheetHeight: CGFloat = 300

  var body: some View {
    ZStack {
      Color.black.edgesIgnoringSafeArea(.all)

      VStack {
        HStack {
          Spacer()
          Menu {
            Button("Disconnect", role: .destructive) {
              wearablesVM.disconnectGlasses()
            }
            .disabled(wearablesVM.registrationState != .registered)
          } label: {
            Image(systemName: "gearshape")
              .resizable()
              .aspectRatio(contentMode: .fit)
              .foregroundColor(.white)
              .frame(width: 24, height: 24)
          }
        }

        Spacer()

        VStack(spacing: 12) {
          Image(.cameraAccessIcon)
            .resizable()
            .renderingMode(.template)
            .foregroundColor(.white)
            .aspectRatio(contentMode: .fit)
            .frame(width: 120)

          Text("Stream Your Glasses Camera")
            .font(.system(size: 20, weight: .semibold))
            .foregroundColor(.white)

          Text("Tap the Start streaming button to stream video from your glasses or use the camera button to take a photo from your glasses.")
            .font(.system(size: 15))
            .multilineTextAlignment(.center)
            .foregroundColor(.white)
        }
        .padding(.horizontal, 12)

        Spacer()

        // Device picker - show when multiple devices available
        if wearablesVM.devices.count > 1 {
          DevicePickerSection(
            viewModel: viewModel,
            wearablesVM: wearablesVM
          )
          .padding(.horizontal, 24)
          .padding(.bottom, 8)
        }

        HStack(spacing: 8) {
          Image(systemName: "hourglass")
            .resizable()
            .aspectRatio(contentMode: .fit)
            .foregroundColor(.white.opacity(0.7))
            .frame(width: 16, height: 16)

          Text("Waiting for an active device")
            .font(.system(size: 14))
            .foregroundColor(.white.opacity(0.7))
        }
        .padding(.bottom, 12)
        .opacity(viewModel.hasActiveDevice ? 0 : 1)

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

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text("SELECT DEVICE")
        .font(.system(size: 11, weight: .bold, design: .monospaced))
        .foregroundColor(.white.opacity(0.5))

      ForEach(wearablesVM.devices, id: \.self) { deviceId in
        let info = wearablesVM.deviceInfos[deviceId]
        let isSelected = viewModel.selectedDeviceId == deviceId
        let isAuto = viewModel.selectedDeviceId == nil

        Button {
          viewModel.selectDevice(deviceId)
        } label: {
          HStack(spacing: 10) {
            Image(systemName: deviceIcon(for: info?.type))
              .foregroundColor(.white)
              .frame(width: 20)

            VStack(alignment: .leading, spacing: 2) {
              Text(info?.name ?? deviceId)
                .font(.system(size: 14, weight: .medium))
                .foregroundColor(.white)
              HStack(spacing: 6) {
                Text(info?.type.displayName ?? "Unknown")
                  .font(.system(size: 11))
                  .foregroundColor(.white.opacity(0.5))
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
          .background(isSelected ? Color.white.opacity(0.15) : Color.white.opacity(0.05))
          .cornerRadius(8)
        }
      }

      // Auto-select option
      Button {
        viewModel.selectDevice(nil)
      } label: {
        HStack(spacing: 10) {
          Image(systemName: "wand.and.stars")
            .foregroundColor(.white.opacity(0.7))
            .frame(width: 20)

          Text("Auto-select")
            .font(.system(size: 14))
            .foregroundColor(.white.opacity(0.7))

          Spacer()

          if viewModel.selectedDeviceId == nil {
            Image(systemName: "checkmark.circle.fill")
              .foregroundColor(.blue)
          }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(viewModel.selectedDeviceId == nil ? Color.white.opacity(0.15) : Color.white.opacity(0.05))
        .cornerRadius(8)
      }
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
    case .connecting: return (.yellow, "CONNECTING")
    case .disconnected: return (.red, "DISCONNECTED")
    case nil: return (.gray, "UNKNOWN")
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
