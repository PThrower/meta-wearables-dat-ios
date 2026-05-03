/**
 * ReIDService -- abstract interface for person re-identification providers
 *
 * Provider-abstracted interface for deep appearance embedding extraction.
 * Mirrors jepa-service.ts pattern: factory registry, provider-agnostic interface.
 *
 * iOS crops person detections from the video frame, sends JPEG patches to server.
 * Server runs OSNet (or similar) on GPU and returns 512-dim embeddings.
 *
 * Initial provider: Modal (serverless GPU, OSNet-x0.5)
 * Future providers: RunPod, Baseten, on-device CoreML
 */

// --- Types ---

export interface ReIDServiceConfig {
  /** Model variant (e.g., "osnet-x05", "osnet-x025", "osnet-x10") */
  model: string;
  /** GPU type to request from provider */
  gpu: string;
  /** Embedding dimensionality (512 for OSNet) */
  embeddingDim: number;
  /** Provider-specific extra config */
  extra?: Record<string, unknown>;
}

export type ReIDServiceStatus =
  | "idle"
  | "loading-model"
  | "ready"
  | "processing"
  | "error";

export interface ReIDServiceCallbacks {
  /** Provider status change */
  onStatusChange: (status: ReIDServiceStatus) => void;
  /** Recoverable error */
  onError: (error: Error) => void;
}

// --- Interface ---

export interface ReIDService {
  /** Initialize the model and warm up. Resolves when ready. */
  connect(config: ReIDServiceConfig, callbacks: ReIDServiceCallbacks): Promise<void>;

  /** Extract embedding from a single JPEG crop. */
  extractEmbedding(crop: Buffer): Promise<number[]>;

  /** Extract embeddings from multiple JPEG crops in a batch. */
  extractBatch(crops: Buffer[]): Promise<number[][]>;

  /** Gracefully shut down. */
  disconnect(): void;

  /** Current status */
  readonly status: ReIDServiceStatus;
}

// --- Factory registry (mirrors jepa-service.ts pattern) ---

type ReIDServiceConstructor = new () => ReIDService;

const providers = new Map<string, ReIDServiceConstructor>();

export function registerReIDProvider(name: string, ctor: ReIDServiceConstructor): void {
  providers.set(name, ctor);
}

export function createReIDService(provider: string): ReIDService | null {
  const ctor = providers.get(provider);
  return ctor ? new ctor() : null;
}

export function listReIDProviders(): string[] {
  return [...providers.keys()];
}
