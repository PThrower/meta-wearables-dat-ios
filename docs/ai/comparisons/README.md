# MentraOS vs Our Architecture: AI Layer Analysis

Comparative analysis of MentraOS's cloud-app model and our dual-layer (server + client) AI architecture. Based on review of the MentraOS open-source reference at `packages/reference/MentraOS/`.

---

## MentraOS Pattern

MentraOS uses a **cloud-app subscription model** -- all AI, TTS, and transcription run server-side in cloud apps that subscribe to device data streams.

```
Glasses -> Phone (BLE) -> MentraOS Cloud Router
                              |
                              +-> App A (subscribes to transcription)
                              +-> App B (subscribes to camera frames)
                              +-> App C (subscribes to audio)
                              |
                              <- responses routed back to glasses
```

### Key Patterns

- **Cloud-side everything** -- AI, TTS, transcription all happen in cloud apps
- **`session.audio.speak()`** -- server-side TTS (ElevenLabs), no client synthesis
- **Multi-app concurrency** -- multiple apps run simultaneously on the same session
- **Stream subscriptions** -- apps declaratively subscribe to data types (transcription, video, audio)
- **Webhook lifecycle** -- app activation via webhook, runs as cloud Node.js service
- **Binary audio streaming** -- `[36 byte streamId UUID][audio data]` over WebSocket

### Architecture: Three-Tier Relay

```
Glasses (MCU) <--BLE--> Phone (React Native) <--WebSocket--> Cloud <--WebSocket--> App Servers
```

The cloud is NOT a dumb relay -- it actively manages subscriptions, routes streams, handles TTS proxying, transcription, translation, and app lifecycle.

---

## Our Pattern (Current + Planned)

```
Glasses -> Phone (BLE/WiFi) -> Relay Server -> AI Provider (Gemini/Gemma)
                                    |
iOS Client (local TTS, local UI)    |
   |                                |
   +-- AVSpeechSynthesizer (TTS)    +-- Guidance events -> viewers
   +-- AudioEventBus (pub/sub)      +-- FRAU/FRLY wire protocol
   +-- Future: on-device Gemma E4B  +-- Future: server Gemma 4 26B
```

### Key Patterns

- **Client-side TTS** -- Apple `AVSpeechSynthesizer`, zero cost, low latency, offline
- **FRAU/FRLY wire protocols** -- multiplexed audio/video on single WebSocket
- **Actor-based audio bus** -- `AudioEventBus` with `AsyncStream` and `bufferingNewest(10)`
- **Dual-layer AI** (planned) -- server AI for heavy analysis + client AI for fast queries
- **Relay as transport** -- relay forwards data, AI orchestration happens server-side

---

## MentraOS: How AI Works

MentraOS has two separate AI systems.

### System 1: Utility LLM (Platform Features)

| Field | Value |
|-------|-------|
| File | `cloud/packages/utils/src/LLMProvider.ts` |
| Purpose | Built-in platform features (news, notifications, AI assistant "Mira") |
| Framework | LangChain wrappers |
| Providers | Azure OpenAI, OpenAI, Anthropic, Google Vertex AI |
| Models | GPT-5.2, GPT-4.1, o3, o4-mini, Claude Sonnet/Opus/Haiku, Gemini 3/2.5-pro/2.5-flash |
| Config | `LLM_MODEL` + `LLM_PROVIDER` env vars |
| Interface | `LLMProvider.getLLM(options?)` returns configured ChatModel instance |

This is NOT for third-party apps. It's a simple factory for platform-level AI processing.

Comparable to our `ai-service.ts` + `guidance-orchestrator.ts`.

### System 2: Realtime AI (App-Level Voice Conversation)

This is the primary AI system. It lives in the **app** (not the cloud relay). Provider-agnostic with two implementations.

#### Trigger Flow

```
1. User triggers app (button press, voice command, dashboard)
2. Cloud fires webhook to app server URL
3. App server connects back to cloud via WebSocket with API key + sessionId
4. Cloud authenticates, creates AppSession, sends CONNECTION_ACK
5. App calls RealtimeManager.start({ provider: "gemini" })
6. RealtimeManager creates provider (GeminiRealtimeProvider or OpenAIRealtimeProvider)
7. Provider connects to Gemini Live / OpenAI Realtime WebSocket
8. SDK subscribes to glasses mic: session.events.onAudioChunk()
9. Mic PCM -> base64 -> provider.sendAudio() -> Gemini/OpenAI
10. AI audio PCM 24kHz comes back via provider.on("audio")
11. Audio written to AudioOutputStream (PCM -> lamejs MP3 encode)
12. MP3 bytes sent as binary WS frame: [36 bytes streamId][audio data]
13. Cloud pipes into HTTP chunked response (like internet radio)
14. Phone's ExoPlayer/AVPlayer plays the stream
```

