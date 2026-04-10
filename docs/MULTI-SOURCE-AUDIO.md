# Multi-Source Audio Pipeline

## Overview

The iOS client captures and relays multiple audio sources simultaneously to the relay server, enabling multi-mic recording, two-way audio, and external tap consumption.

## Architecture

```
iPhone:
  AudioStage(builtIn)   --[codecType=0]--> AudioRelayStage --> WebSocket /publish
  AudioStage(glasses)   --[codecType=1]--> AudioRelayStage --> WebSocket /publish
  AudioPlaybackStage    <--[codecType=2]-- AudioTapClient  <-- WebSocket /tap/audio

Relay Server:
  /publish         → receives FRAU frames, dispatches to fanout + recorder + audioTapBus
  /tap/audio       → external clients receive JSON audio frames (all codecTypes)
  /stats           → includes audioTaps count
```

## FRAU Wire Protocol codecType Field

| Value | Source | Sample Rate | Notes |
|-------|--------|-------------|-------|
| 0 | Built-in phone mic | 48000 Hz | Default, always available |
| 1 | Glasses HFP mic | 8000 Hz (narrowband) or 16000 Hz (wideband) | Must start before DAT video stream |
| 2 | Playback audio (server → glasses) | Variable | Received via /tap/audio, played to glasses speaker |

## iOS Multi-Device Audio Capture

### AVAudioSession Configuration

The audio session must be configured ONCE at app launch, before any streaming starts. The DAT SDK configures its own audio session for BT video — we must not reconfigure it during streaming.

Current configuration (CameraAccessApp):
```swift
AVAudioSession.sharedInstance()
try session.setCategory(.playAndRecord, mode: .default, options: [.allowBluetooth])
try session.setActive(true)
```

### Option A: Split AudioStages with setPreferredInput

Two separate `AudioStage` instances, each capturing from a different hardware input:

```swift
// Built-in mic stage — captures at 48kHz
let builtInStage = AudioStage(source: .builtInMic)   // codecType = 0

// Glasses HFP mic stage — captures at 8kHz or 16kHz
let glassesStage = AudioStage(source: .bluetoothHFP)  // codecType = 1
```

Each stage uses its own `AVAudioEngine` with `installTap(onBus: 0)` on the input node.

**Constraint:** `setPreferredInput()` must be called BEFORE the DAT SDK video stream starts. During streaming, no audio route changes are permitted.

### Option B: AVAudioSession.Category.multiRoute + Channel Maps

Apple's official approach for simultaneous multi-device capture. Uses `.multiRoute` category to expose all hardware inputs as global channel positions:

```
Built-in Mic:  2 channels → hardware [0, 1] (front, back)
Glasses HFP:   1 channel  → hardware [2]
```

Install a single multi-channel tap, then use `AudioUnitSetProperty` with channel map to separate sources:

```swift
try session.setCategory(.multiRoute, mode: .default, options: [.allowBluetooth])

var channelMap: [Int32] = [0, 2]  // [builtIn, glasses]
AudioUnitSetProperty(
    inputAudioUnit,
    kAudioOutputUnitProperty_ChannelMap,
    kAudioUnitScope_Input, 1,
    &channelMap,
    UInt32(channelMap.count * MemoryLayout<Int32>.size)
)
```

**Constraint:** Changing category to `.multiRoute` during active DAT SDK streaming may disrupt the BT video connection. Untested with Meta glasses.

### Option C: Built-in Mic + A2DP Output (Simplest)

Use `.allowBluetoothA2DP` only (not `.allowBluetooth`). This prevents HFP input routing, forcing built-in mic as default while keeping A2DP output to glasses:

```swift
try session.setCategory(.playAndRecord, mode: .default, options: [.allowBluetoothA2DP])
```

This gives built-in mic capture + glasses audio output without route conflicts. Glasses mic is NOT available in this mode.

### Recommended Approach

**Start with Option A** (split AudioStages) because:
1. Each stage is an independent actor — clean isolation
2. No audio session category changes during streaming
3. Each stage tags its own `AudioPacket.codecType` for server-side distinction
4. Glasses mic capture starts before DAT video stream, built-in mic anytime

If Option A fails due to single-input-per-session limitations, fall back to **Option C** (built-in mic only + A2DP output) which is confirmed working.

