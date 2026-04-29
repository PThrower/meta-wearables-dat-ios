/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the
 * LICENSE file in the root directory of this source tree.
 */

//
// StreamSessionView.swift
//
//

import MWDATCore
import SwiftUI

#if DEBUG
import MWDATMockDevice
#endif

struct StreamSessionView: View {
  let wearables: WearablesInterface
  @ObservedObject private var wearablesViewModel: WearablesViewModel
  @StateObject private var viewModel: StreamSessionViewModel
  @ObservedObject private var telemetryService: TelemetryService
  @State private var orientation: UIInterfaceOrientation?
  @Environment(\.scenePhase) private var scenePhase
  var pushNotificationService: PushNotificationService?

  #if DEBUG
  @ObservedObject var mockDeviceVM: MockDeviceKitView.ViewModel

  init(wearables: WearablesInterface, wearablesVM: WearablesViewModel, telemetryService: TelemetryService, mockDeviceVM: MockDeviceKitView.ViewModel, pushNotificationService: PushNotificationService? = nil) {
    self.wearables = wearables
    self.wearablesViewModel = wearablesVM
    self._telemetryService = ObservedObject(wrappedValue: telemetryService)
    self._viewModel = StateObject(wrappedValue: StreamSessionViewModel(wearables: wearables, telemetryService: telemetryService))
    self._mockDeviceVM = ObservedObject(wrappedValue: mockDeviceVM)
    self.pushNotificationService = pushNotificationService
  }
  #else
  init(wearables: WearablesInterface, wearablesVM: WearablesViewModel, telemetryService: TelemetryService, pushNotificationService: PushNotificationService? = nil) {
    self.wearables = wearables
    self.wearablesViewModel = wearablesVM
    self._telemetryService = ObservedObject(wrappedValue: telemetryService)
    self._viewModel = StateObject(wrappedValue: StreamSessionViewModel(wearables: wearables, telemetryService: telemetryService))
    self.pushNotificationService = pushNotificationService
  }
  #endif

  var body: some View {
    ZStack {
      if viewModel.isStreaming {
        // Full-screen video view with streaming controls
        StreamView(viewModel: viewModel, wearablesVM: wearablesViewModel, telemetryService: telemetryService)
      } else {
        // Pre-streaming setup view with permissions and start button
        #if DEBUG
        NonStreamView(viewModel: viewModel, wearablesVM: wearablesViewModel, telemetryService: telemetryService, mockDeviceVM: mockDeviceVM)
        #else
        NonStreamView(viewModel: viewModel, wearablesVM: wearablesViewModel, telemetryService: telemetryService)
        #endif
      }
    }
    .alert("Error", isPresented: $viewModel.showError) {
      Button("OK") {
        viewModel.dismissError()
      }
    } message: {
      Text(viewModel.errorMessage)
    }
    .onAppear {
      // Wire push notification wake callback to standby relay
      if let pushService = pushNotificationService {
        pushService.onWakeFromPush = { [weak viewModel] in
          Task { @MainActor in
            viewModel?.handleWakeFromPush()
          }
        }
        // Cold-launch from notification tap: callback wasn't wired when delegate fired,
        // so a pendingWake flag was set. Pick it up now.
        if pushService.pendingWake {
          NSLog("[StreamSessionView] Detected pendingWake — triggering wake from push")
          pushService.pendingWake = false
          Task { await viewModel.handleWakeFromPush() }
          return
        }
      }
      if viewModel.isStreaming {
        OrientationLock.shared.unlock()
      } else {
        OrientationLock.shared.lock(to: .portrait)
        // Connect to relay in standby mode so viewer can remotely start stream
        Task { await viewModel.startStandbyRelay() }
      }
    }
    .onChange(of: viewModel.isStreaming) { streaming in
      if streaming {
        OrientationLock.shared.unlock()
      } else {
        OrientationLock.shared.lock(to: .portrait)
      }
    }
    .onChange(of: scenePhase) { newPhase in
      switch newPhase {
      case .background:
        viewModel.handleEnterBackground()
      case .active:
        viewModel.handleEnterForeground()
      default:
        break
      }
    }
  }
}

