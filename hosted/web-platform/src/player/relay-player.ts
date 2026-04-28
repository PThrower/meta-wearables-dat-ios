/**
 * RelayPlayer — WebSocket binary frame player with canvas rendering + audio
 *
 * Migrated from relay-player.js to TypeScript with shared protocol imports.
 */

import { FRLY_MAGIC, FRAU_MAGIC, HEADER_SIZE, AUDIO_HEADER_SIZE, isKnownCodecSource, decodeCodecByte,
         VIDEO_CODEC_JPEG, VIDEO_CODEC_H264, H264_FLAG_KEYFRAME } from "@ebowwa/relay-protocol";
import { buildFrauFrame } from "./frau-builder.js";
import { windowedSincResample } from "./resampler.js";
import { getConfig } from "../config.js";
import JMuxer from "jmuxer";

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
  onAuthRequired?: () => void;
  onBandwidth?: (bytesPerSec: number) => void;
  onBackpressureFps?: (targetFps: number) => void;
  onAudioCodec?: (codecType: number, sampleRate: number) => void;
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
  private _lastCodecType: number | undefined;

  // AIMD backpressure state (TCP-style congestion control)
  private backpressureFps = 30;          // Current AIMD target (starts at max)
  private lastBackpressureTime = 0;      // Timestamp of last backpressure send
  private readonly AIMD_DECREASE_FACTOR = 0.5;   // Multiplicative decrease: halve on drops
  private readonly AIMD_INCREASE_FPS = 1;         // Additive increase: +1 fps per interval
  private readonly AIMD_INCREASE_INTERVAL_MS = 3000; // Probe upward every 3s
  private readonly AIMD_MIN_FPS = 1;
  private readonly AIMD_MAX_FPS = 30;

  // Sliding window bandwidth estimate
  private bwWindowBytes: number[] = [];     // bytes per 1s slot
  private bwWindowStart = 0;               // start of current slot (Date.now)
  private bwBytesInSlot = 0;               // bytes accumulated in current slot
  private bwEstimate = Infinity;           // estimated bytes/sec (smoothed)
  private readonly BW_WINDOW_SLOTS = 5;    // 5-second sliding window
  private readonly BW_LOW_THRESHOLD = 200_000;  // 200 KB/s — below this, reduce FPS

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

  // H.264 decoder — dual path: WebCodecs (Chrome/Edge) or MSE/jMuxer (Safari/Firefox)
  private videoDecoder: VideoDecoder | null = null;
  private jmuxer: JMuxer | null = null;
  private mseVideo: HTMLVideoElement | null = null;
  private mseRafId: number = 0;
  private useMSE: boolean = false;

  // H.264 debug state (drawn on canvas for live diagnostics)
  private _h264Debug = {
    framesIn: 0,
    nalsParsed: 0,
    vclNals: 0,
    spsFound: false,
    ppsFound: false,
    decoderState: "none",
    decoderPath: "",
    lastError: "",
    codecStr: "",
    avccSize: 0,
  };

  // Mic capture (push-to-talk)
  private micStream: MediaStream | null = null;
  private micContext: AudioContext | null = null;
  private micWorkletNode: AudioWorkletNode | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private micSeqNum = 0;
  private isMicActive = false;

  // Guidance panel JSON message callback
  onJsonMessage: ((msg: Record<string, unknown>) => void) | null = null;

  // Bounding box overlay
  private overlayCanvas: HTMLCanvasElement | null = null;
  private overlayCtx: CanvasRenderingContext2D | null = null;
  private latestBoundingBoxes: Array<{ y1: number; x1: number; y2: number; x2: number; label: string; confidence: number }> = [];
  private showOverlays = true;
  private bboxTimeout: ReturnType<typeof setTimeout> | null = null;
  private lastVideoWidth = 0;
  private lastVideoHeight = 0;

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
      onAuthRequired: options.onAuthRequired ?? (() => {}),
      onBandwidth: options.onBandwidth ?? (() => {}),
      onBackpressureFps: options.onBackpressureFps ?? (() => {}),
      onAudioCodec: options.onAudioCodec ?? (() => {}),
    };
    this.lastFpsTime = performance.now();

    // Init overlay canvas (sibling of liveCanvas in DOM)
    const sibling = this.canvas?.nextElementSibling;
    if (sibling instanceof HTMLCanvasElement && sibling.id === "overlayCanvas") {
      this.overlayCanvas = sibling;
      this.overlayCtx = sibling.getContext("2d");
    }
  }

  /** Update bounding boxes from a guidance.bbox event */
  setBoundingBoxes(boxes: Array<{ y1: number; x1: number; y2: number; x2: number; label: string; confidence: number }>): void {
    this.latestBoundingBoxes = boxes;
    this.drawBoundingBoxes();

    // Clear boxes after 2x the analysis interval if no new bbox event arrives
    if (this.bboxTimeout) clearTimeout(this.bboxTimeout);
    this.bboxTimeout = setTimeout(() => {
      this.latestBoundingBoxes = [];
      this.drawBoundingBoxes();
    }, 10_000);
  }

  /** Toggle overlay visibility */
  setShowOverlays(show: boolean): void {
    this.showOverlays = show;
    this.drawBoundingBoxes();
  }

  /** Draw current bounding boxes on the overlay canvas */
  private drawBoundingBoxes(): void {
    if (!this.overlayCanvas || !this.overlayCtx) return;

    const ctx = this.overlayCtx;
    const w = this.lastVideoWidth || this.overlayCanvas.width;
    const h = this.lastVideoHeight || this.overlayCanvas.height;

    if (this.overlayCanvas.width !== w || this.overlayCanvas.height !== h) {
      this.overlayCanvas.width = w;
      this.overlayCanvas.height = h;
    }

    ctx.clearRect(0, 0, w, h);

    if (!this.showOverlays || this.latestBoundingBoxes.length === 0) return;

    // Color palette for different labels
    const colors = ["#4ade80", "#60a5fa", "#facc15", "#f87171", "#a78bfa", "#fb923c", "#2dd4bf", "#e879f9"];

    for (let i = 0; i < this.latestBoundingBoxes.length; i++) {
      const box = this.latestBoundingBoxes[i];
      // Convert from 1024-normalized to pixel coordinates
      const px = (box.x1 / 1024) * w;
      const py = (box.y1 / 1024) * h;
      const pw = ((box.x2 - box.x1) / 1024) * w;
      const ph = ((box.y2 - box.y1) / 1024) * h;

      const color = colors[i % colors.length];

      // Draw box
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.strokeRect(px, py, pw, ph);

      // Draw label above box
      const label = `${box.label} ${Math.round(box.confidence * 100)}%`;
      ctx.font = "bold 11px 'SF Mono', monospace";
      const textWidth = ctx.measureText(label).width;
      ctx.fillStyle = color;
      ctx.fillRect(px, py - 16, textWidth + 8, 16);
      ctx.fillStyle = "#000";
      ctx.fillText(label, px + 4, py - 4);
    }
  }

  // --- Connection ---

  private _pendingShareToken: string | null = null;
  private _authToken: string | null = null;

  connect(url: string, shareToken?: string, authToken?: string): void {
    this.lastUrl = url;
    this._pendingShareToken = shareToken ?? null;
    this._authToken = authToken ?? null;
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
      // Send viewer identity with version info and auth token
      let v = { gitCommit: "unknown", buildVersion: "unknown" };
      try { v = getConfig().version; } catch {}
      const token = this._authToken || localStorage.getItem("relay_token") || "";
      this.ws!.send(JSON.stringify({ type: "hello", token, ...v }));
    };

    this.ws.onmessage = (event) => this._handleMessage(event);

    this.ws.onclose = (event) => {
      if (event.code === 401 || event.code === 4001) {
        this.intentionalClose = true;
        this.cb.onConnectionState("error");
        this.cb.onStatus("AUTH REQUIRED");
        try { localStorage.removeItem("relay_token"); } catch {}
        this.cb.onAuthRequired();
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
          if (this.lastUrl) {
            // Re-read token from localStorage on reconnect (may have been refreshed)
            const freshToken = localStorage.getItem("relay_token") || undefined;
            this.connect(this.lastUrl, this._pendingShareToken ?? undefined, freshToken);
          }
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
    this.stopMic();
    this._cleanupAudio();
    this._destroyH264Decoder();
    this.canvas = null;
    this.ctx = null;
  }

  /** Tear down both WebCodecs and MSE/jMuxer decoders. */
  private _destroyH264Decoder(): void {
    if (this.videoDecoder && this.videoDecoder.state !== "closed") {
      this.videoDecoder.close();
    }
    this.videoDecoder = null;
    this._destroyMSE();
  }

  /** Tear down MSE/jMuxer resources. */
  private _destroyMSE(): void {
    if (this.mseRafId) { cancelAnimationFrame(this.mseRafId); this.mseRafId = 0; }
    if (this.jmuxer) { try { this.jmuxer.destroy(); } catch {} this.jmuxer = null; }
    if (this.mseVideo) { this.mseVideo.pause(); this.mseVideo.removeAttribute('src'); this.mseVideo.load(); this.mseVideo.remove(); this.mseVideo = null; }
    this.useMSE = false;
    this._mseReady = false;
    this._msePendingFrames = [];
    this._h264Debug = {
      framesIn: 0, nalsParsed: 0, vclNals: 0,
      spsFound: false, ppsFound: false,
      decoderState: "none", decoderPath: "",
      lastError: "", codecStr: "", avccSize: 0,
    };
  }

  /** Reset the H.264 decoder (call on codec switch to flush stale state). */
  resetVideoDecoder(): void {
    this._destroyH264Decoder();
  }

  setQuality(preset: string): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "config", quality: preset }));
    }
  }

  /** Send backpressure hint to the server (AIMD target). */
  sendBackpressure(targetFps: number): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "backpressure", targetFps }));
      this.lastBackpressureTime = Date.now();
    }
  }

  resumeAudio(): void {
    if (this.audioCtx && this.audioCtx.state === "suspended") {
      this.audioCtx.resume().then(() => { this.audioResumed = true; });
    }
  }

  /** Send a JSON message to the server via the active WebSocket. */
  sendJson(msg: object): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  // --- Mic capture (push-to-talk) ---

  async startMic(): Promise<void> {
    if (this.isMicActive) return;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    try {
      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 16000,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (err) {
      console.warn("[RelayPlayer] Mic permission denied or unavailable:", err);
      return;
    }

    // Create an AudioContext — browsers typically run at 48kHz regardless of
    // the requested sampleRate in getUserMedia, so we resample in the worklet.
    this.micContext = new AudioContext({ sampleRate: 48000 });

    // Register worklet from inline source (avoids needing a separate static file)
    const workletSource = `
      class MicCaptureProcessor extends AudioWorkletProcessor {
        process(inputs) {
          const input = inputs[0];
          if (!input || input.length === 0) return true;
          const ch0 = input[0];
          if (ch0.length === 0) return true;
          // Transfer ownership of the Float32Array buffer to main thread
          this.port.postMessage(ch0.buffer, [ch0.buffer]);
          return true;
        }
      }
      registerProcessor("mic-capture", MicCaptureProcessor);
    `;
    const blob = new Blob([workletSource], { type: "application/javascript" });
    const workletUrl = URL.createObjectURL(blob);

    try {
      await this.micContext.audioWorklet.addModule(workletUrl);
    } catch (err) {
      console.warn("[RelayPlayer] AudioWorklet failed to load:", err);
      URL.revokeObjectURL(workletUrl);
      return;
    }
    URL.revokeObjectURL(workletUrl);

    const source = this.micContext.createMediaStreamSource(this.micStream);
    this.micSource = source;

    const workletNode = new AudioWorkletNode(this.micContext, "mic-capture");
    this.micWorkletNode = workletNode;

    const self = this;

    workletNode.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      if (!self.isMicActive || !self.ws || self.ws.readyState !== WebSocket.OPEN) return;

      const input = new Float32Array(event.data);
      const srcSampleRate = self.micContext!.sampleRate;
      const targetSampleRate = 16000;
      const ratio = srcSampleRate / targetSampleRate;

      // Convert Float32 -> Int16 with clamping + decimate
      const outLength = Math.floor(input.length / ratio);
      const pcmInt16 = new Int16Array(outLength);

      for (let i = 0; i < outLength; i++) {
        const srcIdx = Math.floor(i * ratio);
        let sample = input[srcIdx];
        if (sample > 1) sample = 1;
        else if (sample < -1) sample = -1;
        pcmInt16[i] = sample * 0x7FFF;
      }

      // Build FRAU frame: codecType=3 (relay inbound), 16kHz, mono, 16-bit
      const frame = buildFrauFrame(3, self.micSeqNum++, 16000, 1, 16, pcmInt16);

      try {
        self.ws.send(frame);
      } catch (err) {
        console.warn("[RelayPlayer] Failed to send mic frame:", err);
      }
    };

    source.connect(workletNode);
    workletNode.connect(this.micContext.destination);

    this.isMicActive = true;
  }

  stopMic(): void {
    if (!this.isMicActive) return;

    this.isMicActive = false;

    if (this.micWorkletNode) {
      this.micWorkletNode.port.onmessage = null;
      this.micWorkletNode.disconnect();
      this.micWorkletNode = null;
    }

    if (this.micSource) {
      this.micSource.disconnect();
      this.micSource = null;
    }

    if (this.micStream) {
      for (const track of this.micStream.getTracks()) {
        track.stop();
      }
      this.micStream = null;
    }

    if (this.micContext) {
      try { this.micContext.close(); } catch {}
      this.micContext = null;
    }
  }

  // --- Internal ---

  private _resetStreamState(): void {
    this.frameCount = 0;
    this.fpsFrameCount = 0;
    this.currentFps = 0;
    this.droppedFrames = 0;
    this.lastSequence = 0;
    this._lastCodecType = undefined;
    this.backpressureFps = this.AIMD_MAX_FPS;
    this.lastBackpressureTime = 0;
    this.bwWindowBytes = [];
    this.bwWindowStart = 0;
    this.bwBytesInSlot = 0;
    this.bwEstimate = Infinity;
    this.audioChunkCount = 0;
    this.videoClockBase = null;
    this.ringWritePos = 0;
    this.ringReadPos = 0;
    this.ringFill = 0;
    this.ringStarted = false;
    this.audioResumed = false;
    this._firstFrameLocalTime = 0;
    this._firstFrameSenderTime = 0;
    this.latestBoundingBoxes = [];
    this.lastVideoWidth = 0;
    this.lastVideoHeight = 0;
    this._h264ParameterSets = [];
    this._destroyH264Decoder();
    if (this.overlayCtx && this.overlayCanvas) {
      this.overlayCtx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
    }
    this.cb.onAudioLevel(0);
    if (this.workletNode) {
      try { this.workletNode.port.postMessage({ type: "reset" }); } catch {}
    }
    this.pendingSamples = [];
  }

  /** Track bytes received in 1-second slots for sliding window bandwidth estimate */
  private _trackBandwidth(bytes: number): void {
    const now = Date.now();
    // Initialize window start on first frame
    if (this.bwWindowStart === 0) {
      this.bwWindowStart = now;
      this.bwBytesInSlot = 0;
    }
    // Roll over completed 1-second slots
    const elapsed = now - this.bwWindowStart;
    if (elapsed >= 1000) {
      const completedSlots = Math.floor(elapsed / 1000);
      this.bwWindowBytes.push(this.bwBytesInSlot);
      // Keep only the last N slots
      while (this.bwWindowBytes.length > this.BW_WINDOW_SLOTS) {
        this.bwWindowBytes.shift();
      }
      // Zero-fill any gaps (connection was idle)
      for (let i = 1; i < completedSlots; i++) {
        this.bwWindowBytes.push(0);
        if (this.bwWindowBytes.length > this.BW_WINDOW_SLOTS) {
          this.bwWindowBytes.shift();
        }
      }
      this.bwBytesInSlot = 0;
      this.bwWindowStart = now - (elapsed % 1000);
      // Update smoothed estimate
      if (this.bwWindowBytes.length > 0) {
        const sum = this.bwWindowBytes.reduce((a, b) => a + b, 0);
        this.bwEstimate = sum / this.bwWindowBytes.length;
        if (this.bwEstimate < Infinity) {
          this.cb.onBandwidth(this.bwEstimate);
        }
      }
    }
    this.bwBytesInSlot += bytes;
  }

  private _cleanupAudio(): void {
    if (this.audioCtx) {
      try { this.audioCtx.close(); } catch {}
      this.audioCtx = null;
    }
    this.workletNode = null;
  }

  private _handleMessage(event: MessageEvent): void {
    if (typeof event.data === "string") {
      try {
        const msg = JSON.parse(event.data) as Record<string, unknown>;
        if (this.onJsonMessage) this.onJsonMessage(msg);
      } catch {
        // Non-JSON string — ignore
      }
      return;
    }

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

    // v1 FRAU header fields (36 bytes total)
    // byte[9]: top bit = encoding (Opus), bottom 7 bits = source (0-3)
    const codecByte = view.getUint8(9);
    const { source: codecType, isOpus } = decodeCodecByte(codecByte);
    if (!isKnownCodecSource(codecType)) return;

    // Skip Opus-encoded frames (viewer doesn't decode Opus yet)
    if (isOpus) return;

    const payloadLength = view.getUint32(5, true);
    const sampleRate = view.getUint32(18, true);
    const channels = view.getUint16(22, true);
    const bitsPerSample = view.getUint16(24, true);
    const senderTimestampMs = Number(view.getBigUint64(26, true));

    if (bitsPerSample !== 16) return;

    // Validate payload length against actual buffer
    const actualPayload = buf.length - AUDIO_HEADER_SIZE;
    if (payloadLength > actualPayload) return;

    const pcmBytes = buf.slice(AUDIO_HEADER_SIZE, AUDIO_HEADER_SIZE + payloadLength);
    const pcmInt16 = new Int16Array(pcmBytes.buffer, pcmBytes.byteOffset, pcmBytes.length / 2);

    this._playAudioChunk(pcmInt16, sampleRate, channels, senderTimestampMs);
    this.audioChunkCount++;

    this.cb.onAudioState("ON");
    this.cb.onAudioCodec(codecType, sampleRate);
  }

  private _handleVideoFrame(buf: Uint8Array): void {
    if (buf.length < HEADER_SIZE) return;
    if (!this.canvas || !this.ctx) return;

    const view = new DataView(buf.buffer, buf.byteOffset);

    // v1 FRLY header fields (36 bytes total)
    const payloadLength = view.getUint32(5, true);
    const sequence = Number(view.getBigUint64(9, true));
    const width = view.getUint32(17, true);
    const height = view.getUint32(21, true);
    const codecFlags = buf[25];
    const codecType = (codecFlags >> 4) & 0x0F;
    const flags = codecFlags & 0x0F;
    const timestampMs = Number(view.getBigUint64(26, true));

    // Reset sequence tracking on codec switch to prevent false gap detection
    if (this._lastCodecType !== undefined && this._lastCodecType !== codecType) {
      this.lastSequence = 0;
    }
    this._lastCodecType = codecType;

    // Validate payload length against actual buffer
    const actualPayload = buf.length - HEADER_SIZE;
    if (payloadLength > actualPayload) return;

    // Sliding window bandwidth estimate: accumulate bytes in 1s slots
    this._trackBandwidth(buf.length);

    // Update video clock
    if (this.audioCtx && timestampMs > 0) {
      this.videoClockBase = {
        senderMs: timestampMs,
        audioCtxTime: this.audioCtx.currentTime,
      };
    }

    // Detect dropped frames — AIMD multiplicative decrease on drops
    if (this.lastSequence > 0 && sequence > this.lastSequence + 1) {
      const dropped = sequence - this.lastSequence - 1;
      this.droppedFrames += dropped;
      this.cb.onDropped(this.droppedFrames);

      // Multiplicative decrease: halve the target FPS on frame drops
      const prevBp = this.backpressureFps;
      this.backpressureFps = Math.max(
        this.AIMD_MIN_FPS,
        Math.floor(this.backpressureFps * this.AIMD_DECREASE_FACTOR)
      );
      if (this.backpressureFps < prevBp) {
        this.sendBackpressure(this.backpressureFps);
        this.cb.onBackpressureFps(this.backpressureFps);
      }
    }

    // AIMD additive increase: probe upward when no drops for a while AND bandwidth is healthy
    const nowMs = Date.now();
    const bandwidthOk = this.bwEstimate >= this.BW_LOW_THRESHOLD;
    if (nowMs - this.lastBackpressureTime > this.AIMD_INCREASE_INTERVAL_MS
        && this.backpressureFps < this.AIMD_MAX_FPS
        && bandwidthOk) {
      this.backpressureFps = Math.min(this.AIMD_MAX_FPS, this.backpressureFps + this.AIMD_INCREASE_FPS);
      this.sendBackpressure(this.backpressureFps);
      this.cb.onBackpressureFps(this.backpressureFps);
    }

    // Bandwidth-aware backpressure: only engage after enough samples to be reliable
    if (!bandwidthOk && this.bwEstimate < Infinity && this.frameCount >= 15
        && nowMs - this.lastBackpressureTime > this.AIMD_INCREASE_INTERVAL_MS) {
      const bwFps = Math.max(this.AIMD_MIN_FPS,
        Math.floor(this.bwEstimate / 20_000));  // ~20KB per frame at 30fps
      if (bwFps < this.backpressureFps) {
        this.backpressureFps = bwFps;
        this.sendBackpressure(this.backpressureFps);
        this.cb.onBackpressureFps(this.backpressureFps);
      }
    }
    this.lastSequence = sequence;

    // Codec-aware rendering
    const payload = buf.slice(HEADER_SIZE);

    if (codecType === VIDEO_CODEC_H264) {
      // H.264: dual decoder path — WebCodecs (Chrome/Edge) or MSE/jMuxer (Safari/Firefox)
      this._h264Debug.framesIn++;
      const hasWebCodecs = typeof VideoDecoder !== "undefined";

      if (!hasWebCodecs && !this.useMSE) {
        // Initialize MSE/jMuxer fallback on first H.264 frame (no WebCodecs)
        this._initMSEDecoder(width, height);
      }

      if (this.useMSE) {
        // MSE path: feed raw Annex B NALs to jMuxer
        this._h264Debug.decoderPath = "MSE";
        this._feedMSE(payload, flags);
      } else if (hasWebCodecs) {
        // WebCodecs path: Annex B → AVCC → VideoDecoder
        this._h264Debug.decoderPath = "WebCodecs";
        this._renderH264Frame(payload, width, height, flags, timestampMs);
      }

      // Debug overlay disabled — was painting over video every frame
    } else {
      // JPEG (default): render via Blob -> Image -> Canvas
      this._renderJPEGFrame(payload, width, height);
    }

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

  // --- H.264 rendering (WebCodecs) ---

  // Stored SPS/PPS parameter sets extracted from keyframes, used to build
  // the avcC description for VideoDecoder.configure().
  private _h264ParameterSets: Uint8Array[] = [];

  /** Parse Annex B NAL units from a buffer. Returns array of {type, data} slices. */
  private _parseAnnexBNals(payload: Uint8Array): { type: number; data: Uint8Array }[] {
    const nals: { type: number; data: Uint8Array }[] = [];
    let start = 0;
    const len = payload.length;

    while (start < len) {
      // Find next start code (00 00 00 01 or 00 00 01)
      let scLen = 0;
      let found = -1;
      for (let i = start; i < len - 2; i++) {
        if (payload[i] === 0 && payload[i + 1] === 0) {
          if (payload[i + 2] === 1) { found = i; scLen = 3; break; }
          if (i + 3 < len && payload[i + 2] === 0 && payload[i + 3] === 1) { found = i; scLen = 4; break; }
        }
      }
      if (found === -1) break;

      const nalStart = found + scLen;
      // Find next start code to determine NAL end
      let nalEnd = len;
      for (let i = nalStart + 1; i < len - 2; i++) {
        if (payload[i] === 0 && payload[i + 1] === 0) {
          if (payload[i + 2] === 1) { nalEnd = i; break; }
          if (i + 3 < len && payload[i + 2] === 0 && payload[i + 3] === 1) { nalEnd = i; break; }
        }
      }

      if (nalStart < nalEnd) {
        const nalType = payload[nalStart] & 0x1F;
        nals.push({ type: nalType, data: payload.slice(nalStart, nalEnd) });
      }
      start = nalEnd;
    }
    return nals;
  }

  /** Build an avcC box from extracted SPS/PPS parameter sets for VideoDecoder config. */
  private _buildAvcC(spsList: Uint8Array[], ppsList: Uint8Array[]): Uint8Array {
    // avcC layout:
    // [0] version=1, [1] profile, [2] compat, [3] level,
    // [4] 0xFF + lengthSizeMinusOne(2 bits) = 0xFF (4-byte NAL length),
    // [5] 0xE0 + numSPS, then each SPS as (2-byte len + data),
    // then numPPS, then each PPS as (2-byte len + data)
    const parts: Uint8Array[] = [];
    parts.push(new Uint8Array([1, spsList[0][1], spsList[0][2], spsList[0][3], 0xFF, 0xE0 | spsList.length]));
    for (const sps of spsList) {
      const len = new Uint8Array([(sps.length >> 8) & 0xFF, sps.length & 0xFF]);
      parts.push(len, sps);
    }
    parts.push(new Uint8Array([ppsList.length]));
    for (const pps of ppsList) {
      const len = new Uint8Array([(pps.length >> 8) & 0xFF, pps.length & 0xFF]);
      parts.push(len, pps);
    }
    const total = parts.reduce((s, p) => s + p.length, 0);
    const result = new Uint8Array(total);
    let offset = 0;
    for (const p of parts) { result.set(p, offset); offset += p.length; }
    return result;
  }

  /** Convert Annex B NAL units to AVCC format (4-byte big-endian length prefix). */
  private _annexBToAvcc(nals: Uint8Array[]): Uint8Array {
    let totalLen = 0;
    for (const nal of nals) totalLen += 4 + nal.length;
    const result = new Uint8Array(totalLen);
    let offset = 0;
    for (const nal of nals) {
      result[offset++] = (nal.length >> 24) & 0xFF;
      result[offset++] = (nal.length >> 16) & 0xFF;
      result[offset++] = (nal.length >> 8) & 0xFF;
      result[offset++] = nal.length & 0xFF;
      result.set(nal, offset);
      offset += nal.length;
    }
    return result;
  }

  // --- MSE/jMuxer H.264 Decoder (Safari/Firefox fallback) ---

  /** Initialize jMuxer with a hidden <video> element and canvas draw loop. */
  private _initMSEDecoder(width: number, height: number): void {
    this._destroyMSE();
    this.useMSE = true;

    // Create hidden <video> for MSE
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    video.style.display = "none";
    document.body.appendChild(video);
    this.mseVideo = video;

    try {
      this.jmuxer = new JMuxer({
        node: video,
        mode: "video",
        flushingTime: 50,
        fps: 15,
        debug: false,
        onReady: () => {
          console.log("[RelayPlayer] JMuxer MSE ready");
          this._mseReady = true;
          video.play().catch(() => {});
          this._startMSEDrawLoop();
        },
        onError: (e: unknown) => {
          console.error("[RelayPlayer] JMuxer error:", e);
        },
      });
      console.log("[RelayPlayer] Using MSE/jMuxer H.264 decoder (WebCodecs unavailable)");
    } catch (e) {
      console.error("[RelayPlayer] JMuxer init failed:", e);
      this._destroyMSE();
    }
  }

  /** Buffer for frames that arrive before MSE is ready. */
  private _mseReady = false;
  private _msePendingFrames: Uint8Array[] = [];

  /** Feed raw Annex B H.264 payload to jMuxer. */
  private _feedMSE(payload: Uint8Array, flags: number): void {
    if (!this.jmuxer) return;
    if (!this._mseReady) {
      // Buffer up to 5 frames while waiting for MSE to open
      if (this._msePendingFrames.length < 5) {
        this._msePendingFrames.push(new Uint8Array(payload));
      }
      return;
    }
    // Flush any buffered frames first
    while (this._msePendingFrames.length > 0) {
      const buffered = this._msePendingFrames.shift()!;
      this.jmuxer.feed({ video: buffered });
    }
    this.jmuxer.feed({ video: new Uint8Array(payload) });
  }

  /** requestAnimationFrame loop: draw MSE video frames to canvas for overlay support. */
  private _startMSEDrawLoop(): void {
    const draw = () => {
      this.mseRafId = requestAnimationFrame(draw);
      if (!this.mseVideo || !this.ctx || !this.canvas) return;
      if (this.mseVideo.readyState < 2) return; // HAVE_CURRENT_DATA

      const vw = this.mseVideo.videoWidth;
      const vh = this.mseVideo.videoHeight;
      if (vw === 0 || vh === 0) return;

      if (this.canvas.width !== vw || this.canvas.height !== vh) {
        this.canvas.width = vw;
        this.canvas.height = vh;
      }
      this.ctx.drawImage(this.mseVideo, 0, 0);
      this.lastVideoWidth = vw;
      this.lastVideoHeight = vh;
      this.drawBoundingBoxes();
    };
    this.mseRafId = requestAnimationFrame(draw);
  }

  // --- WebCodecs H.264 Decoder (Chrome/Edge) ---

  private _renderH264Frame(nalPayload: Uint8Array, width: number, height: number, flags: number, timestampMs: number): void {
    const isKeyframe = (flags & H264_FLAG_KEYFRAME) !== 0;
    const d = this._h264Debug;

    // Parse all NAL units from Annex B payload
    const nals = this._parseAnnexBNals(nalPayload);
    d.nalsParsed = nals.length;
    if (nals.length === 0) {
      d.lastError = `no NALs from ${nalPayload.length}B flags=${flags}`;
      return;
    }

    // Extract SPS (type 7) and PPS (type 8) from keyframes
    const spsNals = nals.filter(n => n.type === 7).map(n => n.data);
    const ppsNals = nals.filter(n => n.type === 8).map(n => n.data);
    d.spsFound = spsNals.length > 0;
    d.ppsFound = ppsNals.length > 0;
    const hasNewParams = spsNals.length > 0 && ppsNals.length > 0;

    if (hasNewParams) {
      const prevParams = this._h264ParameterSets;
      this._h264ParameterSets = [...spsNals, ...ppsNals];

      // If decoder exists and SPS changed, reconfigure (handles resolution changes)
      if (this.videoDecoder && this.videoDecoder.state === "configured") {
        const currentSps = spsNals[0];
        const prevSps = prevParams.length > 0 ? prevParams[0] : null;
        const spsChanged = !prevSps || prevSps.length !== currentSps.length
          || !prevSps.every((b, i) => b === currentSps[i]);
        if (spsChanged) {
          const ppsForConfig = this._h264ParameterSets.filter((_, i) => {
            const nalType = this._h264ParameterSets[i][0] & 0x1F;
            return nalType === 8;
          });
          const newAvcC = this._buildAvcC(spsNals, ppsForConfig);
          const profile = currentSps.length > 1 ? currentSps[1] : 0x42;
          const compat = currentSps.length > 2 ? currentSps[2] : 0x00;
          const level = currentSps.length > 3 ? currentSps[3] : 0x1E;
          const codecStr = `avc1.${profile.toString(16).padStart(2, "0")}${compat.toString(16).padStart(2, "0")}${level.toString(16).padStart(2, "0")}`;
          try {
            this.videoDecoder.configure({
              codec: codecStr,
              optimizeForLatency: true,
              description: newAvcC,
            });
            d.codecStr = codecStr;
          } catch (e) {
            console.warn("[RelayPlayer] Decoder reconfigure failed, resetting:", e);
            this.videoDecoder.close();
            this.videoDecoder = null;
          }
        }
      }
    }

    // Strip SPS/PPS from NALs — only pass VCL (slice) NALs to decoder
    const vclNals = nals.filter(n => n.type !== 7 && n.type !== 8).map(n => n.data);
    d.vclNals = vclNals.length;
    if (vclNals.length === 0) {
      d.lastError = "no VCL NALs";
      return;
    }

    // Convert to AVCC format (4-byte length-prefixed)
    const avccData = this._annexBToAvcc(vclNals);

    // Initialize or reconfigure decoder
    if (!this.videoDecoder || this.videoDecoder.state === "closed") {
      if (typeof VideoDecoder === "undefined") {
        d.lastError = "VideoDecoder undefined";
        return;
      }

      // Need SPS/PPS before we can configure
      if (this._h264ParameterSets.length === 0) {
        d.lastError = "no SPS/PPS yet";
        return;
      }

      const currentSps = this._h264ParameterSets.filter((_, i) => {
        const nalType = this._h264ParameterSets[i][0] & 0x1F;
        return nalType === 7;
      });
      const currentPps = this._h264ParameterSets.filter((_, i) => {
        const nalType = this._h264ParameterSets[i][0] & 0x1F;
        return nalType === 8;
      });

      if (currentSps.length === 0 || currentPps.length === 0) {
        d.lastError = "SPS/PPS filter empty";
        return;
      }

      const avcC = this._buildAvcC(currentSps, currentPps);
      d.avccSize = avcC.length;

      // Derive codec string from SPS: profile_idc at byte[1], level_idc at byte[3]
      const profile = currentSps[0].length > 1 ? currentSps[0][1] : 0x42;
      const compat = currentSps[0].length > 2 ? currentSps[0][2] : 0x00;
      const level = currentSps[0].length > 3 ? currentSps[0][3] : 0x1E;
      const codecStr = `avc1.${profile.toString(16).padStart(2, "0")}${compat.toString(16).padStart(2, "0")}${level.toString(16).padStart(2, "0")}`;
      d.codecStr = codecStr;

      try {
        this.videoDecoder = new VideoDecoder({
          output: (frame) => {
            if (!this.canvas || !this.ctx) { frame.close(); return; }
            if (this.canvas.width !== frame.displayWidth || this.canvas.height !== frame.displayHeight) {
              this.canvas.width = frame.displayWidth;
              this.canvas.height = frame.displayHeight;
            }
            this.ctx.drawImage(frame, 0, 0);
            frame.close();
            this.lastVideoWidth = frame.displayWidth;
            this.lastVideoHeight = frame.displayHeight;
            this.drawBoundingBoxes();
          },
          error: (e) => {
            d.lastError = String(e);
            console.error("[RelayPlayer] VideoDecoder error:", e);
          },
        });

        this.videoDecoder.configure({
          codec: codecStr,
          optimizeForLatency: true,
          description: avcC,
        });
        d.decoderState = this.videoDecoder.state;
        console.log("[RelayPlayer] VideoDecoder configured:", codecStr, "avcC:", avcC.length, "bytes");
      } catch (e) {
        d.lastError = `init: ${e}`;
        console.error("[RelayPlayer] VideoDecoder init failed:", e);
        return;
      }
    }

    d.decoderState = this.videoDecoder?.state ?? "?";

    // If decoder is backed up (queue > 3), skip non-keyframes to reduce latency
    if (this.videoDecoder.decodeQueueSize > 3 && !isKeyframe) {
      return;
    }

    const chunk = new EncodedVideoChunk({
      type: isKeyframe ? "key" : "delta",
      timestamp: timestampMs * 1000, // microseconds
      data: avccData,
    });

    this.videoDecoder.decode(chunk);
  }

  /** Draw H.264 debug info overlay on canvas (visible diagnostics). */
  private _drawH264Debug(): void {
    if (!this.ctx || !this.canvas) return;
    const d = this._h264Debug;
    const lines = [
      `H.264 ${d.decoderPath}`,
      `frames: ${d.framesIn}`,
      `NALs: ${d.nalsParsed}  VCL: ${d.vclNals}`,
      `SPS: ${d.spsFound}  PPS: ${d.ppsFound}`,
      `decoder: ${d.decoderState}`,
      `codec: ${d.codecStr || "--"}`,
      `avcC: ${d.avccSize || 0}B`,
    ];
    if (d.lastError) lines.push(`ERR: ${d.lastError}`);

    const x = 8, lineH = 14, pad = 4;
    const boxH = lines.length * lineH + pad * 2;
    const boxW = 200;
    const ctx = this.ctx!;
    const canvas = this.canvas!;
    ctx.fillStyle = "rgba(0,0,0,0.75)";
    ctx.fillRect(x, canvas.height - boxH - 8, boxW, boxH);
    ctx.fillStyle = "#0f0";
    ctx.font = "11px monospace";
    ctx.textAlign = "left";
    lines.forEach((line, i) => {
      ctx.fillStyle = line.startsWith("ERR") ? "#f55" : "#0f0";
      ctx.fillText(line, x + pad, canvas.height - boxH - 8 + pad + lineH * (i + 1) - 3);
    });
  }

  // --- JPEG rendering (legacy) ---

  private _renderJPEGFrame(jpegPayload: Uint8Array, width: number, height: number): void {
    const blob = new Blob([new Uint8Array(jpegPayload)], { type: "image/jpeg" });
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
      this.lastVideoWidth = width;
      this.lastVideoHeight = height;
      this.drawBoundingBoxes();
    };
    img.src = url;
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

  private _pushAudioToRing(pcmInt16: Int16Array, sampleRate: number, channels: number): void {
    const inSamples = pcmInt16.length;
    if (inSamples === 0) return;

    // Downmix multi-channel to mono if needed
    let monoSamples: Int16Array;
    if (channels > 1) {
      const frames = Math.floor(inSamples / channels);
      monoSamples = new Int16Array(frames);
      for (let i = 0; i < frames; i++) {
        let sum = 0;
        for (let ch = 0; ch < channels; ch++) {
          sum += pcmInt16[i * channels + ch];
        }
        monoSamples[i] = Math.round(sum / channels);
      }
    } else {
      monoSamples = pcmInt16;
    }

    const targetRate = this.audioCtx!.sampleRate;
    const floatSamples = windowedSincResample(monoSamples, sampleRate, targetRate);

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

  private _playAudioChunk(pcmInt16: Int16Array, sampleRate: number, channels: number, senderTimestampMs: number): void {
    if (!this.audioCtx) this._initAudio();
    this._ensureAudioResumed();

    if (pcmInt16.length === 0) return;

    this.audioLevel = 0;
    this._pushAudioToRing(pcmInt16, sampleRate, channels);

    if (this.audioCtx && senderTimestampMs > 0) {
      this.videoClockBase = {
        senderMs: senderTimestampMs,
        audioCtxTime: this.audioCtx.currentTime,
      };
    }
  }
}
