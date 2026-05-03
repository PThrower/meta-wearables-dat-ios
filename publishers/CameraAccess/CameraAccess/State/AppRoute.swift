//
// AppRoute.swift
//
// Navigation routes for the app's NavigationStack.
//

import SwiftUI

enum AppRoute: Hashable {
  case settings(mode: SettingsMode)
  case photoPreview
  case appPicker
  case errorLog
}
