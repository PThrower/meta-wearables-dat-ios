# MWDAT SDK Technical Analysis

This document provides a comprehensive technical analysis of the Meta Wearables Device Access Toolkit (MWDAT) iOS SDK frameworks extracted from the built XCFrameworks.

## Overview

The MWDAT SDK consists of three main frameworks:
- **MWDATCore.xcframework**: Core SDK for device connectivity and basic functionality
- **MWDATCamera.xcframework**: Camera module for video streaming and photo capture
- **MWDATMockDevice.xcframework**: Mock device support for development and testing (debug builds only)

## Architecture & Design Patterns

### Swift 6 Modern Features
The SDK is built with Swift 6 and leverages advanced language features:

```swift
// Modern concurrency with MainActor
@_Concurrency.MainActor public protocol WearablesInterface

// Move-only types with ~Copyable
public struct Mutex<Value> : ~Swift.Copyable where Value : ~Copyable

// Async/await patterns
@_Concurrency.MainActor func checkPermissionStatus(_ permission: MWDATCore.Permission) async throws(MWDATCore.PermissionError) -> MWDATCore.PermissionStatus
```

### Observer Pattern Implementation
The SDK extensively uses reactive patterns for state management:

```swift
// Generic announcer protocol
public protocol Announcer<T> {
  associatedtype T : Swift.Sendable
  func listen(_ listener: @escaping (Self.T) -> Swift.Void) -> any MWDATCore.AnyListenerToken
}

// Listener token pattern for subscription management
public protocol AnyListenerToken : Swift.Sendable {
  func cancel() async
}
```

### Protocol-Oriented Design
Heavy reliance on protocols for abstractions and testability:

```swift
@_Concurrency.MainActor public protocol WearablesInterface {
  @_Concurrency.MainActor var registrationState: MWDATCore.RegistrationState { get }
  @_Concurrency.MainActor func startRegistration() throws(MWDATCore.RegistrationError)
  // ...
}
```

## Device Support

### Supported Device Types
The SDK recognizes multiple Meta wearable device types:

```swift
public enum DeviceType : Swift.String, Swift.CaseIterable, Swift.Sendable {
  case unknown
  case rayBanMeta                    // Ray-Ban Meta smart glasses
  case oakleyMetaHSTN                // Oakley Meta Holbrook
  case oakleyMetaVanguard            // Oakley Meta Vanguard
  case metaRayBanDisplay             // Display variant
}
```

### Device State Management
Comprehensive device state tracking:

```swift
// Connection states
@frozen public enum LinkState : Swift.Equatable, Swift.Sendable {
  case disconnected
  case connecting
  case connected
}

// Physical device state
public struct DeviceState : Swift.Equatable, Swift.Sendable {
  public let batteryLevel: Swift.Int      // 0-100
  public let hingeState: MWDATCore.HingeState
}

// Hinge state for glasses
@frozen public enum HingeState : Swift.Equatable, Swift.Sendable {
  case open
  case closed
}
```

### Device Selection Strategies

#### Specific Device Selector
```swift
@_Concurrency.MainActor public class SpecificDeviceSelector : MWDATCore.DeviceSelector {
  @_Concurrency.MainActor public init(device: MWDATCore.DeviceIdentifier)
}
```

#### Automatic Device Selector
```swift
@_Concurrency.MainActor final public class AutoDeviceSelector : MWDATCore.DeviceSelector {
  @_Concurrency.MainActor public init(wearables: any MWDATCore.WearablesInterface)
}
```

## Registration Flow

### Registration States
```swift
@objc(MWDATRegistrationState) @frozen public enum RegistrationState : Swift.Int {
  case unavailable      // SDK not configured or available
  case available        // Ready to register
  case registering      // Registration in progress
  case registered       // Successfully registered
}
```

### Registration Process
1. **Configuration**: `Wearables.configure()` must be called first
2. **Start Registration**: `wearables.startRegistration()` initiates the flow
3. **Meta AI App**: Opens Meta AI companion app for user confirmation
4. **URL Handling**: `wearables.handleUrl(_:)` processes callback from Meta AI
5. **State Updates**: Listeners receive registration state changes

