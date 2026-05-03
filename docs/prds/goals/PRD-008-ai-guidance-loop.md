# PRD-008: AI Guidance Loop

**Product:** com.mwdat-ios / Guidance Orchestrator
**Owner:** @ebowwa
**Status:** Draft
**Last Updated:** 2026-04-15
**Layer:** 2 -- Application Primitive
**Depends On:** PRD-001 (iOS Client, AudioPlaybackStage), PRD-002 (Relay Platform, ControlEventBus, AudioTapBus), PRD-003 (AIStage on-device detections)

---

## Problem

The CaringMind platform streams video from smart glasses through a custom binary relay to browser viewers. The relay already publishes gesture events (`ControlEventBus`) and parsed audio frames (`AudioTapBus`). An app registry system (`AppRegistry`, `apps.json`) defines how apps bind to primitives with `systemPrompt`, `config`, and capability flags. Bidirectional audio is built -- the server can talk to the operator through the glasses speakers via FRAU codecType 3 and the `audio-in` endpoint.

What does not exist is the intelligence layer: an AI worker that watches the stream, reasons about what it sees and hears, and delivers structured guidance back to the operator in real-time. The missing piece is not the AI model itself -- it is the orchestration plumbing that connects trigger sources to AI workers and routes guidance output through existing transport paths.

### Why Not Always-On?

GlassFlow.in (competitive analysis) uses LiveKit rooms with an AI agent as a room participant. The agent sees everything, always -- binary mute/unmute is the only control. Applying a skill destroys agent context (hot-swaps system prompt via `admin.restart`). No device-side triggers. No event-driven architecture. No conditional processing.

CaringMind's approach is fundamentally different: the AI guidance loop is **trigger-driven, not always-on**. The AI worker connects only when needed, processes frames only on trigger, and produces typed guidance events (not raw text). Apps define guidance behavior through `systemPrompt` and can be hot-swapped without losing context.

---

## Users

| Persona | Description | Primary Need |
|---------|-------------|--------------|
| **Operator** | Wearing glasses, doing a task | Spoken guidance ("next step", "wrong part") without stopping work; hands-free interaction |
| **Remote Viewer** | Watching the stream in a browser | Guidance overlay (current step, warnings, identifications) rendered on the video feed |
| **App Developer** | Building guidance experiences on the platform | Clean interface to define triggers, connect AI backends, and receive typed guidance events |
| **CaringMind System** | The orchestration layer | Composable trigger routing, AI worker lifecycle management, multi-backend support |

---

## Current State

### What's Built

| Component | Location | What It Does |
|-----------|----------|--------------|
| `ControlEventBus` | Relay server | Pub/sub for gesture events (thumbs_up, thumbs_down, open_palm, pointing) from iOS publisher |
| `AudioTapBus` | Relay server | Pub/sub for parsed FRAU audio frames; supports AsyncIterable + callbacks |
| `AppRegistry` / `apps.json` | Relay server | App/primitive binding; apps define `systemPrompt`, `config` (model, voice, visionFps, gestures) |
| `AppDefinition` | Relay server | Structured app config: `systemPrompt`, `config` fields for model, voice, visionFps, gesture enable |
| `POST /session/<id>/audio-in` | Relay server endpoint | Pushes FRAU audio (codecType 3) to publisher for playback |
| `AudioPlaybackStage` | iOS client | Receives FRAU from server, plays via AVAudioEngine through glasses speakers |
| Viewer push-to-talk | Browser viewer | Sends FRAU codecType 3 to relay -> publisher |
| `FramePipelineManager` | iOS client | Pluggable stage architecture (RelayStage, DisplayStage, RecordingStage, AudioStage) |

### What's NOT Built

| Component | Why It Matters |
|-----------|---------------|
| `/analyze?session=<id>` WebSocket endpoint | No way for AI workers to receive frames + events |
| `AIStage` on iOS | No on-device Vision/CoreML detections (see PRD-003) |
| AI worker service | No actual inference backend connected |
| Guidance event types | No typed output schema for guidance |
| Guidance orchestrator | No server component routing triggers to workers |
| Skill extraction pipeline | No post-hoc analysis of recorded sessions |

---

## Architecture: Event-Driven, Not Always-On

The guidance loop is **trigger-driven**. AI engagement fires in response to discrete events, not continuous streaming. This is a deliberate design choice that differs from "always-on agent" approaches.

### Why Event-Driven

