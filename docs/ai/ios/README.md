# iOS TTS + Relay Audio: Current State & Future Opportunities

What's built, what's possible, and what the architecture enables.

---

## What We Have Now

### Audio Pipeline (Built)

The iOS app has a full audio pipeline with pub/sub decoupling:

```
Mic -> AudioStage -> AudioEventBus -> AudioRelayStage -> Relay WS
                         |
TTS -> AudioPlaybackStage -> AudioEventBus -> AudioRelayStage -> Relay WS
                         |
                   AudioTapClient (inbound from gateway /tap/audio)
```

Every component is an actor on its own executor. Zero main-thread blocking. The `AudioEventBus` uses `AsyncStream` with `bufferingNewest(10)` -- real-time audio, stale packets dropped.

### TTS (Built, Dev Mode)

`AudioPlaybackStage` uses Apple's `AVSpeechSynthesizer`:
- `.write()` generates Int16 PCM from text (for relay streaming)
- `.speak()` plays through glasses HFP speaker (local output)
- Currently loops "hello world" every 3s -- needs wiring to AI guidance events

### Relay Audio Paths (Built)

| codecType | Direction | What |
|-----------|-----------|------|
| 0 | iOS -> Relay | Phone mic (48kHz) |
| 1 | iOS -> Relay | Glasses HFP mic (8kHz) |
| 2 | iOS -> Relay | TTS playback (22050Hz) |
| 3 | Relay -> iOS | AI audio from server (16kHz) |

### Server TTS Hook (Stub)

`hosted/server/src/tts-service.ts` has the interface wired but returns silence:

```typescript
export interface TTSService {
  synthesize(text: string, opts?: { voice?: string }): Promise<Uint8Array>;
}
```

Drop-in ready for Google Cloud TTS, ElevenLabs, or any backend.

---

## Near-Term: Visual Intelligence with Server-Side Gemma 4 + Client-Side TTS

**Model:** Gemma 4 26B A4B on server (same pattern as Gemini today)
**TTS:** Apple `AVSpeechSynthesizer` on iOS (built-in, offline, zero cost)

```
Glasses camera -> JPEG frames -> Relay Server -> Gemma 4 REST API
                                                  -> text response
                                                  -> guidance event to iOS
                                                  -> AVSpeechSynthesizer.speak()
                                                  -> glasses speaker
                                                  -> AVSpeechSynthesizer.write()
                                                  -> PCM -> AudioEventBus -> relay -> viewers
```

**Why Gemma 4 26B A4B on server:**
- Apache 2.0 -- can self-host on VPS (same infra as relay)
- 3.8B active params (MoE) -- efficient inference, runs on consumer GPUs
- 256K context -- full conversation history
- Native function calling -- tool use for guidance events
- 140+ languages -- multilingual guidance
- Video input (up to 60s at 1fps) -- batch frames for temporal understanding

**Why Apple TTS on client:**
- No API cost (built into iOS)
- No network latency for speech (local synthesis, ~100ms)
- Works offline (no internet needed for TTS specifically)
- No additional infra to maintain

**What needs building:**
- `Gemma4Service` implementing `AIService` (REST `generateContent` instead of WebSocket)
- Wire `AudioPlaybackStage` to trigger on incoming guidance text events instead of "hello world" loop
- App config for visual intelligence mode (no audio input needed, frames-only)
- Gemma 4 inference on VPS (vLLM, llama.cpp, or Ollama)

---

## Future Opportunities

### 1. On-Device Edge AI (Gemma 4 E2B/E4B)

**Model:** Gemma 4 E2B (~2.3B active) or E4B (~4B active)
**TTS:** Apple `AVSpeechSynthesizer`
**Where:** Entirely on the iPhone

```
Glasses camera -> JPEG frames -> Gemma 4 E4B (on-device inference)
                                 -> text response
                                 -> AVSpeechSynthesizer -> glasses speaker
                                 -> guidance events -> local UI
```

**Why this matters:**
- Zero latency (no network round-trip)
- Zero cost (no API calls)
- Full privacy (nothing leaves the device)
- Works without internet
- E2B/E4B are the ONLY Gemma 4 models with audio input -- could accept voice commands
- ~2.3B params fits on iPhone GPU via Metal

**What needs building:**
- On-device inference runtime (Core ML export, or `llama.cpp` / `MLC-LLM` via Swift)
- Audio encoder integration for E2B/E4B (USM Conformer -> soft tokens)
- Model download/management UI

### 3. Hybrid: On-Device + Cloud Cascade

**Fast path:** Gemma 4 E4B on-device for simple queries
**Deep path:** Gemma 4 26B A4B cloud for complex analysis

```
Glasses camera -> JPEG frame -> [route by complexity]
                                  |
                     simple query: Gemma 4 E4B (on-device, <100ms)
                     complex query: Gemma 4 26B A4B (cloud, ~1-3s)
                                  |
                                  -> text response
                                  -> AVSpeechSynthesizer -> glasses
                                  -> guidance events -> UI
```

**Why this matters:**
- 80% of visual queries are simple ("what is this?", "any hazards?") -- handle locally
- 20% need deep reasoning -- fall through to cloud model
- Best of both worlds: low latency for common cases, high quality when needed
- The `AudioEventBus` already supports multiple publishers -- no architecture change