#### RealtimeProvider Interface

```typescript
// cloud/packages/apps/sdk-test/src/backend/managers/realtime-provider.ts

export interface RealtimeProvider extends EventEmitter {
  readonly name: ProviderType;         // "openai" | "gemini"
  connect(config: ProviderConfig): Promise<void>;
  sendAudio(pcmBase64: string): void;  // PCM 16kHz 16-bit mono, base64
  cancelResponse(): void;              // Interrupt current AI response
  disconnect(): void;
  readonly isConnected: boolean;
}
```

Events: `audio`, `audioDone`, `transcript`, `speechStarted`, `speechStopped`, `responseCreated`, `responseDone`, `error`, `closed`, `ready`

#### RealtimeManager (Orchestrator)

```typescript
// cloud/packages/apps/sdk-test/src/backend/managers/realtime.manager.ts

class RealtimeManager {
  async start(options: RealtimeStartOptions): Promise<void>;
  async stop(): Promise<void>;
  async interrupt(): Promise<void>;
}
```

Start sequence (intentional ordering):
1. Validate glasses session alive
2. Connect to AI provider (fail fast if provider unreachable)
3. Re-validate glasses session (may have dropped during connect)
4. Open AudioOutputStream (PCM->MP3, streams to phone)
5. Subscribe to glasses mic audio and forward to provider

#### GeminiRealtimeProvider

```typescript
// Uses @google/genai SDK
const GEMINI_MODEL = "gemini-2.5-flash-native-audio-preview-12-2025";

// Input:  PCM 16-bit, 16kHz, mono (base64 with mime_type "audio/pcm;rate=16000")
// Output: PCM 16-bit, 24kHz, mono (base64 inline_data)

session.sendRealtimeInput({
  audio: { data: pcmBase64, mimeType: "audio/pcm;rate=16000" }
});
```

Handles: audio chunks, server-side VAD, interruption, turn completion, tool calls.

#### REST API Triggers

```typescript
// cloud/packages/apps/sdk-test/src/backend/api/realtime.api.ts

POST /start    { userId, provider, voice, systemPrompt }  // Begin session
POST /stop     { userId }                                  // End session
POST /interrupt { userId }                                 // Flush AI audio
GET  /status   ?userId=...                                 // Check status
```

#### Audio Output Stream

```typescript
// Binary frame protocol over WebSocket:
// [36 bytes: streamId UUID as ASCII] [N bytes: audio data (MP3)]

// SDK encodes PCM -> MP3 via lamejs before sending
// Cloud pipes bytes into HTTP chunked response
// Phone player consumes like internet radio

interface AudioOutputStream {
  readonly id: string;
  readonly state: AudioOutputStreamState;
  write(chunk: Uint8Array): void;   // Write audio chunk
  end(): Promise<void>;             // Graceful close
  flush(): void;                    // Interrupt -- discard buffered, silence immediately
}
```

One stream at a time, with ownership tracking (`OutputStreamManager.claim/release`).

#### TTS: `session.audio.speak()`

```typescript
// Cloud-side TTS via ElevenLabs proxy
async speak(text: string, opts?: SpeakOptions): Promise<PlayResult> {
  const ttsUrl = `${baseUrl}/api/tts?text=${text}&voice_id=${voiceId}`;
  return this.playAudio({ audioUrl: ttsUrl, trackId: 2 });  // Track 2 = TTS
}
```

Cloud receives request, proxies to ElevenLabs API, streams MP3 back. Not client-side.

#### Audio Tracks

| Track ID | Purpose |
|----------|---------|
| 0 | Speaker (default audio playback) |
| 1 | App audio (app-specific audio) |
| 2 | TTS (text-to-speech audio) |

Multiple tracks can play simultaneously (mixing mode when `stopOtherAudio=false`).

---

## MentraOS Key Files Reference