## Two-Way Audio (Playback to Glasses)

The `AudioTapClient` connects to `/tap/audio` and receives JSON audio frames. For playback to glasses:

1. `AudioTapClient` publishes decoded `AudioPacket` to `AudioEventBus`
2. `AudioPlaybackStage` subscribes to the bus, filters for `codecType == 2`
3. Plays PCM audio through `AVAudioEngine.outputNode` routed to glasses HFP speaker

```swift
// PlaybackStage subscribes to bus, plays to glasses
for await packet in stream {
    guard packet.codecType == 2 else { continue }
    // Schedule PCM buffer to output node → glasses HFP speaker
}
```

**Constraint:** Output routing must be configured before streaming starts. During streaming, do not call `setPreferredInput()` or `setActive()`.

## Sources

- [Apple: Routing audio to specific devices in multidevice sessions](https://developer.apple.com/documentation/avfaudio/routing-audio-to-specific-devices-in-multidevice-sessions) — Official docs on `.multiRoute` category, channel maps, multi-device input/output
- [Apple: AVAudioSession.Category.multiRoute](https://developer.apple.com/documentation/avfaudio/avaudiosession/category-swift.struct/multiroute) — Category for routing distinct streams to different devices simultaneously
- [Apple: Audio Routing](https://developer.apple.com/documentation/avfaudio/audio-routing) — Inspecting and configuring audio routes, ports, and data sources
- [SO: iOS record from multiple microphones at same time](https://stackoverflow.com/questions/58420918/ios-is-it-possible-to-record-from-multiple-microphones-at-the-same-time) — Confirms AVAudioSession is singleton, standard API doesn't support per-mic separation, but stereo channel splitting is possible
- [SO: Recording from built-in mic while playing through Bluetooth](https://stackoverflow.com/questions/30614134/recording-from-built-in-mic-when-playing-through-bluetooth-in-ios) — HFP input/output are locked together; using `.allowBluetoothA2DP` (without `.allowBluetooth`) forces built-in mic as input
- [SO: Use internal mic for input, Bluetooth for output](https://stackoverflow.com/questions/65571861/how-to-use-internal-mic-for-input-and-bluetooth-for-output) — `setPreferredInput(builtInMic)` works with A2DP output
- [SO: MultiRoute audio input in iOS](https://stackoverflow.com/questions/49513611/multiroute-audio-input-in-ios) — AudioUnits + multiRoute for multi-device capture
- [SO: How to use AVAudioSessionCategoryMultiRoute on iPhone](https://stackoverflow.com/questions/21832733/how-to-use-avaudiosessioncategorymultiroute-on-iphone-device) — MultiRoute category usage patterns
- [SO: setPreferredInput breaks Bluetooth output](https://stackoverflow.com/questions/34162179/how-to-switch-between-audio-input-sourcebluetooth-builtin-microphone-using-av) — `setPreferredInput` can change both input AND output routes on Bluetooth
- [Apple QA1799: Choosing Built-in Mic with Bluetooth A2DP Output](https://developer.apple.com/library/archive/qa/qa1799/_index.html) — Using `.allowBluetoothA2DP` without `.allowBluetooth` to keep built-in mic
- [Apple Developer Forums: Using Bluetooth mic while controlling A2DP](https://developer.apple.com/forums/thread/734499) — Bluetooth HFP vs A2DP input routing conflicts
- [Switchboard Audio SDK: AVAudioSession management](https://docs.switchboard.audio/audio-engine/ios) — Shared AVAudioSession management patterns

## Implementation Files

| File | Purpose |
|------|---------|
| `Pipeline/AudioPacket.swift` | Add codecType documentation (0/1/2) |
| `Pipeline/AudioEventBus.swift` | No changes needed — already supports multi-subscriber |
| `Pipeline/Stages/AudioStage.swift` | Refactor: accept `AudioSource` enum, tag packets with codecType |
| `Pipeline/Stages/AudioPlaybackStage.swift` | Receive codecType=2 packets from bus, play to glasses |
| `Pipeline/RemoteAudioFrame.swift` | Already handles codecType from server JSON |
| `Pipeline/Stages/AudioTapClient.swift` | Already receives server audio, publishes to bus |
| `ViewModels/StreamSessionViewModel.swift` | Wire multi-stage pipeline, lifecycle management |