### 4. Server-Side TTS for Viewer Audio

**Problem:** Client-side TTS only the wearer hears. Remote viewers get text events but no audio.

**Solution:** Wire the `TTSService` stub for server-side synthesis.

```
AI text response -> server TTSService.synthesize()
                  -> PCM (16kHz mono)
                  -> FRAU codecType=3
                  -> Relay /audio-in
                  -> all viewers get synchronized audio
```

**Backend options:**

| Backend | Quality | Latency | Cost | Notes |
|---------|---------|---------|------|-------|
| Google Cloud TTS | Good | ~300ms | $4/1M chars | Same ecosystem as Gemma |
| ElevenLabs | Excellent | ~200ms WS | $0.18/1K chars | Best voice quality |
| OpenAI TTS HD | Excellent | ~500ms | $15/1M chars | Natural voices |
| Piper (self-hosted) | Good | <50ms | Free | Runs on VPS, Bun FFI |

**What needs building:**
- Implement `TTSService` with chosen backend
- Queue + dedup (don't synthesize same text twice)
- Streaming synthesis (WebSocket TTS backends for lower latency)

### 5. Voice Commands via Gemma 4 E4B Audio Input

**Model:** Gemma 4 E4B (the only Gemma 4 variant with audio input)
**Direction:** User speaks -> E4B understands -> triggers actions

```
Glasses mic -> AudioStage -> AudioEventBus -> [extract audio segment]
                                              -> Gemma 4 E4B (audio input)
                                              -> "pause guidance" / "what's that?"
                                              -> action dispatch
```

**Why this matters:**
- Hands-free control of the guidance system
- No separate STT service needed -- E4B processes audio natively
- Works alongside visual intelligence (different model for voice vs vision)
- The AudioStage + AudioEventBus already captures mic audio -- just need to route it

**What needs building:**
- Voice activity detection (when is the user speaking vs ambient?)
- Audio segment extraction (buffer recent N seconds of mic audio)
- E4B inference endpoint (on-device or cloud)
- Command parser / action dispatcher

### 6. Multi-Modal Fusion (Vision + Audio Together)

**Combine** phone mic audio + glasses camera into a single prompt:

```
AudioStage (phone mic) -> "what's that clicking sound?"
Camera frames -> [image of a turn signal]
     |
     v
Gemma 4 26B A4B with both: "That's a turn signal. The car to your left is about to turn."
```

**Why this matters:**
- Richer environmental understanding
- Safety-critical awareness (audio cues like alarms, sirens, approaching vehicles)
- The relay already receives both video (FRLY) and audio (FRAU codecType 0) from the publisher

**What needs building:**
- Audio transcription (Whisper on server, or on-device)
- Prompt composition that combines transcript + image
- Scheduling logic (when to send a multi-modal prompt vs vision-only)

---

## Architecture Enablers Already in Place

The current pipeline is designed for extensibility:

| Component | What It Enables |
|-----------|----------------|
| `AudioEventBus` | Any number of audio producers/consumers, zero coupling |
| `AIService` interface | Swap Gemini Live <-> Gemma 4 REST <-> on-device without touching orchestrator |
| `TTSService` interface | Drop-in server-side TTS when ready |
| FRAU codecType field | Multiple audio streams on one WebSocket, distinguishable by type |
| `RelayStage` binary receive | Already handles inbound FRAU audio (codecType=3) |
| `FramePipelineManager` | Add new stages without touching existing ones |
| `GuidanceOrchestrator` | AI provider agnostic -- routes events regardless of model |

---

## Codec Type Allocation

4 codecTypes are defined. For future expansion, codecType 4-255 is available:

| codecType | Status | Assigned To |
|-----------|--------|-------------|
| 0 | Active | Phone mic (48kHz) |
| 1 | Active | Glasses HFP mic (8kHz) |
| 2 | Active | TTS playback (22050Hz) |
| 3 | Active | AI audio from server (16kHz) |
| 4-9 | Reserved | Future: voice command segments, ambient audio, etc. |
| 10-255 | Available | Open |

---

## File Reference

| File | Role |
|------|------|
| `Pipeline/AudioPacket.swift` | Immutable audio data packet (Sendable) |
| `Pipeline/AudioEventBus.swift` | Pub/sub for audio packets (AsyncStream) |
| `Pipeline/AudioSource.swift` | Enum: built-in mic vs glasses HFP mic |
| `Pipeline/Stages/AudioStage.swift` | Mic capture via AVAudioEngine |
| `Pipeline/Stages/AudioPlaybackStage.swift` | TTS synthesis + local playback + relay publish |
| `Pipeline/Stages/AudioRelayStage.swift` | FRAU encoding + WebSocket send |
| `Pipeline/Stages/AudioTapClient.swift` | Receive remote audio via gateway /tap/audio |
| `Pipeline/Stages/RelayStage.swift` | WebSocket transport (FRLY + FRAU) |
| `Pipeline/RemoteAudioFrame.swift` | Decode JSON audio from gateway tap |
| `hosted/server/src/tts-service.ts` | Server-side TTS interface (stub) |
| `hosted/server/src/guidance-orchestrator.ts` | AI audio push to relay /audio-in |
| `hosted/server/src/ai-service.ts` | Swappable AI provider interface |