| File | Role |
|------|------|
| `cloud/packages/utils/src/LLMProvider.ts` | Utility LLM factory (LangChain) |
| `cloud/packages/apps/sdk-test/src/backend/managers/realtime-provider.ts` | Provider interface |
| `cloud/packages/apps/sdk-test/src/backend/managers/realtime.manager.ts` | Realtime AI orchestrator |
| `cloud/packages/apps/sdk-test/src/backend/managers/gemini-realtime.provider.ts` | Gemini Live impl |
| `cloud/packages/apps/sdk-test/src/backend/managers/openai-realtime.provider.ts` | OpenAI Realtime impl |
| `cloud/packages/apps/sdk-test/src/backend/managers/output-stream.manager.ts` | Audio output ownership |
| `cloud/packages/apps/sdk-test/src/backend/api/realtime.api.ts` | REST trigger endpoints |
| `cloud/packages/sdk/src/session/managers/SpeakerManager.ts` | SDK v3 speaker API |
| `cloud/packages/sdk/src/app/session/modules/audio.ts` | SDK v2 audio module |
| `cloud/packages/sdk/src/app/session/modules/audio-output-stream.ts` | SDK v2 stream impl |
| `cloud/packages/cloud/src/services/session/AppManager.ts` | App lifecycle management |
| `cloud/packages/cloud/src/services/session/SubscriptionManager.ts` | Stream subscription coordination |
| `cloud/packages/sdk/src/session/DataStreamRouter.ts` | Stream type routing |
| `cloud/packages/sdk/src/types/streams.ts` | StreamType enum |

---

## Side-by-Side Comparison

| Aspect | MentraOS | Us |
|--------|----------|-----|
| **AI interface** | `RealtimeProvider` (connect/sendAudio/cancelResponse) | `AIService` (connect/disconnect/sendFrame/sendAudio) |
| **Orchestrator** | `RealtimeManager` (provider + mic + output stream) | `GuidanceOrchestrator` (AI service + frame relay) |
| **Audio encoding** | PCM -> MP3 via lamejs, streamed to phone | Raw PCM via FRAU protocol |
| **TTS** | Server-side ElevenLabs proxy (`session.audio.speak()`) | Client-side Apple `AVSpeechSynthesizer` |
| **Wire protocol** | `[36 byte UUID][audio data]` (MP3) | `[36 byte FRAU header][PCM payload]` |
| **Audio bus** | One stream at a time, ownership-tracked | One `AudioEventBus` with multiple codecTypes |
| **Trigger mechanism** | REST API: `POST /start`, `/stop`, `/interrupt` | WebSocket-based activate/deactivate events |
| **Transcription** | Cloud-side (Soniox, Alibaba, Deepgram) | Not implemented (Gemini Live handles natively) |
| **App model** | Webhook -> AppSession -> subscribe to streams | Single relay connection with guidance events |
| **Multi-app** | Yes, with `SubscriptionManager` coordination | No (single guidance session) |
| **Stream subscription** | Declarative, fine-grained stream types | All data flows to connected clients |
| **Audio tracks** | 3 tracks (speaker, app_audio, TTS) with mixing | 4 codecTypes (phone mic, glasses mic, TTS, AI audio) |
| **Client intelligence** | None (phone is a bridge) | Full audio pipeline + TTS + future on-device AI |
| **Offline capability** | No (requires cloud for everything) | Partial (client TTS works offline) |
| **Self-hostable** | Yes (Apache 2.0) | Yes (our code) |

---

## What to Adopt

### 1. Provider-Agnostic RealtimeProvider Interface

Their `connect/sendAudio/cancelResponse` pattern is clean. Our `AIService` is similar but their event-based output (`on("audio")`, `on("transcript")`) is better for streaming than our callback approach.

**MentraOS:**
```typescript
interface RealtimeProvider extends EventEmitter {
  connect(config): Promise<void>;
  sendAudio(pcmBase64: string): void;
  cancelResponse(): void;
  disconnect(): void;
}
// Events: audio, audioDone, transcript, error, closed, ready
```

**Our equivalent:**
```typescript
interface AIService {
  connect(sessionId: string, callbacks: AIServiceCallbacks): Promise<void>;
  sendFrame(jpegBytes: Uint8Array): void;
  sendAudio(pcmBytes: Uint8Array): void;
  disconnect(): void;
}
// Callbacks: onAudio, onText, onToolCall, onStatusChange
```

**Action:** Consider migrating from callbacks to EventEmitter pattern for better composability.

### 2. AudioOutputStream Ownership Tracking

`OutputStreamManager.claim/release` ensures only one audio source at a time. We could use this for server TTS vs AI audio on codecType 3.

