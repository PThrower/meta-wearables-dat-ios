/**
 * RelayPlayer — WebSocket binary frame player with canvas rendering + audio
 *
 * Migrated from relay-player.js to TypeScript with shared protocol imports.
 */

import { FRLY_MAGIC, FRAU_MAGIC, HEADER_SIZE, AUDIO_HEADER_SIZE } from "@ebowwa/relay-protocol";

export interface RelayPlayerOptions {
  canvas: HTMLCanvasElement;
  onStatus?: (status: string) => void;
  onFps?: (fps: number) => void;
  onSize?: (width: number, height: number) => void;
  onSequence?: (seq: number) => void;
  onLatency?: (ms: number) => void;
  onDropped?: (count: number) => void;
  onAudioState?: (state: string) => void;
  onAudioLevel?: (pct: number) => void;
  onConnectionState?: (state: string) => void;
  onNeedUnmute?: () => void;
}

type Callbacks = Required<RelayPlayerOptions>;

export class RelayPlayer {
  private canvas: HTMLCanvasElement | null;
  private ctx: CanvasRenderingContext2D | null;
  private cb: Callbacks;

  // Video state
  private ws: WebSocket | null = null;
  private frameCount = 0;
  private lastFpsTime: number;
  private fpsFrameCount = 0;
  private currentFps = 0;
  private droppedFrames = 0;
  private lastSequence = 0;

  // Reconnect
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private readonly RECONNECT_MAX = 15000;
  private intentionalClose = false;
  private lastUrl: string | null = null;

  // Audio
  private audioCtx: AudioContext | null = null;
  private audioChunkCount = 0;
  private audioLevel = 0;
  private audioResumed = false;
  private videoClockBase: { senderMs: number; audioCtxTime: number } | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private pendingSamples: Float32Array[] = [];

  // Ring buffer fallback
  private readonly RING_SIZE = 48000 * 2;
  private readonly RING_BUFFER = new Float32Array(48000 * 2);
  private ringWritePos = 0;
  private ringReadPos = 0;
  private ringFill = 0;
  private ringStarted = false;
  private readonly PREBUFFER_SAMPLES = 48000 * 0.06;

  // Latency tracking
  private _firstFrameLocalTime = 0;
  private _firstFrameSenderTime = 0;

  constructor(options: RelayPlayerOptions) {
    this.canvas = options.canvas;
    this.ctx = this.canvas ? this.canvas.getContext("2d") : null;
    this.cb = {
      canvas: options.canvas,
      onStatus: options.onStatus ?? (() => {}),
      onFps: options.onFps ?? (() => {}),
      onSize: options.onSize ?? (() => {}),
      onSequence: options.onSequence ?? (() => {}),
      onLatency: options.onLatency ?? (() => {}),
      onDropped: options.onDropped ?? (() => {}),
      onAudioState: options.onAudioState ?? (() => {}),
      onAudioLevel: options.onAudioLevel ?? (() => {}),
      onConnectionState: options.onConnectionState ?? (() => {}),
      onNeedUnmute: options.onNeedUnmute ?? (() => {}),
    };
    this.lastFpsTime = performance.now();
  }

  // --- Connection ---

  connect(url: string): void {
    this.lastUrl = url;
    this.intentionalClose = false;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.ws) this.ws.close();

    this.ws = new WebSocket(url);
    this.ws.binaryType = "arraybuffer";

    this.ws.onopen = () => {
      this.reconnectDelay = 1000;
      this._resetStreamState();
      this.cb.onConnectionState("connected");
      this.cb.onStatus("CONNECTED");
      // Send viewer identity with version info
      const v = (window as any).__VIEWER_VERSION;
      this.ws!.send(JSON.stringify({
        type: "hello",
        gitCommit: v?.gitCommit ?? "unknown",
        buildVersion: v?.buildVersion ?? "unknown",
      }));
    };

    this.ws.onmessage = (event) => this._handleMessage(event);

    this.ws.onclose = (event) => {
      if (event.code === 401 || event.code === 4001) {
        this.intentionalClose = true;
        this.cb.onConnectionState("error");
        this.cb.onStatus("AUTH REQUIRED");
        try { localStorage.removeItem("relay_token"); } catch {}
        return;
      }
      if (event.code === 4003) {
        this.intentionalClose = true;
        this.cb.onConnectionState("error");
        this.cb.onStatus("ACCESS DENIED");
        return;
      }
      this._resetStreamState();
      this.cb.onConnectionState("disconnected");
      this.cb.onStatus("CLOSED");
      this.cb.onAudioState("OFF");

      if (!this.intentionalClose) {
        this.cb.onConnectionState("reconnecting");
        this.cb.onStatus(`RECONN ${Math.round(this.reconnectDelay / 1000)}s`);
        this.reconnectTimer = setTimeout(() => {
          if (this.lastUrl) this.connect(this.lastUrl);
        }, this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.RECONNECT_MAX);
      }
    };

