/**
 * Test helpers — frame builders for FRLY (video) and FRAU (audio) wire protocols.
 *
 * Delegates to @ebowwa/relay-protocol buildVideoFrame/buildAudioFrame which
 * produce v1 frames with 36-byte headers (version byte, payloadLength, CRC16).
 */

import { buildVideoFrame, buildAudioFrame } from "@ebowwa/relay-protocol";

// Minimal JPEG: SOI (FF D8) + APP0 marker + EOI (FF D9)
// Real enough for the recorder to store and the exporter to parse.
const MINIMAL_JPEG = new Uint8Array([
  0xFF, 0xD8, // SOI
  0xFF, 0xE0, // APP0
  0x00, 0x02, // length
  0xFF, 0xD9, // EOI
]);

export function buildFRLYFrame(opts: {
  sequence?: number;
  width?: number;
  height?: number;
  quality?: number;
  timestampMs?: number;
  jpegPayload?: Uint8Array;
}): Uint8Array {
  const {
    sequence = 0,
    width = 640,
    height = 480,
    quality = 80,
    timestampMs = Date.now(),
    jpegPayload = MINIMAL_JPEG,
  } = opts;

  return buildVideoFrame(sequence, width, height, quality, timestampMs, jpegPayload);
}

export function buildFRAUFrame(opts: {
  codecType?: number;
  sequence?: number;
  sampleRate?: number;
  channels?: number;
  bitsPerSample?: number;
  timestampMs?: number;
  pcmPayload?: Uint8Array;
}): Uint8Array {
  const {
    codecType = 0,
    sequence = 0,
    sampleRate = 48000,
    channels = 1,
    bitsPerSample = 16,
    timestampMs = Date.now(),
    pcmPayload = new Uint8Array(1024), // 512 samples * 2 bytes
  } = opts;

  return buildAudioFrame(codecType, sequence, sampleRate, channels, bitsPerSample, timestampMs, pcmPayload);
}

/** In-memory ObjectStore mock for testing */
export class MockObjectStore {
  private data = new Map<string, Buffer>();

  async put(key: string, data: Buffer | ReadableStream): Promise<void> {
    if (data instanceof ReadableStream) {
      const chunks: Uint8Array[] = [];
      const reader = data.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      const total = chunks.reduce((s, c) => s + c.length, 0);
      const combined = new Uint8Array(total);
      let offset = 0;
      for (const c of chunks) { combined.set(c, offset); offset += c.length; }
      this.data.set(key, Buffer.from(combined));
    } else {
      this.data.set(key, data);
    }
  }

  async get(key: string): Promise<Buffer | null> {
    return this.data.get(key) ?? null;
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }

  async list(prefix?: string): Promise<string[]> {
    const keys = [...this.data.keys()].sort();
    if (!prefix) return keys;
    return keys.filter(k => k.startsWith(prefix));
  }

  async exists(key: string): Promise<boolean> {
    return this.data.has(key);
  }

  async signedUrl(key: string, ttlSeconds: number): Promise<string> {
    return `memory://${key}?ttl=${ttlSeconds}`;
  }

  async head(key: string): Promise<{ size: number; lastModified: Date; metadata: Record<string, string> } | null> {
    const buf = this.data.get(key);
    if (!buf) return null;
    return { size: buf.length, lastModified: new Date(), metadata: {} };
  }
}