**MentraOS:**
```typescript
const stream = await outputStream.claim("realtime");  // Exclusive ownership
// ... write audio ...
await outputStream.release("realtime", true);          // Release + end stream
```

**Action:** Add ownership tracking to `AudioEventBus` for codecType 3 to prevent TTS and AI audio from colliding.

### 3. REST Trigger API

`POST /start` with `{ provider, voice, systemPrompt }` is a clean way to activate AI. Our current WebSocket-based activation is coupled to the relay connection.

**MentraOS:**
```
POST /api/realtime/start  { userId, provider, voice, systemPrompt }
POST /api/realtime/stop   { userId }
POST /api/realtime/interrupt { userId }
GET  /api/realtime/status ?userId=...
```

**Action:** Consider adding REST endpoints for AI session management alongside WebSocket events.

### 4. Stream Subscription Model

MentraOS's declarative subscription model (`session.updateSubscriptions({ subscribe: ["transcription", "video"] })`) lets apps receive only what they need.

**Action:** When we add multi-app support, adopt a subscription model for guidance events and audio streams.

---

## What NOT to Adopt

### 1. Server-Side TTS (ElevenLabs)

They pay for cloud TTS and add network latency. Our Apple `AVSpeechSynthesizer` on client is zero-cost, lower latency (~100ms vs ~300ms+), and works offline.

### 2. PCM-to-MP3 Transcoding

They transcode PCM to MP3 for the phone player (using `lamejs`). Our FRAU protocol sends raw PCM, which is simpler, avoids quality loss from lossy encoding, and has lower CPU overhead.

### 3. Single-Layer Architecture

MentraOS is cloud-only -- no client intelligence. Our dual-layer (server Gemma 4 + client Apple TTS, future on-device Gemma E4B) is an architectural advantage. The phone isn't just a bridge; it's a compute node.

---

## Two-Layer AI Architecture (Our Advantage)

MentraOS is single-layer: all AI runs in the cloud. We use dual-layer with **different responsibilities** per layer -- not "smaller reasoning on device" but a fundamentally different task category.

### Layer Roles

| | Server AI (Layer 1) | Client AI (Layer 2) |
|--|---------------------|---------------------|
| **Category** | Reasoning, planning, guidance | Perception, classification, detection |
| **Model** | Gemma 4 26B A4B (or Gemini Live) | Core ML / Vision / SoundAnalysis frameworks |
| **What it does** | "Read this document and explain next steps" | "Crosswalk ahead", "STOP sign", "siren detected" |
| **Latency** | ~1-3s (REST) or ~200ms (Live) | <50ms (on-device inference) |
| **Output** | Guidance text + TTS audio | Tags, bounding boxes, classifications |
| **TTS** | Server-side for viewer distribution | `AVSpeechSynthesizer` for wearer |
| **Network** | Required | Not required |
| **When to use** | Complex analysis, multi-step plans, conversation | Safety alerts, pre-processing, offline fallback |

### Client AI = Perception, Not Reasoning

The client layer is a **sensor pre-processor**. It does not make decisions or generate guidance. It tags the world with metadata that either:
1. **Feeds the server** -- reduces what the server needs to process (send tags + region of interest instead of full frame)
2. **Triggers immediate alerts** -- safety-critical detections where waiting for the cloud is too slow

```
Camera frame -> Client perception pipeline
                  |
                  +-- Core ML object detection -> "crosswalk", "vehicle", "person"
                  +-- Vision OCR -> "STOP", "WALK", "EXIT"
                  +-- SoundAnalysis -> "siren", "horn", "alarm"
                  |
                  +-- Safety-critical? -> immediate local TTS alert (<50ms)
                  +-- Informative? -> tag frame, send to server with metadata
```

### On-Device Perception Tools (Available Now)

| Task | iOS Framework | Latency | Offline |
|------|--------------|---------|---------|
| Object detection | Core ML + YOLO/MobileNet | <50ms | Yes |
| Scene classification | Vision (`VNClassifyImage`) | <30ms | Yes |
| OCR / text reading | Vision (`VNRecognizeText`) | <100ms | Yes |
| Face/pose detection | Vision (`VNDetectFaceRectangles`) | <30ms | Yes |
| Sound classification | SoundAnalysis (`SNAudioFileAnalyzer`) | <50ms | Yes |
| Speech activity (VAD) | AudioEngine level monitoring | <10ms | Yes |
| Depth/obstacle detection | LiDAR + ARKit (iPhone Pro) | <20ms | Yes |
| Barcode/QR detection | Vision (`VNDetectBarcodes`) | <20ms | Yes |
| Image similarity | Vision (`VNFeaturePrintObservation`) | <30ms | Yes |

