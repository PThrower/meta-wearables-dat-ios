/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the
 * LICENSE file in the root directory of this source tree.
 */

//
// MockDeviceViewModel.swift
//
// View model for individual mock devices used in development and testing of DAT SDK features.
// This controls mock device behaviors like power states, physical states (folded/unfolded),
// media content (camera feeds and captured images), and permission simulation.
//

#if DEBUG

import Foundation
import MWDATCore
import MWDATMockDevice
import SwiftUI

extension MockDeviceCardView {
  @MainActor
  final class ViewModel: ObservableObject {
    let device: MockDevice
    @Published var hasCameraFeed: Bool = false
    @Published var hasCapturedImage: Bool = false
    @Published var isPoweredOn: Bool = false
    @Published var isDonned: Bool = false
    @Published var isUnfolded: Bool = false
    @Published var selectedFacing: CameraFacing = .back

    init(device: MockDevice, hasCameraFeed: Bool = false, hasCapturedImage: Bool = false) {
      self.device = device
      self.hasCameraFeed = hasCameraFeed
      self.hasCapturedImage = hasCapturedImage
    }

    var id: String { device.deviceIdentifier }

    /// Typed services accessor using MockDisplaylessGlassesServices
    private var glassesServices: MockDisplaylessGlassesServices? {
      (device as? MockDisplaylessGlasses)?.services
    }

    // Display name for the mock device in the UI
    var deviceName: String {
      if device is MockRaybanMeta {
        return "RayBan Meta Glasses"
      }
      return "Device"
    }

    func powerOn() {
      device.powerOn()
      isPoweredOn = true
    }

    func powerOff() {
      device.powerOff()
      isPoweredOn = false
      isDonned = false
      isUnfolded = false
    }

    func don() {
      device.don()
      isDonned = true
    }

    func doff() {
      device.doff()
      isDonned = false
    }

    func unfold() {
      if let rayBanDevice = device as? MockDisplaylessGlasses {
        rayBanDevice.unfold()
        isUnfolded = true
      }
    }

    func fold() {
      if let rayBanDevice = device as? MockDisplaylessGlasses {
        rayBanDevice.fold()
        isUnfolded = false
      }
    }

    // Load mock video content from file
    func selectVideo(from url: URL) {
      if let cameraKit = glassesServices?.camera {
        cameraKit.setCameraFeed(fileURL: url)
        hasCameraFeed = true
      }
    }

    // Use phone camera as mock feed (front or back via CameraFacing)
    func startLiveCameraFeed() async {
      if let cameraKit = glassesServices?.camera {
        await cameraKit.setCameraFeed(cameraFacing: selectedFacing)
        hasCameraFeed = true
      }
    }

    // Load mock image content
    func selectImage(from url: URL) {
      if let cameraKit = glassesServices?.camera {
        cameraKit.setCapturedImage(fileURL: url)
        hasCapturedImage = true
      }
    }

    // Toggle a permission via MockPermissions (accessed through MockDeviceKit)
    func togglePermission(_ permission: Permission, granted: Bool) {
      MockDeviceKit.shared.permissions.set(permission, granted ? .granted : .denied)
    }
  }
}

#endif