| Factor | Always-On Agent (GlassFlow) | Event-Driven (CaringMind) |
|--------|-----------------------------|---------------------------|
| Latency | Low (always listening) | Higher on first trigger, but context-aware |
| Cost | High (continuous inference) | Low (inference only on trigger) |
| Noise | High (irrelevant commentary) | Low (engages only when something changes) |
| Battery/bandwidth | High | Low |
| Context control | Agent drives conversation | Operator/environment drives via triggers |
| Hot-swap | Destroys context (admin.restart) | Preserves context (app_config update) |
| Gating | Binary mute/unmute only | Gesture vocabulary + voice + detection triggers |

---

## Requirements

### P0 -- Must Have

| ID | Requirement | Acceptance Criteria |
|----|-------------|---------------------|
| P0-1 | `/analyze?session=<id>` WebSocket endpoint on relay server | AI worker connects via WebSocket; receives FRLY frames (binary) + JSON control events (text) on the same connection; endpoint exists alongside `/publish` and `/view` with same session routing |
| P0-2 | Analyzer receives FRLY frames and JSON control events on same WS | Binary WebSocket messages carry FRLY frames at throttled FPS (per app config `visionFps`); text WebSocket messages carry JSON events from `ControlEventBus` and `AudioTapBus`; worker parses by message type |
| P0-3 | `GuidanceEvent` type system | Typed JSON events: `guidance.step`, `guidance.alert`, `guidance.correction`, `guidance.identification`, `guidance.acknowledgment`; each event has `type`, `severity` (low/medium/high), `text`, `timestamp`, optional `audio` (PCM base64 or TTS instruction) |
| P0-4 | Guidance audio output via existing `audio-in` endpoint | Guidance orchestrator receives guidance event with audio payload; POSTs FRAU codecType 3 to `/session/<id>/audio-in`; iOS `AudioPlaybackStage` plays through glasses speakers; end-to-end: AI speaks -> operator hears |
| P0-5 | Guidance orchestrator subscribes to `ControlEventBus` + `AudioTapBus` | New server component `GuidanceOrchestrator` instantiated per session; subscribes to `ControlEventBus` for gesture triggers; subscribes to `AudioTapBus` for voice triggers; routes trigger events to connected AI worker via WS JSON message |
| P0-6 | App config drives guidance behavior | `AppDefinition.config` fields (`model`, `voice`, `visionFps`, `gestures`) control which frames and triggers the AI worker receives; `systemPrompt` sent to worker on connect; different apps produce different guidance from the same visual input |

### P1 -- Should Have

| ID | Requirement | Acceptance Criteria |
|----|-------------|---------------------|
| P1-1 | On-device AIStage detections forwarded to analyzer as triggers | `AIStage` (PRD-003) detections published to `ControlEventBus` with type `ai_detection`; guidance orchestrator forwards to AI worker as JSON trigger; worker receives "person count changed" or "text detected" alongside frames |
| P1-2 | Voice-triggered guidance (transcription-based) | `AudioTapBus` audio buffered and transcribed (server-side Whisper or worker-side); wake word or question detection triggers guidance; operator says "what is this?" -> AI identifies object in current frame |
| P1-3 | Gesture-to-guidance mapping | Gesture events mapped to guidance behaviors: `thumbs_up` = request help, `open_palm` = pause guidance, `pointing` = identify what is pointed at; mapping defined in `AppDefinition.config.gestures` |
| P1-4 | Guidance event persistence | Guidance events written to `detections.jsonl` in session's R2 bucket; one JSON line per event; enables post-session review and skill extraction |
| P1-5 | Multiple AI worker backends | AI worker backend selectable per app: Gemini Live, OpenAI Realtime, local VLM; `AppDefinition.config.model` determines backend; orchestrator adapts wire format per backend |
| P1-6 | Guidance events to viewer WebSocket | Guidance JSON events forwarded to all viewers on the session; viewer renders overlay (step indicator, alert banner, identification tooltip) |
| P1-7 | Guidance pause/resume | `open_palm` gesture or explicit JSON command pauses guidance orchestrator; throttled frames stop; orchestrator buffers but does not send to worker until resumed |

### P2 -- Could Have

