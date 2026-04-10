# Flow and Threading Analysis: CameraAccess Pipeline

Complete actor boundary, threading, and async/await crossing map for the CameraAccess
iOS app. Covers every isolation domain, every executor hop, and every AVAudioSession /
AVAudioEngine call with its required threading context.

---

## 1. Actor/Executor Map Per File

### 1.1 CameraAccessApp.swift

| Property | Isolation |
|---|---|
| `@main struct CameraAccessApp: App` | `@MainActor` (SwiftUI App protocol conformance) |
| `init()` body | Main thread (struct init runs at construction site, which is @MainActor here) |
| `AVAudioSession.sharedInstance().setCategory(...)` | Called from `init()` -- main thread |
| `AVAudioSession.sharedInstance().setActive(true)` | Called from `init()` -- main thread |
| `Wearables.configure()` | Called from `init()` -- main thread |
| `var body: some Scene` | `@MainActor` (SwiftUI View body) |

**Threads touched:** Main thread only during init. The audio session is configured as
`.playAndRecord` with `.allowBluetooth`, `.defaultToSpeaker`, `.mixWithOthers` at launch
so no stage ever needs to change the category mid-stream.

**Key design decision:** Audio session category is set once at app launch. Changing the
category while the DAT SDK Bluetooth video stream is active crashes the BT connection.

---

### 1.2 FramePipelineTypes.swift

| Type | Isolation |
|---|---|
| `struct FramePacket: @unchecked Sendable` | Nonisolated (value type, no actor) |
| `struct FrameStageConfig: Sendable` | Nonisolated (value type) |
| `protocol FramePipelineStage` | Nonisolated (protocol requirement) |
| `nonisolated var stageId` | No actor -- accessed from any context |
| `var config` | Isolated to conforming actor (mutable state) |
| `func processFrame(_:) async` | Crosses to conforming actor's executor |
| `func start() async` | Crosses to conforming actor's executor |
| `func stop() async` | Crosses to conforming actor's executor |

**Threads touched:** None directly. These are protocol/value definitions. The async
methods represent boundary crossings -- when called, execution hops to whatever actor
conforms to the protocol.

**Key design decision:** `FramePacket` is `@unchecked Sendable` because `CMSampleBuffer`
is not Sendable, but it is documented as safe to pass across isolation boundaries when
the producer stops mutating it. The pipeline creates the packet on MainActor and then
dispatches it to stage actors via `Task.detached`.

---

### 1.3 FramePipelineManager.swift

| Property/Method | Isolation | Thread |
|---|---|---|
| `@MainActor final class FramePipelineManager` | **@MainActor** | Main thread |
| `var stages: [any FramePipelineStage]` | @MainActor isolated | Main thread |
| `func register(_:)` | @MainActor | Main thread |
| `func attachToStreamSession(_:)` | @MainActor | Main thread |
| `listenerToken = session.videoFramePublisher.listen { ... }` | Callback on SDK thread, hops to @MainActor via `Task { @MainActor in }` | |
| `private func onVideoFrame(_:)` | @MainActor | Main thread |
| `Task.detached { await stage.processFrame(packet) }` | **Hops off MainActor** to each stage's actor executor | Background |
| `func startAll() async` | @MainActor, sequential `await stage.start()` | Hops to each stage actor, returns to main |
| `func stopAll() async` | @MainActor, sequential `await stage.stop()` | Hops to each stage actor, returns to main |

**Threads touched:**
- Main thread: frame reception, packet construction, stage iteration
- Background (per-stage actor executor): `processFrame` dispatch via `Task.detached`

**Async boundary crossings:**
1. SDK callback thread --> @MainActor (`Task { @MainActor in onVideoFrame(...) }`)
2. @MainActor --> stage actor executor (`Task.detached { await stage.processFrame(packet) }`)

The `Task.detached` is critical. It ensures each stage processes frames independently on
its own executor without blocking the main thread. The fire-and-forget pattern means the
pipeline never awaits individual stage processing.

---

### 1.4 ThrottledStage.swift

| Property/Method | Isolation | Thread |
|---|---|---|
| `actor ThrottledStage` | **Custom actor executor** | Background (Swift runtime managed) |
| `nonisolated let stageId` | No actor isolation | Any thread (let binding, safe) |
| `var config` | Actor-isolated | Actor executor |
| `nonisolated func processFrame(_:) async` | Nonisolated entry, immediately calls `await throttledProcess()` which hops to actor | |
| `func throttledProcess(_:)` | Actor-isolated | Actor executor |
| `func processThrottledFrame(_:)` | Actor-isolated, overridden by subclasses | Actor executor |

