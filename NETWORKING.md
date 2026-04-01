# CaringMind Relay Networking

## Architecture

```
[Meta Wearables (Ray-Ban)]
        | Bluetooth LE (DAT SDK)
        v
[iOS App] ---wss://---> [Caddy:443] ---ws://---> [localhost:8080]
  CameraAccess        relay.simulationapi.com      Bun Relay Server
  RelayStage              (auto TLS)             (caringmind-relay)
  AudioStage                                        |
                                                     v
                                              [Browser Viewer]
                                              index.html (FRLY/FRAU decode)
```

## VPS

**Server:** `caringmind-relay` (Hetzner, fsn1)
**IP:** `46.225.151.52`
**Domain:** `relay.simulationapi.com`

### Services Running

| Service | Port | Command |
|---------|------|---------|
| Bun relay server | 8080 | `/root/.bun/bin/bun run src/server.ts` |
| Caddy (TLS) | 443 | `/usr/bin/caddy run --config /etc/caddy/Caddyfile` |

### Caddy Configuration

`/etc/caddy/Caddyfile`:
```
relay.simulationapi.com {
    reverse_proxy localhost:8080
}
```

Caddy handles automatic Let's Encrypt TLS. No ngrok needed.

### Files on VPS

```
/root/relay-server/    # relay/server/ from repo
/root/viewer/          # relay/viewer/ from repo (index.html)
/etc/caddy/Caddyfile   # Caddy reverse proxy config
```

### Deploy / Restart

```bash
# SSH into VPS
ssh root@46.225.151.52

# Restart relay server
kill $(pgrep -f 'bun run')
cd /root/relay-server && /root/.bun/bin/bun run src/server.ts &

# Restart Caddy
systemctl restart caddy

# Check status
curl http://localhost:8080/stats
curl -s https://relay.simulationapi.com/stats
```

### Deploy Updated Code

```bash
# From local machine
scp -r relay/server root@46.225.151.52:/root/relay-server
scp -r relay/viewer root@46.225.151.52:/root/viewer
# Then restart relay server on VPS
```

## Relay Server Endpoints

| Endpoint | Protocol | Role | Description |
|----------|----------|------|-------------|
| `/` | HTTP GET | Viewer | Serves `viewer/index.html` |
| `/publish` | WebSocket | Publisher | iOS app connects (single publisher, reject 4001 if occupied) |
| `/view` | WebSocket | Viewer | Browser viewers connect (N viewers, fan-out) |
| `/stats` | HTTP GET | Debug | JSON stats (fps, bytes, connections) |

Server binds `0.0.0.0:8080`. Port configurable via `RELAY_PORT` env var.

## Wire Protocol

### FRLY - Video Frame (29-byte header + JPEG payload)

| Offset | Size | Field |
|--------|------|-------|
| 0 | 4 | Magic: `0x46 0x52 0x4C 0x59` ("FRLY") |
| 4 | 8 | Sequence number (uint64 LE) |
| 12 | 4 | Width (uint32 LE) |
| 16 | 4 | Height (uint32 LE) |
| 20 | 1 | JPEG quality 0-100 (uint8) |
| 21 | 8 | Timestamp ms (uint64 LE) |
| 29 | N | JPEG payload |

### FRAU - Audio Frame (29-byte header + PCM payload)

| Offset | Size | Field |
|--------|------|-------|
| 0 | 4 | Magic: `0x46 0x52 0x41 0x55` ("FRAU") |
| 4 | 1 | Codec: 0 = raw PCM 16-bit LE |
| 5 | 8 | Sequence number (uint64 LE) |
| 13 | 4 | Sample rate (uint32 LE) |
| 17 | 2 | Channels (uint16 LE) |
| 19 | 2 | Bits/sample (uint16 LE) |
| 21 | 8 | Timestamp ms (uint64 LE) |
| 29 | N | PCM 16-bit LE audio data |

### Audio Parameters

- Sample rate: 48000 Hz
- Channels: 1 (mono)
- Buffer: 960 frames (20ms chunks)
- JPEG quality: 0.6

## iOS App (CameraAccess)

### Pipeline Stages

```
FramePipelineManager
  |-- DisplayStage    -> UIImage for SwiftUI
  |-- RecordingStage  -> .mov file via AVAssetWriter
  |-- RelayStage      -> FRLY over WebSocket to /publish
  `-- AudioStage      -> Mic capture -> FRAU -> RelayStage
```

### Relay Configuration

- Default URL: `wss://relay.simulationapi.com/view` (editable in app UI)
- ATS disabled (`NSAllowsArbitraryLoads = true`) so `ws://` to IP works too
- Connection timeout: 5 seconds
- Auto-retry: up to 3 attempts with exponential backoff (1s, 2s, 4s)
- Receive loop: required for URLSessionWebSocketTask protocol handling
- Keepalive: 5s ping interval prevents proxy/NAT idle disconnects
- JPEG encoding: runs in detached task off actor executor (non-blocking)

### Build & Install

```bash
# Build for device
xcodebuild -project samples/CameraAccess/CameraAccess.xcodeproj \
  -scheme CameraAccess \
  -destination 'platform=iOS,name=Starlink' \
  -configuration Debug build

# Install to device
xcrun devicectl device install app --device <DEVICE_UDID> \
  ~/Library/Developer/Xcode/DerivedData/CameraAccess-*/Build/Products/Debug-iphoneos/CameraAccess.app
```

## Browser Viewer

1. Open `https://relay.simulationapi.com/`
2. Enter WebSocket URL: `wss://relay.simulationapi.com/view`
3. Click Connect

### A/V Sync

Viewer uses a video-clock approach:
- On video frame arrival: map `senderTimestampMs` to `AudioContext.currentTime`
- On audio chunk arrival: schedule playback relative to that mapping
- Look-ahead clamped to 5ms - 200ms

## Secrets

| Secret | Location | Purpose |
|--------|----------|---------|
| VPS SSH key | Default SSH config | `root@46.225.151.52` |
| Apple signing cert | Keychain | `Apple Development: Elijah Arbee (R82A6URQZQ)` |
| DNS | simulationapi.com | A record `relay` -> `46.225.151.52` |

## Key Files

| File | Purpose |
|------|---------|
| `relay/server/src/server.ts` | Bun WebSocket relay server |
| `relay/viewer/index.html` | Browser viewer with A/V sync |
| `samples/CameraAccess/CameraAccess/ViewModels/StreamSessionViewModel.swift` | iOS view model, pipeline orchestration |
| `samples/CameraAccess/CameraAccess/Pipeline/Stages/RelayStage.swift` | Video relay over WebSocket |
| `samples/CameraAccess/CameraAccess/Pipeline/Stages/AudioStage.swift` | Mic capture and FRAU relay |
| `samples/CameraAccess/CameraAccess/Pipeline/FramePipelineManager.swift` | Frame dispatcher to stages |
