import Foundation

/// Local-only device abstraction representing the phone camera.
/// Not a DAT SDK device -- exists only in the app's device picker UI.
struct PhoneDevice: Sendable {
    let id: String = "__phone_camera__"
    let name: String = "iPhone Camera"
    let systemImage: String = "iphone.gen3.camera"

    static let shared = PhoneDevice()
}
