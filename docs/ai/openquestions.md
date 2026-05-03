# Open Questions: AI Architecture

Unresolved questions and decision points before building the dual-layer AI system. Grouped by domain.

---

## Architecture / Scope

### Multi-app or single session?

MentraOS supports multiple concurrent apps per session with `SubscriptionManager` coordination. Do we want that, or is one guidance session per stream sufficient?

- **Single session (simpler):** One AI active at a time. Matches current `GuidanceOrchestrator` model.
- **Multi-app (flexible):** Visual intelligence app + voice assistant running simultaneously. Requires subscription routing, app isolation, audio mixing.

**Impact:** Affects relay protocol, session management, and audio mixing strategy.

### How do client perception results reach the server?

Client-side perception (object detection, OCR, sound classification) produces metadata that the server AI needs for richer reasoning. How does it get there?

- **FRLY metadata extension:** Add a metadata field to the existing FRLY frame header. Low overhead but changes wire protocol.
- **Separate WebSocket message:** New JSON message type alongside FRLY frames. Cleaner separation but adds message overhead.
- **Embedded in frame:** Encode tags as EXIF-like data in the JPEG payload. No protocol change but hacks the image format.

**Impact:** Wire protocol design, relay server parsing, server AI prompt construction.

### Minimum viable client perception pipeline?

What's the smallest useful set of on-device perception we ship first?

- **Just object detection?** (YOLO/MobileNet -- "person ahead", "vehicle", "crosswalk")
- **+ OCR?** (Vision framework -- "STOP sign", "WALK signal", street names)
- **+ Sound classification?** (SoundAnalysis -- "siren", "horn", "alarm")
- **All at once?** (Higher battery/thermal cost, longer implementation)

**Impact:** iOS client complexity, battery life, first-use-case scope.

---

## Server AI

### Which API surface for Gemma 4 26B A4B?

| Provider | Auth | Pros | Cons |
|----------|------|------|------|
| Google AI Studio | API key | Simple setup, free tier | Rate limits, not production-grade SLA |
| Vertex AI | Service account | Production SLA, VPC | More setup, GCP project required |
| OpenRouter | API key | Multi-provider routing | Dependency on third-party |
| Self-hosted (VPS) | None | Full control, no rate limits | GPU cost, ops burden, inference speed |

**Impact:** Cost, latency, reliability, ops complexity.

### REST vs streaming for visual intelligence?

- **REST `generateContent`:** Request/response, ~1-3s for full response. Simpler implementation.
- **Streaming `streamGenerateContent`:** SSE stream, tokens arrive incrementally. Faster time-to-first-text but more complex to handle.

Do we need streaming for visual guidance, or is full response acceptable?

**Impact:** Server-side `Gemma4Service` implementation, client TTS timing (wait for full text vs stream-synthesize).

### Keep Gemini Live alongside Gemma 4?

Do we maintain two AI providers for different modes?

- **Gemini Live (WebSocket):** Real-time voice conversation, bidirectional audio, ~200ms latency. Good for "talk to me" mode.
- **Gemma 4 26B A4B (REST):** Visual analysis, text response, ~1-3s latency. Good for "look at this" mode.

Can both be active on the same session? Or mutually exclusive?

**Impact:** `AIService` interface design, orchestrator complexity, app configuration.

### What happens to existing `GeminiLiveService`?

- **Replace entirely with `Gemma4Service`?** Clean break but loses real-time voice capability.
- **Keep both behind `AIService` interface?** Provider selection at activation time. More flexible.
- **Deprecate gradually?** Keep Gemini Live working while building Gemma 4 path.

**Impact:** Code migration strategy, backward compatibility, test coverage.

---

## Client AI

### Built-in frameworks or custom Core ML models?

Apple provides high-quality built-in perception:

| Built-in (Vision/SoundAnalysis) | Custom Core ML |
|--------------------------------|----------------|
| Zero deployment (ships with iOS) | Model download/management needed |
| Apple-optimized (Neural Engine) | Can be optimized but requires work |
| Good quality for common cases | Higher quality for specific domains |
| Limited customization | Full control over classes/thresholds |
| No model size concerns | Model size matters (download, storage) |

