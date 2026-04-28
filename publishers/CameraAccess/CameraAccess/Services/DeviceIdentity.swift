/*
 * DeviceIdentity.swift
 *
 * Provides a stable device identifier that survives app reinstalls.
 *
 * Strategy (in priority order):
 * 1. UIDevice.identifierForVendor — Apple-guaranteed stable per-device per-vendor.
 *    Survives app reinstalls. Only resets if ALL apps from this vendor are deleted.
 * 2. Keychain-persisted UUID — fallback for scenarios where identifierForVendor
 *    is nil (rare: first launch before system settles).
 *
 * Previously used random UUIDs persisted to Keychain keyed by bundleIdentifier,
 * which created duplicate device rows when bundle ID changed or Keychain was cleared.
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

    /// Stable device ID — identifierForVendor (primary) with Keychain fallback.
    var stableDeviceId: String {
        // Primary: Apple's per-device-per-vendor ID
        if let ifv = UIDevice.current.identifierForVendor?.uuidString {
            // Keep Keychain in sync so migration is transparent
            if readFromKeychain() != ifv {
                writeToKeychain(value: ifv)
            }
            return ifv
        }
        // Fallback: Keychain-persisted value (from previous session)
        if let existing = readFromKeychain() {
            return existing
        }
        // Last resort: generate and persist (shouldn't normally happen)
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
