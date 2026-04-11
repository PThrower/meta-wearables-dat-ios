/*
 * GoogleAuthService.swift
 *
 * Acquires Google ID tokens using ASWebAuthenticationSession.
 * Stores the token in the iOS Keychain for persistence across app launches.
 *
 * Prerequisites:
 *   - GCP OAuth client ID for iOS configured in Info.plist (GIDClientID)
 *   - Custom URL scheme registered in CFBundleURLTypes
 *   - Doppler secrets: GOOGLE_IOS_CLIENT_ID, GOOGLE_IOS_CLIENT_SECRET
 */

import AuthenticationServices
import Foundation
import Security

actor GoogleAuthService {
    // OAuth configuration -- read from Info.plist at init
    private let clientId: String
    private let clientSecret: String
    private let redirectURI: String
    private let keychainService = "com.caringmind.relay.auth"

    // Google OAuth endpoints
    private let authEndpoint = "https://accounts.google.com/o/oauth2/v2/auth"
    private let tokenEndpoint = "https://oauth2.googleapis.com/token"

    init() {
        // Read client ID from Info.plist (GIDClientID key)
        let bundle = Bundle.main
        self.clientId = bundle.object(forInfoDictionaryKey: "GIDClientID") as? String
            ?? ProcessInfo.processInfo.environment["GOOGLE_IOS_CLIENT_ID"] ?? ""
        self.clientSecret = ProcessInfo.processInfo.environment["GOOGLE_IOS_CLIENT_SECRET"] ?? ""
        // Redirect URI uses the custom scheme registered in Info.plist
        let bundleId = bundle.bundleIdentifier ?? "com.caringmind.CameraAccess"
        self.redirectURI = "\(bundleId):/oauth2redirect"
    }

    // MARK: - Public API

    /// Get a valid ID token. Returns cached token if available, otherwise prompts for auth.
    func getIdToken() async throws -> String {
        // Check Keychain for cached token
        if let cached = loadFromKeychain() {
            return cached
        }
        // No cached token -- start OAuth flow
        return try await authenticate()
    }

    /// Force a new authentication (e.g., after 401 from server).
    func reauthenticate() async throws -> String {
        removeFromKeychain()
        return try await authenticate()
    }

    /// Clear stored credentials.
    func signOut() {
        removeFromKeychain()
    }

    // MARK: - OAuth Flow

    private func authenticate() async throws -> String {
        guard !clientId.isEmpty else {
            throw GoogleAuthError.missingClientId
        }

        // Build authorization URL
        let scope = "openid%20email%20profile"
        let state = UUID().uuidString
        let codeVerifier = generateCodeVerifier()
        let codeChallenge = generateCodeChallenge(from: codeVerifier)

        var components = URLComponents(string: authEndpoint)!
        components.queryItems = [
            URLQueryItem(name: "client_id", value: clientId),
            URLQueryItem(name: "redirect_uri", value: redirectURI),
            URLQueryItem(name: "response_type", value: "code"),
            URLQueryItem(name: "scope", value: scope),
            URLQueryItem(name: "state", value: state),
            URLQueryItem(name: "code_challenge", value: codeChallenge),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
        ]

        guard let authURL = components.url else {
            throw GoogleAuthError.invalidURL
        }

        // Extract custom scheme from redirect URI
        let scheme = redirectURI.components(separatedBy: ":").first

        // Use ASWebAuthenticationSession to open the Google sign-in page
        let callbackURL = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<URL, Error>) in
            let session = ASWebAuthenticationSession(
                url: authURL,
                callbackURLScheme: scheme
            ) { callbackURL, error in
                if let error {
                    continuation.resume(throwing: error)
                } else if let callbackURL {
                    continuation.resume(returning: callbackURL)
                } else {
                    continuation.resume(throwing: GoogleAuthError.cancelled)
                }
            }
            session.start()
        }

        // Extract authorization code from callback
        guard let callbackComponents = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false),
              let codeItem = callbackComponents.queryItems?.first(where: { $0.name == "code" }),
              let code = codeItem.value else {
            throw GoogleAuthError.missingAuthCode
        }

        // Exchange code for tokens
        let tokenResponse = try await exchangeCode(code, codeVerifier: codeVerifier)
        guard let idToken = tokenResponse.idToken else {
            throw GoogleAuthError.missingIdToken
        }

        // Store in Keychain
        saveToKeychain(idToken)
        return idToken
    }

    private func exchangeCode(_ code: String, codeVerifier: String) async throws -> TokenResponse {
        var request = URLRequest(url: URL(string: tokenEndpoint)!)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")

        let params = [
            "code": code,
            "client_id": clientId,
            "client_secret": clientSecret,
            "redirect_uri": redirectURI,
            "grant_type": "authorization_code",
            "code_verifier": codeVerifier,
        ]

        request.httpBody = params.map { "\($0.key)=\($0.value)" }.joined(separator: "&").data(using: .utf8)

        let (data, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse,
              (200...299).contains(httpResponse.statusCode) else {
            throw GoogleAuthError.tokenExchangeFailed
        }

        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
        return TokenResponse(
            accessToken: json["access_token"] as? String,
            idToken: json["id_token"] as? String,
            refreshToken: json["refresh_token"] as? String,
            expiresIn: json["expires_in"] as? Int
        )
    }

    // MARK: - PKCE Helpers

    private func generateCodeVerifier() -> String {
        var buffer = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, buffer.count, &buffer)
        return Data(buffer).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
            .trimmingCharacters(in: .whitespaces)
    }

    private func generateCodeChallenge(from verifier: String) -> String {
        guard let data = verifier.data(using: .ascii) else { return "" }
        var hash = [UInt8](repeating: 0, count: Int(CC_SHA256_DIGEST_LENGTH))
        data.withUnsafeBytes {
            _ = CC_SHA256($0.baseAddress, CC_LONG(data.count), &hash)
        }
        return Data(hash).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
            .trimmingCharacters(in: .whitespaces)
    }

    // MARK: - Keychain

    private func saveToKeychain(_ token: String) {
        let data = token.data(using: .utf8) ?? Data()
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: "id_token",
        ] as [String: Any]
        SecItemDelete(query as CFDictionary)
        var addQuery = query
        addQuery[kSecValueData as String] = data
        SecItemAdd(addQuery as CFDictionary, nil)
    }

    private func loadFromKeychain() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: "id_token",
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ] as [String: Any]
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess, let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private func removeFromKeychain() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: "id_token",
        ] as [String: Any]
        SecItemDelete(query as CFDictionary)
    }
}

// MARK: - Supporting Types

private struct TokenResponse {
    let accessToken: String?
    let idToken: String?
    let refreshToken: String?
    let expiresIn: Int?
}

enum GoogleAuthError: LocalizedError {
    case missingClientId
    case invalidURL
    case cancelled
    case missingAuthCode
    case tokenExchangeFailed
    case missingIdToken

    var errorDescription: String? {
        switch self {
        case .missingClientId: return "Google client ID not configured"
        case .invalidURL: return "Invalid OAuth URL"
        case .cancelled: return "Sign-in cancelled"
        case .missingAuthCode: return "Authorization code not received"
        case .tokenExchangeFailed: return "Token exchange failed"
        case .missingIdToken: return "ID token not received"
        }
    }
}

// Needed for CC_SHA256
import CommonCrypto
