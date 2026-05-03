//
// ErrorStore.swift
//
// Error presentation and logging state.
//

import SwiftUI

@MainActor
@Observable
final class ErrorStore {

  var showError: Bool = false
  var errorMessage: String = ""
  var errorLog: [String] = []

  func logError(_ message: String) {
    let timestamp = DateFormatter.localizedString(from: Date(), dateStyle: .none, timeStyle: .medium)
    errorLog.append("[\(timestamp)] \(message)")
    if errorLog.count > 100 {
      errorLog.removeFirst(errorLog.count - 100)
    }
    NSLog("[ErrorStore] \(message)")
  }

  func present(_ message: String) {
    logError(message)
    errorMessage = message
    showError = true
  }

  func dismissError() {
    showError = false
    errorMessage = ""
  }
}