**Threads touched:** Actor executor only (background, managed by Swift runtime).

**Async boundary crossing:** `processFrame` is `nonisolated` (required by protocol), then
`await throttledProcess(packet)` hops onto the actor's executor. This is a standard
protocol-to-actor bridge pattern.

---

### 1.5 DisplayStage.swift

| Property/Method | Isolation | Thread |
|---|---|---|
| `actor DisplayStage` | **Custom actor executor** | Background |
| `nonisolated let stageId` | No isolation | Any |
| `private let onFrame: @MainActor @Sendable (UIImage) -> Void` | Stored closure, invoked on @MainActor | |
| `nonisolated func processFrame(_:) async` | Nonisolated entry, hops to actor via `await processFrameInternal()` | |
| `private func processFrameInternal(_:)` | Actor-isolated | Actor executor |
| `makeCGImage(from:)` | Actor-isolated | Actor executor (CIContext, CGImage -- no UIKit dependency) |
| `Task { @MainActor in let image = UIImage(cgImage:); onFrame(image) }` | **Hops to @MainActor** | Main thread |

**Threads touched:**
- Actor executor: CIImage -> CGImage conversion (CPU-intensive, off main thread)
- Main thread: `UIImage(cgImage:)` creation and `onFrame` callback

**Async boundary crossing:** Actor executor --> @MainActor inside `processFrameInternal`.
This is necessary because `UIImage` is `@MainActor`-isolated in iOS 17+.

**Key design decision:** Heavy image conversion (CIContext.createCGImage) runs on the
actor's background executor. Only the lightweight UIImage wrapper and @Published update
hop back to MainActor. This keeps frame processing off the main thread.

---

### 1.6 RelayStage.swift

| Property/Method | Isolation | Thread |
|---|---|---|
| `actor RelayStage` | **Custom actor executor** | Background |
| `nonisolated let stageId` | No isolation | Any |
| `func connect(to:) async throws` | Actor-isolated | Actor executor |
| `func disconnect()` | Actor-isolated | Actor executor |
| `nonisolated func processFrame(_:) async` | Nonisolated entry, hops to actor | |
| `private func relayFrame(_:)` | Actor-isolated | Actor executor |
| `Task.detached { /* JPEG encode + send */ }` | **Detached from actor** | Background thread pool |
| `func sendRawData(_:)` | Actor-isolated | Actor executor |
| `private func sendHello()` | Actor-isolated, spawns `Task { @MainActor in }` | |
| `nonisolated static func hardwareModelIdentifier()` | No isolation (reads `utsname`) | Any thread |

**Threads touched:**
- Actor executor: connection management, state mutation, sequence tracking
- Background thread pool (via `Task.detached`): JPEG encoding (CIContext, CGImageDestination), WebSocket send
- Main thread (via `Task { @MainActor in }`): reading `UIDevice.current` properties for hello message
- URLSession delegate queue: WebSocket delegate callbacks

**Async boundary crossings:**
1. Actor executor --> background thread pool (`Task.detached` for JPEG encoding)
2. Actor executor --> @MainActor (`sendHello` reads UIDevice.current)
3. Background thread pool --> actor executor (send error/success callbacks via `Task { await self?.onSendError() }`)
4. URLSession delegate queue --> actor executor (WebSocket open/close callbacks via continuation)

**Key design decision:** JPEG encoding is the most CPU-intensive operation in the pipeline.
It is dispatched via `Task.detached` so the actor returns immediately and can accept the
next frame. A backpressure flag (`isEncoding`) drops frames if the previous encode is still
in progress, preventing unbounded memory growth.

---

### 1.7 AudioStage.swift

