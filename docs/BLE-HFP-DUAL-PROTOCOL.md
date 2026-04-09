# Ray-Ban Meta Glasses: Dual Bluetooth Protocol Stack

Ray-Ban Meta smart glasses maintain **two simultaneous Bluetooth connections** to the
iPhone. They share the same 2.4 GHz physical radio, which creates tight coupling between
video streaming and audio routing.

---

## Protocol Overview

```
                         Ray-Ban Meta Glasses
                                |
                   +------------+------------+
                   |                         |
              BLE (L2CAP)                 HFP
              Video Stream              Audio I/O
                   |                         |
         +---------+----------+     +--------+--------+
         | QUIC tunnel        |     | Mic input (8/16kHz)
         | over L2CAP channel |     | Speaker output
         | multiplexed,       |     | bidirectional
         | reliable transport |     | narrow/wideband
         +--------------------+     +-----------------+
                   |                         |
                   +------------+------------+
                                |
                         Bluetooth LE
                          2.4 GHz RF
                                |
                         iPhone (Central)
```

| Property | BLE + L2CAP/QUIC | HFP |
|----------|------------------|-----|
| Purpose | Video stream (DAT SDK) | Mic in + speaker out |
| Direction | Glasses -> Phone (unidirectional video) | Bidirectional audio |
| Throughput | 0.5-1 Mbps real-world | 8kHz (narrowband) / 16kHz (wideband) |
| Latency | 1-3 seconds | ~50ms |
| Protocol stack | BLE -> L2CAP -> QUIC -> DAT API | Classic BT HFP profile |
| Service UUID | `com.meta.ar.wearable` | Standard HFP UUID |
| Managed by | DAT SDK (`MWDATCore`/`MWDATCamera`) | iOS `AVAudioSession` |

---

## Physical Radio Sharing

Both profiles run over the **same Bluetooth radio** to the glasses. This means:

1. **Audio session changes disrupt the BLE video link.** Any call to
   `AVAudioSession.setCategory()`, `setPreferredInput()`, or `setActive()` while the
   DAT SDK video stream is running triggers a BT link renegotiation that tears down the
   QUIC tunnel.

2. **HFP activation changes the audio hardware format.** When the glasses are the active
   audio input (HFP), `AVAudioEngine.inputNode.outputFormat(forBus: 0)` reports
   8kHz/1ch/Int16 instead of 48kHz/1ch/Float32 (built-in mic).

3. **Bandwidth is shared.** Active HFP audio consumes some of the BLE radio time,
   slightly reducing video throughput.

---

## Initialization Sequence

The app **must** configure AVAudioSession before the DAT SDK to avoid mid-stream category
changes. This ordering is enforced in `CameraAccessApp.init()`:

```
Phase A: App Launch (CameraAccessApp.init)
  1. AVAudioSession.setCategory(.playAndRecord,
       options: [.allowBluetooth, .defaultToSpeaker, .mixWithOthers])
     -- .allowBluetooth enables HFP on the BT link to glasses
     -- Without this, iOS only activates A2DP (output-only)
  2. AVAudioSession.setActive(true)
  3. Wearables.configure()
     -- Initializes CBCentralManager, registers service UUIDs
  4. Wearables.shared reference obtained

Phase B: User Registration (WearablesViewModel)
  5. wearables.startRegistration() -> opens Meta AI via fb-viewapp:// URL
  6. User approves in Meta AI
  7. Callback: cameraaccess://?code=xyz&state=abc -> handleUrl()
  8. State: .unregistered -> .registering -> .registered

Phase C: Video Stream Start (StreamSessionViewModel)
  9. Permission check: wearables.requestPermission(.camera)
  10. StreamSession.start()
      -- SDK internally: BLE scan -> connect -> L2CAP open -> QUIC handshake
      -- State: stopped -> waitingForDevice -> starting -> streaming

Phase D: Audio Relay (user taps cloud button, optional)
  11. checkMicPermission() on @MainActor
  12. relayStage.connect(to: url) -- WebSocket to relay server
  13. audioRelayStage.attachToEventBus(audioEventBus)
  14. audioStage.start() -- AVAudioEngine on background actor executor
```

