# @ebowwa/object-store -- Provider-Agnostic S3 Storage

Composable object storage abstraction for the CaringMind relay platform. One S3-compatible adapter covers Hetzner Storage Box, Cloudflare R2, Google Cloud Storage, and AWS S3. Swap providers by changing environment variables -- zero code changes.

Written 2026-04-03 as a planning document. Not yet implemented.

---

## Why Abstract

All target providers are S3-compatible:

| Provider | Endpoint | S3-Compatible | Egress Cost |
|----------|----------|--------------|-------------|
| Hetzner Storage Box | `fsn1.your-storagebox.de` | Yes | Free (internal) |
| Cloudflare R2 | `<account>.r2.cloudflarestorage.com` | Yes | $0 |
| Google Cloud Storage | `storage.googleapis.com` | Yes | Paid |
| AWS S3 | `s3.<region>.amazonaws.com` | Native | Paid |

They all use the same `@aws-sdk/client-s3` calls with different `endpoint` and `credentials`. The abstraction is not about hiding API differences -- it's about:

1. **Config-driven provider selection** -- swap by changing env vars
2. **Testability** -- in-memory provider for unit tests, no real bucket needed
3. **Decoupling** -- relay server depends on an interface, not raw S3 SDK
4. **Future providers** -- add non-S3 backends (local filesystem, FTP) without touching consumers

---

## Package Structure

```
@ebowwa/object-store
  src/
    types.ts              -- ObjectStore interface, StorageConfig type
    providers/
      s3.ts               -- S3Store: S3-compatible adapter (Hetzner, R2, GCS, AWS)
      memory.ts           -- MemoryStore: in-memory Map for dev/tests
    client.ts             -- createObjectStore(): factory from env config
    index.ts              -- Public exports
  dist/                   -- Compiled output
  package.json
  tsconfig.json
```

---

## Interface (`types.ts`)

```ts
/**
 * Provider-agnostic object storage interface.
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
  endpoint?: string;          // S3 endpoint URL
  region?: string;
  bucket?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle?: boolean;   // true for Hetzner, some S3-compatible
}
```

---

## S3 Provider (`providers/s3.ts`)

Single adapter covers all S3-compatible providers. Config-driven endpoint selection.

```ts
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand,
         ListObjectsV2Command, HeadObjectCommand, GetObjectCommandInput } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { ObjectStore, ObjectMeta, StorageConfig } from "../types.js";

export class S3Store implements ObjectStore {
  private client: S3Client;
  private bucket: string;

  constructor(config: StorageConfig) {
    this.bucket = config.bucket!;
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region ?? "auto",
      credentials: {
        accessKeyId: config.accessKeyId!,
        secretAccessKey: config.secretAccessKey!,
      },
      forcePathStyle: config.forcePathStyle ?? false,
    });
  }

  async put(key: string, data: Buffer | ReadableStream, meta?: Record<string, string>): Promise<void> {
    const body = data instanceof ReadableStream ? Buffer.from(await new Response(data).arrayBuffer()) : data;
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: body,
      Metadata: meta,
    }));
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      const resp = await this.client.send(new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }));
      if (!resp.Body) return null;
      return Buffer.from(await resp.Body.transformToByteArray());
    } catch (e: any) {
      if (e.name === "NoSuchKey" || e.$metadata?.httpStatusCode === 404) return null;
      throw e;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: key,
    }));
  }

  async list(prefix?: string): Promise<string[]> {
    const resp = await this.client.send(new ListObjectsV2Command({
      Bucket: this.bucket,
      Prefix: prefix,
    }));
    return (resp.Contents ?? []).map(obj => obj.Key!);
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }));
      return true;
    } catch {
      return false;
    }
  }

  async signedUrl(key: string, ttlSeconds: number): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
    }), { expiresIn: ttlSeconds });
  }

  async head(key: string): Promise<ObjectMeta | null> {
    try {
      const resp = await this.client.send(new HeadObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }));
      return {
        size: resp.ContentLength ?? 0,
        lastModified: resp.LastModified ?? new Date(),
        metadata: (resp.Metadata as Record<string, string>) ?? {},
      };
    } catch {
      return null;
    }
  }
}
```

---

## Memory Provider (`providers/memory.ts`)

For tests and local development. No real bucket needed.