| Property/Method | Isolation | Thread |
|---|---|---|
| `actor AudioStage` | **Custom actor executor** | Background |
| `nonisolated let stageId` | No isolation | Any |
| `func setRelayStage(_:)` | Actor-isolated | Actor executor |
| `nonisolated func processFrame(_:) async` | No-op (audio stage ignores video frames) | |
| **`func start() async`** | **Actor-isolated** | **Actor executor (NOT main thread)** |
| `AVAudioEngine()` creation | **Actor executor** | **Background thread** |
| `inputNode.installTap(onBus:...)` | **Actor executor** | **Background thread** |
| Tap callback `{ buffer, _ in ... }` | **Audio render thread** (per Apple docs: "may invoke on a thread other than the main thread") | |
| `Task { await self?.sendFRAU(...) }` | **Hops from audio thread to actor executor** | |
| `try engine.start()` | Actor executor | Background thread |
| `engine.inputNode.removeTap(onBus: 0)` | Actor-isolated (`stop()`) | Actor executor |
| `NotificationCenter.addObserver(forName:..., queue: .main)` | Actor executor (registration), main queue for callbacks | |
| `func handleInterruption(_:)` | Actor-isolated (called via `Task { await self?.handleInterruption }`) | Actor executor |
| `func handleRouteChange(_:)` | Actor-isolated (called via `Task { await self?.handleRouteChange }`) | Actor executor |
| `nonisolated static func floatToPCM16(...)` | No isolation (pure computation) | Audio render thread (called from tap) |
| `private func sendFRAU(_:, codecType:)` | Actor-isolated | Actor executor |
| `Task { await relayStage.sendRawData(message) }` | **Hops to RelayStage actor** | RelayStage executor |

**Threads touched:**
- Actor executor: AVAudioEngine lifecycle, state management, FRAU encoding, notification handling
- **Audio render thread**: installTap callback -- receives PCM buffers at ~48kHz / 20ms intervals
- RelayStage actor executor: via `sendFRAU` --> `relayStage.sendRawData(message)`

**Async boundary crossings:**
1. Audio render thread --> AudioStage actor (`Task { await self?.sendFRAU(...) }`)
2. AudioStage actor --> RelayStage actor (`await relayStage.sendRawData(message)`)
3. Main queue (NotificationCenter) --> AudioStage actor (`Task { await self?.handleInterruption }`)

---

### 1.8 RecordingStage.swift

| Property/Method | Isolation | Thread |
|---|---|---|
| `actor RecordingStage` | **Custom actor executor** | Background |
| `nonisolated func processFrame(_:) async` | Nonisolated entry, hops to actor | |
| `func appendFrame(_:)` | Actor-isolated | Actor executor |
| `AVAssetWriter` operations | Actor executor | Background |
| `AVAssetWriterInput.append(_:)` | Actor executor | Background |
| `func stopRecording() async` | Actor-isolated, `await writer.finishWriting()` | Actor executor |

**Threads touched:** Actor executor only.

**Async boundary crossing:** Nonisolated `processFrame` --> actor-isolated `appendFrame`.
AVAssetWriter operations run on the actor's background executor, which is acceptable --
AVFoundation's writer APIs are thread-safe when used serially (which actor isolation
guarantees).

---

### 1.9 AudioPlaybackStage.swift

| Property/Method | Isolation | Thread |
|---|---|---|
| `actor AudioPlaybackStage` | **Custom actor executor** | Background |
| `nonisolated func processFrame(_:) async` | No-op | |
| `func start() async` | Actor-isolated, spawns `Task { @MainActor in }` | |
| `loopTask = Task { @MainActor in ... }` | **Entire TTS loop runs on @MainActor** | Main thread |
| `AVSpeechSynthesizer` | @MainActor (inside the Task block) | Main thread |
| `nonisolated static func logAudioRoutes()` | No isolation, but called from @MainActor context | Main thread (at call site) |
| `nonisolated static func tryRouteToGlasses()` | No isolation, but called from @MainActor context | Main thread (at call site) |
| `AVAudioSession.sharedInstance().setPreferredInput(...)` | @MainActor (inside the Task block) | Main thread |
| `func stop() async` | Actor-isolated, hops to @MainActor for route reset | |

**Threads touched:**
- Actor executor: lifecycle state (isPlaying, loopTask management)
- **Main thread**: AVSpeechSynthesizer, AVAudioSession route changes, UIDevice access

**Async boundary crossings:**
1. Actor executor --> @MainActor (`Task { @MainActor in }` in start())
2. @MainActor --> actor executor (`await self.isPlaying`, `await self.phrase`, `await self.speechRate`)
3. Actor executor --> @MainActor (stop() resets route via `await Task { @MainActor in }`)

**Important note on `logAudioRoutes()` and `tryRouteToGlasses()`:** These are marked
`nonisolated static` but call `AVAudioSession.sharedInstance()` and access route
properties. In iOS 17+, `AVAudioSession` property access is effectively `@MainActor`-
isolated. These methods are safe ONLY because `start()` dispatches to @MainActor before
calling them. If called directly from the actor executor, they would produce runtime
assertion failures or crashes. The code comments acknowledge this danger.

---

### 1.10 StreamSessionViewModel.swift

