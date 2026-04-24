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
import type { PublisherDropReason } from "./session-state.js";
import { stateToLegacyStatus, dropReasonFromCloseCode } from "./session-state.js";
import { stateMachine } from "./session-state-machine.js";
import { SessionRecorder } from "./session-recorder.js";
import { DEFAULT_QUALITY, createTokenBucket, bucketTryConsume } from "./types.js";
import { freshTiming, updateTiming, parseHeader, formatTiming } from "./protocol.js";
import { resolvePermission } from "./permissions.js";
import { dbWriter } from "./db/db-writer.js";
import * as q from "./db/queries.js";
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

  // Orphan timers: sessionId -> timeout handle
  private orphanTimers = new Map<string, ReturnType<typeof setTimeout>>();

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
      const now = Date.now();
      const isDeviceBound = false; // will be set by bindDeviceToSession later
      session = {
        id,
        publisher: null,
        viewers: new Map(),
        recorder: null,
        wasmThrottle: null,
        createdAt: now,
        lastActivityAt: now,
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
        framesRelayed: 0,
        publisherClaiming: false,
        activeAppId: null,
        appPipeline: null,
        lastFrame: null,
        linkState: "unknown",
        state: "created",
        stateEnteredAt: now,
        flags: {
          ephemeral: false,
          orphanGraceMs: 300_000, // 5 min default, adjusted on device bind
        },
        dropReason: undefined,
      };
      this.sessions.set(id, session);

      // Emit created event
      stateMachine.transition(id, "created" as any, "created" as any, undefined, { ephemeral: false });
      console.log(`[registry] Session created: ${id}`);

      // Shadow write: session created (skip for ephemeral)
      if (!session.flags.ephemeral) {
        dbWriter.enqueue(q.upsertSession({ id, status: "active" }));
      }
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
      // Device-bound sessions get longer orphan grace
      const session = this.sessions.get(sessionId);
      if (session) session.flags.orphanGraceMs = 300_000;
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
    // Device-bound sessions get longer orphan grace (5 min) for reconnect
    const session = this.sessions.get(sessionId);
    if (session) {
      session.flags.orphanGraceMs = 300_000;
    }
  }

  /** Look up session ID by device ID. Returns undefined if device not connected. */
  findByDevice(deviceId: string): string | undefined {
    return this.deviceSessionMap.get(deviceId);
  }

  /** Find device ID by session ID (reverse lookup). */
  findDeviceBySession(sessionId: string): string | undefined {
    for (const [devId, sid] of this.deviceSessionMap) {
      if (sid === sessionId) return devId;
    }
    return undefined;
  }

  /** Get a session by ID. Returns undefined if not found. */
  getSession(id: string): Session | undefined {
    return this.sessions.get(id);
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
      session.recordingId = undefined;
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
      session.recordingId = undefined;
    }

    // Track reconnects — session already existed with a disconnected publisher
    if (session.publisher === null && this.sessions.has(sessionId) && session.createdAt < Date.now() - 1000) {
      this.publisherReconnects++;
      dbWriter.incrementCounter("publisher_reconnects");
    }

    // Evict this publisher from any OTHER session it may still be registered in
    const orphanedRecorders: SessionRecorder[] = [];
    for (const [otherId, otherSession] of this.sessions) {
      if (otherId === sessionId) continue;
      if (otherSession.publisher && otherSession.publisher.ws === ws) {
        console.log(`[registry] Publisher reconnected — evicting from old session=${otherId}`);
        this.totalDroppedFrames += otherSession.publisher.timing.droppedFrames;
        otherSession.publisher = null;
        if (otherSession.recorder) {
          orphanedRecorders.push(otherSession.recorder);
          otherSession.recorder = null;
          otherSession.recordingId = undefined;
        }
        otherSession.lastActivityAt = Date.now();
      }
    }
    // Await orphaned recorders after session state is updated
    await Promise.all(orphanedRecorders.map(r => r.finish().catch(() => {})));

    this.sessionsStarted++;
    dbWriter.incrementCounter("sessions_started");

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
      batteryLevel: null,
      batteryState: null,
      lowPowerMode: false,
      standby: true,
    };
    session.publisher = publisher;
    session.publisherClaiming = false;
    session.lastActivityAt = Date.now();

    // State machine transition: created|orphaned -> standby
    const prevState = session.state;
    if (prevState === "created" || prevState === "orphaned") {
      stateMachine.transition(sessionId, prevState, "standby", undefined, {
        publisherId: id,
        viewerCount: session.viewers.size,
      });
      session.state = "standby";
      session.stateEnteredAt = Date.now();
      session.dropReason = undefined;
      // Clear orphan timer on reconnect
      if (prevState === "orphaned") {
        this.clearOrphanTimer(sessionId);
      }
      if (!session.flags.ephemeral) {
        dbWriter.enqueue(q.updateSessionState(sessionId, "standby"));
      }
    }

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

    // Do NOT start recorder for standby publishers — wait for activatePublisher()
    // Recorder will be started when publisher transitions from standby to active

    // Shadow write: user + session ownership
    if (userId) {
      dbWriter.enqueue(q.upsertUser({ id: userId, email: email || "" }));
      dbWriter.enqueue(q.upsertSession({
        id: sessionId,
        publisherUserId: userId,
        accessLevel: session.accessLevel,
      }));
    }

    console.log(`[registry] Publisher connected: ${id.slice(0, 8)} session=${sessionId} ip=${clientIp}`);
    return null;
  }

  /** Release publisher when it disconnects */
  async releasePublisher(sessionId: string, dropReason?: PublisherDropReason) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Accumulate dropped frames from publisher timing before clearing
    if (session.publisher) {
      this.totalDroppedFrames += session.publisher.timing.droppedFrames;
    }

    // Shadow write: finalize session + update device status
    const pub = session.publisher;
    const recorder = session.recorder;
    if (pub && recorder) {
      const stats = recorder.getStats();
      const res = session.metadata.resolution;
      dbWriter.enqueue(q.endSession(sessionId, {
        durationMs: stats.active ? Date.now() - (stats as any).startedAt : 0,
        totalFrames: pub.frameCount,
        totalBytes: pub.totalBytes + pub.audioBytes,
        audioChunks: stats.audioChunks,
        peakViewers: session.viewers.size, // approximation
        resolutionW: res?.width,
        resolutionH: res?.height,
      }));
    }
    if (pub?.deviceId) {
      dbWriter.enqueue(q.updateDeviceStatus(pub.deviceId, "standby"));
    }

    if (session.recorder) {
      session.recorder.framesRelayed = session.framesRelayed;
      await session.recorder.finish();
      session.recorder = null;
    }
    session.recordingId = undefined;  // Next activation gets a fresh recording
    session.publisher = null;
    session.lastFrame = null;  // Clear cached frame — no live source
    session.lastActivityAt = Date.now();
    session.dropReason = dropReason;
    console.log(`[registry] Publisher disconnected from session=${sessionId} reason=${dropReason ?? "unknown"}`);

    // No viewers left — end the session immediately
    if (session.viewers.size === 0) {
      const prevState = session.state;
      stateMachine.transition(sessionId, prevState, "ended", dropReason, {
        viewerCount: 0,
      });
      session.state = "ended";
      session.stateEnteredAt = Date.now();
      if (!session.flags.ephemeral) {
        dbWriter.enqueue(q.updateSessionState(sessionId, "ended", dropReason));
      }
      this.sessions.delete(sessionId);
      console.log(`[registry] Session ${sessionId} removed (no viewers after publisher disconnect)`);
      this.onSessionDestroy?.(sessionId);
    } else {
      // Viewers remain — enter orphaned state with grace timer
      const prevState = session.state;
      stateMachine.transition(sessionId, prevState, "orphaned", dropReason, {
        viewerCount: session.viewers.size,
      });
      session.state = "orphaned";
      session.stateEnteredAt = Date.now();
      if (!session.flags.ephemeral) {
        dbWriter.enqueue(q.updateSessionState(sessionId, "orphaned", dropReason));
      }
      this.startOrphanTimer(sessionId, session.flags.orphanGraceMs);
      console.log(`[registry] Session ${sessionId} orphaned (${session.viewers.size} viewers, grace=${session.flags.orphanGraceMs}ms)`);
    }
  }

  /** Activate a standby publisher — starts recorder, marks as active */
  async activatePublisher(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session?.publisher) return;

    if (!session.publisher.standby) return; // Already active
    session.publisher.standby = false;

    // State machine transition: standby|paused -> active
    const prevState = session.state;
    if (prevState === "standby" || prevState === "paused") {
      stateMachine.transition(sessionId, prevState, "active", undefined, {
        publisherId: session.publisher.id,
        viewerCount: session.viewers.size,
      });
      session.state = "active";
      session.stateEnteredAt = Date.now();
      if (!session.flags.ephemeral) {
        dbWriter.enqueue(q.updateSessionState(sessionId, "active"));
      }
    }

    // Start recorder — always creates a new recording per publisher connection.
    // recordingId is cleared on publisher release so reconnects get fresh recordings
    // instead of appending to old ones (which produces gap artifacts in MP4 exports).
    if (!session.recordingId) {
      session.recordingId = crypto.randomUUID();
    }
    session.recorder = new SessionRecorder(session.recordingId, this.store);
    // Pass device metadata from session so the recording's meta.json is populated
    // (hello arrives before activation, so publisher already set session.metadata)
    const pub = session.publisher;
    // Phone/mobile client device info
    session.recorder.start({
      deviceId: pub.deviceId ?? session.metadata.deviceId,
      deviceName: pub.deviceName ?? session.metadata.deviceName,
      deviceModel: pub.deviceModel ?? session.metadata.deviceModel,
      systemVersion: pub.systemVersion ?? session.metadata.systemVersion,
      appVersion: pub.appVersion ?? session.metadata.appVersion,
      buildNumber: pub.buildNumber ?? session.metadata.buildNumber,
    });
    // Camera/wearable device info (separate from phone)
    if (pub.wearableId || pub.wearableType) {
      session.recorder.wearableInfo = {
        wearableId: pub.wearableId ?? null,
        wearableType: pub.wearableType ?? session.metadata.wearableType ?? null,
      };
    }
    session.recorder.accessLevel = session.accessLevel;
    session.recorder.acl = session.acl;
    session.recorder.ownerId = session.ownerId;
    session.recorder.ownerEmail = session.ownerEmail;

    // Shadow write: session activated with recording ID
    dbWriter.enqueue(q.activateSession(sessionId, session.recordingId));
    if (session.publisher?.deviceId) {
      dbWriter.enqueue(q.updateDeviceStatus(session.publisher.deviceId, "online"));
    }

    console.log(`[registry] Publisher activated: ${session.publisher.id.slice(0, 8)} session=${sessionId}`);
  }

  // --- Pause / Resume ---

  /** Pause session: active -> paused. Releases recorder, keeps publisher + viewers connected. */
  async pauseSession(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.state !== "active") return;

    // State machine transition
    stateMachine.transition(sessionId, "active", "paused", undefined, {
      publisherId: session.publisher?.id,
      viewerCount: session.viewers.size,
    });
    session.state = "paused";
    session.stateEnteredAt = Date.now();
    if (session.publisher) session.publisher.standby = true;

    // Release recorder
    if (session.recorder) {
      session.recorder.framesRelayed = session.framesRelayed;
      await session.recorder.finish();
      session.recorder = null;
    }
    session.recordingId = undefined;

    // Write DB state
    if (!session.flags.ephemeral) {
      dbWriter.enqueue(q.updateSessionState(sessionId, "paused"));
    }
    if (session.publisher?.deviceId) {
      dbWriter.enqueue(q.updateDeviceStatus(session.publisher.deviceId, "standby"));
    }

    console.log(`[registry] Session paused: ${sessionId}`);
  }

  /** Resume session: paused -> active. Re-creates recorder, re-activates AI if activeAppId set. */
  async resumeSession(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.state !== "paused") return;

    // State machine transition
    stateMachine.transition(sessionId, "paused", "active", undefined, {
      publisherId: session.publisher?.id,
      viewerCount: session.viewers.size,
    });
    session.state = "active";
    session.stateEnteredAt = Date.now();
    if (session.publisher) session.publisher.standby = false;

    // Re-create recorder
    await this.activatePublisher(sessionId);

    console.log(`[registry] Session resumed: ${sessionId}`);
  }

  // --- Orphan timer ---

  /** Start orphan grace timer. Fires after graceMs, transitioning to expired if still orphaned. */
  private startOrphanTimer(sessionId: string, graceMs: number) {
    this.clearOrphanTimer(sessionId);
    const handle = setTimeout(() => {
      const session = this.sessions.get(sessionId);
      if (!session || session.state !== "orphaned") return;

      console.log(`[registry] Orphan grace expired for session=${sessionId}, evicting ${session.viewers.size} viewers`);
      // Evict viewers
      for (const [viewerId, viewer] of session.viewers) {
        try { viewer.ws.close(4004, "session expired (orphan timeout)"); } catch {}
      }
      session.viewers.clear();

      // Transition to expired
      stateMachine.transition(sessionId, "orphaned", "expired", undefined, {
        viewerCount: 0,
      });
      session.state = "expired";
      session.stateEnteredAt = Date.now();
      if (!session.flags.ephemeral) {
        dbWriter.enqueue(q.updateSessionState(sessionId, "expired"));
      }

      // Clean up
      for (const [devId, sid] of this.deviceSessionMap) {
        if (sid === sessionId) this.deviceSessionMap.delete(devId);
      }
      this.sessions.delete(sessionId);
      this.onSessionDestroy?.(sessionId);
    }, graceMs);
    this.orphanTimers.set(sessionId, handle);
  }

  /** Clear orphan timer for a session (e.g. on publisher reconnect) */
  private clearOrphanTimer(sessionId: string) {
    const handle = this.orphanTimers.get(sessionId);
    if (handle) {
      clearTimeout(handle);
      this.orphanTimers.delete(sessionId);
    }
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

    // Shadow write: viewer connected
    dbWriter.enqueue(q.addViewer({
      id,
      sessionId,
      userId,
      clientIp,
    }));

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

    // Shadow write: viewer disconnected
    if (viewer) {
      dbWriter.enqueue(q.removeViewer(viewerId, viewer.frameCount, viewer.totalBytes));
    }

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
    session.framesRelayed++;
    // Batch increment -- flushed every 60s by DbWriter
    dbWriter.incrementCounter("total_frames_relayed");

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
        dbWriter.incrementCounter("viewers_rejected");
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
        dbWriter.incrementCounter("viewers_rejected");
      }
    }
  }

  // --- Last-frame cache ---

  /** Get the cached last frame for a session (FRLY binary) or null */
  getLastFrame(sessionId: string): Uint8Array | null {
    return this.sessions.get(sessionId)?.lastFrame ?? null;
  }

  /** Resolve a sessionId to its recordingId (R2 prefix). Returns the ID itself if not found. */
  resolveRecordingId(sessionId: string): string {
    const session = this.sessions.get(sessionId);
    return session?.recordingId ?? sessionId;
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
  async cleanupStale() {
    const now = Date.now();
    const PUBLISHER_TIMEOUT_MS = 15_000;
    const VIEWER_TIMEOUT_MS = 30_000;

    // Collect recorders that need finishing so we can await them after mutating the session map
    const recordersToFinish: SessionRecorder[] = [];

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
            recordersToFinish.push(session.recorder);
            session.recorder = null;
          }
          session.recordingId = undefined;
          // No publisher and no viewers — end immediately
          if (session.viewers.size === 0) {
            stateMachine.transition(sessionId, session.state, "ended", "dead_ws");
            session.state = "ended";
            session.stateEnteredAt = Date.now();
            session.dropReason = "dead_ws";
            if (!session.flags.ephemeral) {
              dbWriter.enqueue(q.updateSessionState(sessionId, "ended", "dead_ws"));
            }
            for (const [devId, sessId] of this.deviceSessionMap) {
              if (sessId === sessionId) this.deviceSessionMap.delete(devId);
            }
            this.sessions.delete(sessionId);
            this.onSessionDestroy?.(sessionId);
            console.log(`[registry] Session ${sessionId} removed (dead ws, no viewers)`);
          } else {
            // Viewers remain — orphan
            stateMachine.transition(sessionId, session.state, "orphaned", "dead_ws", {
              viewerCount: session.viewers.size,
            });
            session.state = "orphaned";
            session.stateEnteredAt = Date.now();
            session.dropReason = "dead_ws";
            if (!session.flags.ephemeral) {
              dbWriter.enqueue(q.updateSessionState(sessionId, "orphaned", "dead_ws"));
            }
            this.startOrphanTimer(sessionId, session.flags.orphanGraceMs);
          }
          continue;
        }

        // Standby or paused publishers: skip frame-based stale eviction entirely.
        // The WebSocket ping keepalive handles transport liveness; Bun's idleTimeout (120s) handles transport cleanup.
        if (session.state === "standby" || session.state === "paused") {
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
            recordersToFinish.push(session.recorder);
            session.recorder = null;
          }
          session.recordingId = undefined;
          if (session.viewers.size === 0) {
            stateMachine.transition(sessionId, session.state, "ended", "stale_timeout");
            session.state = "ended";
            session.stateEnteredAt = Date.now();
            session.dropReason = "stale_timeout";
            if (!session.flags.ephemeral) {
              dbWriter.enqueue(q.updateSessionState(sessionId, "ended", "stale_timeout"));
            }
            for (const [devId, sessId] of this.deviceSessionMap) {
              if (sessId === sessionId) this.deviceSessionMap.delete(devId);
            }
            this.sessions.delete(sessionId);
            this.onSessionDestroy?.(sessionId);
            console.log(`[registry] Session ${sessionId} removed (stale publisher, no viewers)`);
            continue;
          } else {
            // Viewers remain — orphan with stale reason
            stateMachine.transition(sessionId, session.state, "orphaned", "stale_timeout", {
              viewerCount: session.viewers.size,
            });
            session.state = "orphaned";
            session.stateEnteredAt = Date.now();
            session.dropReason = "stale_timeout";
            if (!session.flags.ephemeral) {
              dbWriter.enqueue(q.updateSessionState(sessionId, "orphaned", "stale_timeout"));
            }
            this.startOrphanTimer(sessionId, session.flags.orphanGraceMs);
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
        dbWriter.incrementCounter("viewers_rejected");
        }
      }

      // Expire sessions with no publisher AND no viewers
      // Device-bound sessions get 5 min grace (expect reconnect), others 60s
      if (!session.publisher && session.viewers.size === 0 && !stateMachine.isTerminal(session.state)) {
        const idleMs = now - session.lastActivityAt;
        const isDeviceBound = [...this.deviceSessionMap.values()].includes(sessionId);
        const expiry = isDeviceBound ? 300_000 : SESSION_EXPIRY_MS;
        if (idleMs > expiry) {
          console.log(`[registry] Session expired: ${sessionId} (idle ${Math.round(idleMs / 1000)}s)`);
          stateMachine.transition(sessionId, session.state, "expired");
          session.state = "expired";
          session.stateEnteredAt = Date.now();
          if (!session.flags.ephemeral) {
            dbWriter.enqueue(q.updateSessionState(sessionId, "expired"));
          }
          // Clean device map entries pointing to this session
          for (const [devId, sessId] of this.deviceSessionMap) {
            if (sessId === sessionId) this.deviceSessionMap.delete(devId);
          }
          this.sessions.delete(sessionId);
          this.onSessionDestroy?.(sessionId);
        }
      }
    }

    // Await all recorder finishes after session state is consistent
    await Promise.all(recordersToFinish.map(r => r.finish().catch(() => {})));
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