#if DEBUG
struct DebugPanel: View {
  @ObservedObject var viewModel: StreamSessionViewModel
  @ObservedObject var wearablesVM: WearablesViewModel
  @State private var expanded = true

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      Button { expanded.toggle() } label: {
        HStack {
          Image(systemName: "ladybug.fill")
            .font(.system(size: 10))
          Text("DEBUG")
            .font(.system(size: 9, weight: .bold, design: .monospaced))
          Spacer()
          Image(systemName: expanded ? "chevron.down" : "chevron.up")
            .font(.system(size: 8))
        }
        .foregroundColor(.yellow)
      }

      if expanded {
        Divider().background(.white.opacity(0.2))

        row("Registration", String(describing: wearablesVM.registrationState))
        row("Devices", "\(wearablesVM.devices.count) found")
        row("Active", viewModel.hasActiveDevice ? "YES" : "NO")
        row("Selected", viewModel.selectedDeviceId ?? "auto")
        if viewModel.isRetrying {
          row("Retry", "\(viewModel.retryCount)/3")
        }

        if !wearablesVM.deviceInfos.isEmpty {
          Divider().background(.white.opacity(0.2))
          ForEach(wearablesVM.devices, id: \.self) { id in
            if let info = wearablesVM.deviceInfos[id] {
              VStack(alignment: .leading, spacing: 1) {
                Text(info.name)
                  .font(.system(size: 9, weight: .semibold, design: .monospaced))
                  .foregroundColor(.white)
                Text("\(info.type.displayName) | \(String(describing: info.linkState)) | \(String(describing: info.compatibility))")
                  .font(.system(size: 8, design: .monospaced))
                  .foregroundColor(linkColor(info.linkState))
              }
            }
          }
        }

        if !viewModel.errorLog.isEmpty {
          Divider().background(.white.opacity(0.2))
          Text("ERRORS (\(viewModel.errorLog.count))")
            .font(.system(size: 8, weight: .bold, design: .monospaced))
            .foregroundColor(.red)
          ForEach(viewModel.errorLog.suffix(3).reversed(), id: \.self) { entry in
            Text(entry)
              .font(.system(size: 7, design: .monospaced))
              .foregroundColor(.red.opacity(0.9))
              .lineLimit(2)
          }
        }
      }
    }
    .padding(6)
    .background(Color.black.opacity(0.85))
    .cornerRadius(6)
    .font(.system(size: 10, design: .monospaced))
    .foregroundColor(.white)
  }

  private func row(_ label: String, _ value: String) -> some View {
    HStack {
      Text(label).foregroundColor(.white.opacity(0.5))
      Spacer()
      Text(value).foregroundColor(.white)
    }
  }

  private func linkColor(_ state: LinkState) -> Color {
    switch state {
    case .connected: return .green
    case .connecting: return .yellow
    case .disconnected: return .red
    }
  }
}
#endif

// MARK: - Orientation Lock

// THREADING REVIEW: [SAFE] Marked @MainActor.
// Uses UIApplication.shared and UIDevice.current — both @MainActor-isolated in iOS 17+.
// All callers (SwiftUI .onAppear, .onChange) run on @MainActor.
@MainActor final class OrientationLock: ObservableObject {
  static let shared = OrientationLock()
  private var isLocked = true

  func lock(to orientation: UIInterfaceOrientationMask) {
    isLocked = true
    if #available(iOS 16.0, *) {
      let windowScene = UIApplication.shared.connectedScenes.first as? UIWindowScene
      windowScene?.requestGeometryUpdate(.iOS(interfaceOrientations: orientation)) { _ in }
    } else {
      UIDevice.current.setValue(UIInterfaceOrientation.portrait.rawValue, forKey: "orientation")
    }
  }

  func unlock() {
    isLocked = false
    if #available(iOS 16.0, *) {
      let windowScene = UIApplication.shared.connectedScenes.first as? UIWindowScene
      windowScene?.requestGeometryUpdate(.iOS(interfaceOrientations: .all)) { _ in }
    }
  }
}