| Property/Method | Isolation | Thread |
|---|---|---|
| `@MainActor class StreamSessionViewModel` | **@MainActor** | Main thread |
| All `@Published` properties | @MainActor | Main thread |
| `init()` | @MainActor | Main thread |
| `pipeline.register(...)` calls | @MainActor | Main thread |
| `Task { await audioStage.setRelayStage(relayStage) }` | @MainActor, hops to AudioStage actor | |
| `func startRelay() async` | @MainActor | Main thread |
| `func checkMicPermission() async -> Bool` | @MainActor | Main thread |
| `AVAudioSession.sharedInstance().recordPermission` | @MainActor | Main thread |
| `AVAudioSession.sharedInstance().requestRecordPermission(...)` | @MainActor (caller), callback on arbitrary thread | Main thread (initiation) |
| `await relayStage.setDeviceIdentity(...)` | **Hops to RelayStage actor** | RelayStage executor |
| `try await relayStage.connect(to: url)` | **Hops to RelayStage actor** | RelayStage executor |
| `await audioStage.start()` | **Hops to AudioStage actor** | AudioStage executor |
| `func stopRelay() async` | @MainActor, sequential actor hops | |
| `await audioStage.stop()` | **Hops to AudioStage actor** | AudioStage executor |
| `await relayStage.disconnect()` | **Hops to RelayStage actor** | RelayStage executor |
| `func routeAudioInput()` | @MainActor | Main thread |
| `AVAudioSession.sharedInstance().setPreferredInput(...)` | @MainActor | Main thread |
| `func stopSession() async` | @MainActor | Main thread |
| `AVAudioSession.sharedInstance().setActive(false, ...)` | @MainActor | Main thread |

**Threads touched:** Main thread only for direct work. Sequential hops to actor executors
for stage operations.

**Async boundary crossings (in startRelay alone):**
1. @MainActor --> @MainActor (checkMicPermission, local)
2. @MainActor --> RelayStage actor (setDeviceIdentity)
3. @MainActor --> RelayStage actor (connect)
4. @MainActor --> AudioStage actor (start)

---

## 2. AVAudioSession / AVAudioEngine Call Registry

Every call site mapped to its isolation context and Apple's threading requirement:

| Call | File | Isolation Context | Meets Apple Requirement? |
|---|---|---|---|
| `AVAudioSession.setCategory(.playAndRecord, ...)` | CameraAccessApp.init() | @MainActor (main thread) | YES |
| `AVAudioSession.setActive(true)` | CameraAccessApp.init() | @MainActor (main thread) | YES |
| `AVAudioSession.recordPermission` | StreamSessionViewModel | @MainActor | YES |
| `AVAudioSession.requestRecordPermission(...)` | StreamSessionViewModel | @MainActor | YES |
| `AVAudioSession.availableInputs` | StreamSessionViewModel (routeAudioInput) | @MainActor | YES |
| `AVAudioSession.setPreferredInput(...)` | StreamSessionViewModel (routeAudioInput) | @MainActor | YES |
| `AVAudioSession.setActive(false, ...)` | StreamSessionViewModel (stopSession) | @MainActor | YES |
| `AVAudioSession.sharedInstance()` reads | AudioPlaybackStage (logAudioRoutes, tryRouteToGlasses) | @MainActor (via Task block) | YES (fragile -- see note) |
| `AVAudioSession.setPreferredInput(...)` | AudioPlaybackStage (tryRouteToGlasses) | @MainActor (via Task block) | YES (fragile) |
| `AVAudioSession.setPreferredInput(nil)` | AudioPlaybackStage (stop) | @MainActor (via await Task { @MainActor }) | YES |
| **`AVAudioEngine()`** | AudioStage.start() | **AudioStage actor executor** | **YES -- see section 3** |
| **`engine.inputNode`** | AudioStage.start() | **AudioStage actor executor** | **YES -- not main-thread required** |
| **`inputNode.installTap(onBus:...)`** | AudioStage.start() | **AudioStage actor executor** | **YES -- MUST NOT be main thread** |
| **`engine.start()`** | AudioStage.start() | **AudioStage actor executor** | **YES** |
| **`engine.inputNode.removeTap(onBus: 0)`** | AudioStage.stop() | **AudioStage actor executor** | **YES** |
| **`engine.stop()`** | AudioStage.stop() | **AudioStage actor executor** | **YES** |
| **`engine.pause()`** | AudioStage.handleInterruption | **AudioStage actor executor** | **YES** |

---

## 3. The installTap Threading Requirement (Critical)

### What Apple Documents

From the official Apple documentation for `installTap(onBus:bufferSize:format:block:)`:

> **Important:** The framework may invoke the `tapBlock` on a thread other than the main thread.

From WWDC 2014 "AVAudioEngine in Practice" and subsequent documentation:

- `installTap` does **not** require the main thread for the call itself.
- `installTap` does **not** require the main thread for the tap callback.
- The tap callback runs on an **internal audio thread** (not the real-time render thread,
  but also not the main thread).
- You must not call `installTap` on the same bus twice without removing the prior tap.

### iOS 17+ / Swift Concurrency Interaction

In iOS 17+, several AVAudioSession and AVAudioEngine APIs gained implicit `@MainActor`
annotations in Swift. However, `AVAudioEngine` construction, `installTap`, `engine.start()`,
`engine.stop()`, and `removeTap` are **NOT** `@MainActor`-isolated. They are safe to call
from any thread.

### The installTap Crash Scenario

There are two distinct crash scenarios:

**Scenario A: Calling installTap from @MainActor (main thread)**

Per extensive community reports and the article by Itsuki (September 2025):
> "`installTap(onBus:bufferSize:format:block:)` will crash if called from the main thread!"

This is because the tap callback runs on an internal audio thread, and installing the tap
from the main thread creates a priority inversion or deadlock condition with the audio
render pipeline. The crash manifests as an `EXC_BREAKPOINT` or `SIGABRT` in the audio
subsystem.

The community solution is to mark audio engine classes as `nonisolated` and call
`installTap` from a background context.

**Scenario B: Calling @MainActor-isolated APIs from inside the tap callback**

The tap callback runs on the audio thread, NOT @MainActor. Any attempt to call
AVAudioSession methods that are now `@MainActor`-isolated in iOS 17+ from inside the tap
callback will crash with a `MainActor.assumeIsolated` assertion failure.

### How This Codebase Handles installTap

The codebase handles this **correctly**:

1. `AudioStage` is a Swift `actor` (not @MainActor).
2. `start()` is actor-isolated, running on the actor's background executor.
3. `AVAudioEngine()` is created on the actor executor (background thread) -- not main.
4. `inputNode.installTap(onBus:...)` is called on the actor executor (background thread) -- not main.
5. The tap callback receives buffers on the audio thread and dispatches to the actor:
   ```swift
   Task { [weak self] in
       await self?.sendFRAU(pcmData, codecType: ...)
   }
   ```
6. `sendFRAU` runs on the actor executor, builds the FRAU wire protocol, and dispatches
   to RelayStage.

The code comments in `StreamSessionViewModel.startRelay()` document this explicitly:
```
// THREADING REVIEW [FIXED]:
// Permission check runs on @MainActor here (safe for AVAudioSession APIs).
// audioStage.start() no longer touches AVAudioSession -- permission handled above.
```

### What the Crash Stack Trace Would Tell Us

If a crash occurred on `installTap`, the stack trace would show:

```
Thread X (audio thread or actor executor):
  #0  ... AVAudioNode.installTap(onBus:bufferSize:format:block:)
  #1  ... AudioStage.start() [at line where installTap is called]
  ...
```

Or if called from main thread incorrectly:
```
Thread 1 (main thread):
  #0  ... UIApplicationMain / SwiftUI body evaluation
  #1  ... AudioStage.start() called from @MainActor context
  #2  ... specialized AudioStage.start()
  #3  ... AVAudioNode.installTap(onBus:bufferSize:format:block:)
  CRASH: EXC_BREAKPOINT or assertion failure
```

The current code avoids both scenarios because `AudioStage` is an actor (background
executor), and the ViewModel correctly awaits `audioStage.start()` which crosses from
@MainActor to the actor's executor before touching AVAudioEngine.

---

## 4. Complete Flow: User Presses the Cloud Button (startRelay)

Step-by-step trace with actor boundaries and thread assignments:

### Step 1: Button Tap

```
Thread: Main thread
Actor: @MainActor (SwiftUI button action)
```
The SwiftUI button's action closure executes on @MainActor. It calls
`viewModel.startRelay()`.

### Step 2: StreamSessionViewModel.startRelay()

```
Thread: Main thread
Actor: @MainActor (StreamSessionViewModel is @MainActor class)
```
Entry point. Validates the relay URL. Still on @MainActor.

### Step 3: checkMicPermission()

```
Thread: Main thread
Actor: @MainActor (method on @MainActor class)
API: AVAudioSession.sharedInstance().recordPermission -- @MainActor safe
API: AVAudioSession.requestRecordPermission -- @MainActor safe (callback on arbitrary thread)
```
Checks `recordPermission == .granted`. If not granted, calls
`session.requestRecordPermission { granted in cont.resume(returning: granted) }`.
The callback arrives on an arbitrary thread, but `withCheckedContinuation` bridges it
back into the async context safely. Returns to @MainActor.

