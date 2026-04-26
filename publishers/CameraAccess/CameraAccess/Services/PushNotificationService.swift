//
// PushNotificationService.swift
//
// Manages APNs remote push notifications for wake-on-demand.
// Receives device token, sends it to the relay server, and handles
// incoming silent pushes that trigger standby WebSocket reconnection.
//

import Foundation
import UIKit
import UserNotifications

@MainActor
final class PushNotificationService: ObservableObject {

  /// Called when a silent push with wake:"standby" is received.
  var onWakeFromPush: (() -> Void)?

  // MARK: - Authorization

  /// Request push notification authorization from the user.
  func requestAuthorization() async {
    do {
      let center = UNUserNotificationCenter.current()
      let granted = try await center.requestAuthorization(options: [.alert, .sound, .badge])
      NSLog("[PushNotification] Authorization granted: \(granted)")
      if granted {
        await MainActor.run {
          UIApplication.shared.registerForRemoteNotifications()
        }
      }
    } catch {
      NSLog("[PushNotification] Authorization failed: \(error)")
    }
  }

  // MARK: - Device Token

  /// Handle device token received from APNs. Converts to hex string,
  /// persists to Keychain, and sends to relay server.
  func handleDeviceToken(_ deviceToken: Data) {
    let hexToken = deviceToken.map { String(format: "%02x", $0) }.joined()
    NSLog("[PushNotification] Device token: \(hexToken.prefix(16))...")

    // Persist to Keychain for re-sending on future launches
    persistTokenToKeychain(hexToken)

    // Send to relay server
    sendTokenToServer(hexToken)
  }

  /// Re-send stored token to server (called on each app launch).
  func resendStoredToken() {
    guard let token = loadTokenFromKeychain() else { return }
    NSLog("[PushNotification] Re-sending stored token to server")
    sendTokenToServer(token)
  }

  // MARK: - Incoming Push

  /// Handle incoming remote notification. Detects silent wake pushes
  /// and fires the onWakeFromPush callback.
  func handleIncomingPush(userInfo: [AnyHashable: Any],
                          completionHandler: @escaping (UIBackgroundFetchResult) -> Void) {
    NSLog("[PushNotification] Received push: \(userInfo)")

    // Check for silent wake push
    let contentAvailable = userInfo["aps"] as? [String: Any]
    let hasContentAvailable = contentAvailable?["content-available"] as? Int == 1
    let wakeType = userInfo["wake"] as? String

    if hasContentAvailable && wakeType == "standby" {
      NSLog("[PushNotification] Silent wake push received — triggering standby connect")
      onWakeFromPush?()
      completionHandler(.newData)
      return
    }

    completionHandler(.noData)
  }

  // MARK: - Server Communication

  private func sendTokenToServer(_ token: String) {
    let deviceId = DeviceIdentity.shared.stableDeviceId

    guard let relayURL = getRelayURL() else {
      NSLog("[PushNotification] No relay URL configured — skipping token registration")
      return
    }

    guard let url = URL(string: "\(relayURL)/api/device-token") else {
      NSLog("[PushNotification] Invalid relay URL for device token registration")
      return
    }
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")

    let body: [String: String] = [
      "deviceId": deviceId,
      "deviceToken": token,
      "platform": "ios",
      "bundleId": Bundle.main.bundleIdentifier ?? "unknown",
    ]

    do {
      request.httpBody = try JSONSerialization.data(withJSONObject: body)
    } catch {
      NSLog("[PushNotification] Failed to serialize token payload: \(error)")
      return
    }

    URLSession.shared.dataTask(with: request) { data, response, error in
      if let error = error {
        NSLog("[PushNotification] Token registration failed: \(error)")
        return
      }
      if let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 {
        NSLog("[PushNotification] Token registered with server")
      } else {
        NSLog("[PushNotification] Token registration returned non-200: \(String(describing: response))")
      }
    }.resume()
  }

  // MARK: - Keychain Persistence

  private static let tokenKey = "com.mwdat.apns-device-token"

  private func persistTokenToKeychain(_ token: String) {
    guard let data = token.data(using: .utf8) else { return }
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrAccount as String: Self.tokenKey,
      kSecAttrService as String: Bundle.main.bundleIdentifier ?? "com.mwdat-ios",
    ]
    SecItemDelete(query as CFDictionary)
    var addQuery = query
    addQuery[kSecValueData as String] = data
    SecItemAdd(addQuery as CFDictionary, nil)
  }

  private func loadTokenFromKeychain() -> String? {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrAccount as String: Self.tokenKey,
      kSecAttrService as String: Bundle.main.bundleIdentifier ?? "com.mwdat-ios",
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var result: AnyObject?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    guard status == errSecSuccess, let data = result as? Data else { return nil }
    return String(data: data, encoding: .utf8)
  }

  // MARK: - Relay URL

  /// Derives the HTTP base URL for the relay server from the WebSocket URL.
  /// Converts wss://relay.simulationapi.com/publish -> https://relay.simulationapi.com
  private func getRelayURL() -> String? {
    // Use the same default as StreamSessionViewModel
    let wsURL = ProcessInfo.processInfo.environment["RELAY_URL"]
      ?? "wss://relay.simulationapi.com/publish"

    return wsToHTTP(wsURL)
  }

  /// Convert a WebSocket URL to an HTTP base URL.
  /// wss://host/path -> https://host, ws://host:port/path -> http://host:port
  private func wsToHTTP(_ ws: String) -> String? {
    var base = ws
    if base.hasPrefix("wss://") {
      base = "https://" + String(base.dropFirst(6))
    } else if base.hasPrefix("ws://") {
      base = "http://" + String(base.dropFirst(5))
    } else if !base.hasPrefix("http") {
      return nil
    }
    // Strip path components (e.g. /publish) — keep scheme + host + port only
    if let schemeEnd = base.range(of: "://") {
      let afterScheme = base[schemeEnd.upperBound...]
      if let slashIdx = afterScheme.firstIndex(of: "/") {
        base = String(base[..<slashIdx])
      }
    }
    return base
  }

}