| ID | Requirement | Acceptance Criteria |
|----|-------------|---------------------|
| P2-1 | Skill extraction from recorded sessions | Post-hoc analysis of `detections.jsonl` + session recording; extract repeated task patterns into reusable skill definitions; skills become app templates |
| P2-2 | Workflow chaining | Multi-stage AI pipeline: VLM scene analysis produces context -> LLM generates guidance -> TTS produces audio; each stage is a separate worker connected through orchestrator |
| P2-3 | Worker memory/context persistence across sessions | AI worker maintains context (task progress, operator preferences) across session boundaries; stored in R2 alongside session data |
| P2-4 | Guidance compliance tracking | Track whether operator followed guidance steps; compare AI recommendations with subsequent frame analysis; report compliance score per session |
| P2-5 | Proactive guidance triggers | Beyond gesture/voice triggers: anomaly detection (unexpected scene change, safety violation, idle operator) triggers guidance without explicit request |

---

## Technical Architecture

### Component Overview

```
                         RELAY SERVER
                    +------------------------------------------+
                    |                                          |
  iOS Publisher --->|  Session Registry                        |
  (FRLY + FRAU)     |    +-- Session                          |
                    |          +-- ControlEventBus (gestures)   |
                    |          +-- AudioTapBus (audio frames)   |
                    |          +-- GuidanceOrchestrator (NEW)   |
                    |          |     +-- subscribes ControlBus  |
                    |          |     +-- subscribes AudioTapBus |
                    |          |     +-- manages AI worker WS   |
                    |          |     +-- dispatches GuidanceEvt |
                    |          +-- Viewers (fan-out)            |
                    |          +-- Analyzers (fan-out)          |
                    |                                          |
                    |  Endpoints:                              |
                    |    /publish?session=<id>                  |
                    |    /view?session=<id>                     |
                    |    /analyze?session=<id>    <-- NEW P0-1  |
                    |    /session/<id>/audio-in   (existing)    |
                    +------------------------------------------+
                         |         |          |
              FRLY frames    JSON triggers   GuidanceEvent JSON
                         |         |          |
                         v         v          v
                    +------------------------------------------+
                    |          AI WORKER (external)             |
                    |                                          |
                    |  WebSocket: /analyze?session=<id>         |
                    |                                          |
                    |  Receives:                                |
                    |    - Binary FRLY frames (throttled)       |
                    |    - JSON { type: "gesture", ... }        |
                    |    - JSON { type: "transcription", ... }  |
                    |    - JSON { type: "ai_detection", ... }   |
                    |    - JSON { type: "app_config", ... }     |
                    |                                          |
                    |  Sends:                                   |
                    |    - JSON GuidanceEvent (typed)           |
                    |                                          |
                    |  Backend: any (Gemini, OpenAI, local)     |
                    +------------------------------------------+
```

### Guidance Orchestrator (New Server Component)

```
GuidanceOrchestrator (per session)
       |
       +-- subscribes ControlEventBus
       |     gesture event -> forward to AI worker as JSON trigger
       |
       +-- subscribes AudioTapBus
       |     audio frame -> buffer for transcription -> forward trigger
       |
       +-- manages /analyze WebSocket lifecycle
       |     worker connect: send AppDefinition (systemPrompt + config)
       |     worker disconnect: log, await reconnect
       |     frames: forward FRLY at app.config.visionFps
       |
       +-- receives GuidanceEvent from worker
             |
             +-- severity=high (alert): immediate audio push
             |     POST /session/<id>/audio-in (FRAU codecType 3)
             |     + forward JSON to all viewers
             |
             +-- severity=medium/low: queue, batch, or immediate
                   forward JSON to viewers
                   audio push if event includes audio payload
```

### Guidance Event Types

```typescript
type GuidanceEventType =
  | "guidance.step"           // Next step in a procedure
  | "guidance.alert"          // Safety or quality warning
  | "guidance.correction"     // Operator is doing something wrong
  | "guidance.identification" // Identifying an object/person/text
  | "guidance.acknowledgment" // Confirming operator action was correct

type GuidanceSeverity = "low" | "medium" | "high"

interface GuidanceEvent {
  type:         GuidanceEventType
  severity:     GuidanceSeverity
  text:         string           // Human-readable guidance text
  timestamp:    number           // ms epoch, matches FRLY/FRAU timeline
  sessionId:    string
  triggerType:  "gesture" | "voice" | "ai_detection" | "app_event" | "proactive"
  source:       string           // App ID that generated this
  confidence:   number           // 0-1, model confidence
  audio?:       {                // Optional audio payload
    format:     "pcm" | "tts_instruction"
    data?:      string           // base64 PCM if format=pcm
    text?:      string           // TTS text if format=tts_instruction
    sampleRate: number
    channels:   number
  }
  metadata?:    Record<string, unknown>  // Backend-specific data
}
```