### Registration Errors
```swift
@objc(MWDATRegistrationError) @frozen public enum RegistrationError : Swift.Int, Swift.Error {
  case alreadyRegistered       // Device already registered
  case alreadyUnregistered     // Device already unregistered
  case configurationInvalid    // Invalid SDK configuration
  case failedToRegister        // Registration failed
  case failedToUnregister      // Unregistration failed
  case metaAINotInstalled      // Meta AI app not installed
  case unknown                 // Unknown error
}
```

## Permission System

### Permission Types
Currently supports camera permission with extensibility for future permissions:

```swift
public enum Permission : Swift.Sendable {
  case camera
  // Future permissions can be added here
}
```

### Permission Status
```swift
public enum PermissionStatus : Swift.Sendable {
  case granted    // Permission granted by user
  case denied     // Permission denied by user
}
```

### Permission Request Flow
```swift
// Check current permission status
let status = await wearables.checkPermissionStatus(.camera)

// Request permission if needed
let newStatus = await wearables.requestPermission(.camera)
```

### Permission Errors
```swift
@objc(MWDATPermissionError) public enum PermissionError : Swift.Int, Swift.Error, Swift.Sendable {
  case noDevice                  // No device available
  case noDeviceWithConnection     // No device with active connection
  case connectionError           // Connection error occurred
  case companionAppNotInstalled  // Meta AI app not installed
  case requestInProgress         // Permission request already in progress
  case requestTimeout           // Request timed out
  case internalError            // Internal SDK error
}
```

## Camera Capabilities (MWDATCamera)

### Streaming Resolutions
Multiple predefined resolutions with different aspect ratios:

```swift
public enum StreamingResolution : Swift.CaseIterable {
  case low                       // 640x480 at 30fps
  case medium                    // 1280x720 at 30fps
  case high                      // 1920x1080 at 30fps
  case veryHigh                  // 1920x1080 at 60fps
  case fourK                     // 3840x2160 at 30fps

  public var videoFrameSize: MWDATCamera.VideoFrameSize { get }
  public var maxFramesPerSecond: MWDATCamera.FramesPerSecond { get }
}
```

### Video Configuration Options
```swift
public struct StreamSessionConfig {
  public let resolution: MWDATCamera.StreamingResolution
  public let videoCodec: MWDATCamera.VideoCodec      // H264, H265
  public let framesPerSecond: MWDATCamera.FramesPerSecond
  public let photoCaptureFormat: MWDATCamera.PhotoCaptureFormat
  public let enablePhotoCapture: Swift.Bool
  public let enableStreaming: Swift.Bool
}
```

### Photo Capture Formats
```swift
public enum PhotoCaptureFormat : Swift.Sendable {
  case jpeg        // Standard JPEG format
  case heif        // High Efficiency Image Format
  case raw         // RAW image data
}
```

### Video Streaming Session
```swift
@_Concurrency.MainActor final public class StreamSession {
  @_Concurrency.MainActor final public let streamSessionConfig: MWDATCamera.StreamSessionConfig
  @_Concurrency.MainActor final public var state: MWDATCamera.StreamSessionState

  // Publishers for reactive updates
  @_Concurrency.MainActor final public var statePublisher: any MWDATCore.Announcer<MWDATCamera.StreamSessionState>
  @_Concurrency.MainActor final public var videoFramePublisher: any MWDATCore.Announcer<MWDATCamera.VideoFrame>

  // Session control
  @_Concurrency.MainActor final public func start() async throws
  @_Concurrency.MainActor final public func stop() async throws
  @_Concurrency.MainActor final public func capturePhoto() async throws -> MWDATCamera.PhotoData
}
```

### Session States
```swift
@frozen public enum StreamSessionState {
  case idle              // Not started
  case waitingForDevice  // Waiting for device connection
  case running           // Active streaming
  case paused            // Temporarily paused
}
```

### Video Frame Structure
```swift
public struct VideoFrame : Swift.Sendable {
  public let pixelBuffer: CoreVideo.CVPixelBuffer  // Video frame data
  public let timestamp: Foundation.CMTime         // Frame timestamp
}
```

