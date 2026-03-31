/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the
 * LICENSE file in the root directory of this source tree.
 */

//
// CameraAccessApp.swift
//
// Main entry point for the CameraAccess sample app demonstrating the Meta Wearables DAT SDK.
// This app shows how to connect to wearable devices (like Ray-Ban Meta smart glasses),
// stream live video from their cameras, and capture photos. It provides a complete example
// of DAT SDK integration including device registration, permissions, and media streaming.
//

import AVFoundation
import Foundation
import MWDATCore
import UIKit
import SwiftUI

#if DEBUG
import MWDATMockDevice
#endif

@main
struct CameraAccessApp: App {
  #if DEBUG
  // Debug menu for simulating device connections during development
  @StateObject private var debugMenuViewModel = DebugMenuViewModel(mockDeviceKit: MockDeviceKit.shared)
  #endif
  private let wearables: WearablesInterface
  @StateObject private var wearablesViewModel: WearablesViewModel
  @StateObject private var telemetryService = TelemetryService()

  init() {
    NSLog("[CameraAccess] App init starting")

    // Configure audio session as .playAndRecord from launch so AudioStage
    // never needs to change the category mid-stream (which crashes the DAT SDK
    // Bluetooth video connection). .defaultToSpeaker avoids routing audio to the
    // earpiece; .mixWithOthers lets background audio keep playing.
    do {
      let audioSession = AVAudioSession.sharedInstance()
      try audioSession.setCategory(
        .playAndRecord,
        mode: .default,
        options: [.defaultToSpeaker, .mixWithOthers]
      )
      try audioSession.setActive(true)
      NSLog("[CameraAccess] Audio session configured as playAndRecord")
    } catch {
      NSLog("[CameraAccess] Audio session config failed: \(error)")
    }

    do {
      try Wearables.configure()
      NSLog("[CameraAccess] Wearables.configure() succeeded")
    } catch {
      NSLog("[CameraAccess] CRITICAL: Wearables.configure() failed: \(error)")
    }

    #if DEBUG
    // Auto-configure MockDeviceKit when launched by XCUITests
    if ProcessInfo.processInfo.arguments.contains("--ui-testing") {
      let device = MockDeviceKit.shared.pairRaybanMeta()

      let cameraKit = device.getCameraKit()
      Task {
        guard let videoURL = Bundle.main.url(forResource: "plant", withExtension: "mp4"),
          let imageURL = Bundle.main.url(forResource: "plant", withExtension: "png")
        else {
          fatalError("Test resources not found - are you running a Release build?")
        }
        await cameraKit.setCameraFeed(fileURL: videoURL)
        await cameraKit.setCapturedImage(fileURL: imageURL)

        device.powerOn()
        device.don()
      }
    }
    #endif

    let wearables = Wearables.shared
    self.wearables = wearables
    NSLog("[CameraAccess] Wearables.shared obtained, registrationState=\(String(describing: wearables.registrationState))")
    self._wearablesViewModel = StateObject(wrappedValue: WearablesViewModel(wearables: wearables))
    self._telemetryService = StateObject(wrappedValue: {
      let service = TelemetryService()
      service.attachToWearables(wearables)
      NSLog("[CameraAccess] TelemetryService created and attached")
      return service
    }())
    NSLog("[CameraAccess] App init complete")
  }

  var body: some Scene {
    WindowGroup {
      // Main app view with access to the shared Wearables SDK instance
      // The Wearables.shared singleton provides the core DAT API
      MainAppView(wearables: Wearables.shared, viewModel: wearablesViewModel, telemetryService: telemetryService)
        // Show error alerts for view model failures
        .alert("Error", isPresented: $wearablesViewModel.showError) {
          Button("OK") {
            wearablesViewModel.dismissError()
          }
        } message: {
          Text(wearablesViewModel.errorMessage)
        }
        #if DEBUG
      .sheet(isPresented: $debugMenuViewModel.showDebugMenu) {
        MockDeviceKitView(viewModel: debugMenuViewModel.mockDeviceKitViewModel)
      }
      .overlay {
        DebugMenuView(debugMenuViewModel: debugMenuViewModel)
      }
        #endif

      // Registration view handles the flow for connecting to the glasses via Meta AI
      RegistrationView(viewModel: wearablesViewModel)
    }
  }
}
