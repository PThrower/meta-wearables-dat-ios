/**
 * GeminiLiveService -- Google Gemini Live API provider
 *
 * Implements AIService using Gemini's bidirectional WebSocket streaming API.
 * Sends JPEG frames (~1 FPS) + PCM audio (16kHz mono) and receives
 * spoken PCM audio (24kHz mono) + text responses.
 *
 * WebSocket endpoint:
 *   wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent
 *
 * Auth: API key passed as ?key=<KEY> query parameter on the WebSocket URL.
 *
 * Audio output from Gemini is 24kHz PCM; this service resamples to 16kHz
 * before emitting via the onAudio callback (matching FRAU codecType 3).
 */

import type {
  AIService,
  AIServiceConfig,
  AIServiceCallbacks,
  AIServiceStatus,
} from "./ai-service.js";
import { registerAIProvider } from "./ai-service.js";

// --- Constants ---

const GEMINI_WS_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

const INPUT_PCM_RATE = 16000;
const OUTPUT_PCM_RATE = 24000;

// --- Types ---

interface GeminiSetup {
  model: string;
  generationConfig: {
    responseModalities: string[];
    speechConfig?: Record<string, unknown>;
    temperature?: number;
  };
  systemInstruction?: {
    parts: Array<{ text: string }>;
  };
  tools?: Array<{
    functionDeclarations: Array<{
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    }>;
  }>;
}

interface GeminiRealtimeInput {
  video?: { mimeType: string; data: string };
  audio?: { mimeType: string; data: string };
  text?: string;
}

interface GeminiServerMessage {
  setupComplete?: Record<string, unknown>;
  serverContent?: {
    modelTurn?: {
      parts: Array<{
        text?: string;
        inlineData?: { mimeType: string; data: string };
      }>;
    };
    turnComplete?: boolean;
    interrupted?: boolean;
  };
  toolCall?: { functionCalls: Array<Record<string, unknown>> };
  usageMetadata?: {
    promptTokenCount?: number;
    responseTokenCount?: number;
    totalTokenCount?: number;
  };
}

// --- Resampler ---

/**
 * Downsample 24kHz PCM Int16 to 16kHz PCM Int16 by linear interpolation.
 * Output is ~2/3 the input length.
 */
function resample24to16(input: Int16Array): Int16Array {
  const ratio = OUTPUT_PCM_RATE / INPUT_PCM_RATE; // 1.5
  const outLen = Math.floor(input.length / ratio);
  const output = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcPos = i * ratio;
    const idx0 = Math.floor(srcPos);
    const idx1 = Math.min(idx0 + 1, input.length - 1);
    const frac = srcPos - idx0;
    output[i] = Math.round(input[idx0] + (input[idx1] - input[idx0]) * frac);
  }
  return output;
}

// --- Service ---

export class GeminiLiveService implements AIService {
  private ws: WebSocket | null = null;
  private _status: AIServiceStatus = "disconnected";
  private callbacks: AIServiceCallbacks | null = null;
  private config: AIServiceConfig | null = null;

  // Frame rate limiter
  private lastFrameAt = 0;

  get status(): AIServiceStatus {
    return this._status;
  }

  async connect(config: AIServiceConfig, callbacks: AIServiceCallbacks): Promise<void> {
    if (this.ws) this.disconnect();

    this.config = config;
    this.callbacks = callbacks;
    this._status = "connecting";
    this.callbacks.onStatusChange("connecting");

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      const err = new Error("GEMINI_API_KEY environment variable not set");
      this._status = "error";
      callbacks.onStatusChange("error");
      callbacks.onError(err);
      throw err;
    }

