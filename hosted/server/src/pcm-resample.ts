/**
 * PCM resampling — linear interpolation for 16-bit LE audio.
 *
 * Shared between session-recorder (real-time) and session-export (legacy fixup).
 * All incoming audio is normalized to 48kHz for uniform concatenation and export.
 */

export const TARGET_SAMPLE_RATE = 48000;

/**
 * Resample 16-bit LE PCM from fromRate to toRate via linear interpolation.
 * Passthrough when rates match. Handles 8kHz/16kHz/22050Hz/48kHz → 48kHz.
 */
export function resamplePcm(pcm: Uint8Array, fromRate: number, toRate: number): Uint8Array {
  if (fromRate === toRate || pcm.length < 4) return pcm;
  const srcSamples = pcm.length >> 1; // 2 bytes per sample
  const dstSamples = Math.round(srcSamples * toRate / fromRate);
  const out = new Uint8Array(dstSamples * 2);
  const src = new DataView(pcm.buffer, pcm.byteOffset, pcm.length);
  const dst = new DataView(out.buffer, out.byteOffset, out.length);
  for (let i = 0; i < dstSamples; i++) {
    const srcPos = i * (srcSamples - 1) / (dstSamples - 1 || 1);
    const lo = Math.floor(srcPos);
    const hi = Math.min(lo + 1, srcSamples - 1);
    const frac = srcPos - lo;
    const sLo = src.getInt16(lo * 2, true);
    const sHi = src.getInt16(hi * 2, true);
    dst.setInt16(i * 2, Math.round(sLo + (sHi - sLo) * frac), true);
  }
  return out;
}
