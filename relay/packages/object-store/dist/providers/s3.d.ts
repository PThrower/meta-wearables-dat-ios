import type { ObjectStore, ObjectMeta, StorageConfig } from "../types.js";
export declare class S3Store implements ObjectStore {
    private client;
    private bucket;
    constructor(config: StorageConfig);
    put(key: string, data: Buffer | ReadableStream, meta?: Record<string, string>): Promise<void>;
    get(key: string): Promise<Buffer | null>;
    delete(key: string): Promise<void>;
    list(prefix?: string): Promise<string[]>;
    exists(key: string): Promise<boolean>;
    signedUrl(key: string, ttlSeconds: number): Promise<string>;
    head(key: string): Promise<ObjectMeta | null>;
}
//# sourceMappingURL=s3.d.ts.map