**Why @MainActor:** `AVAudioSession` property access (`recordPermission`,
`requestRecordPermission`) is `@MainActor`-isolated in iOS 17+. Calling from an actor
executor would trigger a runtime assertion.

### Step 4: relayStage.setDeviceIdentity(...)

```
Thread: HOPS from main thread to RelayStage actor executor
Actor: RelayStage (custom actor)
Boundary: @MainActor --> RelayStage actor (await)
```
Sets wearable device info. Pure data storage, no system API calls.

### Step 5: relayStage.connect(to: url)

```
Thread: RelayStage actor executor
Actor: RelayStage (custom actor)
API: URLSession(configuration:delegate:delegateQueue:nil) -- no thread requirement
API: session.webSocketTask(with:) -- no thread requirement
API: task.resume() -- no thread requirement
```
Creates URLSession with a custom delegate. The delegate callbacks (onOpen, onClose)
arrive on URLSession's delegate queue (a serial queue since `delegateQueue: nil` creates
a default serial queue). The `withCheckedContinuation` bridges these callbacks back into
the async context.

After connection:
- `sendHello()` dispatches to @MainActor to read `UIDevice.current` properties, then
  sends JSON via WebSocket.
- `startReceiveLoop()` spawns a `Task` on the actor executor for continuous WebSocket
  message reception.
- `startKeepAlive()` spawns a `Task` that sends WebSocket pings every 5 seconds.

### Step 6: audioStage.start()

```
Thread: HOPS from main thread to AudioStage actor executor
Actor: AudioStage (custom actor)
Boundary: @MainActor --> AudioStage actor (await)
```
This is the critical transition. The ViewModel calls `await audioStage.start()` which
suspends the @MainActor and resumes on the AudioStage's background executor.

### Step 7: AVAudioEngine Creation

```
Thread: AudioStage actor executor (background)
Actor: AudioStage
API: AVAudioEngine() -- no main thread requirement, safe from any context
```
`let engine = AVAudioEngine()` runs on the actor's background executor. This is correct --
AVAudioEngine does not require main thread creation.

### Step 8: installTap

```
Thread: AudioStage actor executor (background -- NOT main thread)
Actor: AudioStage
API: inputNode.installTap(onBus: 0, bufferSize: 960, format: targetFormat)
Apple requirement: Tap callback invoked on audio thread (not main thread)
CRITICAL: Calling from background actor executor is CORRECT.
          Calling from @MainActor / main thread would CRASH.
```
This is the linchpin. The tap is installed from the actor executor, which is a background
thread. Apple's documentation states the tap callback runs on "a thread other than the
main thread." Installing from a background context avoids the priority inversion that
causes crashes.

The format requested is 48kHz mono float32. The engine handles format conversion from
whatever the hardware provides (e.g., 8kHz HFP from glasses).

### Step 9: Tap Callback (Audio Render Thread)

```
Thread: Audio render thread (internal to AVAudioEngine, NOT main thread, NOT actor executor)
Actor: None (raw callback context)
API: buffer.floatChannelData (read-only access)
Computation: floatToPCM16() -- nonisolated static, no locks, no allocations
```
The tap callback fires ~50 times per second (48kHz / 960 frames = 50 Hz, i.e., every 20ms).

Inside the callback:
1. Reads `buffer.floatChannelData?[0]` -- zero-copy access to the PCM float buffer.
2. Calls `Self.floatToPCM16(floatData, frameCount:)` -- a `nonisolated static` method
   that converts float32 to int16 PCM in-place. No allocations, no locks, no Objective-C
   messages. Safe for the audio thread.
3. Dispatches to the actor: `Task { [weak self] in await self?.sendFRAU(pcmData, ...) }`.

The `Task { }` captures `pcmData` (a `Data` value) and `self` (weak). The task will be
enqueued to run on the AudioStage actor executor. The tap callback returns immediately,
unblocking the audio thread.

### Step 10: sendFRAU --> relayStage.sendRawData

```
Thread: AudioStage actor executor
Actor: AudioStage
Computation: Build FRAU wire protocol header (29 bytes) + append PCM payload
Boundary: Task { await relayStage.sendRawData(message) } hops to RelayStage actor
```

