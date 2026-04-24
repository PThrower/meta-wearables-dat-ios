/*
 * DeviceIdentity.swift
 *
 * Provides a stable device identifier that survives app reinstalls.
 * Uses iOS Keychain to persist a UUID across app deletions and reinstalls.
 *
 * Keychain items with kSecAttrAccessibleAfterFirstUnlock survive app
 * reinstall and deletion (since iOS 10.3+). This gives us a persistent
 * device identity without requiring enterprise entitlements.
 *
 * Pattern matches GoogleAuthService.swift and PushNotificationService.swift.
 */

import Foundation
import Security
import UIKit

final class DeviceIdentity {
    static let shared = DeviceIdentity()

    private let keychainService: String
    private let keychainAccount = "device-stable-id"

    private init() {
        keychainService = Bundle.main.bundleIdentifier ?? "com.mwdat-ios"
    }

    /// Stable device ID that survives app reinstalls.
    /// Returns Keychain-persisted UUID, falls back to identifierForVendor only
    /// if Keychain is completely unavailable (e.g. device wiped).
    var stableDeviceId: String {
        if let existing = readFromKeychain() {
            return existing
        }
        let newId = UUID().uuidString
        writeToKeychain(value: newId)
        return newId
    }

    // MARK: - Keychain

    private func readFromKeychain() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: keychainAccount,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess, let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private func writeToKeychain(value: String) {
        guard let data = value.data(using: .utf8) else { return }

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: keychainAccount,
        ]

        // Try update first, then add if not found
        let updateStatus = SecItemUpdate(
            query as CFDictionary,
            [kSecValueData as String: data] as CFDictionary
        )

        if updateStatus == errSecItemNotFound {
            var addQuery = query
            addQuery[kSecValueData as String] = data
            addQuery[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
            let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
            if addStatus != errSecSuccess {
                NSLog("[DeviceIdentity] Keychain write failed: \(addStatus)")
            }
        } else if updateStatus != errSecSuccess {
            NSLog("[DeviceIdentity] Keychain update failed: \(updateStatus)")
        }
    }
}
