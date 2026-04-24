/**
 * JEPAService -- abstract interface for JEPA vision providers
 *
 * Provider-abstracted interface for continuous video stream understanding.
 * Plugs into the relay server's video fan-out alongside AI services.
 *
 * Initial provider: Modal (serverless GPU, V-JEPA 2 encoder)
 * Future providers: RunPod, Baseten, on-device CoreML, Hetzner GPU
 */

// --- Types ---

export interface JEPAServiceConfig {
  /** Provider-specific model ID (e.g., "vjepa2-vitl-fpc16-384") */
  model: string;
  /** Frames per clip sent to encoder (16 or 64) */
  clipLength: number;
  /** Frames per second sampled from stream */
  sampleFps: number;
  /** Resolution for encoder input (256 or 384) */
  resolution: number;
  /** Task heads to enable */
  tasks: JEPATaskConfig[];
  /** GPU type to request from provider */
  gpu: string;
  /** Provider-specific extra config */
  extra?: Record<string, unknown>;
}

export interface JEPATaskConfig {
  type: "action-classification" | "anomaly-detection" | "prediction" | "embedding-extraction";
  /** Custom labels for classification (e.g., procedure step names) */
  labels?: string[];
  /** Anomaly threshold (0-1, default 0.85) */
  threshold?: number;
}

export interface JEPAClipMetadata {
  sessionId: string;
  clipIndex: number;
  timestampMs: number;
  frameCount: number;
}

export interface JEPAction {
  label: string;
  confidence: number;
  clipIndex: number;
  timestampMs: number;
}

export interface JEPAomaly {
  score: number;
  description: string;
  clipIndex: number;
  timestampMs: number;
  embeddingBaseline: string;
}

export interface JEPAPrediction {
  predictedAction: string;
  confidence: number;
  predictedEmbedding: number[];
  clipIndex: number;
  timestampMs: number;
}

export type JEPAServiceStatus =
  | "idle"
  | "loading-model"
  | "ready"
  | "processing"
  | "error";

export interface JEPAServiceCallbacks {
  /** Embedding vector for a processed clip */
  onEmbedding: (embedding: number[], metadata: JEPAClipMetadata) => void;
  /** Action classification result */
  onAction: (action: JEPAction) => void;
  /** Anomaly detected (embedding divergence from baseline) */
  onAnomaly: (anomaly: JEPAomaly) => void;
  /** Prediction for next N frames */
  onPrediction: (prediction: JEPAPrediction) => void;
  /** Provider status */
  onStatusChange: (status: JEPAServiceStatus) => void;
  /** Recoverable error */
  onError: (error: Error) => void;
}

// --- Interface ---

export interface JEPAService {
  /** Initialize the model and warm up. Resolves when ready. */
  connect(config: JEPAServiceConfig, callbacks: JEPAServiceCallbacks): Promise<void>;

  /** Send a JPEG frame to be buffered. Encoder runs when clip buffer is full. */
  sendFrame(jpeg: Uint8Array, timestampMs: number): void;

  /** Set a baseline embedding for anomaly comparison */
  setBaseline(baselineId: string, embedding: number[]): void;

  /** Gracefully shut down. */
  disconnect(): void;

  /** Current status */
  readonly status: JEPAServiceStatus;
}

// --- Factory registry (mirrors ai-service.ts pattern) ---

type JEPAServiceConstructor = new () => JEPAService;

const providers = new Map<string, JEPAServiceConstructor>();

export function registerJEPAProvider(name: string, ctor: JEPAServiceConstructor): void {
  providers.set(name, ctor);
}

export function createJEPAService(provider: string): JEPAService | null {
  const ctor = providers.get(provider);
  return ctor ? new ctor() : null;
}

export function listJEPAProviders(): string[] {
  return [...providers.keys()];
}
