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
import { QUALITY_PRESETS, DEFAULT_QUALITY } from "./types.js";
import { freshTiming, updateTiming, parseHeader, formatTiming } from "./protocol.js";
import { resolvePermission } from "./permissions.js";

const DEFAULT_SESSION_ID = "default";
const SESSION_EXPIRY_MS = 60_000; // expire sessions with no publisher + no viewers for 60s

export class SessionRegistry {
  private sessions = new Map<string, Session>();
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
  async claimPublisher(sessionId: string, ws: ServerWebSocket<WsData>, clientIp: string, userId?: string, email?: string): Promise<string | null> {
    const session = this.getOrCreate(sessionId);

    // Ownership enforcement: if session already has an owner, verify identity
    if (session.ownerId && userId && session.ownerId !== userId) {
      return "session owned by another user";
    }

    if (session.publisher && session.publisher.ws.readyState === WebSocket.OPEN) {
      return "publisher already connected";
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
    session.lastActivityAt = Date.now();
    console.log(`[registry] Publisher disconnected from session=${sessionId}`);
  }

  // --- Viewer management ---

  /** Add a viewer to a session. Returns viewer ID or error string (prefixed with "error:"). */
  async addViewer(sessionId: string, ws: ServerWebSocket<WsData>, clientIp: string, userId?: string, email?: string, shareToken?: string): Promise<string> {
    const session = this.getOrCreate(sessionId);

    // Access control: resolve permission via tiered system
    const perm = await resolvePermission(
      { ownerId: session.ownerId, accessLevel: session.accessLevel, acl: session.acl },
      userId,
      shareToken,
      this.store,
      sessionId,
    );
    if (!perm.allowed) {
      return `error:${perm.reason || "access denied"}`;
    }

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

    this.totalFramesRelayed++;

    // Per-session WASM throttle (lazy init)
    if (this.FrameRelayClass && !session.wasmThrottle) {
      session.wasmThrottle = new this.FrameRelayClass(30);
    }
    if (session.wasmThrottle && !session.wasmThrottle.should_relay(BigInt(Date.now()))) {
      this.framesThrottledWasm++;
      return;
    }

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
      if (session.publisher && session.publisher.timing.lastReceivedAt > 0) {
        const stale = now - session.publisher.timing.lastReceivedAt;
        if (stale > PUBLISHER_TIMEOUT_MS) {
          console.log(`[registry] Publisher ${session.publisher.id.slice(0, 8)} stale (${Math.round(stale / 1000)}s) in session=${sessionId}, evicting`);
          this.totalDroppedFrames += session.publisher.timing.droppedFrames;
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
          this.viewersRejected++;
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

  /** Platform-wide stats plus per-session breakdown, with gallery totals from R2 */
  async stats(wifiIp: string, port: number, serverStartTime: number, storeOverride?: ObjectStore) {
    const queryStore = storeOverride ?? this.store;
    const now = Date.now();
    const sessions: Record<string, any> = {};
    let activePublisherCount = 0;

    for (const [id, session] of this.sessions) {
      // Only sign a URL when there's an active recording
      let bucketUrl: string | null = null;
      if (session.recorder && session.publisher) {
        try {
          bucketUrl = await this.store.signedUrl(`sessions/${session.recordingId}/meta.json`, 3600);
        } catch { bucketUrl = null; }
      }

      if (session.publisher) activePublisherCount++;

      // Per-session rates
      const pubUptimeMs = session.publisher ? now - session.publisher.connected : 0;
      const videoBitrateMbps = session.publisher && pubUptimeMs > 0
        ? Math.round(session.publisher.totalBytes / pubUptimeMs * 1000 / 125000 * 100) / 100
        : 0;
      const audioBitrateKbps = session.publisher && pubUptimeMs > 0
        ? Math.round(session.publisher.audioBytes / pubUptimeMs * 1000 / 125 * 100) / 100
        : 0;
      const framesPerSecond = session.publisher && pubUptimeMs > 1000
        ? Math.round(session.publisher.frameCount / (pubUptimeMs / 1000) * 10) / 10
        : 0;

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
          appVersion: session.publisher.appVersion,
          buildNumber: session.publisher.buildNumber,
          frameCount: session.publisher.frameCount,
          totalBytes: session.publisher.totalBytes,
          totalMB: Math.round(session.publisher.totalBytes / 1048576 * 100) / 100,
          audioCount: session.publisher.audioCount,
          audioBytes: session.publisher.audioBytes,
          audioMB: Math.round(session.publisher.audioBytes / 1048576 * 100) / 100,
          audioTaps: Object.fromEntries(
            [...session.publisher.audioTaps.entries()].map(([ct, tap]) => [ct, {
              codecType: ct,
              label: ct === 0 ? "built-in mic" : ct === 1 ? "glasses HFP mic" : ct === 2 ? "TTS playback" : `unknown(${ct})`,
              frameCount: tap.count,
              bytes: tap.bytes,
              sampleRate: tap.sampleRate,
              lastAtMs: tap.lastAt,
            }])
          ),
          uptimeMs: pubUptimeMs,
          latencyMs: session.publisher.timing.lastReceivedAt > 0
            ? Math.round(now - session.publisher.timing.lastReceivedAt)
            : null,
          video: session.publisher.lastHeader,
          timing: formatTiming(session.publisher.timing),
        } : null,
        rates: {
          videoBitrateMbps,
          audioBitrateKbps,
          framesPerSecond,
        },
        recording: session.recorder ? session.recorder.getStats() : { active: false },
        bucketUrl,
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
            gitCommit: v.gitCommit,
            buildVersion: v.buildVersion,
          }])
        ),
      };
    }

    // Aggregate bandwidth across all sessions
    let totalBytesIn = 0;
    let totalBytesOut = 0;
    for (const session of this.sessions.values()) {
      if (session.publisher) {
        totalBytesIn += session.publisher.totalBytes + session.publisher.audioBytes;
      }
      for (const viewer of session.viewers.values()) {
        totalBytesOut += viewer.totalBytes;
      }
    }
    const serverUptimeMs = now - serverStartTime;
    const serverUptimeSec = serverUptimeMs / 1000;
    const totalBandwidthMbps = serverUptimeSec > 0
      ? Math.round((totalBytesIn + totalBytesOut) / serverUptimeSec * 8 / 125000 * 100) / 100
      : 0;

    // Gallery: aggregate historical recording stats from R2
    let galleryTotalRecorded = 0;
    let galleryTotalDurationMs = 0;
    let galleryTotalStorageBytes = 0;
    let galleryCachedExports = 0;
    try {
      const keys = await queryStore.list("sessions/") as string[];
      const metaKeys = keys.filter(k => k.endsWith("/meta.json"));
      const exportKeys = new Set(keys.filter(k => k.endsWith("/export.mp4")));
      galleryTotalRecorded = metaKeys.length;
      galleryCachedExports = exportKeys.size;

      for (const mk of metaKeys) {
        const buf = await queryStore.get(mk);
        if (!buf) continue;
        try {
          const meta = JSON.parse(new TextDecoder().decode(buf));
          if (meta.durationMs) galleryTotalDurationMs += meta.durationMs;
          if (meta.recording?.bytesToBucket) galleryTotalStorageBytes += meta.recording.bytesToBucket;
        } catch (err) { console.warn(`[stats] Gallery meta parse error:`, err); }
      }
    } catch (err) {
      console.error("[stats] Gallery stats failed:", err);
    }

    return {
      server: {
        uptimeMs: serverUptimeMs,
        wasmLoaded: this.FrameRelayClass !== null,
        sessionCount: this.sessions.size,
        ip: wifiIp,
        port,
        memoryUsageMb: Math.round(process.memoryUsage().rss / 1048576 * 100) / 100,
        activeConnections: activePublisherCount + this.totalViewers(),
        gitCommit: process.env.GIT_COMMIT?.slice(0, 7) ?? "unknown",
        buildVersion: process.env.BUILD_VERSION ?? "dev",
      },
      aggregate: {
        totalViewers: this.totalViewers(),
        peakViewers: this.peakViewers,
        totalBandwidthMbps,
        totalBytesInMB: Math.round(totalBytesIn / 1048576 * 100) / 100,
        totalBytesOutMB: Math.round(totalBytesOut / 1048576 * 100) / 100,
        totalFramesRelayed: this.totalFramesRelayed,
        totalDroppedFrames: this.totalDroppedFrames,
        sessionsStarted: this.sessionsStarted,
      },
      reliability: {
        viewersRejected: this.viewersRejected,
        publisherReconnects: this.publisherReconnects,
        framesThrottledWasm: this.framesThrottledWasm,
        framesThrottledQuality: this.framesThrottledQuality,
      },
      gallery: {
        totalRecordedSessions: galleryTotalRecorded,
        totalDurationMs: galleryTotalDurationMs,
        totalStorageMB: Math.round(galleryTotalStorageBytes / 1048576 * 100) / 100,
        cachedExports: galleryCachedExports,
      },
      sessions,
    };
  }
}
