# Video Input + Audio Output Models

Models that accept real-time video/image frames and produce native audio output
via bidirectional streaming. These work with the `GeminiLiveService` WebSocket
provider (no external TTS required).

---

## Gemini 3.1 Flash Live (Recommended)

| Field | Value |
|-------|-------|
| Model ID | `gemini-3.1-flash-live-preview` |
| Launch | March 26, 2026 |
| API Surface | Gemini Live API (stateful WebSocket) |
| Input | Text, Image, Audio, Video |
| Output | Native audio (AUDIO modality) + text |
| Context | 1M tokens |
| Output token limit | 65,536 |
| Auth | API key via `?key=` query param on WS URL |
| Pricing | Free tier available, pay-per-use |
| Status | Preview (not GA) |

### Notes
- Newest real-time audio model from Google
- Higher quality voice, lower latency than 2.5 Flash Live
- Only supports `AUDIO` response modality (no text+audio mixed output)
- Tool calling supported (used for `emit_guidance_event`)
- Good default for new voice-agent builds

### WebSocket Endpoint
```
wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent
```

### Setup Message
```json
{
  "setup": {
    "model": "models/gemini-3.1-flash-live-preview",
    "generationConfig": {
      "responseModalities": ["AUDIO"],
      "speechConfig": {
        "voiceConfig": {
          "prebuiltVoiceConfig": { "voiceName": "Kore" }
        }
      }
    },
    "systemInstruction": { "parts": [{ "text": "..." }] },
    "tools": [...]
  }
}
```

### Error Handling

| Close Code | Reason Pattern | Classification | Action |
|------------|---------------|----------------|--------|
| 1007 | `invalid api key`, `unauthorized`, `forbidden` | Fatal (auth) | Do not retry. Alert user. |
| 1007 | `invalid argument`, `not found` | Config error | Do not retry. Check model name. |
| 429 | `resource_exhausted`, `rate limit`, `quota exceeded` | Rate limit | Retry with backoff (5s*3^n, cap 120s, 15 attempts) |
| 1000 | (empty/timeout) | Transient | Retry with backoff (1s*2^n, cap 30s, 10 attempts) |

---

## Gemini 2.5 Flash Live (Legacy)

| Field | Value |
|-------|-------|
| Model ID | `gemini-2.5-flash-native-audio-preview-12-2025` |
| Launch | September 2025 (last update Dec 2025) |
| API Surface | Gemini Live API (stateful WebSocket) |
| Input | Text, Image, Audio, Video |
| Output | Native audio (24kHz PCM) + text |
| Context | 1M tokens |
| Output token limit | 8,192 |
| Auth | API key via `?key=` query param |
| Status | Preview (superseded by 3.1) |

### Notes
- Audio output is 24kHz PCM; our service resamples to 16kHz for FRAU codecType 3
- `gemini-2.5-flash-native-audio-latest` is NOT a valid model ID -- causes 1007 close
- Lower output token limit (8K vs 65K) compared to 3.1
- Still functional but Google recommends migrating to 3.1 Flash Live

### Audio Pipeline
```
Gemini output (24kHz PCM Int16)
  -> resample24to16() linear interpolation
  -> 16kHz PCM Uint8Array
  -> onAudio callback
  -> audioPushFn -> relay /audio-in
  -> publisher + viewers
```

---

## Architecture: Gemini Live WebSocket

```
iOS Publisher                    Relay Server                    Google Gemini
    |                                |                               |
    |-- JPEG frame (FRLY) --------->|                               |
    |-- PCM audio (FRAU) ---------->|-- JPEG (base64) ------------->|
    |                                |-- PCM (base64) ------------->|
    |                                |                               |
    |                                |<-- Audio PCM (24kHz) ---------|
    |                                |<-- Text parts ---------------|
    |                                |<-- Tool calls ---------------|
    |                                |                               |
    |<-- PCM audio (16kHz) --------- |  (resampled, pushed to audio-in)
    |<-- Guidance events (WS) ------ |  (broadcast to viewers)
    |                                |                               |
```

Key characteristics:
- Bidirectional streaming (send frames/audio, receive audio/text simultaneously)
- No external STT/TTS needed -- model handles speech natively
- Single WebSocket connection per session
- `goAway` messages signal impending server-side shutdown
- Rate limits are transient and should be retried with exponential backoff

---

## Invalid / Deprecated Model IDs

These model IDs will cause a 1007 close with "Request contains an invalid argument":

| Model ID | Status |
|----------|--------|
| `gemini-2.5-flash-native-audio-latest` | Invalid -- does not exist |
| `gemini-2.0-flash-exp` | Deprecated |
| `gemini-1.5-flash` | No Live API support |