Do we start with built-in frameworks and upgrade to custom models later, or go custom from day one?

**Impact:** Implementation timeline, app bundle size, model accuracy, update cadence.

### How does on-device inference fit into `FramePipelineManager`?

Current pipeline: `StreamSession -> FramePipelineManager -> RelayStage -> FRLY frames -> WebSocket`

Where does perception fit?

- **New pipeline stage:** `PerceptionStage` after frame capture, before relay. Tags frames in-place.
- **Parallel pipeline:** Run perception alongside the relay pipeline on a frame sampler (every Nth frame).
- **Separate module:** Independent of frame pipeline, subscribes to `AudioEventBus` + frame events.

**Impact:** Frame latency, pipeline architecture, threading model.

### Battery and thermal budget

On-device inference costs energy. How much can we sustain while also running:

- Camera streaming (DAT SDK `StreamSession`)
- Audio capture (`AVAudioEngine` input tap)
- Relay WebSocket send/receive
- TTS synthesis (`AVSpeechSynthesizer`)

Key metrics needed:
- mA draw per inference call at each model size
- Thermal throttling threshold on target iPhones (SE? 15? 16 Pro?)
- Acceptable battery drain rate (user tolerance)

**Impact:** Inference frequency, model size selection, device support matrix.

### Gemma E4B on iPhone: which runtime?

| Runtime | Pros | Cons |
|---------|------|------|
| Core ML export | Apple-optimized, Neural Engine | Export tooling may not exist yet, quantization limits |
| `llama.cpp` via Swift | Mature, well-tested, GGUF format | CPU-bound (no Neural Engine), larger binary |
| `MLC-LLM` | GPU-accelerated via Metal | Less mature, complex build |
| `mlx-swift` | Apple-native, Metal-backed | Newer, smaller community |

Has anyone benchmarked Gemma E4B inference on iPhone 15/16? What's the tokens/sec? Is it usable for real-time perception?

**Impact:** On-device inference feasibility, implementation path, dependency choice.

---

## TTS

### Server-side TTS for viewers: implement now or wait?

Client-side TTS (`AVSpeechSynthesizer`) only the wearer hears. Remote viewers get text guidance events but no audio. Server-side TTS would push audio through relay codecType 3 to all viewers.

- **Now:** Complete the viewer experience, test the `TTSService` stub.
- **Wait:** Focus on AI provider migration first, add viewer TTS later.

**Impact:** Scope of current work, viewer experience, server resource usage.

### Which server TTS backend?

| Backend | Quality | Latency | Cost | Notes |
|---------|---------|---------|------|-------|
| Piper (self-hosted) | Good | <50ms | Free | Runs on VPS, `bun:ffi`, offline |
| Google Cloud TTS | Good | ~300ms | $4/1M chars | Same ecosystem as Gemma |
| ElevenLabs | Excellent | ~200ms WS | $0.18/1K chars | Best voice quality |
| OpenAI TTS HD | Excellent | ~500ms | $15/1M chars | Natural voices |

**Impact:** Cost, quality, server complexity, viewer experience.

### Audio collision: client TTS vs server AI audio

If client produces TTS (via `AVSpeechSynthesizer`) AND server pushes AI audio (codecType 3), both play through the glasses speaker. How do we prevent overlap?

- **Ownership tracking:** Like MentraOS's `OutputStreamManager.claim/release` -- only one audio source owns the speaker at a time.
- **Priority system:** Server AI audio always interrupts client TTS (or vice versa).
- **Track mixing:** Let them overlap if content is different (navigation instruction + object alert).

**Impact:** `AudioPlaybackStage` design, `AudioEventBus` priority handling, user experience.

---

## Relay / Protocol

### New codecType for perception metadata?

Current codecTypes: 0 (phone mic), 1 (glasses mic), 2 (TTS), 3 (AI audio).

