/**
 * DeepgramSTTService -- real-time speech-to-text via Deepgram WebSocket API
 *
 * Implements AIService as a transform processor: receives PCM audio from the
 * workflow DAG, streams it to Deepgram, and emits transcription events back
 * via onToolCall({ name: "emit_guidance_event", args: { eventType: "transcription", ... } }).
 *
 * Differences from conversational AI providers:
 * - sendVideoFrame() is a no-op (STT is audio-only)
 * - sendText() is a no-op (no text input to a transcription stream)
 * - No onAudio() output (STT produces text, not audio)
 * - Uses onToolCall to emit structured transcription events with interim/final
 *   flags, confidence scores, and word-level metadata
 */

import type { AIService, AIServiceConfig, AIServiceCallbacks, AIServiceStatus } from "./ai-service.js";
import { registerAIProvider } from "./ai-service.js";

interface DeepgramWord {
  word: string;
  start: number;
  end: number;
  confidence: number;
}

interface DeepgramAlternative {
  transcript: string;
  confidence: number;
  words?: DeepgramWord[];
}

interface DeepgramChannel {
  alternatives: DeepgramAlternative[];
}

interface DeepgramResult {
  is_final: boolean;
  speech_final: boolean;
  channel: DeepgramChannel;
}

interface DeepgramMessage {
  type: string;
  channel?: DeepgramChannel;
  alternatives?: DeepgramAlternative[];
  is_final?: boolean;
  speech_final?: boolean;
}

export class DeepgramSTTService implements AIService {
  readonly expectedInputSampleRate = 48000;
  private _status: AIServiceStatus = "disconnected";
  private ws: WebSocket | null = null;
  private callbacks: AIServiceCallbacks | null = null;
  private config: AIServiceConfig | null = null;
  private keepAliveInterval: ReturnType<typeof setInterval> | null = null;

  get status(): AIServiceStatus {
    return this._status;
  }

