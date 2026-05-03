/*
 * EnumTests.swift
 *
 * Unit tests for StreamingStatus and AudioInputMode.
 * Verifies enum contract integrity — no SDK dependencies.
 *
 * DeviceType tests are in the integration test target since they require MWDATCore.
 */

import Foundation
import XCTest

@testable import CameraAccess

// MARK: - StreamingStatus

final class StreamingStatusTests: XCTestCase {

    func testCasesAreDistinct() {
        XCTAssertNotEqual(StreamingStatus.streaming, .waiting)
        XCTAssertNotEqual(StreamingStatus.streaming, .stopped)
        XCTAssertNotEqual(StreamingStatus.waiting, .stopped)
    }

    func testAllCasesExist() {
        let _: [StreamingStatus] = [.streaming, .waiting, .stopped]
    }
}

// MARK: - AudioInputMode

final class AudioInputModeTests: XCTestCase {

    func testAllCases() {
        XCTAssertEqual(AudioInputMode.allCases.count, 3)
        XCTAssertTrue(AudioInputMode.allCases.contains(.builtInMic))
        XCTAssertTrue(AudioInputMode.allCases.contains(.glassesMic))
        XCTAssertTrue(AudioInputMode.allCases.contains(.all))
    }

    func testRawValues() {
        XCTAssertEqual(AudioInputMode.builtInMic.rawValue, "Phone Mic")
        XCTAssertEqual(AudioInputMode.glassesMic.rawValue, "Glasses Mic")
        XCTAssertEqual(AudioInputMode.all.rawValue, "All")
    }

    func testIdentifiable() {
        let ids = Set(AudioInputMode.allCases.map { $0.id })
        XCTAssertEqual(ids.count, 3, "All AudioInputMode cases should have unique IDs")
    }

    func testSystemImages() {
        for mode in AudioInputMode.allCases {
            XCTAssertFalse(mode.systemImage.isEmpty, "\(mode.rawValue) should have a system image")
        }
    }
}
