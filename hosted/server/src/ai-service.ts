/**
 * AIService -- abstract interface for AI providers
 *
 * Swappable provider interface. Each provider implements a WebSocket-based
 * multimodal AI session that accepts video frames + audio and returns
 * spoken guidance audio + text events.
 *
 * Current providers: Gemini Live API
 * Future: OpenAI Realtime, Anthropic, etc.
 */

// --- Types ---

export interface AIServiceConfig {
  /** Provider-specific model ID (e.g., "gemini-3.1-flash-live-preview") */
  model: string;
  /** System prompt for the AI session */
  systemPrompt: string;
  /** Voice name (provider-specific, e.g., "Kore" for Gemini) */
  voice?: string;
  /** Max FPS for video frames sent to the model */
  visionFps?: number;
  /** Temperature (0-1) */
  temperature?: number;
  /** Provider-specific extra config */
  extra?: Record<string, unknown>;
}

export interface AIServiceCallbacks {
  /** AI produced a spoken response -- PCM 16-bit LE, 16kHz, mono */
  onAudio: (pcm: Uint8Array) => void;
  /** AI produced a text response (thinking/transcript -- not spoken) */
  onText: (text: string) => void;
  /** AI made a tool call (e.g. emit_guidance_event) */
  onToolCall: (toolCall: { name: string; args: Record<string, unknown> }) => void;
  /** AI session status changed */
  onStatusChange: (status: AIServiceStatus) => void;
  /** Provider reported usage/token counts */
  onUsage: (usage: { promptTokens: number; responseTokens: number }) => void;
  /** Recoverable error -- service should still be usable */
  onError: (error: Error) => void;
}

export type AIServiceStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

// --- Interface ---

export interface AIService {
  /** Open a session to the AI provider. Resolves when setup is complete. */
  connect(config: AIServiceConfig, callbacks: AIServiceCallbacks): Promise<void>;

  /** Send a JPEG video frame to the AI model */
  sendVideoFrame(jpeg: Uint8Array): void;

  /** Send raw PCM audio (16-bit LE, 16kHz, mono) to the AI model */
  sendAudio(pcm: Uint8Array): void;

  /** Send a text message to the AI model */
  sendText(text: string): void;

  /** Gracefully close the AI session */
  disconnect(): void;

  /** Update vision FPS rate limit at runtime */
  setVisionFps?(fps: number): void;

  /** Current connection status */
  readonly status: AIServiceStatus;
}

// --- Factory registry ---

type AIServiceConstructor = new () => AIService;

const providers = new Map<string, AIServiceConstructor>();

export function registerAIProvider(name: string, ctor: AIServiceConstructor): void {
  providers.set(name, ctor);
}

export function createAIService(provider: string): AIService | null {
  const ctor = providers.get(provider);
  return ctor ? new ctor() : null;
}

export function listAIProviders(): string[] {
  return [...providers.keys()];
}
