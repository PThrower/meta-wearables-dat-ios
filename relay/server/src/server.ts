/**
 * caringmind-frame-relay
 *
 * Bun WebSocket relay server that:
 * 1. Accepts a single publisher (iOS app) sending FRLY-encoded JPEG frames
 * 2. Fans out frames to N browser viewers in real-time
 * 3. Uses WASM module for frame throttling (falls back to pure JS)
 *
 * Endpoints:
 *   /publish  - WebSocket, iOS publisher connects here
 *   /view     - WebSocket, browser viewers connect here
 *   /         - Serves viewer HTML
 *   /stats    - JSON stats
 *
 * Wire protocol (FRLY):
 *   [4B "FRLY"][8B sequence][4B width][4B height][1B quality][8B timestamp_ms][JPEG payload]
 */

import { join } from "node:path";
import os from "node:os";
import type { ServerWebSocket } from "bun";
import { createObjectStore, type ObjectStore } from "@ebowwa/object-store";

// --- WebSocket Data Type (Bun.serve generic) ---

interface WsData {
  role: string;
  clientIp: string;
  viewerId?: string;
}

// --- Quality Presets ---

type QualityPreset = "high" | "medium" | "low" | "mini";

const QUALITY_PRESETS: Record<QualityPreset, { maxFps: number; minIntervalMs: number; label: string }> = {
  high:   { maxFps: 30, minIntervalMs: 33,  label: "High (30 FPS)" },
  medium: { maxFps: 15, minIntervalMs: 67,  label: "Medium (15 FPS)" },
  low:    { maxFps: 8,  minIntervalMs: 125, label: "Low (8 FPS)" },
  mini:   { maxFps: 4,  minIntervalMs: 250, label: "Mini (4 FPS)" },
};

const DEFAULT_QUALITY: QualityPreset = "high";

// --- Types ---

interface FrameTiming {
  lastSequence: number;
  lastTimestampMs: number;
  lastReceivedAt: number;
  jitterMs: number;       // variation in frame-to-frame interval
  fps: number;            // rolling FPS estimate
  minIntervalMs: number;
  maxIntervalMs: number;
  droppedFrames: number;  // gaps in sequence numbers
}

interface Publisher {
  ws: ServerWebSocket<WsData>;
  id: string;
  connected: number;
  frameCount: number;
  totalBytes: number;
  audioCount: number;
  audioBytes: number;
  timing: FrameTiming;
  lastHeader: { width: number; height: number; quality: number } | null;
  clientIp: string;
  // Device identity — sent by iOS publisher via {"type":"hello",...}
  deviceId: string | null;       // iOS identifierForVendor
  deviceName: string | null;     // iOS device name (e.g. "Starlink", "iPhone")
  wearableId: string | null;     // Connected wearable device ID (DAT SDK DeviceIdentifier)
  wearableType: string | null;   // Wearable type (e.g. "Ray-Ban Meta", "Oakley Meta HSTN")
  deviceModel: string | null;    // iPhone, iPad, etc.
  systemVersion: string | null;  // iOS version (e.g. "18.3.2")
}

interface Viewer {
  ws: ServerWebSocket<WsData>;
  connected: number;
  frameCount: number;
  totalBytes: number;
  timing: FrameTiming;
  quality: QualityPreset;
  lastSentAt: number;          // timestamp of last sent frame (for throttle)
  throttledCount: number;      // frames skipped due to throttle
  clientIp: string;
}

// --- State ---

let publisher: Publisher | null = null;
const viewers: Map<string, Viewer> = new Map();
let wasmModule: any = null;
const serverStartTime = Date.now();

// --- Object Store & Session Recorder ---

const store: ObjectStore = createObjectStore();
let recorder: SessionRecorder | null = null;

const SEGMENT_FLUSH_MS = 10_000; // flush buffered data every 10s

class SessionRecorder {
  readonly sessionId: string;
  private store: ObjectStore;
  private videoParts: Buffer[] = [];
  private audioParts: Buffer[] = [];
  private segIndex = 0;
  private chunkIndex = 0;
  private lastFlush = Date.now();
  private startedAt: number = 0;
  private flushedSegments = 0;
  private bytesToBucket = 0;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private deviceInfo: Record<string, string | null> = {};