    const setup: GeminiSetup = {
      model: `models/${config.model}`,
      generationConfig: {
        responseModalities: ["AUDIO"],
        ...(config.voice
          ? {
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: { voiceName: config.voice },
                },
              },
            }
          : {}),
        ...(config.temperature != null ? { temperature: config.temperature } : {}),
      },
    };

    if (config.systemPrompt) {
      setup.systemInstruction = {
        parts: [{ text: config.systemPrompt }],
      };
    }

    // Register tools the AI can call
    setup.tools = [
      {
        functionDeclarations: [
          {
            name: "emit_guidance_event",
            description: "Emit a guidance event to the user's viewer panel. Use this to log important guidance, corrections, alerts, or identification of objects. Do NOT use this for casual conversation — that goes through spoken audio only.",
            parameters: {
              type: "object",
              properties: {
                eventType: {
                  type: "string",
                  enum: ["step", "alert", "correction", "identification"],
                  description: "The type of guidance event",
                },
                content: {
                  type: "string",
                  description: "The guidance message to display",
                },
                confidence: {
                  type: "number",
                  description: "Confidence score 0-1",
                },
                severity: {
                  type: "string",
                  enum: ["info", "warning", "critical"],
                  description: "Severity level (default: info)",
                },
              },
              required: ["eventType", "content"],
            },
          },
        ],
      },
    ];

    return new Promise<void>((resolve, reject) => {
      try {
        const url = `${GEMINI_WS_URL}?key=${apiKey}`;
        this.ws = new WebSocket(url);

        const connectTimeout = setTimeout(() => {
          if (this._status === "connecting") {
            this._status = "error";
            callbacks.onStatusChange("error");
            callbacks.onError(new Error("Gemini Live API connection timeout"));
            this.ws?.close();
            reject(new Error("Connection timeout"));
          }
        }, 15_000);

        this.ws.addEventListener("open", () => {
          // Send setup message
          const msg = JSON.stringify({ setup });
          this.ws!.send(msg);
        });

        this.ws.addEventListener("message", (event) => {
          // Bun delivers WS messages as Buffer, string, or ArrayBuffer
          let data: string;
          if (typeof event.data === "string") {
            data = event.data;
          } else if (Buffer.isBuffer(event.data)) {
            data = event.data.toString("utf8");
          } else if (event.data instanceof ArrayBuffer) {
            data = Buffer.from(event.data).toString("utf8");
          } else {
            return;
          }

          let msg: GeminiServerMessage;
          try {
            msg = JSON.parse(data);
          } catch {
            return;
          }

          // Setup complete
          if (msg.setupComplete) {
            clearTimeout(connectTimeout);
            this._status = "connected";
            callbacks.onStatusChange("connected");
            console.log(`[gemini-live] Connected: model=${config.model}`);
            resolve();
            return;
          }

          // Usage metadata
          if (msg.usageMetadata) {
            callbacks.onUsage({
              promptTokens: msg.usageMetadata.promptTokenCount ?? 0,
              responseTokens: msg.usageMetadata.responseTokenCount ?? 0,
            });
          }

          // Server content (audio + text responses)
          if (msg.serverContent?.modelTurn?.parts) {
            for (const part of msg.serverContent.modelTurn.parts) {
              if (part.inlineData?.data) {
                // Audio response from Gemini (24kHz PCM 16-bit LE)
                const raw = base64ToUint8(part.inlineData.data);
                console.log(`[gemini-live] Audio part: ${raw.length} bytes, mime=${part.inlineData.mimeType}`);
                // Copy into a clean ArrayBuffer with correct size to avoid Buffer pool issues
                const cleanBuf = new ArrayBuffer(raw.length);
                new Uint8Array(cleanBuf).set(raw);
                const pcm24 = new Int16Array(cleanBuf);
                const pcm16 = resample24to16(pcm24);
                // Build output from a fresh ArrayBuffer sized exactly to the data
                const outBuf = new ArrayBuffer(pcm16.length * 2);
                new Uint8Array(outBuf).set(new Uint8Array(pcm16.buffer, pcm16.byteOffset, pcm16.length * 2));
                const outPcm = new Uint8Array(outBuf);
                console.log(`[gemini-live] Resampled: ${outPcm.length} bytes (16kHz)`);
                callbacks.onAudio(outPcm);
              }
              if (part.text) {
                console.log(`[gemini-live] Text part: ${part.text.slice(0, 80)}`);
                callbacks.onText(part.text);
              }
            }
          }

          // Tool calls (e.g. emit_guidance_event)
          if (msg.toolCall?.functionCalls) {
            for (const fc of msg.toolCall.functionCalls) {
              const name = fc.name as string;
              const args = (fc.args ?? {}) as Record<string, unknown>;
              const id = fc.id as string | undefined;
              console.log(`[gemini-live] Tool call: ${name} args=${JSON.stringify(args).slice(0, 120)}`);
              callbacks.onToolCall({ name, args });

              // Send tool response back so Gemini can continue
              if (id) {
                this.ws!.send(JSON.stringify({
                  toolResponse: {
                    functionResponses: [{ id, name, response: { ok: true } }],
                  },
                }));
              }
            }
          }
        });

        this.ws.addEventListener("error", (_event) => {
          clearTimeout(connectTimeout);
          const errMsg = "WebSocket error";
          console.error(`[gemini-live] ${errMsg}`);
          const wasConnected = this._status === "connected";
          this._status = "error";
          callbacks.onStatusChange("error");
          callbacks.onError(new Error(errMsg));
          if (!wasConnected) {
            reject(new Error(errMsg));
          }
        });

        this.ws.addEventListener("close", (event) => {
          clearTimeout(connectTimeout);
          console.log(`[gemini-live] Closed: code=${event.code} reason=${event.reason}`);
          if (this._status !== "error") {
            this._status = "disconnected";
            callbacks.onStatusChange("disconnected");
          }
        });
      } catch (err) {
        this._status = "error";
        callbacks.onStatusChange("error");
        callbacks.onError(err instanceof Error ? err : new Error(String(err)));
        reject(err);
      }
    });
  }

  sendVideoFrame(jpeg: Uint8Array): void {
    if (!this.ws || this._status !== "connected") return;

    // Rate-limit frames to visionFps
    const fps = this.config?.visionFps ?? 1;
    const minInterval = 1000 / fps;
    const now = Date.now();
    if (now - this.lastFrameAt < minInterval) return;
    this.lastFrameAt = now;

    const input: GeminiRealtimeInput = {
      video: {
        mimeType: "image/jpeg",
        data: uint8ToBase64(jpeg),
      },
    };
    this.ws.send(JSON.stringify({ realtimeInput: input }));
  }

  sendAudio(pcm: Uint8Array): void {
    if (!this.ws || this._status !== "connected") return;

    const input: GeminiRealtimeInput = {
      audio: {
        mimeType: `audio/pcm;rate=${INPUT_PCM_RATE}`,
        data: uint8ToBase64(pcm),
      },
    };
    this.ws.send(JSON.stringify({ realtimeInput: input }));
  }

  sendText(text: string): void {
    if (!this.ws || this._status !== "connected") return;

    const input: GeminiRealtimeInput = { text };
    this.ws.send(JSON.stringify({ realtimeInput: input }));
  }

  disconnect(): void {
    if (this.ws) {
      try {
        this.ws.close(1000, "Client disconnect");
      } catch {}
      this.ws = null;
    }
    this._status = "disconnected";
    this.callbacks?.onStatusChange("disconnected");
    this.config = null;
  }

  setVisionFps(fps: number): void {
    if (this.config) {
      this.config.visionFps = fps;
      console.log(`[gemini-live] Vision FPS updated to ${fps}`);
    }
  }
}

// --- Utilities ---

function uint8ToBase64(bytes: Uint8Array): string {
  // Bun has btoa but it expects string. Use Buffer for binary base64.
  return Buffer.from(bytes).toString("base64");
}

function base64ToUint8(b64: string): Uint8Array {
  return Buffer.from(b64, "base64");
}

// --- Register provider ---

registerAIProvider("gemini", GeminiLiveService);
registerAIProvider("gemini-live", GeminiLiveService);
