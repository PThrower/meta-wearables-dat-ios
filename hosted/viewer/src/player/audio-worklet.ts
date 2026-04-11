/**
 * AudioWorklet — ring buffer drain processor
 *
 * Runs in AudioWorklet scope (separate thread).
 * Receives Float32 samples via postMessage, drains via process().
 */

declare function registerProcessor(name: string, processor: any): void;

const RING = new Float32Array(96000);
let writePos = 0, readPos = 0, fill = 0, started = false;
const PREBUFFER = 48000 * 0.06;

self.onmessage = (e: MessageEvent) => {
  if (e.data.type === "push") {
    const samples: Float32Array = e.data.samples;
    for (let i = 0; i < samples.length; i++) {
      if (fill < RING.length) {
        RING[writePos] = samples[i];
        writePos = (writePos + 1) % RING.length;
        fill++;
      }
    }
  } else if (e.data.type === "reset") {
    writePos = 0; readPos = 0; fill = 0; started = false;
  }
};

class RingDrainProcessor extends AudioWorkletProcessor {
  process(_inputs: Float32Array[][], outputs: Float32Array[][]) {
    const output = outputs[0][0];
    const len = output.length;
    if (!started) {
      output.fill(0);
      if (fill >= PREBUFFER) started = true;
      return true;
    }
    const toRead = Math.min(len, fill);
    for (let i = 0; i < toRead; i++) {
      output[i] = RING[readPos];
      readPos = (readPos + 1) % RING.length;
    }
    fill -= toRead;
    if (toRead < len) {
      for (let i = toRead; i < len; i++) output[i] = 0;
      started = false;
    }
    return true;
  }
}

registerProcessor("ring-drain", RingDrainProcessor);