| Event Type | Severity | When | Example |
|------------|----------|------|---------|
| `guidance.step` | low | Next procedural step | "Tighten the bolt to 12 Newton meters" |
| `guidance.alert` | high | Safety violation, immediate danger | "Stop -- high voltage panel is exposed" |
| `guidance.correction` | medium | Operator doing something wrong | "That is the wrong connector -- use the red one" |
| `guidance.identification` | low | Object/tool/material identification | "That is a 10mm socket wrench" |
| `guidance.acknowledgment` | low | Response to operator's gesture or question | "Got it -- I will pause guidance. Thumbs up when ready." |

### /analyze WebSocket Protocol

```
CONNECT:
  Client -> Server:  WS handshake to /analyze?session=<id>
  Server -> Client:  JSON { type: "app_config", app: AppDefinition }

FRAMES (binary):
  Server -> Client:  Binary FRLY frame (throttled to app.config.visionFps)

TRIGGERS (text JSON):
  Server -> Client:  JSON { type: "gesture", gesture: "thumbs_up", timestamp: ... }
  Server -> Client:  JSON { type: "transcription", text: "what is this?", timestamp: ... }
  Server -> Client:  JSON { type: "ai_detection", detection: AIDetection, timestamp: ... }
  Server -> Client:  JSON { type: "app_event", event: "activate_app"|"deactivate_app", ... }

GUIDANCE OUTPUT (text JSON):
  Client -> Server:  JSON GuidanceEvent (see type definition above)

CONTROL (text JSON):
  Client -> Server:  JSON { type: "ready" }  // worker is initialized and accepting frames
  Client -> Server:  JSON { type: "error", message: string }
  Server -> Client:  JSON { type: "pause" }  // stop sending frames
  Server -> Client:  JSON { type: "resume" } // resume sending frames
```

### Session Data Model Extension

```
Session {
  ...existing fields...
  analyzers:        Map<string, Analyzer>        // AI worker connections
  orchestrator:     GuidanceOrchestrator | null   // Per-session orchestrator
  guidanceLog:      GuidanceEvent[]               // In-memory ring buffer (last 100)
}

Analyzer {
  id:               string      // Connection UUID
  ws:               WebSocket   // /analyze connection
  relay:            FrameRelay  // Throttle instance (visionFps from app config)
  connectedAt:      number      // Connection timestamp
  lastActivity:     number      // Last message timestamp
}
```

---

## Data Flow

### Trigger-Driven Guidance Loop

```
 1. Camera captures frame (FRLY) + mic captures audio (FRAU)
 2. iOS -> Relay WebSocket (existing publish path)
 3. Relay fan-out: viewers, recorder, /analyze endpoint
 4. GuidanceOrchestrator receives frame -> forwards to AI worker (throttled)
 5. Parallel trigger paths:
    a. ControlEventBus: gesture detected -> orchestrator -> AI worker JSON trigger
    b. AudioTapBus: audio buffered -> transcription -> question/wake-word -> orchestrator -> AI worker JSON trigger
    c. AIStage (future): on-device detection -> ControlEventBus -> orchestrator -> AI worker JSON trigger
 6. AI worker receives frame + trigger context -> reasons
 7. AI worker emits GuidanceEvent JSON -> orchestrator
 8. Orchestrator dispatches:
    a. Audio payload -> POST /session/<id>/audio-in -> FRAU codecType 3 -> iOS AudioPlaybackStage -> glasses speakers
    b. JSON event -> viewer WebSocket -> overlay rendering
    c. JSON event -> detections.jsonl -> R2 bucket (persistence)
    d. JSON event -> iOS control channel -> local notification/alert (future)
 9. Operator hears guidance, adjusts action, loop continues
```

### Audio Guidance Path (P0-4)

```
AI Worker
   |
   | GuidanceEvent with audio: { format: "tts_instruction", text: "Turn left" }
   v
GuidanceOrchestrator
   |
   | Server-side TTS: text -> PCM Int16 16kHz
   v
POST /session/<id>/audio-in
   |  Body: FRAU binary [codecType=3][seq][16000][1][16][timestamp][PCM]
   v
Relay Server
   |
   | Forward FRAU frame to publisher's WebSocket
   v
iOS RelayStage
   |
   | onReceivedAudio callback
   v
AudioPlaybackStage
   |
   | Decode PCM -> AVAudioEngine output node
   v
AVAudioSession (.allowBluetooth)
   |
   v
Glasses Speakers (HFP) / Phone Speaker
```

### App Composition (Not Monolithic Agent)

