import type { ObjectStore } from "./types.js";
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
export declare function createObjectStore(env?: Record<string, string | undefined>): ObjectStore;
//# sourceMappingURL=client.d.ts.map