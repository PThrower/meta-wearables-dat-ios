/**
 * Opus decoder for the Bun relay server
 *
 * Decodes Opus-encoded FRAU payloads back to raw PCM (Int16 LE)
 * for consumption by AI pipelines (Gemini Live, STT) and R2 session recording.
 *
 * Uses `opusscript` (pure JS Opus decoder backed by libopus compiled to JS).
 * Works in Bun without native module compilation.
 */

// opusscript decoder instances keyed by sample rate
const decoders = new Map<number, any>();

/**
 * Get or create an opusscript decoder for the given sample rate.
 */
function getDecoder(sampleRate: number, channels: number = 1): any {
    const key = sampleRate;
    if (decoders.has(key)) return decoders.get(key);

    // opusscript is a CJS module — dynamic import for ESM compat
    let OpusScript: any;
    try {
        OpusScript = require("opusscript");
    } catch {
        console.error("[opus-decode] opusscript not available — Opus decoding disabled");
        return null;
    }

    const decoder = new OpusScript(sampleRate, channels, OpusScript.Application.VOIP);
    // Enable forward error correction for better quality
    decoder.enableDTX = false;
    decoders.set(key, decoder);
    return decoder;
}

/**
 * Decode a single Opus packet to raw PCM Int16 LE.
 *
 * @param payload - Opus-encoded bytes from FRAU frame
 * @param sampleRate - Decoder sample rate (typically 16000)
 * @param channels - Number of channels (default 1)
 * @returns PCM Int16 LE as Uint8Array (ready for resampling / AI / R2)
 */
export function decodeOpusFrame(
  payload: Uint8Array,
  sampleRate: number,
  channels: number = 1,
): Uint8Array {
  if (payload.length === 0) return new Uint8Array(0);

  const decoder = getDecoder(sampleRate, channels);
  if (!decoder) return new Uint8Array(0);

  try {
    // opusscript.decode returns a Buffer of Int16 LE PCM samples
    const pcmBuffer = decoder.decode(payload);
    return new Uint8Array(pcmBuffer.buffer, pcmBuffer.byteOffset, pcmBuffer.byteLength);
  } catch (err) {
    console.error("[opus-decode] Decode failed:", (err as Error).message);
    return new Uint8Array(0);
  }
}

/**
 * Decode Opus and return as Int16Array (typed view for direct sample access).
 */
export function decodeOpusToInt16(
  payload: Uint8Array,
  sampleRate: number,
  channels: number = 1,
): Int16Array {
  const bytes = decodeOpusFrame(payload, sampleRate, channels);
  if (bytes.length === 0) return new Int16Array(0);
  return new Int16Array(bytes.buffer, bytes.byteOffset, bytes.length / 2);
}

/** Int16Array to Uint8Array (PCM bytes) */
export function int16ToBytes(samples: Int16Array): Uint8Array {
  return new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
}

/** Clean up decoder resources */
export function cleanupDecoders(): void {
  for (const [, decoder] of decoders) {
    try { decoder.delete(); } catch {}
  }
  decoders.clear();
}
