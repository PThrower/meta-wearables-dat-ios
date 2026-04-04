/**
 * SessionRegistry — manages concurrent streaming sessions
 *
 * Adapted from MentraOS StreamRegistry pattern.
 * Each session has its own publisher, viewers, recorder, and WASM throttle.
 * Backward compatible: clients without ?session= param route to "default" session.
 */

import type { ServerWebSocket } from "bun";
import type { ObjectStore } from "@ebowwa/object-store";
import type { WsData, Publisher, Viewer, Session, SessionMetadata, QualityPreset } from "./types.js";
import type { SessionRecorder } from "./session-recorder.js";
import { QUALITY_PRESETS, DEFAULT_QUALITY } from "./types.js";
import { freshTiming, updateTiming, parseHeader, formatTiming, isAudioFrame, isVideoFrame } from "./protocol.js";

const DEFAULT_SESSION_ID = "default";
const SESSION_EXPIRY_MS = 60_000; // expire sessions with no publisher + no viewers for 60s

export class SessionRegistry {
  private sessions = new Map<string, Session>();
  private store: ObjectStore;
  private FrameRelayClass: any | null = null; // WASM class constructor, not instance

  constructor(store: ObjectStore) {
    this.store = store;
  }

  /** Store the WASM FrameRelay class constructor (called once at startup) */
  setFrameRelayClass(cls: any) {
    this.FrameRelayClass = cls;
  }

  // --- Session lifecycle ---

  /** Get an existing session or create a new one */
  getOrCreate(id: string): Session {
    let session = this.sessions.get(id);
    if (!session) {
      session = {
        id,
        publisher: null,
        viewers: new Map(),
        recorder: null,
        wasmThrottle: null,
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        metadata: {
          deviceName: null,
          deviceModel: null,
          deviceId: null,
          systemVersion: null,
          wearableType: null,
          resolution: null,
        },
      };
      this.sessions.set(id, session);
      console.log(`[registry] Session created: ${id}`);
    }
    return session;
  }

  /** Get session by id, or undefined */
  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  /** Resolve session id from URL, defaulting to "default" */
  resolveSessionId(url: URL): string {
    return url.searchParams.get("session") || DEFAULT_SESSION_ID;
  }

  // --- Publisher management ---