    this.ws.onerror = () => {
      this.cb.onConnectionState("error");
      this.cb.onStatus("ERROR");
    };
  }

  disconnect(): void {
    this.intentionalClose = true;
    this.lastUrl = null;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.ws) this.ws.close();
    this.ws = null;
  }

  destroy(): void {
    this.disconnect();
    this._cleanupAudio();
    this.canvas = null;
    this.ctx = null;
  }

  setQuality(preset: string): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "config", quality: preset }));
    }
  }

  resumeAudio(): void {
    if (this.audioCtx && this.audioCtx.state === "suspended") {
      this.audioCtx.resume().then(() => { this.audioResumed = true; });
    }
  }

  // --- Internal ---

  private _resetStreamState(): void {
    this.frameCount = 0;
    this.fpsFrameCount = 0;
    this.currentFps = 0;
    this.droppedFrames = 0;
    this.lastSequence = 0;
    this.audioChunkCount = 0;
    this.videoClockBase = null;
    this.ringWritePos = 0;
    this.ringReadPos = 0;
    this.ringFill = 0;
    this.ringStarted = false;
    this.audioResumed = false;
    this._firstFrameLocalTime = 0;
    this._firstFrameSenderTime = 0;
    this.cb.onAudioLevel(0);
    if (this.workletNode) {
      try { this.workletNode.port.postMessage({ type: "reset" }); } catch {}
    }
    this.pendingSamples = [];
  }

  private _cleanupAudio(): void {
    if (this.audioCtx) {
      try { this.audioCtx.close(); } catch {}
      this.audioCtx = null;
    }
    this.workletNode = null;
  }

  private _handleMessage(event: MessageEvent): void {
    if (typeof event.data === "string") return;

    const buf = new Uint8Array(event.data);
    if (buf.length < 4) return;

    const m0 = buf[0], m1 = buf[1], m2 = buf[2], m3 = buf[3];

    if (m0 === FRAU_MAGIC[0] && m1 === FRAU_MAGIC[1] && m2 === FRAU_MAGIC[2] && m3 === FRAU_MAGIC[3]) {
      this._handleAudioFrame(buf);
    } else if (m0 === FRLY_MAGIC[0] && m1 === FRLY_MAGIC[1] && m2 === FRLY_MAGIC[2] && m3 === FRLY_MAGIC[3]) {
      this._handleVideoFrame(buf);
    }
  }

  private _handleAudioFrame(buf: Uint8Array): void {
    if (buf.length < AUDIO_HEADER_SIZE) return;

    const view = new DataView(buf.buffer, buf.byteOffset);
    const sampleRate = view.getUint32(13, true);
    const channels = view.getUint16(17, true);
    const bitsPerSample = view.getUint16(19, true);
    const senderTimestampMs = Number(view.getBigUint64(21, true));

    if (bitsPerSample !== 16) return;

    const pcmBytes = buf.slice(AUDIO_HEADER_SIZE);
    const pcmInt16 = new Int16Array(pcmBytes.buffer, pcmBytes.byteOffset, pcmBytes.length / 2);

    this._playAudioChunk(pcmInt16, sampleRate, channels, senderTimestampMs);
    this.audioChunkCount++;

    this.cb.onAudioState("ON");
  }

  private _handleVideoFrame(buf: Uint8Array): void {
    if (buf.length < HEADER_SIZE) return;
    if (!this.canvas || !this.ctx) return;

    const sequence = Number(new DataView(buf.buffer, buf.byteOffset + 4, 8).getBigUint64(0, true));
    const width = new DataView(buf.buffer, buf.byteOffset + 12, 4).getUint32(0, true);
    const height = new DataView(buf.buffer, buf.byteOffset + 16, 4).getUint32(0, true);
    const timestampMs = Number(new DataView(buf.buffer, buf.byteOffset + 21, 8).getBigUint64(0, true));

    // Update video clock
    if (this.audioCtx && timestampMs > 0) {
      this.videoClockBase = {
        senderMs: timestampMs,
        audioCtxTime: this.audioCtx.currentTime,
      };
    }

    // Detect dropped frames
    if (this.lastSequence > 0 && sequence > this.lastSequence + 1) {
      this.droppedFrames += sequence - this.lastSequence - 1;
    }
    this.lastSequence = sequence;

    // JPEG payload — render to canvas
    const jpeg = buf.slice(HEADER_SIZE);
    const blob = new Blob([jpeg], { type: "image/jpeg" });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      if (!this.canvas || !this.ctx) return;
      if (this.canvas.width !== width || this.canvas.height !== height) {
        this.canvas.width = width;
        this.canvas.height = height;
      }
      this.ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
    };
    img.src = url;

    // FPS counter
    this.frameCount++;
    this.fpsFrameCount++;
    const now = performance.now();
    if (now - this.lastFpsTime >= 1000) {
      this.currentFps = Math.round(this.fpsFrameCount * 1000 / (now - this.lastFpsTime));
      this.fpsFrameCount = 0;
      this.lastFpsTime = now;
    }

    // Relative latency
    if (!this._firstFrameLocalTime) this._firstFrameLocalTime = Date.now();
    if (!this._firstFrameSenderTime) this._firstFrameSenderTime = timestampMs;
    const latency = (Date.now() - this._firstFrameLocalTime) - (timestampMs - this._firstFrameSenderTime);
    const absLatency = Math.abs(latency);

    this.cb.onFps(this.currentFps);
    this.cb.onSize(width, height);
    this.cb.onSequence(sequence);
    this.cb.onLatency(absLatency);
    this.cb.onDropped(this.droppedFrames);
  }

  // --- Audio engine ---

  private _initAudio(): void {
    if (this.audioCtx) return;
    this.audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 48000 });
    this.audioResumed = false;
    this.ringStarted = false;
    this.ringWritePos = 0;
    this.ringReadPos = 0;
    this.ringFill = 0;

    const workletUrl = new URL("./audio-worklet.ts", import.meta.url);
    this.audioCtx.audioWorklet.addModule(workletUrl).then(() => {
      if (!this.audioCtx) return;
      this.workletNode = new AudioWorkletNode(this.audioCtx, "ring-drain");
      this.workletNode.connect(this.audioCtx.destination);
      // Flush pending samples
      for (const batch of this.pendingSamples) {
        this.workletNode.port.postMessage({ type: "push", samples: batch });
      }
      this.pendingSamples = [];
    }).catch(() => {
      // Fallback to ScriptProcessorNode
      if (!this.audioCtx) return;
      const processor = this.audioCtx.createScriptProcessor(4096, 0, 1);
      processor.onaudioprocess = (e) => {
        const output = e.outputBuffer.getChannelData(0);
        const len = output.length;
        if (!this.ringStarted) {
          output.fill(0);
          if (this.ringFill >= this.PREBUFFER_SAMPLES) this.ringStarted = true;
          return;
        }
        const toRead = Math.min(len, this.ringFill);
        for (let i = 0; i < toRead; i++) {
          output[i] = this.RING_BUFFER[this.ringReadPos];
          this.ringReadPos = (this.ringReadPos + 1) % this.RING_SIZE;
        }
        this.ringFill -= toRead;
        if (toRead < len) {
          for (let i = toRead; i < len; i++) output[i] = 0;
          this.ringStarted = false;
        }
      };
      processor.connect(this.audioCtx.destination);
    });
  }

  private _ensureAudioResumed(): void {
    if (!this.audioCtx || this.audioResumed) return;
    if (this.audioCtx.state === "suspended") {
      this.cb.onNeedUnmute();
      return;
    }
    this.audioResumed = true;
  }

  private _pushAudioToRing(pcmInt16: Int16Array, sampleRate: number): void {
    const inSamples = pcmInt16.length;
    if (inSamples === 0) return;

    const targetRate = this.audioCtx!.sampleRate;
    const ratio = targetRate / sampleRate;
    const outSamples = Math.round(inSamples * ratio);
    const floatSamples = new Float32Array(outSamples);

    for (let i = 0; i < outSamples; i++) {
      const srcPos = i / ratio;
      const idx0 = Math.floor(srcPos);
      const idx1 = Math.min(idx0 + 1, inSamples - 1);
      const frac = srcPos - idx0;
      const s0 = pcmInt16[idx0] / 32768.0;
      const s1 = pcmInt16[idx1] / 32768.0;
      floatSamples[i] = s0 + (s1 - s0) * frac;
    }

    // Track peak for meter
    for (let i = 0; i < floatSamples.length; i++) {
      const abs = Math.abs(floatSamples[i]);
      if (abs > this.audioLevel) this.audioLevel = abs;
    }

    const pct = Math.min(100, Math.round(this.audioLevel * 300));
    this.cb.onAudioLevel(pct);

    // Send to AudioWorklet if ready, else fallback ring buffer
    if (this.workletNode) {
      this.workletNode.port.postMessage({ type: "push", samples: floatSamples });
    } else {
      this.pendingSamples.push(floatSamples);
      for (let i = 0; i < floatSamples.length; i++) {
        if (this.ringFill < this.RING_SIZE) {
          this.RING_BUFFER[this.ringWritePos] = floatSamples[i];
          this.ringWritePos = (this.ringWritePos + 1) % this.RING_SIZE;
          this.ringFill++;
        }
      }
    }
  }

  private _playAudioChunk(pcmInt16: Int16Array, sampleRate: number, _channels: number, senderTimestampMs: number): void {
    if (!this.audioCtx) this._initAudio();
    this._ensureAudioResumed();

    if (pcmInt16.length === 0) return;

    this.audioLevel = 0;
    this._pushAudioToRing(pcmInt16, sampleRate);

    if (this.audioCtx && senderTimestampMs > 0) {
      this.videoClockBase = {
        senderMs: senderTimestampMs,
        audioCtxTime: this.audioCtx.currentTime,
      };
    }
  }
}