`sendFRAU` runs on the AudioStage actor executor:
1. Increments `sequenceNumber` (actor-isolated state).
2. Builds the 29-byte FRAU header: magic "FRAU" + codec type + sequence + sample rate +
   channels + bits per sample + timestamp.
3. Appends the PCM data payload.
4. Dispatches to RelayStage: `Task { await relayStage.sendRawData(message) }`.

### Step 11: relayStage.sendRawData

```
Thread: RelayStage actor executor
Actor: RelayStage
API: webSocketTask.send(.data(data)) -- no thread requirement (URLSession is thread-safe)
```
Checks `isConnected` and socket state, then sends the binary WebSocket message.
The send completion callback arrives on the URLSession's delegate queue, which may update
`isConnected` state via `Task { await self?.markDisconnected() }`.

---

## 5. Complete Actor Boundary Diagram

```
@MainActor (Main Thread)
  |
  |  CameraAccessApp.init()
  |    |-- AVAudioSession.setCategory()        [MainActor]
  |    |-- AVAudioSession.setActive()          [MainActor]
  |
  |  StreamSessionViewModel
  |    |-- @Published properties               [MainActor]
  |    |-- checkMicPermission()                [MainActor]
  |    |     |-- AVAudioSession.recordPermission       [MainActor]
  |    |     |-- AVAudioSession.requestRecordPermission [MainActor]
  |    |
  |    |-- startRelay()
  |    |     |-- await relayStage.setDeviceIdentity()  ----> [RelayStage actor]
  |    |     |-- await relayStage.connect()            ----> [RelayStage actor]
  |    |     |-- await audioStage.start()              ----> [AudioStage actor]
  |    |
  |    |-- routeAudioInput()                   [MainActor]
  |    |     |-- AVAudioSession.setPreferredInput()    [MainActor]
  |    |
  |    |-- stopSession()
  |    |     |-- AVAudioSession.setActive(false)       [MainActor]
  |    |
  |  FramePipelineManager (@MainActor)
  |    |-- onVideoFrame()                      [MainActor]
  |    |     |-- Task.detached { stage.processFrame() }  --+
  |    |                                                   |
  |  DisplayStage callback                                       |
  |    |-- Task { @MainActor in onFrame(image) } <------------+-- see below
  |
  +------------------------------------------------------------------+
                                                                     |
  RelayStage actor (Background)                                   <----+
    |-- connect() / disconnect()                  [RelayStage executor]
    |-- processFrame()                            [RelayStage executor]
    |     |-- relayFrame()
    |           |-- Task.detached { JPEG encode } ----> [Background thread pool]
    |           |                                        |
    |           |                          +-------------+
    |           |-- sendRawData()          |
    |           |     |-- wsTask.send()    |
    |           |                          |
    +--------------------------------------+
                                                     |
  AudioStage actor (Background)                   <--+
    |-- start()                                   [AudioStage executor]
    |     |-- AVAudioEngine()                     [AudioStage executor]
    |     |-- inputNode.installTap()              [AudioStage executor]
    |     |-- engine.start()                      [AudioStage executor]
    |     |-- NotificationCenter observers        [Main queue -> actor hop]
    |
    |   Tap callback (Audio Render Thread)        [NOT any actor -- audio thread]
    |     |-- floatToPCM16()                      [audio thread, nonisolated]
    |     |-- Task { await sendFRAU() }           ------> [AudioStage executor]
    |
    |-- sendFRAU()                                [AudioStage executor]
    |     |-- Build FRAU header
    |     |-- Task { await relayStage.sendRawData() } --> [RelayStage executor]
    |
    |-- stop()                                    [AudioStage executor]
    |     |-- removeTap(onBus: 0)                 [AudioStage executor]
    |     |-- engine.stop()                       [AudioStage executor]
    |
    +-----------------------------------------------+
                                                    |
  AudioPlaybackStage actor (Background)          <--+
    |-- start()                                   [AudioPlaybackStage executor]
    |     |-- Task { @MainActor in ... }          ------> [Main thread]
    |           |-- AVSpeechSynthesizer           [@MainActor]
    |           |-- AVAudioSession.setPreferredInput() [@MainActor]
    |           |-- AVAudioSession route reads    [@MainActor]
    |
    |-- stop()                                    [AudioPlaybackStage executor]
          |-- await Task { @MainActor in ... }    ------> [Main thread]
                |-- AVAudioSession.setPreferredInput(nil) [@MainActor]
```

---

## 6. Threading Safety Summary

### What is Safe

