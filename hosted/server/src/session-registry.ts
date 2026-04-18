/**
 * SessionRegistry — manages concurrent streaming sessions
 *
 * Adapted from MentraOS StreamRegistry pattern.
 * Each session has its own publisher, viewers, recorder, and WASM throttle.
 * Backward compatible: clients without ?session= param route to "default" session.
 */

import type { ServerWebSocket } from "bun";
import type { ObjectStore } from "@ebowwa/object-store";
import type { WsData, Publisher, Viewer, Session, SessionMetadata, AccessLevel, AclEntry } from "./types.js";
import { SessionRecorder } from "./session-recorder.js";
import { DEFAULT_QUALITY, createTokenBucket, bucketTryConsume } from "./types.js";
import { freshTiming, updateTiming, parseHeader, formatTiming } from "./protocol.js";
import { resolvePermission } from "./permissions.js";
import { computeStats, type StatsSource } from "./stats.js";

const DEFAULT_SESSION_ID = "default";
const SESSION_EXPIRY_MS = 60_000; // expire sessions with no publisher + no viewers for 60s

export class SessionRegistry {
  private sessions = new Map<string, Session>();
  private deviceSessionMap = new Map<string, string>(); // deviceId → sessionId
  private store: ObjectStore;
  private FrameRelayClass: any | null = null; // WASM class constructor, not instance

  // --- Aggregate counters (lifetime, reset on process restart) ---
  private sessionsStarted = 0;
  private totalFramesRelayed = 0;
  private totalDroppedFrames = 0;
  private peakViewers = 0;
  private viewersRejected = 0;
  private publisherReconnects = 0;
  private framesThrottledWasm = 0;
  private framesThrottledQuality = 0;

  private onSessionDestroy?: (id: string) => void;

  constructor(store: ObjectStore) {
    this.store = store;
  }

  /** Set callback invoked when a session is destroyed (for orchestrator cleanup) */
  setOnSessionDestroy(fn: (id: string) => void) {
    this.onSessionDestroy = fn;
  }

  /** Expose read-only view for stats computation */
  asStatsSource(): StatsSource {
    const self = this;
    return {
      sessions: self.sessions,
      store: self.store,
      wasmLoaded: () => self.FrameRelayClass !== null,
      totalViewers: () => self.totalViewers(),
      get peakViewers() { return self.peakViewers; },
      get totalFramesRelayed() { return self.totalFramesRelayed; },
      get totalDroppedFrames() { return self.totalDroppedFrames; },
      get sessionsStarted() { return self.sessionsStarted; },
      get viewersRejected() { return self.viewersRejected; },
      get publisherReconnects() { return self.publisherReconnects; },
      get framesThrottledWasm() { return self.framesThrottledWasm; },
      get framesThrottledQuality() { return self.framesThrottledQuality; },
    } as StatsSource;
  }

  /** Store the WASM FrameRelay class constructor (called once at startup) */
  setFrameRelayClass(cls: any) {
    this.FrameRelayClass = cls;
  }

  /** Whether the WASM FrameRelay class is loaded */
  wasmLoaded(): boolean {
    return this.FrameRelayClass !== null;
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
          appVersion: null,
          buildNumber: null,
          resolution: null,
          ownerEmail: null,
          accessLevel: "private",
          acl: [],
        },
        ownerId: undefined,
        ownerEmail: undefined,
        accessLevel: "private",
        acl: [],
        publisherClaiming: false,
        activeAppId: null,
        appPipeline: null,
        lastFrame: null,
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

  /** For publishers: resolve stable session by device identity, or explicit session param */
  resolvePublisherSessionId(url: URL): string {
    // Explicit session param takes priority
    const explicit = url.searchParams.get("session");
    if (explicit) return explicit;

    // Device-keyed: reuse existing session for this device
    const deviceId = url.searchParams.get("device");
    if (deviceId) {
      const existing = this.deviceSessionMap.get(deviceId);
      if (existing) {
        console.log(`[registry] Device ${deviceId.slice(0, 8)} rejoining session=${existing}`);
        return existing;
      }
      // New device → create stable session ID
      const sessionId = `dev-${deviceId.slice(0, 8)}`;
      this.deviceSessionMap.set(deviceId, sessionId);
      console.log(`[registry] Device ${deviceId.slice(0, 8)} assigned session=${sessionId}`);
      return sessionId;
    }

    // Fallback: no device param (legacy clients)
    return crypto.randomUUID();
  }