```
AppRegistry (apps.json)
   |
   +-- App "assembly-coach"
   |     systemPrompt: "You are an assembly line coach..."
   |     config: { model: "gemini-live", visionFps: 2, gestures: true, voice: "en-US-male" }
   |
   +-- App "safety-monitor"
   |     systemPrompt: "You monitor for safety violations..."
   |     config: { model: "openai-realtime", visionFps: 4, gestures: false, voice: "en-US-female" }
   |
   +-- App "training-buddy"
         systemPrompt: "You help new workers learn..."
         config: { model: "local-vlm", visionFps: 1, gestures: true, voice: "en-US-male" }

When app activates:
  1. GuidanceOrchestrator loads AppDefinition from registry
  2. Sends app_config to AI worker on connect (systemPrompt + config)
  3. Throttles frames to app.config.visionFps
  4. Routes triggers based on app.config.gestures, etc.

When app changes (hot-swap):
  1. Send new app_config to worker (NO disconnect, NO context loss)
  2. Worker updates system prompt in-place
  3. Frame rate adjusts to new visionFps

Unlike GlassFlow's admin.restart which wipes memory,
CaringMind hot-swaps preserve worker context.
```

### Full Loop: Gesture Trigger to Operator Hearing Guidance

```
  iOS                           Relay Server                    AI Worker
  ===                           ============                    =========

  Operator thumbs up
       |
  RelayStage sends JSON
  { type: "gesture",
    gesture: "thumbs_up" }
       +------------------------>
                                ControlEventBus.publish()
                                       |
                                GuidanceOrchestrator
                                  .handleGesture()
                                       |
                                Resolve app via
                                AppRegistry
                                       |
                                Send JSON trigger
                                { type: "gesture",
                                  gesture: "thumbs_up" }
       +-------------------------+-------->
                                |        AI reasons about
                                |        current frame context
                                |
                                |        Emits GuidanceEvent
                                |        { type: "guidance.step",
                                |          text: "Connect the
                                |           red wire to terminal A",
                                |          audio: { format:
                                |           "tts_instruction",
                                |           text: "Connect the
                                |            red wire to terminal A" }}
                                |
                                <--------+
                                |
                                TTS: text -> PCM 16kHz
                                FRAU encode codecType 3
                                POST /audio-in
                                       |
  RelayStage receives FRAU             |
  AudioPlaybackStage                   |
  decodes PCM                          |
       <-------------------------+
  AVAudioEngine plays
  Glasses speakers output
       |
  Operator hears: "Connect the red wire to terminal A"
```

---

## Success Metrics

| Metric | Target | Measurement Method |
|--------|--------|--------------------|
| Trigger-to-guidance latency (gesture -> audio playback) | < 3 seconds p95 | Timestamp delta: gesture event -> audio playback start |
| Trigger-to-guidance latency (voice -> audio playback) | < 5 seconds p95 | Timestamp delta: question detected -> audio playback start |
| Frame delivery to AI worker | At configured `visionFps` +/- 1fps | Server-side frame counter per analyzer connection |
| Guidance audio clarity | Understandable at glasses speaker volume | Manual test: operator repeats guidance phrase back correctly |
| AI worker reconnection | < 10 seconds after disconnect | Orchestrator logs; auto-reconnect on worker restart |
| Zero impact on viewer stream quality | No FPS degradation for viewers when analyzer connected | Compare viewer FPS with/without analyzer on same session |
| Guidance event schema compliance | 100% valid GuidanceEvent JSON | Schema validation on orchestrator input; reject malformed events |
| Concurrent guidance sessions | >= 5 on single VPS | Load test with mock AI workers per session |

---

## Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| AI worker latency too high for real-time guidance | High | Throttle visionFps to minimum useful rate (1-2fps for procedural tasks); pre-generate common guidance; cache TTS audio for repeated phrases |
| FRLY frame forwarding to AI worker competes with viewer bandwidth | Medium | Analyzer fan-out is independent of viewer fan-out; separate throttle instances; cap analyzer FPS via app config |
| Guidance audio plays over operator conversation (interruption) | High | Severity-based priority: alerts interrupt, steps queue; audio ducking on iOS side (lower playback volume during mic input); pause guidance during active voice input |
| AI hallucination produces dangerous guidance (wrong tool, wrong step) | Critical | Never execute actions autonomously; all guidance is advisory; `guidance.alert` events require human acknowledgment; app systemPrompt constrains AI domain; log all guidance for review |
| Multiple trigger sources fire simultaneously (gesture + voice) | Medium | Orchestrator queues triggers per session; deduplication window (500ms); AI worker receives merged context, not separate events |
| AI worker WebSocket disconnected during active session | Medium | Orchestrator logs disconnection; buffers recent frames (ring buffer, 10s); auto-reconnect; viewers see "guidance offline" status |
| App hot-swap confuses AI worker mid-inference | Low | Send app_config with sequence number; worker acknowledges before switching; in-flight inference completes with old context |
| Server-side TTS quality insufficient for industrial environment | Medium | Support PCM passthrough from AI worker (worker does its own TTS); fallback to text-only guidance displayed on viewer; test multiple TTS engines |
| AudioTapBus transcription adds processing overhead on relay | Medium | Transcription runs on AI worker, not relay; relay only buffers and forwards PCM chunks; worker pulls audio via `/tap/audio` or receives alongside frames |
| Privacy: AI worker sees everything operator sees | High | Trigger-driven: AI worker only receives frames when triggered, not continuously; app config `visionFps` can be set to 0 (audio-only guidance); operator can pause guidance with open_palm gesture; all processing is opt-in per app |

---

## Anti-Patterns (Lessons from GlassFlow)

These patterns from GlassFlow.in are explicitly **not** how CaringMind works:

| Anti-Pattern | Why It Is Bad | CaringMind Approach |
|-------------|---------------|---------------------|
| Always-on agent processing every frame | Wastes compute, generates noise, no trigger control | Event-driven: AI engages only on gesture/voice/detection trigger |
| `callAgentRpc('admin.restart')` to hot-swap prompts | Destroys conversation context mid-session | App binding system: different apps have different prompts, app activation preserves context |
| Binary mute/unmute as only gating | Operator cannot express intent through triggers | Gesture vocabulary: different gestures trigger different app behaviors |
| Workflow builder disconnected from runtime | Visual flow editors do not map cleanly to real-time streaming | App/primitive binding in apps.json: config-driven, no visual editor needed |
| Agent as room participant | Couples AI lifecycle to room lifecycle | AI primitive as a service: activated by orchestrator, independent of session |

---

## Implementation Phases

### Phase 1: Foundation (P0)

1. Add `/analyze?session=<id>` WebSocket endpoint to relay server
2. Implement frame forwarding to analyzers (alongside existing viewer fan-out)
3. Define `GuidanceEvent` type system (TypeScript types + JSON schema)
4. Build `GuidanceOrchestrator` -- subscribes to `ControlEventBus` + `AudioTapBus`, routes to connected analyzer
5. Implement guidance audio output: orchestrator receives event -> server-side TTS -> POST `/session/<id>/audio-in`
6. Wire `AppDefinition.config` to analyzer frame rate and trigger routing

### Phase 2: Triggers (P1)

7. Forward AIStage detections (PRD-003) to analyzer as triggers
8. Voice-triggered guidance via audio transcription
9. Gesture-to-guidance mapping from app config
10. Guidance event persistence to `detections.jsonl`
11. Multi-backend adapter (Gemini Live, OpenAI Realtime)

### Phase 3: Intelligence (P2)

12. Skill extraction from recorded sessions
13. Workflow chaining (VLM -> LLM -> TTS pipeline)
14. Worker memory persistence across sessions
15. Guidance compliance tracking

---

## Dependencies

```
PRD-008 (AI Guidance Loop)
   |
   +---> PRD-001 P1-8  (AudioPlaybackStage -- receives FRAU codecType 3)
   +---> PRD-002 P1-3  (/analyze endpoint -- this PRD defines it)
   +---> PRD-002 P1-6  (audio-in endpoint -- push FRAU to publisher)
   +---> PRD-003 P0    (AIStage -- on-device detections as trigger source, P1-1)
   +---> PRD-004       (R2 persistence -- detections.jsonl, P1-4)
   +---> AppRegistry   (existing -- app config drives guidance behavior)
   +---> ControlEventBus (existing -- gesture triggers)
   +---> AudioTapBus    (existing -- voice triggers)
```

---

## TTS Service Interface

```typescript
interface TTSService {
  synthesize(text: string, opts: { voice?: string }): Promise<Buffer>  // Returns 16kHz 16-bit mono PCM
}
```

Implementation options:
- **Google Cloud TTS** -- low latency, many voices, WaveNet quality
- **ElevenLabs** -- high quality, voice cloning, REST API
- **Piper TTS** -- self-hosted, no API cost, runs on the VPS
- **Gemini built-in TTS** -- if using Gemini Live models, TTS is built into the multimodal session
