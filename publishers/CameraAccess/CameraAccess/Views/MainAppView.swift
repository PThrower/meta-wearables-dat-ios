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

import SwiftUI

#if DEBUG
import MWDATMockDevice
#endif

struct MainAppView: View {
  @EnvironmentObject private var wearablesVM: WearablesViewModel
  var pushService: PushNotificationService

  #if DEBUG
  var mockDeviceViewModel: MockDeviceKitView.ViewModel
  #endif

  var body: some View {
    if wearablesVM.registrationState == .registered || wearablesVM.hasMockDevice {
      #if DEBUG
      StreamSessionView(pushService: pushService, mockDeviceViewModel: mockDeviceViewModel)
      #else
      StreamSessionView(pushService: pushService)
      #endif
    } else {
      // User not registered - show registration/onboarding flow
      HomeScreenView(viewModel: wearablesVM)
    }
  }
}