  constructor(sessionId: string, store: ObjectStore) {
    this.sessionId = sessionId;
    this.store = store;
  }

  start(params: Record<string, string | null>) {
    this.startedAt = Date.now();
    this.lastFlush = this.startedAt;
    this.deviceInfo = { ...params };
    this.writeMeta(false);
    this.flushTimer = setInterval(() => this.tick(), SEGMENT_FLUSH_MS);
    console.log(`[recorder] Session ${this.sessionId.slice(0, 8)} started`);
  }

  appendVideo(frame: Uint8Array) {
    // Extract JPEG payload (skip 29-byte FRLY header)
    const jpeg = frame.length > HEADER_SIZE ? frame.subarray(HEADER_SIZE) : frame;
    this.videoParts.push(Buffer.from(jpeg));
  }

  appendAudio(frame: Uint8Array) {
    // Extract PCM payload (skip 29-byte FRAU header)
    const pcm = frame.length > HEADER_SIZE ? frame.subarray(HEADER_SIZE) : frame;
    this.audioParts.push(Buffer.from(pcm));
  }

  private tick() {
    this.flushVideo();
    this.flushAudio();
  }

  private flushVideo() {
    if (this.videoParts.length === 0) return;
    const data = Buffer.concat(this.videoParts);
    this.videoParts = [];
    this.segIndex++;
    this.flushedSegments++;
    this.bytesToBucket += data.length;
    const key = `sessions/${this.sessionId}/video/seg-${this.segIndex.toString().padStart(4, "0")}.mjpeg`;
    this.store.put(key, data).catch(err =>
      console.error(`[recorder] video write failed:`, err.message)
    );
  }

  private flushAudio() {
    if (this.audioParts.length === 0) return;
    const data = Buffer.concat(this.audioParts);
    this.audioParts = [];
    this.chunkIndex++;
    this.bytesToBucket += data.length;
    const key = `sessions/${this.sessionId}/audio/chunk-${this.chunkIndex.toString().padStart(4, "0")}.pcm`;
    this.store.put(key, data).catch(err =>
      console.error(`[recorder] audio write failed:`, err.message)
    );
  }

  async finish() {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    // Flush remaining buffers
    this.flushVideo();
    this.flushAudio();
    this.writeMeta(true);
    console.log(`[recorder] Session ${this.sessionId.slice(0, 8)} finished: ${this.flushedSegments} video segs, ${this.chunkIndex} audio chunks, ${(this.bytesToBucket / 1048576).toFixed(2)} MB`);
  }

  private writeMeta(final: boolean) {
    const meta = {
      sessionId: this.sessionId,
      startedAt: new Date(this.startedAt).toISOString(),
      ...(final ? { finishedAt: new Date().toISOString(), durationMs: Date.now() - this.startedAt } : {}),
      device: this.deviceInfo,
      recording: {
        segmentsWritten: this.flushedSegments,
        audioChunks: this.chunkIndex,
        bytesToBucket: this.bytesToBucket,
      },
    };
    this.store.put(`sessions/${this.sessionId}/meta.json`, Buffer.from(JSON.stringify(meta, null, 2))).catch(err =>
      console.error(`[recorder] meta write failed:`, err.message)
    );
  }

  getStats() {
    return {
      active: true,
      sessionId: this.sessionId,
      segmentsWritten: this.flushedSegments,
      audioChunks: this.chunkIndex,
      bytesToBucket: this.bytesToBucket,
    };
  }
}

// --- Stale Connection Cleanup ---
// If Caddy/proxy swallows TCP close, the server never gets the WebSocket close event.
// Periodically check for dead connections and clean them up.

const PUBLISHER_TIMEOUT_MS = 15_000; // 15s without a frame = dead
const VIEWER_TIMEOUT_MS = 30_000;    // 30s without any activity = dead