  /** Claim the publisher slot for a session. Returns error string or null on success. */
  claimPublisher(sessionId: string, ws: ServerWebSocket<WsData>, clientIp: string): string | null {
    const session = this.getOrCreate(sessionId);

    if (session.publisher && session.publisher.ws.readyState === WebSocket.OPEN) {
      return "publisher already connected";
    }

    const id = crypto.randomUUID();
    const publisher: Publisher = {
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
    session.publisher = publisher;
    session.lastActivityAt = Date.now();

    // Start recorder
    const { SessionRecorder } = require("./session-recorder.js") as typeof import("./session-recorder.js");
    session.recorder = new SessionRecorder(id, this.store);
    session.recorder.start({});

    console.log(`[registry] Publisher connected: ${id.slice(0, 8)} session=${sessionId} ip=${clientIp}`);
    return null;
  }

  /** Release publisher when it disconnects */
  async releasePublisher(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (session.recorder) {
      await session.recorder.finish();
      session.recorder = null;
    }
    session.publisher = null;
    session.lastActivityAt = Date.now();
    console.log(`[registry] Publisher disconnected from session=${sessionId}`);
  }

  // --- Viewer management ---

  /** Add a viewer to a session */
  addViewer(sessionId: string, ws: ServerWebSocket<WsData>, clientIp: string): string {
    const session = this.getOrCreate(sessionId);
    const id = crypto.randomUUID();
    ws.data.viewerId = id;

    session.viewers.set(id, {
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
    session.lastActivityAt = Date.now();
    console.log(`[registry] Viewer connected: ${id.slice(0, 8)} session=${sessionId} (total: ${session.viewers.size})`);
    return id;
  }

  /** Remove a viewer from its session */
  removeViewer(sessionId: string, viewerId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.viewers.delete(viewerId);
    session.lastActivityAt = Date.now();
    console.log(`[registry] Viewer disconnected: ${viewerId.slice(0, 8)} session=${sessionId} (${session.viewers.size} remaining)`);
  }

  /** Find which session a viewer belongs to by viewerId */
  findViewerSession(viewerId: string): { session: Session; viewer: Viewer } | null {
    for (const session of this.sessions.values()) {
      const viewer = session.viewers.get(viewerId);
      if (viewer) return { session, viewer };
    }
    return null;
  }

  // --- Frame fanout ---

  /** Fan out a video frame to all viewers in a session */
  fanout(sessionId: string, data: Uint8Array) {
    const session = this.sessions.get(sessionId);
    if (!session || session.viewers.size === 0) return;

    const header = parseHeader(data);
    if (!header) return;

    // Update publisher timing
    if (session.publisher) {
      updateTiming(session.publisher.timing, header.sequence, header.timestampMs);
      session.publisher.lastHeader = { width: header.width, height: header.height, quality: header.quality };
      session.metadata.resolution = { width: header.width, height: header.height };
    }

    // Per-session WASM throttle (lazy init)
    if (this.FrameRelayClass && !session.wasmThrottle) {
      session.wasmThrottle = new this.FrameRelayClass(30);
    }
    if (session.wasmThrottle && !session.wasmThrottle.should_relay(BigInt(Date.now()))) return;

    const now = Date.now();

    for (const [id, viewer] of session.viewers) {
      try {
        if (viewer.ws.readyState !== WebSocket.OPEN) continue;

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
        session.viewers.delete(id);
      }
    }
  }

  /** Fan out an audio frame to all viewers in a session */
  fanoutAudio(sessionId: string, data: Uint8Array) {
    const session = this.sessions.get(sessionId);
    if (!session || session.viewers.size === 0) return;

    for (const [id, viewer] of session.viewers) {
      try {
        if (viewer.ws.readyState === WebSocket.OPEN) {
          viewer.ws.send(data);
          viewer.totalBytes += data.length;
        }
      } catch {
        session.viewers.delete(id);
      }
    }
  }

  // --- Stale connection cleanup ---

  /** Evict stale publishers (15s timeout) and viewers (30s timeout) */
  cleanupStale() {
    const now = Date.now();
    const PUBLISHER_TIMEOUT_MS = 15_000;
    const VIEWER_TIMEOUT_MS = 30_000;

    for (const [sessionId, session] of this.sessions) {
      // Check publisher staleness
      if (session.publisher && session.publisher.timing.lastReceivedAt > 0) {
        const stale = now - session.publisher.timing.lastReceivedAt;
        if (stale > PUBLISHER_TIMEOUT_MS) {
          console.log(`[registry] Publisher ${session.publisher.id.slice(0, 8)} stale (${Math.round(stale / 1000)}s) in session=${sessionId}, evicting`);
          try { session.publisher.ws.close(4002, "publisher stale"); } catch {}
          session.publisher = null;
          if (session.recorder) {
            session.recorder.finish().catch(() => {});
            session.recorder = null;
          }
        }
      }

      // Check viewer staleness
      for (const [viewerId, viewer] of session.viewers) {
        const stale = viewer.timing.lastReceivedAt > 0
          ? now - viewer.timing.lastReceivedAt
          : now - viewer.connected;
        if (stale > VIEWER_TIMEOUT_MS) {
          console.log(`[registry] Viewer ${viewerId.slice(0, 8)} stale (${Math.round(stale / 1000)}s) in session=${sessionId}, evicting`);
          try { viewer.ws.close(4003, "viewer stale"); } catch {}
          session.viewers.delete(viewerId);
        }
      }

      // Expire sessions with no publisher AND no viewers for > 60s
      if (!session.publisher && session.viewers.size === 0) {
        const idleMs = now - session.lastActivityAt;
        if (idleMs > SESSION_EXPIRY_MS) {
          console.log(`[registry] Session expired: ${sessionId} (idle ${Math.round(idleMs / 1000)}s)`);
          this.sessions.delete(sessionId);
        }
      }
    }
  }

  // --- Query ---

  /** List all active (non-expired) sessions with metadata */
  listActive(): Array<{
    id: string;
    publisherConnected: boolean;
    viewerCount: number;
    metadata: SessionMetadata;
    uptimeMs: number;
  }> {
    const now = Date.now();
    return [...this.sessions.values()].map(s => ({
      id: s.id,
      publisherConnected: s.publisher !== null,
      viewerCount: s.viewers.size,
      metadata: s.metadata,
      uptimeMs: now - s.createdAt,
    }));
  }

  /** Platform-wide stats plus per-session breakdown */
  stats(wifiIp: string, port: number, serverStartTime: number) {
    const now = Date.now();
    const sessions: Record<string, any> = {};

    for (const [id, session] of this.sessions) {
      sessions[id] = {
        publisher: session.publisher ? {
          id: session.publisher.id,
          clientIp: session.publisher.clientIp,
          deviceId: session.publisher.deviceId,
          deviceName: session.publisher.deviceName,
          deviceModel: session.publisher.deviceModel,
          systemVersion: session.publisher.systemVersion,
          wearableId: session.publisher.wearableId,
          wearableType: session.publisher.wearableType,
          frameCount: session.publisher.frameCount,
          totalBytes: session.publisher.totalBytes,
          totalMB: Math.round(session.publisher.totalBytes / 1048576 * 100) / 100,
          audioCount: session.publisher.audioCount,
          audioBytes: session.publisher.audioBytes,
          audioMB: Math.round(session.publisher.audioBytes / 1048576 * 100) / 100,
          uptimeMs: now - session.publisher.connected,
          latencyMs: session.publisher.timing.lastReceivedAt > 0
            ? Math.round(now - session.publisher.timing.lastReceivedAt)
            : null,
          video: session.publisher.lastHeader,
          timing: formatTiming(session.publisher.timing),
        } : null,
        recording: session.recorder ? session.recorder.getStats() : { active: false },
        viewers: session.viewers.size,
        viewerStats: Object.fromEntries(
          [...session.viewers.entries()].map(([vid, v]) => [vid.slice(0, 8), {
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

    return {
      server: {
        uptimeMs: now - serverStartTime,
        wasmLoaded: this.FrameRelayClass !== null,
        sessionCount: this.sessions.size,
        ip: wifiIp,
        port,
      },
      sessions,
    };
  }
}