### Future: Gemma 4 E4B for Vision+Audio Perception

When on-device LLM inference is ready, Gemma 4 E4B (4B active params, 128K context) adds **unified vision+audio understanding** -- the only Gemma 4 variant with audio input (USM Conformer encoder):

```
Glasses mic -> raw waveform -> Gemma 4 E4B audio encoder -> soft tokens
Camera frame -> pixel values -> Gemma 4 E4B vision encoder -> soft tokens
     |
     v
Combined perception -> "car horn + image of intersection" -> "vehicle approaching from left"
```

This replaces multiple specialized models with a single unified perception model. Still perception, not reasoning -- the "what to do about it" stays on the server.

### Architecture Diagram

```
Layer 1: Server AI (Reasoning)              Layer 2: Client AI (Perception)
  - Gemma 4 26B A4B on server                - Core ML / Vision / SoundAnalysis
  - Complex visual analysis                  - Object detection, OCR, sound ID
  - Guidance generation (what to do)         - Frame tagging (what's in frame)
  - Server TTS for viewer distribution       - AVSpeechSynthesizer for wearer
  - Multi-step planning                      - Immediate safety alerts
  - Conversation / Q&A                       - Sensor pre-processing for server
        |                                           |
        v                                           v
  AudioEventBus (server)                    AudioEventBus (client)
        |                                           |
        +--- FRAU codecType 3 (AI audio) -----------+
        +--- Guidance events (text) ----------------+
        +--- Perception tags (client -> server) ----+
```

### Data Flow: Client Perception Feeds Server Reasoning

```
Camera frame arrives on client
  |
  +-- Client perception pipeline (Core ML, Vision)
  |     -> tags: ["crosswalk", "vehicle", "person:3"]
  |     -> OCR: ["WALK signal"]
  |     -> regions of interest (bounding boxes)
  |
  +-- Safety check
  |     -> hazard detected? -> immediate TTS alert + send tag to server
  |     -> no hazard? -> send frame + tags to server
  |
  +-- Server reasoning (Gemma 4 26B)
        -> receives frame + perception tags
        -> "Crosswalk with WALK signal. Three pedestrians ahead. Vehicle stopped."
        -> generates guidance -> TTS -> glasses speaker
```

This is something MentraOS **cannot** do -- they're cloud-only, no client perception. Our dual-layer is an architectural advantage: lower latency for safety, less bandwidth to server, offline-capable for critical detections.

### Hybrid Routing (Future Cascade Model)

As on-device models mature, a cascade adds a second client path for simple queries:

```
Frame arrives -> route by complexity
                  |
                  +-- perception only (tags, detections) -> Core ML / Vision (<50ms)
                  +-- simple query ("what's ahead?") -> Gemma E4B on-device (<100ms)
                  +-- complex query ("read this document") -> Gemma 26B on server (~2s)
                  |
                  +-- merge responses -> AudioEventBus -> speaker
```

The cascade sits **on top of** the perception layer. Even without the cascade, the perception layer alone provides immediate value (safety alerts, frame tagging).

---

## Architecture Enablers Already in Place

Our current pipeline already supports dual-layer:

| Component | What It Enables |
|-----------|-----------------|
| `AudioEventBus` | Multiple audio producers/consumers, zero coupling -- both server and client AI publish |
| `AIService` interface | Swap Gemini Live <-> Gemma 4 REST <-> on-device without touching orchestrator |
| `TTSService` interface | Drop-in server-side TTS when needed (for viewer audio) |
| FRAU codecType field | Multiple audio streams on one WebSocket, distinguishable by type |
| `AudioPlaybackStage` | Client-side TTS via `AVSpeechSynthesizer.write()` already generates PCM |
| `RelayStage` binary receive | Already handles inbound FRAU audio (codecType=3) from server |
| `GuidanceOrchestrator` | AI provider agnostic -- routes events regardless of model |

---

## Source

MentraOS reference codebase: `/Users/ebowwa/Desktop/codespaces/packages/reference/MentraOS/`

Key documentation:
- `MentraOS/README.md` -- Project overview
- `MentraOS/AGENTS.md` -- Architecture guidance
- `MentraOS/CONTRIBUTING.md` -- Data flow diagram
- `MentraOS/cloud/README.md` -- Cloud package architecture
