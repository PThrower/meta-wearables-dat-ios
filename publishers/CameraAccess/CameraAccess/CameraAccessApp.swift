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
import UserNotifications

#if DEBUG
import MWDATMockDevice
#endif

// MARK: - AppDelegate for Push Notifications

final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
  let pushService = PushNotificationService()

  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    UNUserNotificationCenter.current().delegate = self

    // Request push authorization asynchronously
    Task { @MainActor in
      await pushService.requestAuthorization()
      // Re-send stored token on each launch
      pushService.resendStoredToken()
    }

    // Check if app was launched from a notification tap (cold launch)
    if let notification = launchOptions?[.remoteNotification] as? [AnyHashable: Any] {
      let wakeType = notification["wake"] as? String
      if wakeType == "standby" {
        NSLog("[PushNotification] Launched from notification — setting pendingWake")
        pushService.pendingWake = true
      }
    }

    return true
  }

  func application(
    _ application: UIApplication,
    didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
  ) {
    pushService.handleDeviceToken(deviceToken)
  }

  func application(
    _ application: UIApplication,
    didFailToRegisterForRemoteNotificationsWithError error: Error
  ) {
    NSLog("[PushNotification] Failed to register for remote notifications: \(error)")
  }

  func application(
    _ application: UIApplication,
    didReceiveRemoteNotification userInfo: [AnyHashable: Any],
    fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void
  ) {
    pushService.handleIncomingPush(userInfo: userInfo, completionHandler: completionHandler)
  }

  // MARK: - UNUserNotificationCenterDelegate

  nonisolated func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    let userInfo = response.notification.request.content.userInfo
    NSLog("[PushNotification] Notification tapped: \(userInfo)")

    // Route visible notification taps through the same wake flow as silent pushes.
    // This handles the case where the user taps the "Stream Ready" fallback notification.
    let wakeType = userInfo["wake"] as? String
    if wakeType == "standby" {
      NSLog("[PushNotification] Wake notification tapped — setting pendingWake flag")
      Task { @MainActor in
        // If callback is already wired (app was backgrounded), call it directly
        if let callback = pushService.onWakeFromPush {
          callback()
        } else {
          // App cold-launched from notification — callback not wired yet.
          // Set flag so StreamSessionView.onAppear picks it up.
          pushService.pendingWake = true
        }
      }
    }

    completionHandler()
  }

  nonisolated func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    // Show notification even when app is in foreground
    completionHandler([.banner, .sound])
  }
}

// MARK: - App

@main
struct CameraAccessApp: App {
  @UIApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
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
    // Bluetooth video connection).
    //
    // Options:
    //   .allowBluetooth — required for Meta glasses mic input + speaker output via HFP.
    //     Without this, iOS only enables A2DP (output-only) for BT devices.
    //     HFP provides bidirectional audio (mic input + speaker output) at 8/16kHz.
    //     No .defaultToSpeaker — when HFP glasses are connected, output (inbound
    //     viewer audio, TTS) routes through glasses speakers. Without glasses,
    //     output falls back to phone speaker automatically.
    //   .mixWithOthers — background audio from other apps keeps playing.
    //
    // See Meta docs: https://wearables.developer.meta.com/docs/microphones-and-speakers/
    do {
      let audioSession = AVAudioSession.sharedInstance()
      try audioSession.setCategory(
        .playAndRecord,
        mode: .default,
        options: [.allowBluetooth, .mixWithOthers]
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
          NSLog("[CameraAccess] WARNING: Test resources not found - skipping UI testing resources")
          return
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
      #if DEBUG
      MainAppView(
          wearables: Wearables.shared,
          viewModel: wearablesViewModel,
          telemetryService: telemetryService,
          mockDeviceViewModel: debugMenuViewModel.mockDeviceKitViewModel,
          pushNotificationService: appDelegate.pushService
        )
        .alert("Error", isPresented: $wearablesViewModel.showError) {
          Button("OK") {
            wearablesViewModel.dismissError()
          }
        } message: {
          Text(wearablesViewModel.errorMessage)
        }
      #else
      MainAppView(
          wearables: Wearables.shared,
          viewModel: wearablesViewModel,
          telemetryService: telemetryService,
          pushNotificationService: appDelegate.pushService
        )
        .alert("Error", isPresented: $wearablesViewModel.showError) {
          Button("OK") {
            wearablesViewModel.dismissError()
          }
        } message: {
          Text(wearablesViewModel.errorMessage)
        }
      #endif

      // Registration view handles the flow for connecting to the glasses via Meta AI
      RegistrationView(viewModel: wearablesViewModel)
    }
  }
}
