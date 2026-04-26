/*
 * NowPlayingLowLevelTests.swift
 *
 * Brute-force C-level exploration of all private frameworks for Now Playing info.
 * Tries: SpringBoardServices, MediaRemote, Darwin notifications, CPDistributedMessaging.
 * Designed to be run on-device with music playing to find ANY working path.
 */

import Foundation
import MediaPlayer
import XCTest

@testable import CameraAccess

final class NowPlayingLowLevelTests: XCTestCase {

  private static var darwinFired = false

  // MARK: - 1. Enumerate ALL symbols in SpringBoardServices

  func testSpringBoardServicesSymbols() {
    guard let handle = dlopen(
      "/System/Library/PrivateFrameworks/SpringBoardServices.framework/SpringBoardServices",
      RTLD_LAZY
    ) else {
      XCTFail("dlopen SpringBoardServices failed")
      return
    }
    print("[LowLevel] SpringBoardServices loaded")

    // Try known functions
    let knownSymbols = [
      "SBSCopyNowPlayingAppBundleIdentifier",
      "SBSCopyNowPlayingInfo",
      "SBSCopyNowPlayingTitle",
      "SBSCopyNowPlayingArtist",
      "SBSCopyNowPlayingAlbum",
      "SBSCopyNowPlayingArtwork",
      "SBSCopyNowPlayingDuration",
      "SBSCopyNowPlayingElapsed",
      "SBSCopyNowPlayingIsPlaying",
      "SBSCopyNowPlayingPlaybackState",
      "SBSCopyFrontmostApplicationDisplayIdentifier",
      "SBSSpringBoardServerPort",
    ]

    for sym in knownSymbols {
      if let ptr = dlsym(handle, sym) {
        print("[LowLevel] SBS FOUND: \(sym) at \(ptr)")
      } else {
        print("[LowLevel] SBS MISSING: \(sym)")
      }
    }
  }

  // MARK: - 2. Try SBSCopyNowPlayingAppBundleIdentifier

  func testSBSCopyNowPlayingAppBundleIdentifier() {
    guard let handle = dlopen(
      "/System/Library/PrivateFrameworks/SpringBoardServices.framework/SpringBoardServices",
      RTLD_LAZY
    ) else {
      XCTFail("dlopen failed")
      return
    }

    // typedef CFStringRef (*SBSCopyNowPlayingAppBundleIdentifierFn)(void)
    if let ptr = dlsym(handle, "SBSCopyNowPlayingAppBundleIdentifier") {
      typealias Fn = @convention(c) () -> Unmanaged<CFString>?
      let fn = unsafeBitCast(ptr, to: Fn.self)
      if let result = fn() {
        let bundleID = result.takeUnretainedValue() as String
        print("[LowLevel] SBSCopyNowPlayingAppBundleIdentifier = \(bundleID)")
        XCTAssertFalse(bundleID.isEmpty, "Got a bundle ID!")
      } else {
        print("[LowLevel] SBSCopyNowPlayingAppBundleIdentifier returned nil")
      }
    } else {
      print("[LowLevel] SBSCopyNowPlayingAppBundleIdentifier symbol not found")
    }
  }

  // MARK: - 3. Try SBSCopyNowPlayingInfo (may exist on newer iOS)

  func testSBSCopyNowPlayingInfo() {
    guard let handle = dlopen(
      "/System/Library/PrivateFrameworks/SpringBoardServices.framework/SpringBoardServices",
      RTLD_LAZY
    ) else {
      XCTFail("dlopen failed")
      return
    }

    // Try CFDictionaryRef return variant
    if let ptr = dlsym(handle, "SBSCopyNowPlayingInfo") {
      typealias Fn = @convention(c) () -> CFDictionary?
      let fn = unsafeBitCast(ptr, to: Fn.self)
      if let info = fn() {
        let dict = info as NSDictionary
        print("[LowLevel] SBSCopyNowPlayingInfo returned \(dict.count) keys:")
        for (key, value) in dict {
          let valStr: String
          if let data = value as? Data {
            valStr = "Data(\(data.count) bytes)"
          } else {
            valStr = String(describing: value)
          }
          print("[LowLevel]   \(key): \(valStr)")
        }
      } else {
        print("[LowLevel] SBSCopyNowPlayingInfo returned nil")
      }
    } else {
      print("[LowLevel] SBSCopyNowPlayingInfo symbol not found (expected on older headers)")
    }
  }

  // MARK: - 4. Darwin notification for Now Playing changes

