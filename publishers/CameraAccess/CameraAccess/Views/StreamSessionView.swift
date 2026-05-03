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
  @Environment(StreamCoordinator.self) private var coordinator
  @EnvironmentObject private var wearablesViewModel: WearablesViewModel
  @EnvironmentObject private var telemetryService: TelemetryService
  @State private var orientation: UIInterfaceOrientation?
  @Environment(\.scenePhase) private var scenePhase
  var pushService: PushNotificationService

  #if DEBUG
  var mockDeviceViewModel: MockDeviceKitView.ViewModel
  #endif

  var body: some View {
    ZStack {
      if coordinator.isStreaming {
        // Full-screen video view with streaming controls
        StreamView()
      } else {
        // Pre-streaming setup view with permissions and start button
        #if DEBUG
        NonStreamView(mockDeviceViewModel: mockDeviceViewModel)
        #else
        NonStreamView()
        #endif
      }
    }
    .alert("Error", isPresented: Binding(
      get: { coordinator.errors.showError },
      set: { if !$0 { coordinator.errors.dismissError() } }
    )) {
      Button("OK") {
        coordinator.errors.dismissError()
      }
    } message: {
      Text(coordinator.errors.errorMessage)
    }
    .onAppear {
      // Wire push notification wake callback to coordinator
      pushService.onWakeFromPush = {
        Task { @MainActor in
          coordinator.handleWakeFromPush()
        }
      }
      // Cold-launch from notification tap: launchOptions set pendingWake in didFinishLaunching
      if pushService.pendingWake {
        NSLog("[StreamSessionView] Detected pendingWake on appear — triggering wake from push")
        pushService.pendingWake = false
        Task { await coordinator.handleWakeFromPush() }
        return
      }
      if coordinator.isStreaming {
        OrientationLock.shared.unlock()
      } else {
        OrientationLock.shared.lock(to: .portrait)
        // Connect to relay in standby mode so viewer can remotely start stream
        Task { await coordinator.startStandbyRelay() }
      }
    }
    .onChange(of: coordinator.isStreaming) { streaming in
      if streaming {
        OrientationLock.shared.unlock()
      } else {
        OrientationLock.shared.lock(to: .portrait)
      }
    }
    .onChange(of: scenePhase) { newPhase in
      switch newPhase {
      case .background:
        coordinator.handleEnterBackground()
      case .active:
        coordinator.handleEnterForeground()
      default:
        break
      }
    }
  }
}

#if DEBUG
struct DebugPanel: View {
  @Environment(StreamCoordinator.self) private var coordinator
  @EnvironmentObject private var wearablesVM: WearablesViewModel
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
        row("Active", coordinator.hasActiveDevice ? "YES" : "NO")
        row("Selected", coordinator.selectedDeviceId ?? "auto")
        if coordinator.isRetrying {
          row("Retry", "\(coordinator.retryCount)/3")
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

        if !coordinator.errors.errorLog.isEmpty {
          Divider().background(.white.opacity(0.2))
          Text("ERRORS (\(coordinator.errors.errorLog.count))")
            .font(.system(size: 8, weight: .bold, design: .monospaced))
            .foregroundColor(.red)
          ForEach(coordinator.errors.errorLog.suffix(3).reversed(), id: \.self) { entry in
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