```ts
import type { ObjectStore, ObjectMeta } from "../types.js";

export class MemoryStore implements ObjectStore {
  private store = new Map<string, { data: Buffer; meta: Record<string, string>; modified: Date }>();

  async put(key: string, data: Buffer | ReadableStream, meta?: Record<string, string>): Promise<void> {
    const buf = data instanceof ReadableStream
      ? Buffer.from(await new Response(data).arrayBuffer())
      : data;
    this.store.set(key, { data: buf, meta: meta ?? {}, modified: new Date() });
  }

  async get(key: string): Promise<Buffer | null> {
    return this.store.get(key)?.data ?? null;
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list(prefix?: string): Promise<string[]> {
    const keys = [...this.store.keys()];
    if (!prefix) return keys;
    return keys.filter(k => k.startsWith(prefix));
  }

  async exists(key: string): Promise<boolean> {
    return this.store.has(key);
  }

  async signedUrl(key: string, ttlSeconds: number): Promise<string> {
    return `memory://${key}?ttl=${ttlSeconds}`;
  }

  async head(key: string): Promise<ObjectMeta | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    return { size: entry.data.length, lastModified: entry.modified, metadata: entry.meta };
  }
}
```

---

## Factory (`client.ts`)

Reads environment and returns the right provider. Relay server calls this once at startup.

```ts
import type { ObjectStore, StorageConfig } from "./types.js";
import { S3Store } from "./providers/s3.js";
import { MemoryStore } from "./providers/memory.js";

/**
 * Create an ObjectStore from environment variables.
 *
 * Env vars:
 *   OBJECT_STORE_PROVIDER  = "s3" | "memory"  (default: "s3")
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
```

---

## Provider Configuration Examples

### Hetzner Storage Box

```env
OBJECT_STORE_PROVIDER=s3
S3_ENDPOINT=https://fsn1.your-storagebox.de
S3_REGION=fsn1
S3_BUCKET=caringmind-sessions
S3_ACCESS_KEY=<from-doppler>
S3_SECRET_KEY=<from-doppler>
S3_FORCE_PATH_STYLE=true
```

### Cloudflare R2

```env
OBJECT_STORE_PROVIDER=s3
S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
S3_REGION=auto
S3_BUCKET=caringmind-sessions
S3_ACCESS_KEY=<from-doppler>
S3_SECRET_KEY=<from-doppler>
S3_FORCE_PATH_STYLE=false
```

### Google Cloud Storage

```env
OBJECT_STORE_PROVIDER=s3
S3_ENDPOINT=https://storage.googleapis.com
S3_REGION=auto
S3_BUCKET=caringmind-sessions
S3_ACCESS_KEY=<from-doppler>
S3_SECRET_KEY=<from-doppler>
S3_FORCE_PATH_STYLE=false
```

### AWS S3

```env
OBJECT_STORE_PROVIDER=s3
S3_ENDPOINT=https://s3.us-east-1.amazonaws.com
S3_REGION=us-east-1
S3_BUCKET=caringmind-sessions
S3_ACCESS_KEY=<from-doppler>
S3_SECRET_KEY=<from-doppler>
S3_FORCE_PATH_STYLE=false
```

### Development / Testing

```env
OBJECT_STORE_PROVIDER=memory
# No other vars needed -- in-memory store
```

---

## Dependencies

```json
{
  "name": "@ebowwa/object-store",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "dependencies": {
    "@aws-sdk/client-s3": "^3.x",
    "@aws-sdk/s3-request-presigner": "^3.x"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "typescript": "^5.x"
  }
}
```

Two runtime dependencies. Both are AWS SDK v3 packages -- tree-shakeable, compatible with Bun.

---

## Usage in Relay Server

```ts
// server.ts
import { createObjectStore } from "@ebowwa/object-store";

const store = createObjectStore();

// Session recorder flushes segments to bucket
async function flushSegment(sessionId: string, segIndex: number, data: Buffer) {
  await store.put(
    `sessions/${sessionId}/video/seg-${segIndex.toString().padStart(4, "0")}.mjpeg`,
    data,
    { contentType: "video/mjpeg" }
  );
}

// Retrieve recording
async function getRecording(sessionId: string, segIndex: number): Promise<Buffer | null> {
  return store.get(`sessions/${sessionId}/video/seg-${segIndex.toString().padStart(4, "0")}.mjpeg`);
}

// List all sessions
async function listSessions(): Promise<string[]> {
  return store.list("sessions/");
}
```

---

## Usage in Tests

```ts
import { createObjectStore } from "@ebowwa/object-store";

const store = createObjectStore({ OBJECT_STORE_PROVIDER: "memory" });

await store.put("test-key", Buffer.from("hello"));
const data = await store.get("test-key");
assert(data?.toString() === "hello");
```

No mocks, no stubs, no real bucket. The `MemoryStore` is the test double.

---

## Export Structure

```ts
// index.ts
export type { ObjectStore, ObjectMeta, StorageConfig } from "./types.js";
export { S3Store } from "./providers/s3.js";
export { MemoryStore } from "./providers/memory.js";
export { createObjectStore } from "./client.js";
```

Consumers import the interface and factory:

```ts
import { type ObjectStore, createObjectStore } from "@ebowwa/object-store";
```

---

## Staleness Warning

This document was written against the codebase on `feat/telemetry-diagnostics` at commit `33ea802`. Implementation should reference:

- `docs/persistence-architecture.md` -- how the relay uses this package
- `docs/multi-session-platform.md` -- session routing that drives storage keys
- `docs/auth-google-oauth.md` -- auth gating on retrieval endpoints
