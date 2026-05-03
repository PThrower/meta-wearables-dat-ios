/*
 * RelayErrorTests.swift
 *
 * Unit tests for RelayError enum — error descriptions.
 * No SDK dependencies required.
 */

import Foundation
import XCTest

@testable import CameraAccess

final class RelayErrorTests: XCTestCase {

    func testInvalidURLDescription() {
        let error = RelayError.invalidURL("not-a-url")
        XCTAssertEqual(error.localizedDescription, "Invalid relay URL: not-a-url")
    }

    func testNotConnectedDescription() {
        let error = RelayError.notConnected
        XCTAssertEqual(error.localizedDescription, "Relay not connected")
    }

    func testConnectionFailedDescription() {
        let error = RelayError.connectionFailed("ws://example.com")
        XCTAssertEqual(error.localizedDescription, "Failed to connect to relay: ws://example.com")
    }
}
