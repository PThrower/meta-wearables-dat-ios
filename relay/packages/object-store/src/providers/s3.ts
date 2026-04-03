import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
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
    const body = data instanceof ReadableStream
      ? Buffer.from(await new Response(data).arrayBuffer())
      : data;
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
