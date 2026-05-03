import XCTest
import MediaPlayer
@testable import CameraAccess

final class NowPlayingTests: XCTestCase {

  // MARK: - MediaRemote direct call

  /// Load MediaRemote and call MRMediaRemoteGetNowPlayingInfo directly.
  /// Logs every key in the returned dictionary so we can see what's available.
  func testMediaRemoteGetNowPlayingInfo() {
    guard let handle = dlopen(
      "/System/Library/PrivateFrameworks/MediaRemote.framework/MediaRemote",
      RTLD_LAZY
    ) else {
      XCTFail("dlopen MediaRemote.framework failed — framework not available on this device")
      return
    }

    typealias GetInfoFn = @convention(c) (DispatchQueue, @escaping (NSDictionary?) -> Void) -> Void
    guard let sym = dlsym(handle, "MRMediaRemoteGetNowPlayingInfo") else {
      XCTFail("dlsym MRMediaRemoteGetNowPlayingInfo failed — symbol not found")
      return
    }

    let fn = unsafeBitCast(sym, to: GetInfoFn.self)
    let expectation = self.expectation(description: "MRMediaRemoteGetNowPlayingInfo callback")
    var result: NSDictionary?

    fn(DispatchQueue.global()) { info in
      result = info
      expectation.fulfill()
    }

    waitForExpectations(timeout: 5)

    guard let info = result else {
      print("[NowPlayingTest] MRMediaRemoteGetNowPlayingInfo returned nil")
      XCTFail("MRMediaRemoteGetNowPlayingInfo returned nil — no media playing or framework blocked")
      return
    }

    // Log every key/value
    print("[NowPlayingTest] === MediaRemote dictionary (\(info.count) keys) ===")
    for (key, value) in info {
      let valStr: String
      if let data = value as? Data {
        valStr = "Data(\(data.count) bytes)"
      } else {
        valStr = String(describing: value)
      }
      print("[NowPlayingTest]   \(key): \(valStr)")
    }

    // Check expected keys
    let title = info["kMRMediaRemoteNowPlayingInfoTitle"] as? String
    let artist = info["kMRMediaRemoteNowPlayingInfoArtist"] as? String
    let album = info["kMRMediaRemoteNowPlayingInfoAlbum"] as? String

    print("[NowPlayingTest] title=\(title ?? "nil") artist=\(artist ?? "nil") album=\(album ?? "nil")")

    // Not failing if title is nil — test documents what the device returns
    if title == nil || title!.isEmpty {
      print("[NowPlayingTest] WARNING: No title found. Is music actually playing?")
    }
  }

  // MARK: - MediaRemote subscribe + notification

  /// Register for MediaRemote notifications and wait for one to fire.
  func testMediaRemoteNotification() {
    guard let handle = dlopen(
      "/System/Library/PrivateFrameworks/MediaRemote.framework/MediaRemote",
      RTLD_LAZY
    ) else {
      XCTFail("dlopen failed")
      return
    }

    // Register for notifications
    typealias SubscribeFn = @convention(c) (DispatchQueue) -> Void
    guard let subSym = dlsym(handle, "MRMediaRemoteRegisterForNowPlayingNotifications") else {
      XCTFail("dlsym MRMediaRemoteRegisterForNowPlayingNotifications failed")
      return
    }
    unsafeBitCast(subSym, to: SubscribeFn.self)(DispatchQueue.main)

    let expectation = self.expectation(description: "kMRMediaRemoteNowPlayingInfoDidChangeNotification")
    var notificationFired = false

    let observer = NotificationCenter.default.addObserver(
      forName: NSNotification.Name("kMRMediaRemoteNowPlayingInfoDidChangeNotification"),
      object: nil, queue: .main
    ) { _ in
      notificationFired = true
      expectation.fulfill()
    }

    waitForExpectations(timeout: 10)
    NotificationCenter.default.removeObserver(observer)

    if notificationFired {
      print("[NowPlayingTest] MediaRemote notification DID fire")
    } else {
      print("[NowPlayingTest] MediaRemote notification did NOT fire within 10s")
    }
  }

  // MARK: - MPNowPlayingInfoCenter

  func testMPNowPlayingInfoCenter() {
    let info = MPNowPlayingInfoCenter.default().nowPlayingInfo
    if let info {
      print("[NowPlayingTest] MPNowPlayingInfoCenter returned \(info.count) keys:")
      for (key, value) in info {
        print("[NowPlayingTest]   \(key): \(value)")
      }
    } else {
      print("[NowPlayingTest] MPNowPlayingInfoCenter returned nil")
    }
  }

  // MARK: - MPMusicPlayerController (Apple Music only)

  func testMPMusicPlayerController() {
    let item = MPMusicPlayerController.systemMusicPlayer.nowPlayingItem
    if let item {
      print("[NowPlayingTest] Apple Music nowPlayingItem: title=\(item.title ?? "nil") artist=\(item.artist ?? "nil") album=\(item.albumTitle ?? "nil")")
    } else {
      print("[NowPlayingTest] Apple Music nowPlayingItem is nil")
    }
  }
}
