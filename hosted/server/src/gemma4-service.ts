/**
 * Gemma4Service -- Google Gemma 4 26B A4B REST API provider
 *
 * Implements AIService using Gemma 4's REST `generateContent` endpoint.
 * Sends JPEG frames (as inline base64) + text prompts and receives
 * text responses + function calls.
 *
 * Unlike GeminiLiveService (bidirectional WebSocket), this is a
 * request/response REST client. Frames are buffered and sent periodically
 * or on-demand when text triggers arrive.
 *
 * REST endpoint:
 *   POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key=API_KEY
 *
 * Auth: API key via `GEMINI_API_KEY` environment variable (same as Gemini Live).
 *
 * Gemma 4 26B A4B spec:
 *   - Apache 2.0 license (self-hostable)
 *   - 25.2B total params, 3.8B active (MoE)
 *   - 256K context window
 *   - Input: text, image, video (up to 60s at 1fps)
 *   - Output: text only (no native audio -- TTS handled client-side)
 *   - No audio input (only E2B/E4B edge models have audio encoders)
 */

import type {
  AIService,
  AIServiceConfig,
  AIServiceCallbacks,
  AIServiceStatus,
} from "./ai-service.js";
import { registerAIProvider } from "./ai-service.js";

// --- Types ---

interface GeminiContent {
  role: string;
  parts: Array<Record<string, unknown>>;
}

interface GeminiGenerateRequest {
  contents: GeminiContent[];
  systemInstruction?: { parts: Array<{ text: string }> };
  tools?: Array<{ functionDeclarations: Array<Record<string, unknown>> }>;
  generationConfig?: Record<string, unknown>;
}

interface GeminiCandidate {
  content?: {
    role?: string;
    parts?: Array<{
      text?: string;
      functionCall?: { name: string; args: Record<string, unknown> };
    }>;
  };
  finishReason?: string;
}

interface GeminiGenerateResponse {
  candidates?: GeminiCandidate[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
  error?: { code: number; message: string; status: string };
}

// --- Service ---

export class Gemma4Service implements AIService {
  private _status: AIServiceStatus = "disconnected";
  private callbacks: AIServiceCallbacks | null = null;
  private config: AIServiceConfig | null = null;

  // Frame buffer -- ring buffer of latest frames for the next request
  private frameBuffer: Uint8Array[] = [];
  private readonly maxFrames = 3;

  // Conversation history (bounded) — text only, no images
  private history: GeminiContent[] = [];
  private readonly maxHistoryTurns = 10;

  // Periodic analysis timer
  private analysisTimer: ReturnType<typeof setInterval> | null = null;
  private analysisIntervalMs = 5_000;
  private isAnalyzing = false;

  get status(): AIServiceStatus {
    return this._status;
  }

  async connect(config: AIServiceConfig, callbacks: AIServiceCallbacks): Promise<void> {
    this.config = config;
    this.callbacks = callbacks;
    this._status = "connecting";
    callbacks.onStatusChange("connecting");

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      const err = new Error("GEMINI_API_KEY environment variable not set");
      this._status = "error";
      callbacks.onStatusChange("error");
      callbacks.onError(err);
      throw err;
    }

    // Analysis interval: from extra config, or derived from visionFps, or default 5s
    if (typeof config.extra?.analysisIntervalSec === "number") {
      this.analysisIntervalMs = config.extra.analysisIntervalSec * 1000;
    } else if (config.visionFps && config.visionFps > 0) {
      // Cap minimum interval at 2s for REST (API cost consideration)
      this.analysisIntervalMs = Math.max(2000, Math.round(1000 / config.visionFps));
    }

    // REST has no persistent connection -- mark connected immediately
    this._status = "connected";
    callbacks.onStatusChange("connected");
    console.log(`[gemma4] Connected: model=${config.model} interval=${this.analysisIntervalMs}ms`);

    // Start periodic scene analysis
    this.startAnalysisTimer();
  }

  sendVideoFrame(jpeg: Uint8Array): void {
    if (this._status !== "connected") return;

    // Ring buffer: keep latest N frames
    this.frameBuffer.push(jpeg);
    if (this.frameBuffer.length > this.maxFrames) {
      this.frameBuffer.shift();
    }
  }

  sendAudio(_pcm: Uint8Array): void {
    // Gemma 4 26B A4B has no audio encoder -- no-op
  }

  sendText(text: string): void {
    if (this._status !== "connected") return;
    this.analyze(text);
  }

  disconnect(): void {
    if (this.analysisTimer) {
      clearInterval(this.analysisTimer);
      this.analysisTimer = null;
    }
    this.frameBuffer = [];
    this.history = [];
    this.isAnalyzing = false;
    this._status = "disconnected";
    this.callbacks?.onStatusChange("disconnected");
    this.config = null;
    console.log("[gemma4] Disconnected");
  }

  setVisionFps(fps: number): void {
    if (!this.config) return;
    this.config.visionFps = fps;
    // Cap minimum interval at 2s for REST
    this.analysisIntervalMs = Math.max(2000, Math.round(1000 / fps));
    this.startAnalysisTimer();
    console.log(`[gemma4] Analysis interval updated to ${this.analysisIntervalMs}ms`);
  }

