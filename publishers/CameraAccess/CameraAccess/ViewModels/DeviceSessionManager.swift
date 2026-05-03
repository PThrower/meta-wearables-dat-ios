/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * Manages DeviceSession lifecycle for DAT SDK 0.6.0+.
 * Provides 1:1 device-to-session mapping with device availability
 * monitoring and session creation.
 */

import MWDATCore
import SwiftUI

/// Manages DeviceSession lifecycle with 1:1 device-to-session mapping.
/// Handles device availability monitoring, session creation, and state observation.
@MainActor
final class DeviceSessionManager: ObservableObject {
  @Published private(set) var isReady: Bool = false
  @Published private(set) var hasActiveDevice: Bool = false

  private let wearables: WearablesInterface
  private var deviceSelector: any DeviceSelector
  private var deviceSession: DeviceSession?
  private var deviceMonitorTask: Task<Void, Never>?
  private var stateObserverTask: Task<Void, Never>?

  init(wearables: WearablesInterface, selector: (any DeviceSelector)? = nil) {
    self.wearables = wearables
    self.deviceSelector = selector ?? AutoDeviceSelector(wearables: wearables)
    startDeviceMonitoring()
  }

  deinit {
    deviceMonitorTask?.cancel()
    stateObserverTask?.cancel()
  }

  /// Update the device selector (e.g. when user picks a specific device).
  /// Tears down the current session and starts monitoring the new selector.
  func updateSelector(_ selector: any DeviceSelector) {
    deviceMonitorTask?.cancel()
    stateObserverTask?.cancel()
    stateObserverTask = nil
    deviceSession?.stop()
    deviceSession = nil
    isReady = false

    deviceSelector = selector
    startDeviceMonitoring()
  }

  /// Returns a ready DeviceSession, creating one if needed.
  /// Waits for the session to reach .started state before returning.
  func getSession() async -> DeviceSession? {
    if let session = deviceSession, session.state == .started {
      isReady = true
      return session
    }

    // Session needs to be created or is stopped
    if deviceSession?.state == .stopped {
      deviceSession = nil
    }

    guard deviceSession == nil else {
      // Session exists but not in .started state - wait or return nil
      return nil
    }

    do {
      let session = try wearables.createSession(deviceSelector: deviceSelector)
      deviceSession = session

      let stateStream = session.stateStream()
      try session.start()

      // Wait for .started state
      for await state in stateStream {
        if state == .started {
          isReady = true
          startStateObserver(for: session)
          return session
        } else if state == .stopped {
          isReady = false
          deviceSession = nil
          return nil
        }
      }
    } catch let error as DeviceSessionError {
      switch error {
      case .noEligibleDevice:
        NSLog("[DeviceSessionManager] No eligible device found")
      case .sessionAlreadyExists:
        NSLog("[DeviceSessionManager] Session already exists — tearing down stale session")
        deviceSession = nil
      case .sessionAlreadyStopped:
        NSLog("[DeviceSessionManager] Session already stopped")
        deviceSession = nil
      case .sessionIdle:
        NSLog("[DeviceSessionManager] Session is idle")
      case .capabilityAlreadyActive:
        NSLog("[DeviceSessionManager] Capability already active on session")
      case .capabilityNotFound:
        NSLog("[DeviceSessionManager] Capability not found on session")
      case .unexpectedError(let description):
        NSLog("[DeviceSessionManager] Unexpected session error: \(description)")
      @unknown default:
        NSLog("[DeviceSessionManager] Unknown DeviceSessionError: \(error)")
      }
      isReady = false
      deviceSession = nil
    } catch {
      NSLog("[DeviceSessionManager] Failed to create session: \(error)")
      isReady = false
      deviceSession = nil
    }
    return nil
  }

  /// Active device identifier from the selector stream, if any.
  var activeDeviceId: DeviceIdentifier? {
    // Exposed for consumers that need the device identity
    nil // Will be populated via deviceMonitorTask
  }

  // MARK: - Private

  private func startDeviceMonitoring() {
    deviceMonitorTask = Task { [weak self] in
      guard let self else { return }

      // Only AutoDeviceSelector has activeDeviceStream
      if let autoSelector = self.deviceSelector as? AutoDeviceSelector {
        for await device in autoSelector.activeDeviceStream() {
          self.hasActiveDevice = device != nil
          if device != nil {
            _ = await self.getSession()
          } else {
            self.handleDeviceLost()
          }
        }
      }
    }
  }

  private func startStateObserver(for session: DeviceSession) {
    stateObserverTask?.cancel()
    stateObserverTask = Task { [weak self] in
      for await state in session.stateStream() {
        guard let self else { return }
        if state == .started {
          isReady = true
        } else if state == .stopped {
          // DeviceSession.stopped is terminal - clean up
          isReady = false
          deviceSession = nil
          return
        }
      }
    }
  }

  private func handleDeviceLost() {
    stateObserverTask?.cancel()
    stateObserverTask = nil
    deviceSession?.stop()
    deviceSession = nil
    isReady = false
  }
}