setInterval(() => {
  const now = Date.now();

  // Check publisher staleness
  if (publisher && publisher.timing.lastReceivedAt > 0) {
    const stale = now - publisher.timing.lastReceivedAt;
    if (stale > PUBLISHER_TIMEOUT_MS) {
      console.log(`[relay] Publisher ${publisher.id.slice(0, 8)} stale (${Math.round(stale / 1000)}s), evicting`);
      try { publisher.ws.close(4002, "publisher stale"); } catch {}
      publisher = null;
    }
  }

  // Check viewer staleness
  for (const [id, viewer] of viewers) {
    const stale = viewer.timing.lastReceivedAt > 0
      ? now - viewer.timing.lastReceivedAt
      : now - viewer.connected;
    if (stale > VIEWER_TIMEOUT_MS) {
      console.log(`[relay] Viewer ${id.slice(0, 8)} stale (${Math.round(stale / 1000)}s), evicting`);
      try { viewer.ws.close(4003, "viewer stale"); } catch {}
      viewers.delete(id);
    }
  }
}, 5_000); // Check every 5 seconds

// --- WASM Loading ---
// Nodejs target from wasm-pack is self-initializing: just import and use.

async function loadWasm() {
  try {
    const pkgDir = join(import.meta.dir, "..", "pkg");
    const gluePath = join(pkgDir, "frame_relay_wasm.js");
    const glueFile = Bun.file(gluePath);
    if (!(await glueFile.exists())) {
      console.log("[relay] WASM not found, running pure JS");
      return;
    }
    const { FrameRelay } = await import(gluePath);
    wasmModule = new FrameRelay(30);
    console.log("[relay] WASM loaded, throttle: 30 FPS");
  } catch (err) {
    console.log("[relay] WASM load failed:", err);
    console.log("[relay] Running without WASM throttle");
  }
}

// --- Protocol ---

const HEADER_SIZE = 29;
const AUDIO_HEADER_SIZE = 29;

function freshTiming(): FrameTiming {
  return {
    lastSequence: 0,
    lastTimestampMs: 0,
    lastReceivedAt: 0,
    jitterMs: 0,
    fps: 0,
    minIntervalMs: Infinity,
    maxIntervalMs: 0,
    droppedFrames: 0,
  };
}

function updateTiming(t: FrameTiming, sequence: number, timestampMs: number): FrameTiming {
  const now = Date.now();
  if (t.lastReceivedAt > 0) {
    const interval = now - t.lastReceivedAt;
    // Skip same-tick frames (interval=0) to avoid Infinity FPS poisoning the EMA
    if (interval > 0) {
      const instantFps = 1000 / interval;
      t.fps = t.fps === 0 ? instantFps : t.fps * 0.9 + instantFps * 0.1;
      if (interval < t.minIntervalMs) t.minIntervalMs = interval;
      if (interval > t.maxIntervalMs) t.maxIntervalMs = interval;
    }
    // Jitter = EMA of absolute deviation from mean interval
    if (t.minIntervalMs < Infinity && t.maxIntervalMs > 0) {
      const avg = (t.minIntervalMs + t.maxIntervalMs) / 2;
      const jitter = Math.abs(interval - avg);
      t.jitterMs = t.jitterMs === 0 ? jitter : t.jitterMs * 0.9 + jitter * 0.1;
    }

    // Detect dropped frames (sequence gaps)
    const expectedSeq = t.lastSequence + 1;
    if (sequence > expectedSeq) {
      t.droppedFrames += sequence - expectedSeq;
    }
  }
  t.lastSequence = sequence;
  t.lastTimestampMs = timestampMs;
  t.lastReceivedAt = now;
  return t;
}

function parseHeader(buf: Uint8Array) {
  if (buf.length < HEADER_SIZE) return null;
  if (buf[0] !== 0x46 || buf[1] !== 0x52 || buf[2] !== 0x4c || buf[3] !== 0x59) return null;
  const view = new DataView(buf.buffer, buf.byteOffset);
  return {
    sequence: Number(view.getBigUint64(4, true)),
    width: view.getUint32(12, true),
    height: view.getUint32(16, true),
    quality: buf[20],
    timestampMs: Number(view.getBigUint64(21, true)),
  };
}

