/**
 * RelayPlayer — centralized WebSocket + audio/video player
 *
 * Used by viewer/index.html (full page), gallery.html (overlay),
 * and directory.html (preview).
 *
 * Usage:
 *   const player = new RelayPlayer({
 *     canvas: document.getElementById('canvas'),
 *     onStatus: (s) => { ... },
 *     onFps: (fps) => { ... },
 *     onSize: (w, h) => { ... },
 *     onSequence: (seq) => { ... },
 *     onLatency: (ms) => { ... },
 *     onDropped: (count) => { ... },
 *     onAudioState: (state) => { ... },  // "ON" | "OFF"
 *     onAudioLevel: (pct) => { ... },    // 0-100
 *     onConnectionState: (state) => { ... }, // "connected" | "disconnected" | "reconnecting" | "error"
 *     onNeedUnmute: () => { ... },       // called when AudioContext needs user gesture
 *   });
 *   player.connect('wss://host/view?session=xxx');
 *   player.resumeAudio();                // call from user gesture handler
 *   player.setQuality('high');
 *   player.disconnect();
 *   player.destroy();
 */

class RelayPlayer {
  static FRLY_HEADER_SIZE = 29;
  static FRAU_HEADER_SIZE = 29;
  static FRAU_MAGIC = [0x46, 0x52, 0x41, 0x55]; // "FRAU"
  static FRLY_MAGIC = [0x46, 0x52, 0x4C, 0x59]; // "FRLY"

  constructor(options = {}) {
    this.canvas = options.canvas;
    this.ctx = this.canvas ? this.canvas.getContext('2d') : null;
    this.callbacks = {
      onStatus: options.onStatus || (() => {}),
      onFps: options.onFps || (() => {}),
      onSize: options.onSize || (() => {}),
      onSequence: options.onSequence || (() => {}),
      onLatency: options.onLatency || (() => {}),
      onDropped: options.onDropped || (() => {}),
      onAudioState: options.onAudioState || (() => {}),
      onAudioLevel: options.onAudioLevel || (() => {}),
      onConnectionState: options.onConnectionState || (() => {}),
      onNeedUnmute: options.onNeedUnmute || (() => {}),
    };

    // Video state
    this.ws = null;
    this.frameCount = 0;
    this.lastFpsTime = performance.now();
    this.fpsFrameCount = 0;
    this.currentFps = 0;
    this.droppedFrames = 0;
    this.lastSequence = 0;

    // Reconnect state
    this.reconnectTimer = null;
    this.reconnectDelay = 1000;
    this.RECONNECT_MAX = 15000;
    this.intentionalClose = false;
    this.lastUrl = null;

    // Audio state
    this.audioCtx = null;
    this.audioChunkCount = 0;
    this.audioLevel = 0;
    this.audioResumed = false;

    // A/V sync state
    this.videoClockBase = null;

    // AudioWorklet
    this.workletNode = null;
    this.pendingSamples = [];

    // Fallback ring buffer (if AudioWorklet unavailable)
    this.RING_SIZE = 48000 * 2;
    this.RING_BUFFER = new Float32Array(this.RING_SIZE);
    this.ringWritePos = 0;
    this.ringReadPos = 0;
    this.ringFill = 0;
    this.ringStarted = false;
    this.PREBUFFER_SAMPLES = 48000 * 0.06;
  }

  // --- AudioWorklet inline code ---
  static get WORKLET_CODE() {
    return `
      const RING = new Float32Array(96000);
      let writePos = 0, readPos = 0, fill = 0, started = false;
      const PREBUFFER = 48000 * 0.06;

      self.onmessage = (e) => {
        if (e.data.type === 'push') {
          const samples = e.data.samples;
          for (let i = 0; i < samples.length; i++) {
            if (fill < RING.length) {
              RING[writePos] = samples[i];
              writePos = (writePos + 1) % RING.length;
              fill++;
            }
          }
        } else if (e.data.type === 'reset') {
          writePos = 0; readPos = 0; fill = 0; started = false;
        }
      };

      class RingDrainProcessor extends AudioWorkletProcessor {
        process(inputs, outputs) {
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
      registerProcessor('ring-drain', RingDrainProcessor);
    `;
  }

