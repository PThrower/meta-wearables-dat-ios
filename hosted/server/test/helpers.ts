/**
 * Test helpers — frame builders for FRLY (video) and FRAU (audio) wire protocols.
 *
 * FRLY: [4B "FRLY"][8B seq][4B width][4B height][1B quality][8B timestamp_ms][JPEG payload]
 * FRAU: [4B "FRAU"][1B codec][8B seq][4B sampleRate][2B channels][2B bitsPerSample][8B timestamp_ms][PCM payload]
 */

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

  const headerSize = 29;
  const buf = new Uint8Array(headerSize + jpegPayload.length);
  const view = new DataView(buf.buffer);

  // Magic "FRLY"
  buf[0] = 0x46; buf[1] = 0x52; buf[2] = 0x4c; buf[3] = 0x59;

  // Sequence (8 bytes LE, offset 4)
  view.setBigUint64(4, BigInt(sequence), true);

  // Width (4 bytes LE, offset 12)
  view.setUint32(12, width, true);

  // Height (4 bytes LE, offset 16)
  view.setUint32(16, height, true);

  // Quality (1 byte, offset 20)
  buf[20] = quality;

  // Timestamp ms (8 bytes LE, offset 21)
  view.setBigUint64(21, BigInt(timestampMs), true);

  // JPEG payload after header
  buf.set(jpegPayload, headerSize);

  return buf;
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

  const headerSize = 29;
  const buf = new Uint8Array(headerSize + pcmPayload.length);
  const view = new DataView(buf.buffer);

  // Magic "FRAU"
  buf[0] = 0x46; buf[1] = 0x52; buf[2] = 0x41; buf[3] = 0x55;

  // Codec type (1 byte, offset 4)
  buf[4] = codecType;

  // Sequence (8 bytes LE, offset 5)
  view.setBigUint64(5, BigInt(sequence), true);

  // Sample rate (4 bytes LE, offset 13)
  view.setUint32(13, sampleRate, true);

  // Channels (2 bytes LE, offset 17)
  view.setUint16(17, channels, true);

  // Bits per sample (2 bytes LE, offset 19)
  view.setUint16(19, bitsPerSample, true);

  // Timestamp ms (8 bytes LE, offset 21)
  view.setBigUint64(21, BigInt(timestampMs), true);

  // PCM payload after header
  buf.set(pcmPayload, headerSize);

  return buf;
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