## Analytics Integration

### Analytics Event Protocol
```swift
public protocol AnalyticsEvent : Swift.Sendable {
  var name: Swift.String { get }
  var data: [Swift.String : Any] { get }
}
```

### Tracked Event Types

#### Permission Check Events
```swift
public struct WearablesSDKCheckPermissionEvent : MWDATCore.AnalyticsEvent {
  public var deviceSocBuildVersion: Swift.String?
  public var error: Swift.String?
  public var hasPermission: Swift.Bool?
  public var permission: Swift.String?
  public var success: Swift.Bool?
}
```

#### Device Analytics Events
```swift
public struct WearablesSDKDeviceAnalyticsEvent : MWDATCore.AnalyticsEvent {
  public var deviceSocBuildVersion: Swift.String?
  public var deviceType: Swift.String?
  public var eventType: MWDATCore.WearablesSDKDeviceAnalyticsEventType
}

public enum WearablesSDKDeviceAnalyticsEventType : Swift.String, Swift.Codable, Swift.Sendable {
  case deviceConnect
  case deviceDisconnect
  case linkStateChange
  case sessionStart
  case sessionStop
  case permissionRequest
}
```

#### Mock Device Events (Debug Only)
```swift
public struct WearablesSDKMockDeviceEvent : MWDATCore.AnalyticsEvent {
  public var deviceSocBuildVersion: Swift.String?
  public var eventType: MWDATCore.WearablesSDKMockDeviceEventType
}

public enum WearablesSDKMockDeviceEventType : Swift.String, Swift.Codable, Swift.Sendable {
  case mockDeviceAdded
  case mockDeviceConnected
  case mockDeviceDisconnected
  case mockDeviceRemoved
}
```

### Performance Logging (QPL)
Integration with Quick Performance Logger for performance monitoring:

```swift
public protocol QPLAnnotatable {
  func annotateQPL(using wrapper: MWDATCore.QPLLoggerWrapper, markerId: Swift.Int32, instanceKey: Swift.Int32, key: Swift.String)
}

// Supported types for annotation
extension Swift.String : MWDATCore.QPLAnnotatable {}
extension Swift.Int : MWDATCore.QPLAnnotatable {}
extension Swift.Double : MWDATCore.QPLAnnotatable {}
extension Swift.Bool : MWDATCore.QPLAnnotatable {}
```

### Configuration Options
Analytics can be configured and disabled via Info.plist:

```xml
<key>MWDAT</key>
<dict>
    <key>Analytics</key>
    <dict>
        <key>OptOut</key>
        <true/>    <!-- Set to true to disable analytics -->
    </dict>
</dict>
```

## Error Handling

### Comprehensive Error Types
The SDK provides typed errors for different failure scenarios:

#### Wearables Errors
```swift
@objc(MWDATWearablesError) @frozen public enum WearablesError : Swift.Int, Swift.Error {
  case alreadyConfigured      // SDK already configured
  case notConfigured         // SDK not configured
  case configurationInvalid  // Invalid configuration
  case internalError         // Internal SDK error
}
```

#### Camera Streaming Errors
```swift
public enum StreamSessionError : Swift.Error, Swift.Equatable {
  case deviceNotConnected      // No device connected
  case sessionAlreadyRunning   // Session already active
  case sessionNotRunning       // Session not active
  case invalidConfiguration    // Invalid session config
  case internalError          // Internal camera error
}
```

#### Decoder Errors
```swift
public enum DecoderError : Swift.Error {
  case invalidPixelFormat    // Unsupported pixel format
  case internalError        // Decoder failure
}
```

## Technical Implementation Details

### Framework Dependencies
The frameworks depend on Apple system frameworks:

```swift
import CoreBluetooth      // For device connectivity
import CryptoKit          // For secure communications
import Foundation         // Base framework
import Swift             // Swift standard library
import UIKit             // UI components
import _Concurrency      // Swift concurrency
import _StringProcessing // String processing utilities
```

### Build Configuration

#### XCFramework Structure
Each framework is built as an XCFramework supporting:
- **iOS Device**: arm64 architecture
- **iOS Simulator**: arm64 and x86_64 architectures