---

## Audio Hardware Format Matrix

The `AudioStage` uses `inputNode.outputFormat(forBus: 0)` (hardware native format)
for the tap. Requesting a different format at tap level causes `SIGABRT` on iOS 18.

| Active Input | Sample Rate | Channels | Format | Notes |
|-------------|-------------|----------|--------|-------|
| Built-in mic (phone) | 48000 Hz | 1 | Float32 | Default when no BT device |
| HFP glasses mic | 8000 Hz | 1 | Int16 (or Float32 wrapper) | Narrowband HFP |
| HFP glasses mic (wideband) | 16000 Hz | 1 | Int16 | If glasses negotiate wideband |
| Other BT headset | Varies | 1 | Varies | Depends on headset |

The `AudioPacket` carries `sampleRate` from the actual hardware format so consumers
(relay server, future recording stages) know the real sample rate of the PCM data.

---

## Hard Constraints

### 1. Never change audio session category during streaming

```
FORBIDDEN while DAT SDK video stream is active:
  - AVAudioSession.setCategory(...)
  - AVAudioSession.setActive(true)
  - AVAudioSession.setPreferredInput(...)

Consequence: BT link renegotiation -> QUIC tunnel drops -> video dies
```

### 2. Never call installTap from the main thread

```
REQUIRED:
  - AudioStage is a Swift actor (background executor)
  - installTap called from actor executor, NOT @MainActor
  - Tap callback fires on internal audio thread

Consequence if violated: EXC_BREAKPOINT or SIGABRT
```

### 3. Use hardware native format for installTap

```
REQUIRED:
  - let hwFormat = inputNode.outputFormat(forBus: 0)
  - installTap(onBus: 0, bufferSize: 1024, format: hwFormat)
  - Convert to target format in the tap callback

Consequence if violated: NSException SIGABRT on iOS 18 (SetOutputFormat)
```

### 4. routeAudioInput() must happen before streaming starts

```
The routeAudioInput() method is DISABLED during streaming.
Changing setPreferredInput() while the DAT SDK BT video stream is
active tears down the HFP link and kills video.
The audioInputMode is stored but only applied on next session.
```

---

## QUIC Connection State Machine (Internal to DAT SDK)

```
idle -> connecting -> establishing -> handshaking -> ready -> failed(Error)
                     (BLE connect)  (L2CAP open)   (TLS)     (retry w/ backoff)
```

Errors visible in logs (`quic_conn_process_inbound`) occur during the TLS handshake
phase and are expected transient failures during connection establishment.

---

## StreamSession State Machine

```
stopped -> waitingForDevice -> starting -> streaming -> paused -> stopped
                                    |         |
                                    v         v
                               BLE connect  Frames arriving
                               QUIC setup   via QUIC data channel
```

Physical triggers:
- Closing glasses hinges -> Bluetooth disconnects -> forces `STOPPED`
- Opening hinges -> restores Bluetooth but does NOT restart sessions
- Another app claims the device -> session preempted
- System gesture -> session paused

---

## Decoupled Audio Pipeline

The audio path is decoupled from video via event bus:

```
AudioStage (mic capture)
  |  publishes AudioPacket (PCM + metadata)
  v
AudioEventBus (AsyncStream pub/sub, .bufferingNewest(10))
  |
  v
AudioRelayStage (subscribes to bus)
  |  encodes AudioPacket as FRAU wire protocol
  v
RelayStage (WebSocket binary send)
  |
  v
relay.simulationapi.com
```

Video path runs independently through FramePipelineManager:

```
StreamSession.videoFramePublisher
  -> FramePipelineManager (@MainActor)
  -> Task.detached { stage.processFrame(packet) }
  -> DisplayStage (UI) / RecordingStage (.mov) / RelayStage (FRLY wire protocol)
```

Both paths converge at `RelayStage.sendRawData()` for WebSocket binary transport,
but they never share mutable state. Video uses FRLY header; audio uses FRAU header.

---

## Wire Protocol Summary