  async connect(config: AIServiceConfig, callbacks: AIServiceCallbacks): Promise<void> {
    this.config = config;
    this.callbacks = callbacks;

    const apiKey = process.env.DEEPGRAM_API_KEY;
    if (!apiKey) {
      const err = new Error("[deepgram-stt] DEEPGRAM_API_KEY not set in environment");
      callbacks.onError(err);
      this._status = "error";
      callbacks.onStatusChange("error");
      return;
    }

    const params = this.buildConnectionParams(config);
    const url = `wss://api.deepgram.com/v1/listen?${params}`;

    this._status = "connecting";
    callbacks.onStatusChange("connecting");
    console.log(`[deepgram-stt] Connecting to ${url.replace(apiKey, "***")}`);

    try {
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(url, ["token", apiKey]);

        ws.binaryType = "arraybuffer";

        ws.addEventListener("open", () => {
          console.log("[deepgram-stt] WebSocket connected");
          this._status = "connected";
          callbacks.onStatusChange("connected");
          this.startKeepAlive();
          resolve();
        });

        ws.addEventListener("message", (event: MessageEvent) => {
          if (typeof event.data === "string") {
            this.handleTextMessage(event.data);
          }
        });

        ws.addEventListener("close", (event: CloseEvent) => {
          console.log(`[deepgram-stt] WebSocket closed: code=${event.code} reason=${event.reason}`);
          this.stopKeepAlive();
          this._status = "disconnected";
          callbacks.onStatusChange("disconnected", {
            closeCode: event.code,
            closeReason: event.reason,
          });
        });

        ws.addEventListener("error", (event: Event) => {
          console.error("[deepgram-stt] WebSocket error", event);
          this.stopKeepAlive();
          this._status = "error";
          callbacks.onError(new Error("[deepgram-stt] WebSocket error"));
          callbacks.onStatusChange("error");
          reject(new Error("[deepgram-stt] Connection failed"));
        });

        this.ws = ws;
      });
    } catch (err) {
      console.error("[deepgram-stt] Connect failed", err);
      this._status = "error";
      callbacks.onStatusChange("error");
    }
  }

  sendAudio(pcm: Uint8Array): void {
    if (this._status !== "connected" || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(pcm);
  }

  sendVideoFrame(_jpeg: Uint8Array): void {
    // No-op: STT is audio-only
  }

  sendText(_text: string): void {
    // No-op: no text input to a transcription stream
  }

  disconnect(): void {
    this.stopKeepAlive();

    if (this.ws) {
      // Send CloseStream to signal we're done sending audio
      if (this.ws.readyState === WebSocket.OPEN) {
        try {
          this.ws.send(JSON.stringify({ type: "CloseStream" }));
        } catch { /* ignore */ }
      }
      try {
        this.ws.close(1000, "client disconnect");
      } catch { /* ignore */ }
      this.ws = null;
    }

    this._status = "disconnected";
    if (this.callbacks) {
      this.callbacks.onStatusChange("disconnected");
    }
  }

  // --- Private ---

  private buildConnectionParams(config: AIServiceConfig): string {
    const parts: string[] = [
      "encoding=linear16",
      "sample_rate=48000",
      "channels=1",
      "interim_results=true",
      "smart_format=true",
      "endpointing=300",
      "vad_events=true",
    ];

    // Model (default: nova-2)
    const model = config.model || "nova-2";
    parts.push(`model=${encodeURIComponent(model)}`);

    // Language from extra config
    const extra = config.extra ?? {};
    if (extra.language) {
      parts.push(`language=${encodeURIComponent(extra.language as string)}`);
    } else {
      parts.push("language=en-US");
    }

    // Optional flags from extra config
    if (extra.punctuation === true || extra.punctuation === undefined) {
      parts.push("punctuate=true");
    }
    if (extra.diarize === true) {
      parts.push("diarize=true");
    }
    if (extra.profanityFilter === true) {
      parts.push("profanity_filter=true");
    }

    return parts.join("&");
  }

  private handleTextMessage(data: string): void {
    let msg: DeepgramMessage;
    try {
      msg = JSON.parse(data);
    } catch {
      console.warn("[deepgram-stt] Non-JSON text message:", data.slice(0, 200));
      return;
    }

    switch (msg.type) {
      case "Results": {
        const result = this.extractResult(msg);
        if (!result || !result.transcript) return;
        this.emitTranscription(result);
        break;
      }
      case "Metadata":
        console.log("[deepgram-stt] Session metadata received");
        break;
      case "SpeechStarted":
        console.log("[deepgram-stt] Speech detected");
        break;
      case "UtteranceEnd":
        console.log("[deepgram-stt] Utterance ended");
        break;
      default:
        // Log unknown types for diagnostics
        if (msg.type !== "Summary") {
          console.log(`[deepgram-stt] Unhandled message type: ${msg.type}`);
        }
    }
  }

  private extractResult(msg: DeepgramMessage): {
    transcript: string;
    confidence: number;
    isFinal: boolean;
    speechFinal: boolean;
    words: DeepgramWord[];
  } | null {
    // Deepgram v1 API structure: msg.channel.alternatives[0]
    const channel = msg.channel;
    if (!channel?.alternatives?.length) return null;

    const alt = channel.alternatives[0];
    if (!alt.transcript) return null;

    return {
      transcript: alt.transcript,
      confidence: alt.confidence ?? 0,
      isFinal: msg.is_final ?? false,
      speechFinal: msg.speech_final ?? false,
      words: alt.words ?? [],
    };
  }

  private emitTranscription(result: {
    transcript: string;
    confidence: number;
    isFinal: boolean;
    speechFinal: boolean;
    words: DeepgramWord[];
  }): void {
    if (!this.callbacks) return;

    this.callbacks.onToolCall({
      name: "emit_guidance_event",
      args: {
        eventType: "transcription",
        content: result.transcript,
        confidence: result.confidence,
        isFinal: result.isFinal,
        speechFinal: result.speechFinal,
        words: result.words.length > 0 ? result.words : undefined,
      },
    });
  }

  private startKeepAlive(): void {
    this.stopKeepAlive();
    this.keepAliveInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        try {
          this.ws.send(JSON.stringify({ type: "KeepAlive" }));
        } catch { /* ignore */ }
      }
    }, 5000);
  }

  private stopKeepAlive(): void {
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = null;
    }
  }
}

// --- Register provider ---

registerAIProvider("deepgram", DeepgramSTTService);
registerAIProvider("deepgram-stt", DeepgramSTTService);