| Operation | From | Why Safe |
|---|---|---|
| AVAudioEngine creation | Any thread | No main thread requirement |
| installTap | Background thread (actor executor) | Avoids main-thread crash |
| removeTap | Same context as installTap | Consistent lifecycle |
| engine.start() / stop() | Any thread | No main thread requirement |
| engine.pause() | Any thread | No main thread requirement |
| Tap callback body | Audio thread (as designed) | Only nonisolated static pure computation |
| AVAudioSession.setCategory/setActive | @MainActor | iOS 17+ requirement met |
| AVAudioSession.recordPermission | @MainActor | iOS 17+ requirement met |
| AVAudioSession.setPreferredInput | @MainActor | iOS 17+ requirement met |
| AVSpeechSynthesizer.speak | @MainActor | UIKit requirement met |
| UIImage(cgImage:) | @MainActor | iOS 17+ requirement met |
| UIDevice.current access | @MainActor | iOS 17+ requirement met |
| CGImage / CIContext operations | Any thread | No UIKit dependency |
| CGImageDestination (ImageIO) | Any thread | C API, no isolation requirements |
| URLSession WebSocket operations | Any thread | Thread-safe by design |

### What is Fragile (Acknowledged in Code Comments)

| Operation | Risk | Mitigation |
|---|---|---|
| `AudioPlaybackStage.logAudioRoutes()` | `nonisolated static` calling `AVAudioSession` APIs; only safe because caller dispatches to @MainActor first | Could add `@MainActor` annotation for compile-time enforcement |
| `AudioPlaybackStage.tryRouteToGlasses()` | Same as above | Same as above |
| `AudioStage` tap callback capturing `self` via `Task` | If the actor is deallocated while audio is running, the tap continues firing but `self` is nil -- no crash, just dropped audio | `weak self` prevents retain cycle and crash |

### What Would Crash

| Scenario | What Happens |
|---|---|
| `installTap` called from @MainActor / main thread | `EXC_BREAKPOINT` or `SIGABRT` in audio subsystem (priority inversion / deadlock) |
| `AVAudioSession.setCategory()` called from actor executor | Runtime assertion failure -- `@MainActor` API called from wrong isolation context |
| `UIDevice.current` accessed from actor executor | Runtime assertion failure in iOS 17+ |
| `UIImage(cgImage:)` called from actor executor | Runtime assertion failure in iOS 17+ |
| Changing audio session category while DAT SDK BT stream is active | BT HFP link torn down, video stream dies |

---

## 7. Notification Observer Threading

| Observer | Registered From | Callback Queue | Handler Runs On |
|---|---|---|---|
| `AVAudioSession.interruptionNotification` | AudioStage actor executor | `.main` (explicit) | Main thread, then `Task { await self?.handleInterruption() }` hops to AudioStage actor |
| `AVAudioSession.routeChangeNotification` | AudioStage actor executor | `.main` (explicit) | Main thread, then `Task { await self?.handleRouteChange() }` hops to AudioStage actor |

Both observers use `queue: .main` for the NotificationCenter callback, then dispatch to
the AudioStage actor for state mutation. This is correct -- the notification callback
must not directly mutate actor-isolated state.

---

## 8. Backpressure and Frame Dropping

| Stage | Strategy | Thread |
|---|---|---|
| ThrottledStage | Time-based: drops frames that arrive faster than `targetFPS` | Actor executor |
| RelayStage | Encoding flag: drops frames while previous JPEG encode is in progress | Actor executor (flag), background pool (encode) |
| DisplayStage | None -- every frame is processed | Actor executor |
| RecordingStage | `input.isReadyForMoreMediaData` check | Actor executor |
| AudioStage | N/A -- tap fires at hardware rate, PCM conversion is fast | Audio thread -> actor |

The pipeline is designed to never block the main thread. Frame dropping is intentional
and logged at regular intervals (every 100th dropped frame for RelayStage).

---

## 9. References

- Apple `installTap` documentation: https://developer.apple.com/documentation/avfaudio/avaudionode/installtap(onbus:buffersize:format:block:)
- Apple Developer Forums, AVAudioEngine thread-safety: https://developer.apple.com/forums/thread/123540
- WWDC 2014 "AVAudioEngine in Practice" (tap callback threading)
- WWDC 2016 "Delivering an Exceptional Audio Experience" (real-time audio constraints)
- Stack Overflow: "What I can not do inside an installTapOnBus() method?" https://stackoverflow.com/questions/44194259
- Itsuki (2025): "SwiftUI: AVAudioEngine With Swift Concurrency" https://levelup.gitconnected.com/swiftui-avaudioengine-with-swift-concurrency-a231c31ad509
