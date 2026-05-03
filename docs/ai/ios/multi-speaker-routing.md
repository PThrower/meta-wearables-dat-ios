# Multi-Speaker Audio Routing

## Problem

Workflows with multiple TTS threads routing to different speakers (glasses vs phone) played all audio through the phone speaker. A workflow like:

```
text → local-tts → glasses-speaker
text → local-tts → phone-speaker
```

Would play both through the phone speaker only.

## Root Causes (3 separate bugs)

### Bug 1: WebSocket activation paths used wrong resolver

**File**: `hosted/server/src/server.ts`

Three WebSocket activation code paths (`activate_app` from publisher, `activate_workflow` from publisher, `activate_app` from viewer) called `resolveWorkflowToApp()` — the old single-node resolver that does NOT compute `speakerTarget` per processor. Only the REST API endpoint used `resolveWorkflowToPipeline()`, which walks the edge graph via BFS to find downstream speaker sinks.

**Fix**: Changed all three WebSocket paths to use `resolveWorkflowToPipeline()`, which returns per-processor `AppDefinition` objects with `speakerTarget` set based on downstream sink nodes.

**Commits**: `38d0538`, `5f75c75`

### Bug 2: Passive workflows sent guidance_text without speaker routing

**File**: `hosted/server/src/server.ts`

Passive workflows (no AI processor) with `text → local-tts → speaker` chains pushed `guidance_text` JSON to the iOS client without any `preferGlasses` field. The old code walked a single-target edge map (which couldn't handle multiple outgoing edges from one node) and never resolved which speaker sink was downstream.

**Fix**: Added `resolveSinkTarget()` BFS helper that walks from any node through transforms to find reachable speaker sinks. Added `pushPassiveTTSChains()` function used by all 4 activation paths (REST API + 3 WebSocket paths) that sends both `audio_route` and `guidance_text` with `preferGlasses` for each TTS chain.

**Commit**: `dcad0d2`

### Bug 3: Concurrent TTS calls overwrote each other's audio route

**File**: `publishers/CameraAccess/CameraAccess/Pipeline/Stages/AudioPlaybackStage.swift`

AVAudioSession routing is global — only one output route at a time. When two `speakGuidance()` calls ran concurrently, the second call's `routeToPhone()` overwrote the first call's `routeToGlasses()` before the first utterance finished speaking. The original code also called `synth.stopSpeaking(at: .immediate)` which killed any in-progress utterance.

**Fix**: Replaced fire-and-forget `speak()` with a serial queue. Each utterance:
1. Sets the correct audio route (glasses HFP or phone speaker)
2. Speaks via `AVSpeechSynthesizer.speak()`
3. Waits for completion via `AVSpeechSynthesizerDelegate` callback
4. Only then does the next utterance change the route and speak

Added `SpeechWaitDelegate` class that bridges the delegate callback to an async continuation, and a `drainQueue()` method that processes queued utterances serially.

**Commit**: `5734fdc`

## Architecture

### Server-Side Resolution

```
Workflow Nodes + Edges
        │
        ▼
resolveWorkflowToPipeline()          ← for workflows with AI processors
  └── resolveProcessorSinkTarget()   ← BFS from each processor to find sink
        │
        ▼
OutputConfig.speakerTarget: "phone" | "glasses"
        │
        ▼
handleAIAudio() / handleToolCall()
  └── preferGlasses = speakerTarget === "glasses"
  └── sends audio_route + guidance_text to iOS

pushPassiveTTSChains()               ← for passive workflows (no AI)
  └── resolveSinkTarget()            ← BFS from local-tts to find speaker
  └── sends audio_route + guidance_text to iOS
```

### iOS-Side Playback

```
WebSocket receives JSON messages:
  1. { type: "audio_route", preferGlasses: true }
  2. { type: "guidance_text", text: "...", preferGlasses: true }

AudioPlaybackStage.speakGuidance():
  └── Queues (text, preferGlasses) in serial queue
  └── drainQueue() processes one at a time:
        ├── routeToGlasses() or routeToPhone()
        ├── AVSpeechSynthesizer.speak(utterance)
        ├── Wait for delegate callback (didFinish/didCancel)
        └── Next utterance...
```

### Audio Session Routing

| Target | Method |
|--------|--------|
| Glasses | `AVAudioSession.setPreferredInput(bluetoothHFP)` |
| Phone | `AVAudioSession.overrideOutputAudioPort(.speaker)` |

The audio session must be configured as `.playAndRecord` with `.allowBluetooth` option for HFP routing to work. See `dat-audio-hfp.md` for HFP setup requirements.

## Files Changed

| File | Change |
|------|--------|
| `hosted/server/src/server.ts` | 4 activation paths now use `resolveWorkflowToPipeline` + passive TTS chain push |
| `hosted/server/src/app-registry.ts` | `resolveProcessorSinkTarget()` BFS + `speakerTarget` in pipeline resolution |
| `hosted/server/src/guidance-orchestrator.ts` | `preferGlasses` derived from `speakerTarget` per app |
| `hosted/server/src/app-types.ts` | `speakerTarget` field added to `OutputConfig` |
| `publishers/.../StreamSessionViewModel.swift` | `audio_route` handler + per-message `preferGlasses` in `guidance_text` |
| `publishers/.../AudioPlaybackStage.swift` | Serial TTS queue + `SpeechWaitDelegate` |

## Gotchas

1. **AVAudioSession route is global**: You cannot play to two speakers simultaneously. Must serialize utterances and wait for each to finish.
2. **`setPreferredInput` vs `overrideOutputAudioPort`**: These are different mechanisms — `setPreferredInput` routes through a Bluetooth device, `overrideOutputAudioPort(.speaker)` forces the built-in speaker. Calling one doesn't undo the other cleanly — always explicitly set the route you want.
3. **HFP requires `.allowBluetooth`**: The audio session category options must include `.allowBluetooth` before the HFP input port becomes available.
4. **Edge graph must connect processors to sinks**: If a processor node has no edge path to a `glasses-speaker` node, `resolveProcessorSinkTarget()` returns `"phone"` (the default). The workflow builder must wire edges correctly.