Do we need a new codecType or message type for client perception results going to the server?

- **New codecType (4+):** Structured binary metadata alongside audio/video. Clean separation.
- **FRLY frame metadata:** Extend FRLY header with optional metadata field.
- **JSON WebSocket message:** Separate `PERCEPTION_RESULT` message type.

**Impact:** Wire protocol version, relay server routing, server AI prompt construction.

### Fix `apps.json` on VPS

The production `apps.json` still has invalid model name `gemini-2.5-flash-native-audio-latest` which causes immediate disconnect. Valid options:

- `gemini-3.1-flash-live-preview` (newest)
- `gemini-2.5-flash-native-audio-preview-12-2025` (legacy but valid)

Or replace with new Gemma 4 config once `Gemma4Service` is built.

**Impact:** Spanish Co-pilot (and any Gemini Live app) is broken until fixed.

---

## Product

### First use case to ship?

What's the first thing a user experiences with visual intelligence?

- **Navigation assistance:** "Crosswalk ahead", "Turn left in 50m", obstacle detection
- **Reading assistant:** OCR on signs, menus, documents -- read aloud
- **Object identification:** "What is this?" -- point at something, get description
- **Environmental awareness:** Scene description, hazard alerts, ambient sound classification

Each has different perception requirements and latency tolerance.

**Impact:** Prioritization of perception models, prompt engineering, UX design.

### Manual or automatic AI activation?

- **Manual:** User taps a button or says a phrase to activate visual intelligence. Explicit, predictable, saves battery.
- **Automatic:** AI watches frames continuously and speaks up when something notable is detected. Always-on, higher battery drain, privacy implications.
- **Hybrid:** Automatic perception (low-power, tags only) with manual activation for full analysis.

**Impact:** Battery life, privacy, UX, server cost (continuous vs on-demand API calls).

---

---

## Scope

### In Scope (Now / Near-Term)

- **Gemma 4 26B A4B** server-side for visual intelligence (replacing Gemini Live as primary AI)
- **`Gemma4Service`** implementing `AIService` interface (REST `generateContent`, not WebSocket)
- **Client TTS** -- wire `AudioPlaybackStage` to trigger on guidance text events (kill "hello world" loop)
- **Apple `AVSpeechSynthesizer`** for wearer TTS (already built, zero cost, offline)
- **Keep `GeminiLiveService`** as secondary provider behind `AIService` interface
- **Client perception layer** -- Core ML / Vision / SoundAnalysis frameworks for frame tagging and classification
- **Hybrid cascade routing** -- simple queries on-device, complex queries to server
- **Voice commands via Gemma 4 E4B audio input** -- glasses mic -> E4B -> action dispatch
- **`apps.json` fix** on VPS (invalid model name `gemini-2.5-flash-native-audio-latest`)
- **Server-side TTS for viewers** -- `TTSService` stub implementation (backend TBD)

### Out of Scope

- Client-side reasoning or decision-making AI (perception only, not guidance generation)
- Replacing `AVSpeechSynthesizer` with cloud TTS for the wearer (cloud TTS only for viewer audio)
- PCM-to-MP3 transcoding (raw PCM via FRAU is sufficient)
- Gemma 4 E4B on-device for unified vision+audio perception (too early, runtime not validated)
- Full MentraOS-style app platform (webhook lifecycle, app marketplace, etc.)
- Spanish Co-pilot fix (display project, deprioritized)
- `llama.cpp` / `MLC-LLM` runtime integration (waiting for E4B on-device validation)
- Always-on automatic AI (manual activation for now)

---

## Reference

- Architecture comparison: `docs/ai/comparisons/README.md`
- iOS audio pipeline: `docs/ai/ios/README.md`
- Video+audio models (Gemini Live): `docs/ai/videoinput-audiooutput/README.md`
- Video+text models (Gemma 4): `docs/ai/videoinput-textresponse/README.md`
- MentraOS source: `packages/reference/MentraOS/`
