/**
 * Windowed sinc resampler — replaces naive linear interpolation
 *
 * Uses a Lanczos window (a = 3) for high-quality sample rate conversion.
 * Produces significantly fewer artifacts than linear interpolation,
 * especially at non-integer resampling ratios.
 */

const SINC_WINDOW_SIZE = 3; // Lanczos a parameter

/**
 * Lanczos window function
 */
function lanczos(x: number, a: number): number {
  if (x === 0) return 1;
  if (Math.abs(x) >= a) return 0;
  const pix = Math.PI * x;
  return (a * Math.sin(pix) * Math.sin(pix / a)) / (pix * pix);
}

/**
 * Resample Int16 PCM from srcRate to dstRate using windowed sinc interpolation.
 * Returns Float32 samples normalized to [-1, 1].
 */
export function windowedSincResample(
  input: Int16Array,
  srcRate: number,
  dstRate: number,
): Float32Array {
  if (srcRate === dstRate) {
    // No resampling needed, just normalize
    const out = new Float32Array(input.length);
    for (let i = 0; i < input.length; i++) {
      out[i] = input[i] / 32768.0;
    }
    return out;
  }

  const ratio = dstRate / srcRate;
  const inLen = input.length;
  const outLen = Math.round(inLen * ratio);
  const output = new Float32Array(outLen);
  const a = SINC_WINDOW_SIZE;

  // Pre-compute normalized input as Float32
  const normalized = new Float32Array(inLen);
  for (let i = 0; i < inLen; i++) {
    normalized[i] = input[i] / 32768.0;
  }

  for (let i = 0; i < outLen; i++) {
    const srcPos = i / ratio;
    const center = Math.floor(srcPos);
    const frac = srcPos - center;

    let sum = 0;
    let weightSum = 0;

    // Sum over the Lanczos window
    const start = Math.max(0, center - a + 1);
    const end = Math.min(inLen - 1, center + a);

    for (let j = start; j <= end; j++) {
      const distance = j - srcPos;
      const weight = lanczos(distance, a);
      sum += normalized[j] * weight;
      weightSum += weight;
    }

    output[i] = weightSum !== 0 ? sum / weightSum : 0;
  }

  return output;
}