### FRLY -- Video Frame (29-byte header + JPEG)

| Offset | Size | Field |
|--------|------|-------|
| 0 | 4 | Magic `0x46524C59` ("FRLY") |
| 4 | 8 | Sequence number (uint64 LE) |
| 12 | 4 | Width (uint32 LE) |
| 16 | 4 | Height (uint32 LE) |
| 20 | 1 | JPEG quality 0-100 (uint8) |
| 21 | 8 | Timestamp ms (uint64 LE) |
| 29 | N | JPEG payload |

### FRAU -- Audio Frame (29-byte header + PCM)

| Offset | Size | Field |
|--------|------|-------|
| 0 | 4 | Magic `0x46524155` ("FRAU") |
| 4 | 1 | Codec: 0 = raw PCM 16-bit LE |
| 5 | 8 | Sequence number (uint64 LE) |
| 13 | 4 | Sample rate (uint32 LE) |
| 17 | 2 | Channels (uint16 LE) |
| 19 | 2 | Bits/sample (uint16 LE) |
| 21 | 8 | Timestamp ms (uint64 LE) |
| 29 | N | PCM 16-bit LE audio data |

Note: FRAU `sampleRate` reflects the actual hardware rate (varies: 48000 built-in,
8000 HFP, 16000 wideband HFP). Consumers must handle variable-rate audio.

---

## Audio Routing Scenarios

| Scenario | Active Input | AudioSession Route | Hardware Format | Behavior |
|----------|-------------|-------------------|----------------|----------|
| Glasses connected, no relay | N/A (no tap) | HFP output to glasses speaker | N/A | Video stream works. TTS can play to glasses speaker via HFP. |
| Glasses connected, relay active | Built-in mic (default) | HFP output + built-in mic input | 48kHz Float32 | Video + audio relay both work. Glasses HFP not used for capture. |
| Glasses connected, relay active, glasses mic | Glasses HFP mic | HFP bidirectional | 8kHz Int16 | DANGEROUS: conflicts with DAT SDK BLE video stream. May cause frame drops or disconnect. |
| No glasses, relay active | Built-in mic | Built-in speaker/mic | 48kHz Float32 | Audio relay works. No video. |
| Phone call during relay | Interrupted | Phone call takes HFP | N/A | AudioStage pauses engine. Resumes if `shouldResume=true` on interruption end. |

---

## Key Files

| File | Role |
|------|------|
| `CameraAccessApp.swift` | Audio session config + SDK init ordering |
| `ViewModels/StreamSessionViewModel.swift` | Pipeline orchestration, sequence constraints |
| `Pipeline/Stages/AudioStage.swift` | Mic capture via AVAudioEngine, hardware format handling |
| `Pipeline/Stages/AudioRelayStage.swift` | AudioEventBus subscriber, FRAU wire protocol encoder |
| `Pipeline/AudioEventBus.swift` | AsyncStream pub/sub between AudioStage and consumers |
| `Pipeline/AudioPacket.swift` | Transport-agnostic PCM data + metadata struct |
| `Pipeline/AudioTransport.swift` | Protocol for audio consumers |
| `Pipeline/Stages/RelayStage.swift` | WebSocket relay, FRLY video + sendRawData() for FRAU audio |
| `Pipeline/Stages/AudioPlaybackStage.swift` | TTS to glasses via HFP (disabled -- conflicts with relay) |
| `Pipeline/FramePipelineManager.swift` | Video frame dispatcher to stages |

## Related Documentation

- `docs/DAT_SDK_TECHNICAL_ANALYSIS.md` -- BLE/L2CAP/QUIC protocol stack, bandwidth analysis
- `docs/MWDAT_SDK_TECHNICAL_ANALYSIS.md` -- SDK framework types, state machines, error types
- `docs/FLOW-AND-THREADING.md` -- Actor boundary map, threading safety, installTap constraints
- `NETWORKING.md` -- Relay architecture, wire protocol specs, VPS deployment
- `.claude/skills/session-lifecycle.md` -- StreamSession state machine
- `.claude/skills/camera-streaming.md` -- Bandwidth auto-reduction behavior