  // --- Connection ---

  connect(url) {
    this.lastUrl = url;
    this.intentionalClose = false;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.ws) this.ws.close();

    this.ws = new WebSocket(url);
    this.ws.binaryType = 'arraybuffer';

    this.ws.onopen = () => {
      this.reconnectDelay = 1000;
      this._resetStreamState();
      this.callbacks.onConnectionState('connected');
      this.callbacks.onStatus('CONNECTED');
    };

    this.ws.onmessage = (event) => this._handleMessage(event);

    this.ws.onclose = () => {
      this._resetStreamState();
      this.callbacks.onConnectionState('disconnected');
      this.callbacks.onStatus('CLOSED');
      this.callbacks.onAudioState('OFF');

      if (!this.intentionalClose) {
        this.callbacks.onConnectionState('reconnecting');
        this.callbacks.onStatus(`RECONN ${Math.round(this.reconnectDelay / 1000)}s`);
        this.reconnectTimer = setTimeout(() => {
          if (this.lastUrl) this.connect(this.lastUrl);
        }, this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.RECONNECT_MAX);
      }
    };

    this.ws.onerror = () => {
      this.callbacks.onConnectionState('error');
      this.callbacks.onStatus('ERROR');
    };
  }

  disconnect() {
    this.intentionalClose = true;
    this.lastUrl = null;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.ws) this.ws.close();
    this.ws = null;
  }

  destroy() {
    this.disconnect();
    this._cleanupAudio();
    this.canvas = null;
    this.ctx = null;
  }

  setQuality(preset) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'config', quality: preset }));
    }
  }

  resumeAudio() {
    if (this.audioCtx && this.audioCtx.state === 'suspended') {
      this.audioCtx.resume().then(() => {
        this.audioResumed = true;
      });
    }
  }

  // --- Internal ---

  _resetStreamState() {
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
    this.callbacks.onAudioLevel(0);
    if (this.workletNode) {
      try { this.workletNode.port.postMessage({ type: 'reset' }); } catch {}
    }
    this.pendingSamples = [];
  }

  _cleanupAudio() {
    if (this.audioCtx) {
      try { this.audioCtx.close(); } catch {}
      this.audioCtx = null;
    }
    this.workletNode = null;
  }

  _handleMessage(event) {
    if (typeof event.data === 'string') {
      // JSON control messages — ignore for now (quality confirmations etc.)
      return;
    }

    const buf = new Uint8Array(event.data);
    if (buf.length < 4) return;

    const m0 = buf[0], m1 = buf[1], m2 = buf[2], m3 = buf[3];
    const M = RelayPlayer;

    if (m0 === M.FRAU_MAGIC[0] && m1 === M.FRAU_MAGIC[1] && m2 === M.FRAU_MAGIC[2] && m3 === M.FRAU_MAGIC[3]) {
      this._handleAudioFrame(buf);
    } else if (m0 === M.FRLY_MAGIC[0] && m1 === M.FRLY_MAGIC[1] && m2 === M.FRLY_MAGIC[2] && m3 === M.FRLY_MAGIC[3]) {
      this._handleVideoFrame(buf);
    }
  }

  _handleAudioFrame(buf) {
    if (buf.length < RelayPlayer.FRAU_HEADER_SIZE) return;

    const view = new DataView(buf.buffer, buf.byteOffset);
    const codecType = buf[4];
    const sampleRate = view.getUint32(13, true);
    const channels = view.getUint16(17, true);
    const bitsPerSample = view.getUint16(19, true);
    const senderTimestampMs = Number(view.getBigUint64(21, true));

    if (codecType !== 0 || bitsPerSample !== 16) return;

    const pcmBytes = buf.slice(RelayPlayer.FRAU_HEADER_SIZE);
    const pcmInt16 = new Int16Array(pcmBytes.buffer, pcmBytes.byteOffset, pcmBytes.length / 2);

    this._playAudioChunk(pcmInt16, sampleRate, channels, senderTimestampMs);
    this.audioChunkCount++;

    this.callbacks.onAudioState('ON');
  }

  _handleVideoFrame(buf) {
    if (buf.length < RelayPlayer.FRLY_HEADER_SIZE) return;
    if (!this.canvas || !this.ctx) return;

    const sequence = Number(new DataView(buf.buffer, buf.byteOffset + 4, 8).getBigUint64(0, true));
    const width = new DataView(buf.buffer, buf.byteOffset + 12, 4).getUint32(0, true);
    const height = new DataView(buf.buffer, buf.byteOffset + 16, 4).getUint32(0, true);
    const quality = buf[20];
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
    const jpeg = buf.slice(RelayPlayer.FRLY_HEADER_SIZE);
    const blob = new Blob([jpeg], { type: 'image/jpeg' });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
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

    // Use relative latency: measure transport delay from first frame baseline
    if (!this._firstFrameLocalTime) this._firstFrameLocalTime = Date.now();
    if (!this._firstFrameSenderTime) this._firstFrameSenderTime = timestampMs;
    const clockOffset = this._firstFrameLocalTime - this._firstFrameSenderTime;
    const latency = (Date.now() - this._firstFrameLocalTime) - (timestampMs - this._firstFrameSenderTime);
    const absLatency = Math.abs(latency);

    this.callbacks.onFps(this.currentFps);
    this.callbacks.onSize(width, height);
    this.callbacks.onSequence(sequence);
    this.callbacks.onLatency(absLatency);
    this.callbacks.onDropped(this.droppedFrames);
  }

  // --- Audio engine ---

  _initAudio() {
    if (this.audioCtx) return;
    this.audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
    this.audioResumed = false;
    this.ringStarted = false;
    this.ringWritePos = 0;
    this.ringReadPos = 0;
    this.ringFill = 0;

    const blob = new Blob([RelayPlayer.WORKLET_CODE], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    this.audioCtx.audioWorklet.addModule(url).then(() => {
      this.workletNode = new AudioWorkletNode(this.audioCtx, 'ring-drain');
      this.workletNode.connect(this.audioCtx.destination);
      // Flush pending samples
      for (const batch of this.pendingSamples) {
        this.workletNode.port.postMessage({ type: 'push', samples: batch });
      }
      this.pendingSamples = [];
    }).catch(() => {
      // Fallback to ScriptProcessorNode
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
    URL.revokeObjectURL(url);
  }

  _ensureAudioResumed() {
    if (!this.audioCtx || this.audioResumed) return;
    if (this.audioCtx.state === 'suspended') {
      this.callbacks.onNeedUnmute();
      return;
    }
    this.audioResumed = true;
  }

  _pushAudioToRing(pcmInt16, sampleRate) {
    const inSamples = pcmInt16.length;
    if (inSamples === 0) return;

    const targetRate = this.audioCtx.sampleRate;
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

    // Update audio level callback
    const pct = Math.min(100, Math.round(this.audioLevel * 300));
    this.callbacks.onAudioLevel(pct);

    // Send to AudioWorklet if ready, else fallback ring buffer
    if (this.workletNode) {
      this.workletNode.port.postMessage({ type: 'push', samples: floatSamples });
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

  _playAudioChunk(pcmInt16, sampleRate, channels, senderTimestampMs) {
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

// Export for browser global or module
if (typeof window !== 'undefined') {
  window.RelayPlayer = RelayPlayer;
}
if (typeof module !== 'undefined') {
  module.exports = RelayPlayer;
}
