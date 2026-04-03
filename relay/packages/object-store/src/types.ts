/**
 * @ebowwa/object-store -- Provider-agnostic object storage types.
 * All methods are async, all keys are forward-slash paths.
 */

export interface ObjectStore {
  /** Write an object. Overwrites if exists. */
  put(key: string, data: Buffer | ReadableStream, meta?: Record<string, string>): Promise<void>;

  /** Read an object. Returns null if not found. */
  get(key: string): Promise<Buffer | null>;

  /** Delete an object. No-op if not found. */
  delete(key: string): Promise<void>;

  /** List keys with optional prefix filter. */
  list(prefix?: string): Promise<string[]>;

  /** Check if an object exists. */
  exists(key: string): Promise<boolean>;

  /** Generate a pre-signed URL for temporary direct access. */
  signedUrl(key: string, ttlSeconds: number): Promise<string>;

  /** Get object metadata (size, last modified, custom meta). Returns null if not found. */
  head(key: string): Promise<ObjectMeta | null>;
}

export interface ObjectMeta {
  size: number;
  lastModified: Date;
  metadata: Record<string, string>;
}

export interface StorageConfig {
  provider: "s3" | "memory";
  endpoint?: string;
  region?: string;
  bucket?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle?: boolean;
}
