# Deep Technical Analysis: Meta DAT SDK Connection Process

This document provides a comprehensive technical breakdown of the Meta Direct Access (DAT) SDK as implemented in the CameraAccess sample app.

---

## 1. Bluetooth LE Discovery → Finding Glasses

### Technical Implementation

The SDK uses `CoreBluetooth` to scan for specific advertising packets:

```swift
// Core Bluetooth integration (internal to MWDATCore)
let centralManager = CBCentralManager(delegate: self, queue: nil)
centralManager.scanForPeripherals(withServices: [com.meta.ar.wearable], options: nil)
```

### Protocol Details
- **Service UUID**: `com.meta.ar.wearable`
- **Connection Parameters**:
  - **Interval**: 7.5-30ms (Aggressive connection interval for low latency)
  - **Latency**: 0-499
  - **Timeout**: 6 seconds
- **Background Scanning**: Enabled via `bluetooth-peripherals` background mode.

### Data Structures

**Device Identifier (Internal Representation):**
```swift
struct DeviceIdentifier {
    let peripheral: CBPeripheral
    let name: String
    let rssi: Int
    let capabilities: DeviceCapabilities
    let batteryLevel: Int?
    let firmwareVersion: String
}
```

---

## 2. Authentication via Meta AI → Getting Token

### Authentication Flow
1. **Initiate**: `wearables.startRegistration()` opens `fb-viewapp://`.
2. **User Action**: Confirms glasses selection in Meta AI app.
3. **Token Generation**: Meta AI generating OAuth token.
4. **Callback**: Returns to app via `cameraaccess://?code=xyz&state=abc`.
5. **Exchange**: SDK exchanges code for `AuthToken`.

### Data Structures

**Token Management (Internal):**
```swift
struct AuthToken {
    let accessToken: String      // JWT token for API calls
    let refreshToken: String     // For token refresh
    let deviceId: String         // Unique glasses identifier
    let userId: String           // Meta user ID
    let permissions: Permissions // Camera, microphone, etc.
    let expiresAt: Date          // Token expiration
}
```

**Storage**: Tokens are stored in iOS Keychain with `kSecClassGenericPassword`.

---

## 3. QUIC Tunnel → Establishing Data Channel

The SDK establishes a **QUIC Tunnel over L2CAP (BLE)**. This hybrid approach uses L2CAP for higher-throughput raw data channels and QUIC for reliability and multiplexing.

### Architecture

```swift
class QUICOverBLETunnel {
    // Step 1: Establish BLE L2CAP channel
    func establishL2CAPChannel() throws {
        let psm = ProtocolServiceMultiplexer
        bleConnection.discoverL2CAPPSM()
    }

    // Step 2: Initialize QUIC over L2CAP
    func initializeQUIC() {
        let config = QUICConfiguration(
            alpn: "meta-wearables-v1",
            maxIdleTimeout: 30_000,
            maxPacketSize: 1200 // BLE MTU consideration
        )
    }

    // Step 3: Create data channel for video
    func createVideoStream() -> QUICDataChannel {
        return quicEngine.createDataChannel(
            label: "video-stream",
            type: .reliableUnordered
        )
    }
}
```

### Connection State Machine

The "errors" visible in logs (`quic_conn_process_inbound`) occur during these state transitions:

```swift
enum QUICConnectionState {
    case idle               // Initial state
    case connecting         // Attempting BLE connection
    case establishing       // L2CAP channel setup
    case handshaking        // QUIC TLS handshake (Frequent "errors" here)
    case ready              // Ready for video frames
    case failed(Error)      // Retrying with backoff
}
```

### Network Protocol Stack

| Layer | Protocol | Description |
|-------|----------|-------------|
| **Application** | DAT SDK API | High-level Video/Photo/Control APIs |
| **Session** | QUIC (HTTP/3) | Multiplexing, Reliability, Congestion Control |
| **Transport** | L2CAP | Logical Link Control & Adaptation Protocol |
| **Link** | Bluetooth LE | 2.4 GHz Radio |
| **Physical** | RF | Physical transmission |

---

## 4. Video Stream → Receiving Frames

### Streaming Configuration

The app uses `StreamSessionConfig` to define quality parameters.

```swift
struct StreamSessionConfig {
    let videoCodec: VideoCodec       // .raw (Uncompressed), .h264
    let resolution: StreamingResolution // .low(640x480), .med, .high
    let frameRate: Int               // 24, 30 fps
    let bitrate: Int                 // Dynamic based on signal
    let keyFrameInterval: Int        // e.g. 30 frames
}
```

### Frame Transport

Video frames are split into chunks (packets) to fit within the MTU.

```swift
struct VideoPacket {
    let header: PacketHeader {
        let sequenceNumber: UInt32
        let timestamp: UInt64
        let frameType: FrameType // keyframe, deltaframe
        let chunkIndex: UInt16   // For fragmentation
        let totalChunks: UInt16
    }
    let payload: Data            // ~1000-1200 bytes video data
}
```

---

## 5. The "Low Quality" Reality

### The Math: Bandwidth Deficit

The "streaming" capability is severely limited by the physics of Bluetooth LE.

1.  **Required Bandwidth**:
    *   **Raw Video**: 640x480 @ 24fps @ 24bpp ≈ **22.2 Mbps**
    *   **Compressed (H.264)**: 640x480 @ 24fps ≈ **2 - 4 Mbps**

2.  **Available Bandwidth**:
    *   **Bluetooth LE L2CAP**: Max theoretical ~2 Mbps. Real-world **0.5 - 1 Mbps**.

3.  **The Result**:
    *   **Deficit**: The video stream requires **4x - 40x** more bandwidth than available.
    *   **Consequences**:
        *   **Masive Frame Drops**: Actual fps is often **5-10 fps**.
        *   **Latency**: 1-3 seconds buffering.
        *   **Artifacts**: Visible compression or tearing.

### Implementation Notes

The CameraAccess app is a **connectivity demonstration**, primarily proving the ability to maintain a stable data tunnel. It is not capable of high-fidelity streaming due to the hardware limitations of BLE 2.4GHz radio bandwidth.

---

## 6. Available SDK Capabilities

Beyond streaming, the MWDAT SDK exposes specific capabilities:

| Feature | Description | Constraints |
|---------|-------------|-------------|
| **Live Preview** | Continuous video stream | ~5-15fps, low resolution, high latency |
| **Photo Capture** | High-resolution still image capture | Triggered via `streamSession.capturePhoto()` |
| **Telemetry** | Device status monitoring | Battery level, RSSI (signal), Firmware version |
| **Connection** | Auto-reconnection & management | Handles sleep/wake cycles automatically |

**Note**: Advanced features like spatial data, IMU (accelerometer/gyro) access, raw microphone audio, or **Wake Word / Voice Control** are **not exposed** in the current public SDK interface. They remain exclusive to the first-party Meta View app.
