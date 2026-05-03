---
description: Bluetooth audio profiles (A2DP/HFP), mic/speaker routing, and AVAudioSession setup for Ray-Ban Meta glasses via DAT SDK
---

# DAT SDK Audio: Device Microphones & Speakers

**Source:** Meta Wearables Device Access Toolkit docs
**Updated:** 2026-02-24

## Bluetooth Audio Profiles

The glasses use two Bluetooth audio profiles:

| Profile | Full Name | Quality | Direction | Use Case |
|---------|-----------|---------|-----------|----------|
| **A2DP** | Advanced Audio Distribution Profile | High quality | Output only | Media playback to glasses speakers |
| **HFP** | Hands-Free Profile | 8kHz mono | Two-way (mic + speaker) | Voice communication, mic capture |

### HFP Audio Quality

- HFP streams audio at **8kHz mono** -- significantly lower than the phone's built-in mic (48kHz)
- Wearable device microphones use **beamforming** to isolate and clarify the wearer's voice
- This beamforming **reduces the volume of ambient sounds and other speakers** -- this is an expected limitation, not a bug
- For high-quality ambient capture, use the phone's built-in mic (codecType 0, 48kHz) instead

## HFP + Streaming Coordination

Wearables DAT SDK sessions share microphone and speaker access with the system Bluetooth stack on the glasses.

**Critical ordering rule:** HFP must be fully configured BEFORE initiating any streaming session that requires audio functionality.

```swift
func startStreamSessionWithAudio() async {
  // 1. Set up the HFP audio session FIRST
  startAudioSession()

  // 2. Wait for HFP to be ready (state-based coordination)
  try? await Task.sleep(nanoseconds: 2 * NSEC_PER_SEC)

  // 3. Then start the stream session
  await streamSession.start()
}
```

## iOS Audio Session Setup

```swift
import AVFoundation

func startAudioSession() {
  let audioSession = AVAudioSession.sharedInstance()
  try audioSession.setCategory(
    .playAndRecord,
    mode: .default,
    options: [.allowBluetooth]
  )
  try audioSession.setActive(true, options: .notifyOthersOnDeactivation)
}
```

Key points:
- Category must be `.playAndRecord` (not just `.record`) for bidirectional audio
- `.allowBluetooth` option routes audio through the glasses HFP connection
- Must call `setActive(true)` before starting the stream session

## Our Audio Architecture (FRAU codecType)

| codecType | Source | Sample Rate | Direction | How |
|-----------|--------|-------------|-----------|-----|
| 0 | Phone built-in mic | 48kHz | iOS -> Relay | `AVAudioEngine` input tap |
| 1 | Glasses HFP mic | 16kHz (upsampled from 8kHz) | iOS -> Relay | `AVAudioEngine` with `.allowBluetooth` routing |
| 2 | TTS playback | 22050Hz | iOS -> Relay | `AVSpeechSynthesizer.write()` PCM |
| 3 | Relay inbound | TBD | Relay -> iOS | Not built yet (see PRD-001 P1-8, PRD-002 P1-6) |

### Audio Input Modes

The iOS app supports three audio input modes (selectable in pre-stream setup):

- **Phone mic only**: codecType 0, 48kHz, no HFP needed
- **Glasses mic only**: codecType 1, requires HFP setup before streaming
- **All devices**: Both codecType 0 and 1 simultaneously

### HFP Setup Sequence

```
1. AVAudioSession.setCategory(.playAndRecord, options: [.allowBluetooth])
2. AVAudioSession.setActive(true)
3. Wait 2s for Bluetooth HFP handshake
4. Start StreamSession
5. AudioStage starts AVAudioEngine input tap
6. HFP mic audio arrives at 8kHz, upsampled to 16kHz for FRAU encoding
```

## Gotchas

- **Ordering matters**: If you start streaming before HFP is ready, audio routing will fall back to the phone mic and won't switch to glasses mic mid-session
- **Beamforming side effect**: Glasses mic captures the wearer's voice clearly but suppresses ambient sounds -- not suitable for capturing environmental audio
- **HFP bandwidth**: 8kHz mono is a hard Bluetooth HFP limitation, not a DAT SDK limitation
- **Audio session conflicts**: Other apps using audio (phone calls, Siri, music) can interrupt the HFP connection

## Links

- [DAT SDK Audio Docs](https://wearables.developer.meta.com/docs/develop/audio)
- [AVAudioSession Reference](https://developer.apple.com/documentation/avfaudio/avaudiosession)
- [iOS Audio Session Programming Guide](https://developer.apple.com/library/archive/documentation/Audio/Conceptual/AudioSessionProgrammingGuide/)
