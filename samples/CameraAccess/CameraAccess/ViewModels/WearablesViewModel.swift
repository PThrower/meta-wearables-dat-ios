/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the
 * LICENSE file in the root directory of this source tree.
 */

//
// WearablesViewModel.swift
//
// Primary view model for the CameraAccess app that manages DAT SDK integration.
// Demonstrates how to listen to device availability changes using the DAT SDK's
// device stream functionality and handle permission requests.
//

import MWDATCore
import SwiftUI

#if DEBUG
import MWDATMockDevice
#endif

struct DeviceInfo {
    let name: String
    let type: DeviceType
    let linkState: LinkState
    let compatibility: Compatibility
}

extension DeviceType {
    var displayName: String {
        switch self {
        case .rayBanMeta: return "Ray-Ban Meta"
        case .oakleyMetaHSTN: return "Oakley Meta HSTN"
        case .oakleyMetaVanguard: return "Oakley Meta Vanguard"
        case .metaRayBanDisplay: return "Meta Ray-Ban Display"
        case .unknown: return "Unknown"
        }
    }
}

@MainActor
class WearablesViewModel: ObservableObject {
  @Published var devices: [DeviceIdentifier]
  @Published var deviceInfos: [DeviceIdentifier: DeviceInfo] = [:]
  @Published var hasMockDevice: Bool
  @Published var registrationState: RegistrationState
  @Published var showGettingStartedSheet: Bool = false
  @Published var showError: Bool = false
  @Published var errorMessage: String = ""

  private var registrationTask: Task<Void, Never>?
  private var deviceStreamTask: Task<Void, Never>?
  private var setupDeviceStreamTask: Task<Void, Never>?
  private let wearables: WearablesInterface
  private var compatibilityListenerTokens: [DeviceIdentifier: AnyListenerToken] = [:]
  private var linkStateTokens: [DeviceIdentifier: AnyListenerToken] = [:]

  init(wearables: WearablesInterface) {
    self.wearables = wearables
    self.devices = wearables.devices
    self.hasMockDevice = false
    self.registrationState = wearables.registrationState

    // Set up device stream immediately to handle MockDevice events
    setupDeviceStreamTask = Task {
      await setupDeviceStream()
    }

    registrationTask = Task {
      for await registrationState in wearables.registrationStateStream() {
        let previousState = self.registrationState
        self.registrationState = registrationState
        if self.showGettingStartedSheet == false && registrationState == .registered && previousState == .registering {
          self.showGettingStartedSheet = true
        }
      }
    }
  }

  deinit {
    registrationTask?.cancel()
    deviceStreamTask?.cancel()
    setupDeviceStreamTask?.cancel()
  }

  private func setupDeviceStream() async {
    if let task = deviceStreamTask, !task.isCancelled {
      task.cancel()
    }

    deviceStreamTask = Task {
      for await devices in wearables.devicesStream() {
        self.devices = devices
        #if DEBUG
        self.hasMockDevice = !MockDeviceKit.shared.pairedDevices.isEmpty
        #endif
        // Monitor compatibility and link state for each device
        monitorDeviceCompatibility(devices: devices)
        updateDeviceInfos(devices: devices)
      }
    }
  }

  private func updateDeviceInfos(devices: [DeviceIdentifier]) {
    let deviceSet = Set(devices)
    linkStateTokens = linkStateTokens.filter { deviceSet.contains($0.key) }

    for deviceId in devices {
      guard let device = wearables.deviceForIdentifier(deviceId) else { continue }

      let name = device.nameOrId()
      let type = device.deviceType()
      let state = device.linkState
      let compat = device.compatibility()

      deviceInfos[deviceId] = DeviceInfo(name: name, type: type, linkState: state, compatibility: compat)

      if linkStateTokens[deviceId] == nil {
        let token = device.addLinkStateListener { [weak self] linkState in
          Task { @MainActor [weak self] in
            guard let self else { return }
            if var info = self.deviceInfos[deviceId] {
              info = DeviceInfo(name: info.name, type: info.type, linkState: linkState, compatibility: info.compatibility)
              self.deviceInfos[deviceId] = info
            }
          }
        }
        linkStateTokens[deviceId] = token
      }
    }
  }

  private func monitorDeviceCompatibility(devices: [DeviceIdentifier]) {
    // Remove listeners for devices that are no longer present
    let deviceSet = Set(devices)
    compatibilityListenerTokens = compatibilityListenerTokens.filter { deviceSet.contains($0.key) }

    // Add listeners for new devices
    for deviceId in devices {
      guard compatibilityListenerTokens[deviceId] == nil else { continue }
      guard let device = wearables.deviceForIdentifier(deviceId) else { continue }

      // Capture device name before the closure to avoid Sendable issues
      let deviceName = device.nameOrId()
      let token = device.addCompatibilityListener { [weak self] compatibility in
        guard let self else { return }
        if compatibility == .deviceUpdateRequired {
          Task { @MainActor in
            self.showError("Device '\(deviceName)' requires an update to work with this app")
          }
        }
        Task { @MainActor [weak self] in
          guard let self else { return }
          if var info = self.deviceInfos[deviceId] {
            info = DeviceInfo(name: info.name, type: info.type, linkState: info.linkState, compatibility: compatibility)
            self.deviceInfos[deviceId] = info
          }
        }
      }
      compatibilityListenerTokens[deviceId] = token
    }
  }

  func connectGlasses() {
    guard registrationState != .registering else { return }
    Task { @MainActor in
      do {
        try await wearables.startRegistration()
      } catch let error as RegistrationError {
        showError(error.description)
      } catch {
        showError(error.localizedDescription)
      }
    }
  }

  func disconnectGlasses() {
    Task { @MainActor in
      do {
        try await wearables.startUnregistration()
      } catch let error as UnregistrationError {
        showError(error.description)
      } catch {
        showError(error.localizedDescription)
      }
    }
  }

  func showError(_ error: String) {
    errorMessage = error
    showError = true
  }

  func dismissError() {
    showError = false
  }
}