function fanout(data: Uint8Array) {
  if (viewers.size === 0) return;
  const header = parseHeader(data);
  if (!header) return;

  // Update publisher timing
  if (publisher) {
    updateTiming(publisher.timing, header.sequence, header.timestampMs);
    publisher.lastHeader = { width: header.width, height: header.height, quality: header.quality };
  }

  // WASM throttle check (video only)
  if (wasmModule && !wasmModule.should_relay(BigInt(Date.now()))) return;

  const now = Date.now();

  for (const [id, viewer] of viewers) {
    try {
      if (viewer.ws.readyState !== WebSocket.OPEN) continue;

      // Per-viewer frame throttle based on quality preset
      const preset = QUALITY_PRESETS[viewer.quality];
      const elapsed = viewer.lastSentAt > 0 ? now - viewer.lastSentAt : preset.minIntervalMs;
      if (elapsed < preset.minIntervalMs) {
        viewer.throttledCount++;
        continue;
      }

      viewer.ws.send(data);
      viewer.frameCount++;
      viewer.totalBytes += data.length;
      viewer.lastSentAt = now;
      updateTiming(viewer.timing, header.sequence, header.timestampMs);
    } catch {
      viewers.delete(id);
    }
  }
}

function fanoutAudio(data: Uint8Array) {
  if (viewers.size === 0) return;
  for (const [id, viewer] of viewers) {
    try {
      if (viewer.ws.readyState === WebSocket.OPEN) {
        viewer.ws.send(data);
        viewer.totalBytes += data.length;
      }
    } catch {
      viewers.delete(id);
    }
  }
}

// --- Stats ---

function formatTiming(t: FrameTiming) {
  return {
    fps: Math.round(t.fps * 10) / 10,
    jitterMs: Math.round(t.jitterMs * 10) / 10,
    minIntervalMs: t.minIntervalMs === Infinity ? 0 : Math.round(t.minIntervalMs),
    maxIntervalMs: Math.round(t.maxIntervalMs),
    droppedFrames: t.droppedFrames,
  };
}

function stats() {
  const now = Date.now();
  return {
    server: {
      uptimeMs: now - serverStartTime,
      wasmLoaded: wasmModule !== null,
      ip: wifiIp,
      port: PORT,
    },
    publisher: publisher ? {
      id: publisher.id,
      clientIp: publisher.clientIp,
      deviceId: publisher.deviceId,
      deviceName: publisher.deviceName,
      deviceModel: publisher.deviceModel,
      systemVersion: publisher.systemVersion,
      wearableId: publisher.wearableId,
      wearableType: publisher.wearableType,
      frameCount: publisher.frameCount,
      totalBytes: publisher.totalBytes,
      totalMB: Math.round(publisher.totalBytes / 1048576 * 100) / 100,
      audioCount: publisher.audioCount,
      audioBytes: publisher.audioBytes,
      audioMB: Math.round(publisher.audioBytes / 1048576 * 100) / 100,
      uptimeMs: now - publisher.connected,
      latencyMs: publisher.timing.lastReceivedAt > 0
        ? Math.round(now - publisher.timing.lastReceivedAt)
        : null,
      video: publisher.lastHeader,
      timing: formatTiming(publisher.timing),
    } : null,
    recording: recorder ? recorder.getStats() : { active: false },
    viewers: viewers.size,
    viewerStats: Object.fromEntries(
      [...viewers.entries()].map(([id, v]) => [id.slice(0, 8), {
        clientIp: v.clientIp,
        quality: v.quality,
        maxFps: QUALITY_PRESETS[v.quality].maxFps,
        frames: v.frameCount,
        throttled: v.throttledCount,
        totalBytes: v.totalBytes,
        totalMB: Math.round(v.totalBytes / 1048576 * 100) / 100,
        uptimeMs: now - v.connected,
        timing: formatTiming(v.timing),
      }])
    ),
  };
}

// --- Auto-detect WiFi IP ---