  // --- Private ---

  private startAnalysisTimer(): void {
    if (this.analysisTimer) clearInterval(this.analysisTimer);
    this.analysisTimer = setInterval(() => {
      if (this._status === "connected" && this.frameBuffer.length > 0 && !this.isAnalyzing) {
        this.analyze("Continue analyzing the scene. Report changes or notable observations. Use emit_guidance_event for anything important.");
      }
    }, this.analysisIntervalMs);
  }

  private async analyze(prompt: string): Promise<void> {
    if (this.isAnalyzing || !this.callbacks || !this.config) return;
    this.isAnalyzing = true;

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      this.isAnalyzing = false;
      return;
    }

    // Build user parts: frames + text
    const userParts: Array<Record<string, unknown>> = [];

    for (const frame of this.frameBuffer) {
      userParts.push({
        inlineData: {
          mimeType: "image/jpeg",
          data: uint8ToBase64(frame),
        },
      });
    }

    userParts.push({ text: prompt });

    // Append text-only user message to history (keep images out of history to avoid token bloat)
    this.history.push({ role: "user", parts: [{ text: prompt }] });
    while (this.history.length > this.maxHistoryTurns * 2) {
      this.history.shift();
    }

    // Build contents: history (text) + current frames
    const contentsWithFrames: GeminiContent[] = [
      ...this.history.slice(0, -1), // previous turns (text only)
      { role: "user", parts: userParts }, // latest turn with frames
    ];

    // Build request body
    const requestBody: GeminiGenerateRequest = {
      contents: contentsWithFrames,
      generationConfig: {
        ...(this.config.temperature != null ? { temperature: this.config.temperature } : {}),
      },
    };

    if (this.config.systemPrompt) {
      requestBody.systemInstruction = {
        parts: [{ text: this.config.systemPrompt }],
      };
    }

    // Register tools (same interface as Gemini Live)
    requestBody.tools = [
      {
        functionDeclarations: [
          {
            name: "emit_guidance_event",
            description: "Emit a guidance event to the user. Use for important guidance, alerts, corrections, or object identification. Do NOT use for every analysis -- only when there is something actionable to communicate.",
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
                  description: "The guidance message",
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
          {
            name: "annotate_scene",
            description: "Detect and localize objects with bounding boxes. Call on every frame that has visible objects to provide spatial awareness.",
            parameters: {
              type: "object",
              properties: {
                objects: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      box_2d: {
                        type: "array",
                        items: { type: "number" },
                        description: "[y1, x1, y2, x2] normalized to 1024x1024 grid",
                      },
                      label: {
                        type: "string",
                        description: "Object label / class name",
                      },
                      confidence: {
                        type: "number",
                        description: "Detection confidence 0-1",
                      },
                    },
                    required: ["box_2d", "label"],
                  },
                  description: "Array of detected objects with bounding boxes",
                },
              },
              required: ["objects"],
            },
          },
        ],
      },
    ];

    try {
      const modelId = this.config.model || "gemma-4-26b-a4b-it";
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`;

      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorText = await response.text();

        // Rate limit
        if (response.status === 429) {
          console.warn(`[gemma4] Rate limited: ${response.status}`);
          this.isAnalyzing = false;
          return;
        }

        throw new Error(`Gemma 4 API ${response.status}: ${errorText.slice(0, 200)}`);
      }

      const data = (await response.json()) as GeminiGenerateResponse;

      // API-level error
      if (data.error) {
        throw new Error(`Gemma 4 API error: ${data.error.message}`);
      }

      // Process candidates
      if (data.candidates?.[0]?.content?.parts) {
        const parts = data.candidates[0].content.parts;
        const modelParts: Array<Record<string, unknown>> = [];

        for (const part of parts) {
          if (part.text) {
            console.log(`[gemma4] Text: ${part.text.slice(0, 120)}`);
            this.callbacks.onText(part.text);
            modelParts.push({ text: part.text });
          }
          if (part.functionCall) {
            console.log(`[gemma4] Tool call: ${part.functionCall.name} args=${JSON.stringify(part.functionCall.args).slice(0, 120)}`);
            this.callbacks.onToolCall({
              name: part.functionCall.name,
              args: part.functionCall.args ?? {},
            });
            modelParts.push({ functionCall: part.functionCall });
          }
        }

        // Add model response to history
        if (modelParts.length > 0) {
          this.history.push({ role: "model", parts: modelParts });
        }
      }

      // Usage
      if (data.usageMetadata) {
        this.callbacks.onUsage({
          promptTokens: data.usageMetadata.promptTokenCount ?? 0,
          responseTokens: data.usageMetadata.candidatesTokenCount ?? 0,
        });
      }
    } catch (err) {
      console.error(`[gemma4] Analysis error:`, err);
      this.callbacks.onError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      this.isAnalyzing = false;
    }
  }
}

// --- Utilities ---

function uint8ToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

// --- Register provider ---

registerAIProvider("gemma4", Gemma4Service);
