import type { ObjectStore, StorageConfig } from "./types.js";
import { S3Store } from "./providers/s3.js";
import { MemoryStore } from "./providers/memory.js";

/**
 * Create an ObjectStore from environment variables.
 *
 * Env vars:
 *   OBJECT_STORE_PROVIDER  = "s3" | "memory"  (default: "memory" if no S3_ENDPOINT)
 *   S3_ENDPOINT            = provider endpoint URL
 *   S3_REGION              = region (default: "auto")
 *   S3_BUCKET              = bucket name
 *   S3_ACCESS_KEY          = access key
 *   S3_SECRET_KEY          = secret key
 *   S3_FORCE_PATH_STYLE    = "true" | "false" (default: "false")
 */
export function createObjectStore(env?: Record<string, string | undefined>): ObjectStore {
  const e = env ?? process.env;
  const provider = e.OBJECT_STORE_PROVIDER ?? "s3";

  if (provider === "memory" || !e.S3_ENDPOINT) {
    return new MemoryStore();
  }

  const config: StorageConfig = {
    provider: "s3",
    endpoint: e.S3_ENDPOINT,
    region: e.S3_REGION,
    bucket: e.S3_BUCKET,
    accessKeyId: e.S3_ACCESS_KEY,
    secretAccessKey: e.S3_SECRET_KEY,
    forcePathStyle: e.S3_FORCE_PATH_STYLE === "true",
  };

  return new S3Store(config);
}