function getWifiIp(): string {
  const nets = os.networkInterfaces();
  for (const addrs of Object.values(nets) as (os.NetworkInterfaceInfo[] | undefined)[]) {
    for (const a of (addrs ?? [])) {
      if (a.family === "IPv4" && !a.internal && !a.address.startsWith("100.") && !a.address.startsWith("169.")) {
        return a.address;
      }
    }
  }
  return "127.0.0.1";
}

// --- Server ---

const PORT = parseInt(process.env.RELAY_PORT || "8080");
const wifiIp = getWifiIp();

await loadWasm();

// Load viewer HTML
const viewerHtml = await Bun.file(join(import.meta.dir, "../../viewer/index.html")).text().catch(() =>
  "<html><body><h1>Viewer HTML not found</h1></body></html>"
);

const server = Bun.serve<WsData>({
  hostname: "0.0.0.0",
  port: PORT,
  async fetch(req, server) {
    const url = new URL(req.url, `http://${req.headers.get("host") || "localhost"}`);

    if (url.pathname === "/stats") {
      return Response.json(stats());
    }

    // --- Retrieval Endpoints (S3 persistence) ---

    if (url.pathname === "/sessions") {
      const keys = await store.list("sessions/") as string[];
    const sessionIds = [...new Set<string>()];
    for (const key of keys) {
      if (key.startsWith("sessions/") && key.endsWith("/meta.json")) {
        sessionIds.add(key.slice("sessions/".length, key.length - "/meta.json".length));
      }
    }
    return Response.json([...sessionIds]);
    }

    const sessionMatch = url.pathname.match(/^\/session\/([^/]+)$/);
    if (sessionMatch) {
      const id = sessionMatch[1];
      const data = await store.get(`sessions/${id}/meta.json`);
      if (!data) return Response.json({ error: "Session not found" }, { status: 404 });
      return new Response(data, { headers: { "Content-Type": "application/json" } });
    }

    const videoMatch = url.pathname.match(/^\/session\/([^/]+)\/video\/(.+)$/);
    if (videoMatch) {
      const [, id, seg] = videoMatch;
      const key = `sessions/${id}/video/${seg}`;
      try {
        const signed = await store.signedUrl(key, 3600);
        return Response.redirect(signed);
      } catch {
        return Response.json({ error: "Not found" }, { status: 404 });
      }
    }

    const audioMatch = url.pathname.match(/^\/session\/([^/]+)\/audio\/(.+)$/);
    if (audioMatch) {
      const [, id, chunk] = audioMatch;
      const key = `sessions/${id}/audio/${chunk}`;
      try {
        const signed = await store.signedUrl(key, 3600);
        return Response.redirect(signed);
      } catch {
        return Response.json({ error: "Not found" }, { status: 404 });
      }
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(viewerHtml, { headers: { "Content-Type": "text/html" } });
    }

    // /publish and /view get upgraded to WebSocket
    const role = url.pathname === "/publish" ? "publish" : "view";
    const clientIp = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
      || req.headers.get("x-real-ip")
      || "unknown";
    server.upgrade(req, { data: { role, clientIp } });
    return new Response(null, { status: 204 });
  },
  websocket: {
    open(ws) {
      const { role, clientIp } = ws.data;
      if (role === "publish") {
        if (publisher && publisher.ws.readyState === WebSocket.OPEN) {
          ws.close(4001, "publisher already connected");
          return;
        }
        const id = crypto.randomUUID();
        publisher = {
          ws,
          id,
          connected: Date.now(),
          frameCount: 0,
          totalBytes: 0,
          audioCount: 0,
          audioBytes: 0,
          timing: freshTiming(),
          lastHeader: null,
          clientIp,
          deviceId: null,
          deviceName: null,
          wearableId: null,
          wearableType: null,
          deviceModel: null,
          systemVersion: null,
        };
        console.log(`[relay] Publisher connected: ${id.slice(0, 8)} ip=${clientIp}`);
        // Start recording session
        recorder = new SessionRecorder(id, store);
        recorder.start({});
      } else {
        const id = crypto.randomUUID();
        ws.data.viewerId = id;
        viewers.set(id, {
          ws,
          connected: Date.now(),
          frameCount: 0,
          totalBytes: 0,
          timing: freshTiming(),
          quality: DEFAULT_QUALITY,
          lastSentAt: 0,
          throttledCount: 0,
          clientIp,
        });
        console.log(`[relay] Viewer connected: ${id.slice(0, 8)} ip=${clientIp} (total: ${viewers.size})`);
      }
    },
    message(ws, message) {
      const { role } = ws.data;

      if (role === "publish" && publisher?.ws === ws) {
        if (typeof message === "string") {
          // Publisher JSON control messages
          try {
            const cmd = JSON.parse(message);
            if (cmd.type === "hello" && publisher) {
              publisher.deviceId = cmd.deviceId || null;
              publisher.deviceName = cmd.deviceName || null;
              publisher.wearableId = cmd.wearableId || null;
              publisher.wearableType = cmd.wearableType || null;
              publisher.deviceModel = cmd.deviceModel || null;
              publisher.systemVersion = cmd.systemVersion || null;
              console.log(`[relay] Publisher hello: device=${cmd.deviceName || "?"} wearable=${cmd.wearableType || "none"} ip=${publisher.clientIp}`);
              // Update recorder device info
              if (recorder) {
                (recorder as any).deviceInfo = {
                  deviceId: cmd.deviceId || null,
                  deviceName: cmd.deviceName || null,
                  wearableId: cmd.wearableId || null,
                  wearableType: cmd.wearableType || null,
                  deviceModel: cmd.deviceModel || null,
                  systemVersion: cmd.systemVersion || null,
                };
                (recorder as any).writeMeta(false);
              }
            }
          } catch {}
        } else {
          // Binary frame (Uint8Array in Bun)
          const buf = message as Uint8Array;

          // Check magic bytes: FRAU (0x46 0x52 0x41 0x55) vs FRLY (0x46 0x52 0x4C 0x59)
          if (buf.length >= 4 && buf[0] === 0x46 && buf[1] === 0x52 && buf[2] === 0x41 && buf[3] === 0x55) {
            // Audio frame (FRAU)
            publisher.audioCount++;
            publisher.audioBytes += buf.length;
            fanoutAudio(buf);
            recorder?.appendAudio(buf);
          } else {
            // Video frame (FRLY)
            publisher.frameCount++;
            publisher.totalBytes += buf.length;
            fanout(buf);
            recorder?.appendVideo(buf);
          }
        }
      } else {
        // Viewer control messages
        if (typeof message === "string") {
          try {
            const cmd = JSON.parse(message);
            if (cmd.type === "stats") {
              ws.send(JSON.stringify({ type: "stats", ...stats() }));
            } else if (cmd.type === "config" && cmd.quality && cmd.quality in QUALITY_PRESETS) {
              const viewerId = ws.data.viewerId;
              const viewer = viewerId ? viewers.get(viewerId) : undefined;
              if (viewer && viewerId) {
                const newQuality = cmd.quality as QualityPreset;
                viewer.quality = newQuality;
                console.log(`[relay] Viewer ${viewerId.slice(0, 8)} quality: ${newQuality} (${QUALITY_PRESETS[newQuality].maxFps} FPS)`);
                ws.send(JSON.stringify({
                  type: "quality",
                  preset: newQuality,
                  maxFps: QUALITY_PRESETS[newQuality].maxFps,
                  label: QUALITY_PRESETS[newQuality].label,
                }));
              }
            }
          } catch {}
        }
      }
    },
    async close(ws) {
      const { role } = ws.data;
      if (role === "publish" && publisher?.ws === ws) {
        console.log("[relay] Publisher disconnected");
        // Finish recording session
        if (recorder) {
          await recorder.finish();
          recorder = null;
        }
        publisher = null;
      } else {
        const id = ws.data.viewerId;
        if (id) {
          viewers.delete(id);
          console.log(`[relay] Viewer disconnected: ${id.slice(0, 8)} (${viewers.size} remaining)`);
        }
      }
    },
  },
});

console.log(`[relay] Server on 0.0.0.0:${PORT}`);
console.log(`[relay] Publisher: ws://${wifiIp}:${PORT}/publish`);
console.log(`[relay] Viewer:   http://${wifiIp}:${PORT}`);
