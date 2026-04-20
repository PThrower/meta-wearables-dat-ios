/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the
 * LICENSE file in the root directory of this source tree.
 */

//
// MainAppView.swift
//
// Central navigation hub that displays different views based on DAT SDK registration and device states.
// When unregistered, shows the registration flow. When registered, shows the device selection screen
// for choosing which Meta wearable device to stream from.
//

import MWDATCore
import SwiftUI

#if DEBUG
import MWDATMockDevice
#endif

struct MainAppView: View {
  let wearables: WearablesInterface
  @ObservedObject private var viewModel: WearablesViewModel
  @ObservedObject private var telemetryService: TelemetryService
  var pushNotificationService: PushNotificationService?

  #if DEBUG
  @ObservedObject var mockDeviceViewModel: MockDeviceKitView.ViewModel

  init(wearables: WearablesInterface, viewModel: WearablesViewModel, telemetryService: TelemetryService, mockDeviceViewModel: MockDeviceKitView.ViewModel, pushNotificationService: PushNotificationService? = nil) {
    self.wearables = wearables
    self.viewModel = viewModel
    self._telemetryService = ObservedObject(wrappedValue: telemetryService)
    self._mockDeviceViewModel = ObservedObject(wrappedValue: mockDeviceViewModel)
    self.pushNotificationService = pushNotificationService
  }
  #else
  init(wearables: WearablesInterface, viewModel: WearablesViewModel, telemetryService: TelemetryService, pushNotificationService: PushNotificationService? = nil) {
    self.wearables = wearables
    self.viewModel = viewModel
    self._telemetryService = ObservedObject(wrappedValue: telemetryService)
    self.pushNotificationService = pushNotificationService
  }
  #endif

  var body: some View {
    if viewModel.registrationState == .registered || viewModel.hasMockDevice {
      #if DEBUG
      StreamSessionView(
        wearables: wearables,
        wearablesVM: viewModel,
        telemetryService: telemetryService,
        mockDeviceVM: mockDeviceViewModel,
        pushNotificationService: pushNotificationService
      )
      #else
      StreamSessionView(
        wearables: wearables,
        wearablesVM: viewModel,
        telemetryService: telemetryService,
        pushNotificationService: pushNotificationService
      )
      #endif
    } else {
      // User not registered - show registration/onboarding flow
      HomeScreenView(viewModel: viewModel)
    }
  }
}