  func testDarwinNotificationNowPlaying() {
    let notificationName = "com.apple.MRMediaRemoteNowPlayingInfoDidChangeNotification" as CFString
    Self.darwinFired = false

    let _ = self.expectation(description: "Darwin notification for Now Playing")

    let center = CFNotificationCenterGetDarwinNotifyCenter()
    CFNotificationCenterAddObserver(
      center,
      Unmanaged.passUnretained(self).toOpaque(),
      { (_, observer, name, _, _) in
        guard let name = name else { return }
        print("[LowLevel] Darwin notification fired: \(name)")
        NowPlayingLowLevelTests.darwinFired = true
      },
      notificationName,
      nil,
      .deliverImmediately
    )

    // Also try the playback state change notification
    CFNotificationCenterAddObserver(
      center,
      Unmanaged.passUnretained(self).toOpaque(),
      { (_, observer, name, _, _) in
        guard let name = name else { return }
        print("[LowLevel] Darwin notification fired: \(name)")
      },
      "com.apple.MRMediaRemoteNowPlayingApplicationIsPlayingDidChangeNotification" as CFString,
      nil,
      .deliverImmediately
    )

    // Also try generic media change
    CFNotificationCenterAddObserver(
      center,
      Unmanaged.passUnretained(self).toOpaque(),
      { (_, observer, name, _, _) in
        guard let name = name else { return }
        print("[LowLevel] Darwin notification fired: \(name)")
      },
      "com.apple.MediaPlayer.nowPlayingInfoChanged" as CFString,
      nil,
      .deliverImmediately
    )

    // Wait up to 15s for a notification
    waitForExpectations(timeout: 15)

    if Self.darwinFired {
      print("[LowLevel] Darwin notification DID fire — Now Playing changes ARE observable")
    } else {
      print("[LowLevel] Darwin notification did NOT fire in 15s")
    }

    CFNotificationCenterRemoveObserver(center, Unmanaged.passUnretained(self).toOpaque(), nil, nil)
  }

  // MARK: - 5. Try MRMediaRemoteGetNowPlayingClient (tells us WHO is playing)

  func testMediaRemoteGetNowPlayingClient() {
    guard let handle = dlopen(
      "/System/Library/PrivateFrameworks/MediaRemote.framework/MediaRemote",
      RTLD_LAZY
    ) else {
      XCTFail("dlopen failed")
      return
    }

    // Try to get the playing client (bundle identifier of who's playing)
    if let ptr = dlsym(handle, "MRMediaRemoteGetNowPlayingClient") {
      // void MRMediaRemoteGetNowPlayingClient(DispatchQueue, callback)
      typealias Fn = @convention(c) (DispatchQueue, @escaping (AnyObject?) -> Void) -> Void
      let fn = unsafeBitCast(ptr, to: Fn.self)
      let exp = self.expectation(description: "MRMediaRemoteGetNowPlayingClient")
      var result: AnyObject?

      fn(DispatchQueue.global()) { client in
        result = client
        exp.fulfill()
      }

      waitForExpectations(timeout: 5)

      if let client = result {
        print("[LowLevel] MRMediaRemoteGetNowPlayingClient returned: \(type(of: client))")
        print("[LowLevel]   description: \(client)")

        // Try to extract bundle identifier via selector
        if client.responds(to: NSSelectorFromString("bundleIdentifier")) {
          let bid = client.value(forKey: "bundleIdentifier")
          print("[LowLevel]   bundleIdentifier: \(bid ?? "nil")")
        }
        if client.responds(to: NSSelectorFromString("parentAppBundleIdentifier")) {
          let pid = client.value(forKey: "parentAppBundleIdentifier")
          print("[LowLevel]   parentAppBundleIdentifier: \(pid ?? "nil")")
        }
        if client.responds(to: NSSelectorFromString("displayName")) {
          let dn = client.value(forKey: "displayName")
          print("[LowLevel]   displayName: \(dn ?? "nil")")
        }

        // Log all properties
        let mirror = Mirror(reflecting: client)
        print("[LowLevel]   Mirror children:")
        for child in mirror.children {
          print("[LowLevel]     \(child.label ?? "_"): \(child.value)")
        }
      } else {
        print("[LowLevel] MRMediaRemoteGetNowPlayingClient returned nil")
      }
    } else {
      print("[LowLevel] MRMediaRemoteGetNowPlayingClient symbol not found")
    }
  }

  // MARK: - 6. Try MRMediaRemoteGetNowPlayingApplicationIsPlaying