  /** For viewers/taps: default to "default" session for backward compat */
  resolveViewerSessionId(url: URL): string {
    return url.searchParams.get("session") || DEFAULT_SESSION_ID;
  }

  /** Bind a device to a session (called when publisher hello provides deviceId) */
  bindDeviceToSession(deviceId: string, sessionId: string): void {
    this.deviceSessionMap.set(deviceId, sessionId);
  }

  // --- Publisher management ---

  /** Claim the publisher slot for a session. Returns error string or null on success. */
  async claimPublisher(sessionId: string, ws: ServerWebSocket<WsData>, clientIp: string, userId?: string, email?: string): Promise<string | null> {
    const session = this.getOrCreate(sessionId);

    // Ownership enforcement: if session already has an owner, verify identity
    if (session.ownerId && userId && session.ownerId !== userId) {
      return "session owned by another user";
    }

    // Force-takeover: evict zombie publisher (ws not OPEN) instead of rejecting
    if (session.publisher) {
      if (session.publisher.ws.readyState === WebSocket.OPEN) {
        return "publisher already connected";
      }
      console.log(`[registry] Evicting zombie publisher ${session.publisher.id.slice(0, 8)} (ws state=${session.publisher.ws.readyState}) in session=${sessionId}`);
      this.totalDroppedFrames += session.publisher.timing.droppedFrames;
      try { session.publisher.ws.close(4002, "publisher replaced"); } catch {}
      if (session.recorder) {
        try { await session.recorder.finish(); } catch { /* non-critical */ }
        session.recorder = null;
      }
      session.publisher = null;
    }

    // Mutex: prevent concurrent publisher claims
    if (session.publisherClaiming) {
      return "publisher claim in progress";
    }
    session.publisherClaiming = true;

    // Finish any existing recorder before starting a new one (prevents overlap)
    if (session.recorder) {
      try { await session.recorder.finish(); } catch { /* non-critical */ }
      session.recorder = null;
    }

    // Track reconnects — session already existed with a disconnected publisher
    if (session.publisher === null && this.sessions.has(sessionId) && session.createdAt < Date.now() - 1000) {
      this.publisherReconnects++;
    }

    // Evict this publisher from any OTHER session it may still be registered in
    for (const [otherId, otherSession] of this.sessions) {
      if (otherId === sessionId) continue;
      if (otherSession.publisher && otherSession.publisher.ws === ws) {
        console.log(`[registry] Publisher reconnected — evicting from old session=${otherId}`);
        this.totalDroppedFrames += otherSession.publisher.timing.droppedFrames;
        otherSession.publisher = null;
        if (otherSession.recorder) {
          otherSession.recorder.finish().catch(() => {});
          otherSession.recorder = null;
        }
        otherSession.lastActivityAt = Date.now();
      }
    }

    this.sessionsStarted++;

    const id = crypto.randomUUID();
    const publisher: Publisher = {
      ws,
      id,
      connected: Date.now(),
      frameCount: 0,
      totalBytes: 0,
      audioCount: 0,
      audioBytes: 0,
      audioTaps: new Map(),
      timing: freshTiming(),
      lastHeader: null,
      clientIp,
      deviceId: null,
      deviceName: null,
      wearableId: null,
      wearableType: null,
      deviceModel: null,
      systemVersion: null,
      appVersion: null,
      buildNumber: null,
    };
    session.publisher = publisher;
    session.publisherClaiming = false;
    session.lastActivityAt = Date.now();

    // Set session ownership on first publisher claim
    if (userId && !session.ownerId) {
      session.ownerId = userId;
      session.ownerEmail = email || undefined;
      session.metadata.ownerEmail = email || null;
      session.metadata.accessLevel = session.accessLevel;
    }

    // Unauthenticated publisher → link session (viewers need share token)
    if (!userId && !session.ownerId) {
      session.accessLevel = "link";
      session.metadata.accessLevel = "link";
    }

    // Start recorder — reuse stable recordingId so reconnects append to same R2 prefix
    if (!session.recordingId) {
      session.recordingId = crypto.randomUUID();
    }
    session.recorder = new SessionRecorder(session.recordingId, this.store);
    session.recorder.start({});

    console.log(`[registry] Publisher connected: ${id.slice(0, 8)} session=${sessionId} ip=${clientIp}`);
    return null;
  }