#### Swift Compiler Flags
```swift
// swift-interface-format-version: 1.0
// swift-compiler-version: Apple Swift version 6.2
// swift-module-flags: -target arm64-apple-ios15.2-simulator -enable-objc-interop -enable-library-evolution -swift-version 6 -Osize
```

#### Minimum Platform Support
- **iOS**: 15.2+
- **visionOS**: 1.0+

### Thread Safety and Concurrency

#### MainActor Usage
All public APIs require MainActor isolation:
```swift
@_Concurrency.MainActor public protocol WearablesInterface
@_Concurrency.MainActor final public class StreamSession
```

#### Sendable Conformance
Most public types conform to `Sendable` for safe concurrency:
```swift
public enum DeviceType : Swift.String, Swift.CaseIterable, Swift.Sendable
public struct DeviceState : Swift.Equatable, Swift.Sendable
```

## Developer Experience Features

### Mock Device Support
Complete mock framework for testing without physical devices:

```swift
// Available in debug builds only
#if DEBUG
import MWDATMockDevice
```

### Swift Package Manager Ready
Properly structured for Swift Package Manager integration via Package.swift

### Dual Architecture Support
Universal binaries supporting both device and simulator architectures

### Documentation and Examples
- Comprehensive sample app in `samples/CameraAccess/`
- Inline documentation for all public APIs
- Clear error messages and debugging support

## Memory Management

### ARC and Reference Cycles
The SDK uses modern Swift memory management:
- Automatic Reference Counting (ARC)
- Weak references in listener patterns to avoid retain cycles
- Explicit cancellation tokens for cleanup

### Resource Management
```swift
// Listener tokens for subscription cleanup
public protocol AnyListenerToken : Swift.Sendable {
  func cancel() async  // Cancel subscription and cleanup resources
}
```

## Security Considerations

### CryptoKit Integration
Uses CryptoKit for secure communications and data protection

### Permission Model
Granular permission system requiring explicit user consent

### Analytics Opt-out
Privacy-first approach with easy analytics opt-out configuration

## Performance Optimizations

### Binary Size Optimization
- Built with `-Osize` optimization flag
- Library evolution enabled for binary compatibility
- Selective framework inclusion (Core required, Camera optional)

### Streaming Performance
- Hardware-accelerated video encoding (H264/H265)
- Configurable frame rates and resolutions
- Efficient pixel buffer handling with CVPixelBuffer

### Battery Optimization
- Adaptive streaming based on device capabilities
- Configurable quality settings for power management
- Automatic session cleanup on disconnect

## Integration Guidelines

### Basic Setup
```swift
import MWDATCore
import MWDATCamera

// Configure SDK
try Wearables.configure()

// Get shared instance
let wearables = Wearables.shared

// Start device registration
try wearables.startRegistration()
```

### Camera Streaming
```swift
// Create stream session
let config = StreamSessionConfig(
  resolution: .high,
  videoCodec: .h264,
  framesPerSecond: .fps30,
  photoCaptureFormat: .jpeg,
  enablePhotoCapture: true,
  enableStreaming: true
)

// Start streaming
let session = StreamSession(
  device: device,
  config: config
)

// Listen for video frames
session.videoFramePublisher.listen { frame in
  // Process video frame
  processFrame(frame.pixelBuffer)
}

// Start session
try await session.start()
```

### Error Handling Best Practices
```swift
do {
  try await session.start()
} catch StreamSessionError.deviceNotConnected {
  // Handle device not connected
} catch StreamSessionError.invalidConfiguration {
  // Handle invalid config
} catch {
  // Handle other errors
}
```

## Migration and Versioning

### Library Evolution
The SDK uses Swift's library evolution feature for binary compatibility:
- `-enable-library-evolution` compiler flag
- Stable API between versions
- Backward compatibility maintained where possible

### Version Information
Version tracking through package manager and framework bundles

This analysis demonstrates a well-architected, modern Swift SDK that leverages the latest language features while maintaining compatibility and providing a comprehensive developer experience for Meta's wearables platform.