  func testMediaRemoteIsPlaying() {
    guard let handle = dlopen(
      "/System/Library/PrivateFrameworks/MediaRemote.framework/MediaRemote",
      RTLD_LAZY
    ) else {
      XCTFail("dlopen failed")
      return
    }

    if let ptr = dlsym(handle, "MRMediaRemoteGetNowPlayingApplicationIsPlaying") {
      // void MRMediaRemoteGetNowPlayingApplicationIsPlaying(DispatchQueue, callback(BOOL))
      typealias Fn = @convention(c) (DispatchQueue, @escaping (Bool) -> Void) -> Void
      let fn = unsafeBitCast(ptr, to: Fn.self)
      let exp = self.expectation(description: "MRMediaRemoteGetNowPlayingApplicationIsPlaying")
      var playing = false

      fn(DispatchQueue.global()) { isPlaying in
        playing = isPlaying
        exp.fulfill()
      }

      waitForExpectations(timeout: 5)
      print("[LowLevel] MRMediaRemoteGetNowPlayingApplicationIsPlaying = \(playing)")
    } else {
      print("[LowLevel] MRMediaRemoteGetNowPlayingApplicationIsPlaying symbol not found")
    }
  }

  // MARK: - 7. Enumerate ALL MediaRemote symbols with "NowPlaying" or "Playing"

  func testEnumerateMediaRemoteSymbols() {
    guard let handle = dlopen(
      "/System/Library/PrivateFrameworks/MediaRemote.framework/MediaRemote",
      RTLD_LAZY
    ) else {
      XCTFail("dlopen failed")
      return
    }

    // dlsym can't enumerate, but we can check known symbols
    let symbols = [
      "MRMediaRemoteGetNowPlayingInfo",
      "MRMediaRemoteGetNowPlayingClient",
      "MRMediaRemoteGetNowPlayingApplicationIsPlaying",
      "MRMediaRemoteRegisterForNowPlayingNotifications",
      "MRMediaRemoteGetNowPlayingInfoForClient",
      "MRMediaRemoteGetNowPlayingClients",
      "MRMediaRemoteSendCommandToClient",
      "MRNowPlayingClientGetBundleIdentifier",
      "MRNowPlayingClientGetParentAppBundleIdentifier",
      "MRNowPlayingClientGetType",
      "MRNowPlayingClientGetDisplayName",
      "MRNowPlayingClientIsLocal",
      "MRNowPlayingRequestCreateForBundleID",
      "MRNowPlayingRequestCreateForClient",
      "MRNowPlayingRequestGetNowPlayingInfo",
      "MRNowPlayingRequestGetNowPlayingClient",
      "MRMediaRemoteCopyNowPlayingApplicationBundleIdentifier",
      "MRMediaRemoteCopyNowPlayingInfo",
      "MRMediaRemoteGetNowPlayingPlaybackState",
      "MRMediaRemoteSetNowPlayingInfoWithClientID",
      "kMRMediaRemoteNowPlayingInfoTitle",
      "kMRMediaRemoteNowPlayingInfoArtist",
      "kMRMediaRemoteNowPlayingInfoAlbum",
      "kMRMediaRemoteNowPlayingInfoArtworkData",
      "kMRMediaRemoteNowPlayingInfoDuration",
      "kMRMediaRemoteNowPlayingInfoElapsedPlaybackTime",
      "kMRMediaRemoteNowPlayingInfoPlaybackQueueCount",
      "kMRMediaRemoteNowPlayingInfoPlaybackQueueIndex",
    ]

    print("[LowLevel] === MediaRemote symbol scan ===")
    for sym in symbols {
      if dlsym(handle, sym) != nil {
        print("[LowLevel]   FOUND: \(sym)")
      }
    }
    print("[LowLevel] === End scan ===")
  }

  // MARK: - 8. Try notify_ API via dlsym

  func testNotifyRegister() {
    // notify_register_dispatch is a C function we can call directly via libSystem
    typealias RegisterFn = @convention(c) (UnsafePointer<CChar>, UnsafeMutablePointer<Int32>, DispatchQueue, @convention(c) (UnsafeMutableRawPointer?) -> Void) -> Int32
    typealias CancelFn = @convention(c) (Int32) -> Int32

    guard let registerPtr = dlsym(dlopen(nil, RTLD_LAZY), "notify_register_dispatch"),
          let cancelPtr = dlsym(dlopen(nil, RTLD_LAZY), "notify_cancel") else {
      print("[LowLevel] notify functions not found")
      return
    }

    let register = unsafeBitCast(registerPtr, to: RegisterFn.self)
    let cancel = unsafeBitCast(cancelPtr, to: CancelFn.self)

    var token: Int32 = 0
    let status = register(
      "com.apple.MRMediaRemoteNowPlayingInfoDidChangeNotification",
      &token,
      DispatchQueue.global()
    ) { _ in
      print("[LowLevel] notify_register fired for Now Playing change!")
    }

    print("[LowLevel] notify_register_dispatch status: \(status) (0 = OK)")

    let exp = self.expectation(description: "notify wait")
    exp.isInverted = true
    waitForExpectations(timeout: 5)

    if token != 0 {
      _ = cancel(token)
    }
  }
}