  /** Release publisher when it disconnects */
  async releasePublisher(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Accumulate dropped frames from publisher timing before clearing
    if (session.publisher) {
      this.totalDroppedFrames += session.publisher.timing.droppedFrames;
    }

    if (session.recorder) {
      await session.recorder.finish();
      session.recorder = null;
    }
    session.publisher = null;
    session.lastFrame = null;  // Clear cached frame — no live source
    session.lastActivityAt = Date.now();
    console.log(`[registry] Publisher disconnected from session=${sessionId}`);
  }

  // --- Viewer management ---

  /** Add a viewer to a session. Returns viewer ID or error string (prefixed with "error:"). */
  async addViewer(sessionId: string, ws: ServerWebSocket<WsData>, clientIp: string, userId?: string, email?: string, shareToken?: string): Promise<string> {
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
      gitCommit: null,
      buildVersion: null,
      bucket: createTokenBucket(DEFAULT_QUALITY),
    });
    session.lastActivityAt = Date.now();

    // Track peak viewers
    const totalNow = this.totalViewers();
    if (totalNow > this.peakViewers) {
      this.peakViewers = totalNow;
    }

    console.log(`[registry] Viewer connected: ${id.slice(0, 8)} session=${sessionId} (total: ${session.viewers.size})`);
    return id;
  }

  /** Remove a viewer from its session */
  removeViewer(sessionId: string, viewerId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Accumulate throttled quality frames before removing
    const viewer = session.viewers.get(viewerId);
    if (viewer) {
      this.framesThrottledQuality += viewer.throttledCount;
    }

    session.viewers.delete(viewerId);
    session.lastActivityAt = Date.now();
    console.log(`[registry] Viewer disconnected: ${viewerId.slice(0, 8)} session=${sessionId} (${session.viewers.size} remaining)`);

    // Garbage collect phantom sessions: no publisher (ever), no viewers left
    // Skip device-bound sessions — they should persist for reconnect
    if (session.viewers.size === 0 && session.publisher === null && !session.metadata.deviceName) {
      const isDeviceBound = [...this.deviceSessionMap.values()].includes(sessionId);
      if (!isDeviceBound) {
        this.sessions.delete(sessionId);
        console.log(`[registry] Phantom session garbage collected: ${sessionId}`);
      }
    }
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
    if (!session) return;

    // Always touch lastReceivedAt so stale detection works even if header parse fails
    if (session.publisher) {
      session.publisher.timing.lastReceivedAt = Date.now();
    }

    const header = parseHeader(data);
    if (!header) return;

    // Cache latest frame for instant viewer/AI delivery on connect
    session.lastFrame = data;

    // Update detailed publisher stats — even with zero viewers
    if (session.publisher) {
      updateTiming(session.publisher.timing, header.sequence, header.timestampMs);
      session.publisher.lastHeader = { width: header.width, height: header.height, quality: header.quality };
      session.metadata.resolution = { width: header.width, height: header.height };
    }

    if (session.viewers.size === 0) return;

    this.totalFramesRelayed++;

    const now = Date.now();

    for (const [id, viewer] of session.viewers) {
      try {
        if (viewer.ws.readyState !== WebSocket.OPEN) continue;

        if (!bucketTryConsume(viewer.bucket)) {
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
        this.viewersRejected++;
      }
    }
  }

  /** Fan out an audio frame to all viewers in a session */
  fanoutAudio(sessionId: string, data: Uint8Array, codecType: number, sampleRate: number) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Track per-codecType audio stats on the publisher
    if (session.publisher) {
      const tap = session.publisher.audioTaps.get(codecType);
      if (tap) {
        tap.count++;
        tap.bytes += data.length;
        tap.lastAt = Date.now();
        if (sampleRate > 0) tap.sampleRate = sampleRate;
      } else {
        session.publisher.audioTaps.set(codecType, {
          count: 1,
          bytes: data.length,
          sampleRate,
          lastAt: Date.now(),
        });
      }
    }

    if (session.viewers.size === 0) return;

    for (const [id, viewer] of session.viewers) {
      try {
        if (viewer.ws.readyState === WebSocket.OPEN) {
          viewer.ws.send(data);
          viewer.totalBytes += data.length;
        }
      } catch {
        session.viewers.delete(id);
        this.viewersRejected++;
      }
    }
  }

  // --- Last-frame cache ---

  /** Get the cached last frame for a session (FRLY binary) or null */
  getLastFrame(sessionId: string): Uint8Array | null {
    return this.sessions.get(sessionId)?.lastFrame ?? null;
  }

  // --- Server-to-publisher audio push ---

  /** Send binary data (FRAU frame) to a session's publisher. Returns true if sent. */
  sendToPublisher(sessionId: string, data: Uint8Array): boolean {
    const session = this.sessions.get(sessionId);
    if (!session?.publisher) return false;
    if (session.publisher.ws.readyState !== WebSocket.OPEN) return false;
    session.publisher.ws.send(data);
    return true;
  }

  // --- Stale connection cleanup ---

  /** Evict stale publishers (15s timeout) and viewers (30s timeout) */
  cleanupStale() {
    const now = Date.now();
    const PUBLISHER_TIMEOUT_MS = 15_000;
    const VIEWER_TIMEOUT_MS = 30_000;

    for (const [sessionId, session] of this.sessions) {
      // Check publisher staleness
      if (session.publisher) {
        // Immediate eviction: ws is no longer OPEN (closed/closing without close handler firing)
        if (session.publisher.ws.readyState !== WebSocket.OPEN) {
          console.log(`[registry] Publisher ${session.publisher.id.slice(0, 8)} ws not OPEN (state=${session.publisher.ws.readyState}) in session=${sessionId}, evicting`);
          this.totalDroppedFrames += session.publisher.timing.droppedFrames;
          try { session.publisher.ws.close(4002, "publisher dead ws"); } catch {}
          session.publisher = null;
          if (session.recorder) {
            session.recorder.finish().catch(() => {});
            session.recorder = null;
          }
          session.lastActivityAt = Date.now();
          continue;
        }

        const staleFromFrame = session.publisher.timing.lastReceivedAt > 0
          ? now - session.publisher.timing.lastReceivedAt
          : Infinity;
        const connectedMs = now - session.publisher.connected;
        const stale = Math.min(staleFromFrame, connectedMs);
        if (stale > PUBLISHER_TIMEOUT_MS) {
          console.log(`[registry] Publisher ${session.publisher.id.slice(0, 8)} stale (${Math.round(stale / 1000)}s, frames=${session.publisher.frameCount}) in session=${sessionId}, evicting`);
          this.totalDroppedFrames += session.publisher.timing.droppedFrames;
          try { session.publisher.ws.close(4002, "publisher stale"); } catch {}
          session.publisher = null;
          if (session.recorder) {
            session.recorder.finish().catch(() => {});
            session.recorder = null;
          }
          session.lastActivityAt = Date.now();
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
          this.viewersRejected++;
        }
      }

      // Expire sessions with no publisher AND no viewers
      // Device-bound sessions get 5 min grace (expect reconnect), others 60s
      if (!session.publisher && session.viewers.size === 0) {
        const idleMs = now - session.lastActivityAt;
        const isDeviceBound = [...this.deviceSessionMap.values()].includes(sessionId);
        const expiry = isDeviceBound ? 300_000 : SESSION_EXPIRY_MS;
        if (idleMs > expiry) {
          console.log(`[registry] Session expired: ${sessionId} (idle ${Math.round(idleMs / 1000)}s)`);
          // Clean device map entries pointing to this session
          for (const [devId, sessId] of this.deviceSessionMap) {
            if (sessId === sessionId) this.deviceSessionMap.delete(devId);
          }
          this.sessions.delete(sessionId);
          this.onSessionDestroy?.(sessionId);
        }
      }
    }
  }

  // --- Helpers ---

  /** Count total viewers across all sessions */
  private totalViewers(): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      count += session.viewers.size;
    }
    return count;
  }

  // --- Query ---

  /** List all active (non-expired) sessions with metadata */
  listActive(): Array<{
    id: string;
    publisherConnected: boolean;
    viewerCount: number;
    metadata: SessionMetadata;
    uptimeMs: number;
    ownerId: string | undefined;
    ownerEmail: string | undefined;
    accessLevel: AccessLevel;
    acl: AclEntry[];
  }> {
    const now = Date.now();
    return [...this.sessions.values()].map(s => ({
      id: s.id,
      publisherConnected: s.publisher !== null,
      viewerCount: s.viewers.size,
      metadata: s.metadata,
      uptimeMs: now - s.createdAt,
      ownerId: s.ownerId,
      ownerEmail: s.ownerEmail,
      accessLevel: s.accessLevel,
      acl: s.acl,
    }));
  }

  /** Platform-wide stats — delegates to stats.ts */
  async stats(wifiIp: string, port: number, serverStartTime: number, audioTapCount = 0) {
    return computeStats(this.asStatsSource(), { wifiIp, port, serverStartTime, audioTapCount });
  }
}
