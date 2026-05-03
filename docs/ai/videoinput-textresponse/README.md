# Video Input + Text Response Models

Models that accept video/image frames and produce text output only.
Audio output requires a separate TTS layer (e.g., Apple `AVSpeechSynthesizer`
on the iOS client, or server-side TTS like ElevenLabs).

---

## Gemma 4 26B A4B IT (Recommended)

| Field | Value |
|-------|-------|
| Model ID | `gemma-4-26b-a4b-it` |
| Model ID (Vertex AI) | `gemma-4-26b-a4b-it-maas` |
| License | Apache 2.0 |
| Launch | April 3, 2026 |
| Architecture | Mixture-of-Experts (MoE) |
| Total Parameters | 25.2B |
| Active Parameters | 3.8B per token |
| Experts | 128 total + 1 shared, 8 active per token |
| Context Window | 256,000 tokens |
| Input | Text, Image, Video (up to 60s at 1fps) |
| Output | Text only (no native audio) |
| Audio Input | No (only E2B/E4B edge models support audio) |
| Pricing | $0.08/M input tokens, $0.35/M output tokens |
| Launch Stage | Experimental |

### Capabilities
- Native function calling
- Configurable thinking/reasoning mode (`<|think|>`)
- Structured JSON output
- 140+ language support (pre-trained), 35+ out-of-box
- Video understanding as frame sequences
- Object detection, OCR, chart parsing, scene description
- Bounding box output in JSON format

### What It Does NOT Support
- No native audio output (text only)
- No audio input (only E2B/E4B edge models have audio encoders)
- No Gemini Live WebSocket API (`BidiGenerateContent`)
- No real-time bidirectional streaming

### API Surfaces

| Provider | Endpoint | Notes |
|----------|----------|-------|
| Google AI Studio | `generativelanguage.googleapis.com` REST | API key auth |
| Vertex AI | `aiplatform.googleapis.com` REST | Service account auth |
| OpenRouter | `openrouter.ai/api/v1` | Multi-provider routing |
| Cloudflare Workers AI | `@cf/google/gemma-4-26b-a4b-it` | Edge inference |
| Novita AI | Novita API | GPU application hosting |
| Self-hosted | LM Studio, vLLM, etc. | Local inference |

---

## Other Gemma 4 Variants

| Model | Total Params | Active Params | Audio In | Context | Best For |
|-------|-------------|---------------|----------|---------|----------|
| Gemma 4 E2B | ~5.1B | ~2.3B | **Yes** | 128K | On-device, phones, Raspberry Pi |
| Gemma 4 E4B | ~10B | ~4B | **Yes** | 128K | Edge devices, audio+vision |
| **Gemma 4 26B A4B** | **25.2B** | **3.8B** | **No** | **256K** | **Server-side visual intelligence** |
| Gemma 4 31B | 31B | 31B (dense) | No | 256K | Max quality, higher compute |

Note: Only E2B and E4B have the USM-style Conformer audio encoder (raw waveform -> mel-spectrogram -> soft tokens). The 26B A4B and 31B models have vision encoders only.

---

## Architecture: Visual Intelligence with Client-Side TTS

For our use case (visual intelligence with spoken output):

```
iOS Publisher                    Relay Server                    Gemma 4 API
    |                                |                               |
    |-- JPEG frame (FRLY) --------->|                               |
    |                                |-- image (base64) ------------>|
    |                                |-- prompt + history ---------->|
    |                                |                               |
    |                                |<-- text response -------------|
    |                                |<-- tool calls ----------------|
    |                                |                               |
    |<-- Guidance events (WS) ------ |  (text events to viewers)
    |                                |                               |
    |  [Client-side TTS]            |                               |
    |  AVSpeechSynthesizer          |                               |
    |  .write() PCM -> audio out    |                               |
```

### TTS Options (Client-Side)

| Option | Quality | Latency | Offline |
|--------|---------|---------|---------|
| `AVSpeechSynthesizer` | Good | Low (~100ms) | Yes |
| `AVSpeechSynthesizer.write()` | Good | Low | Yes |
| ElevenLabs API | Excellent | Medium (~500ms) | No |
| OpenAI TTS | Excellent | Medium | No |

### TTS Options (Server-Side, if needed)

If we want server-side TTS to push audio back through the relay:

| Option | Quality | Notes |
|--------|---------|-------|
| `bun:ffi` + Piper TTS | Good | Runs locally, fast |
| Google Cloud TTS | Excellent | API call, adds latency |
| ElevenLabs WebSocket | Excellent | Streaming, lowest latency |

---

## Comparison: Live API vs REST API

| Aspect | Gemini Live (3.1 Flash) | Gemma 4 26B A4B |
|--------|------------------------|------------------|
| Connection | WebSocket (persistent) | REST (per-request) |
| Latency | ~200ms first audio | ~1-3s full response |
| Streaming | Bidirectional, real-time | Request/response |
| Audio Output | Native (built-in) | Requires TTS layer |
| Audio Input | Yes | No |
| Video Input | Frame-by-frame streaming | Batch (up to 60s @ 1fps) |
| Model Size | Proprietary | 25.2B MoE (Apache 2.0) |
| Cost | Free tier + pay-per-use | $0.08/M in, $0.35/M out |
| Self-Hostable | No | Yes |
| Best For | Real-time voice conversation | Visual analysis, agentic tasks |

---

## Recommended Use Cases

### When to use Gemma 4 26B A4B
- Visual intelligence (object detection, scene understanding, OCR)
- Step-by-step guidance with text display
- Agentic tasks with tool calling
- Privacy-sensitive (can self-host)
- Cost-sensitive (MoE efficiency, only 3.8B active params)

### When to use Gemini Live API (3.1 Flash)
- Real-time spoken conversation
- Low-latency voice interaction required
- Bidirectional audio streaming needed
- Simpler architecture (no STT/TTS layer)
