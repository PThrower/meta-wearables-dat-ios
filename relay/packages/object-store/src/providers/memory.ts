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
