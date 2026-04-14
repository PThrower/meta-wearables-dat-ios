/**
 * session-store.ts — R2 session data access layer
 *
 * Manages session metadata (meta.json), gallery index, and cleanup.
 * All R2 key operations for sessions live here.
 * Consumers (server.ts, session-registry.ts) import from this module.
 */

import type { ObjectStore } from "@ebowwa/object-store";
import type { AccessLevel, AclEntry, SessionRole } from "./types.js";
import type { GallerySession } from "./session-export.js";
import { canSeeInGallery } from "./permissions.js";

// --- Types ---

export interface SessionMeta {
  sessionId?: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  device?: {
    deviceId?: string;
    deviceName?: string;
    deviceModel?: string;
    wearableId?: string;
    wearableType?: string;
    systemVersion?: string;
  };
  accessLevel?: AccessLevel;
  acl?: AclEntry[];
  ownerId?: string;
  ownerEmail?: string;
  recording?: {
    segmentsWritten?: number;
    audioChunks?: number;
    bytesToBucket?: number;
  };
  [key: string]: unknown;
}

export interface SessionMetaPatch {
  accessLevel?: AccessLevel;
  acl?: AclEntry[];
}

// --- SessionStore class ---

export class SessionStore {
  private store: ObjectStore;

  // Gallery index: parsed meta.json per session
  private galleryIndex = new Map<string, {
    meta: SessionMeta;
    exportCached: boolean;
    hasThumbnail: boolean;
    updatedAt: number;
  }>();
  private galleryIndexReady = false;

  // Per-user gallery response cache
  private galleryCacheMap = new Map<string, { data: GallerySession[]; expiry: number }>();
  private readonly GALLERY_TTL_MS = 30_000;

  // Session ID list cache
  private sessionListCache: { ids: string[]; expiry: number } | null = null;
  private readonly SESSION_LIST_TTL_MS = 60_000;

  // Background refresh interval
  private readonly GALLERY_INDEX_TTL_MS = 120_000;

  constructor(store: ObjectStore) {
    this.store = store;
  }

  // --- Meta CRUD ---

  /** Read a session's meta.json from R2 */
  async getMeta(sessionId: string): Promise<SessionMeta | null> {
    const buf = await this.store.get(`sessions/${sessionId}/meta.json`);
    if (!buf) return null;
    try {
      return JSON.parse(new TextDecoder().decode(buf)) as SessionMeta;
    } catch {
      return null;
    }
  }

  /** Write a session's meta.json to R2 */
  async putMeta(sessionId: string, meta: SessionMeta): Promise<void> {
    await this.store.put(
      `sessions/${sessionId}/meta.json`,
      Buffer.from(JSON.stringify(meta, null, 2)),
    );
  }

  /** Patch specific fields on a session's meta.json */
  async patchMeta(sessionId: string, patch: SessionMetaPatch): Promise<SessionMeta | null> {
    const meta = await this.getMeta(sessionId);
    if (!meta) return null;
    if (patch.accessLevel) meta.accessLevel = patch.accessLevel;
    if (patch.acl) meta.acl = patch.acl;
    await this.putMeta(sessionId, meta);
    return meta;
  }

  /** Check if a key exists in R2 */
  async exists(key: string): Promise<boolean> {
    return this.store.exists(key);
  }

  /** List all keys with a given prefix */
  async list(prefix: string): Promise<string[]> {
    return this.store.list(prefix) as Promise<string[]>;
  }

  /** Get a signed URL for a key */
  async signedUrl(key: string, expiresInSeconds: number): Promise<string> {
    return this.store.signedUrl(key, expiresInSeconds);
  }

  // --- Session ID list ---

  async getSessionIds(): Promise<string[]> {
    const now = Date.now();
    if (this.sessionListCache && now < this.sessionListCache.expiry) {
      return this.sessionListCache.ids;
    }
    const keys = await this.store.list("sessions/") as string[];
    const metaKeys = keys.filter(k => k.startsWith("sessions/") && k.endsWith("/meta.json"));
    const ids = metaKeys.map(k => k.slice("sessions/".length, k.length - "/meta.json".length));
    this.sessionListCache = { ids, expiry: now + this.SESSION_LIST_TTL_MS };
    return ids;
  }

  /** Find the latest session ID (by R2 listing order) */
  async findLatestSessionId(): Promise<string | null> {
    const ids = await this.getSessionIds();
    return ids.length > 0 ? ids[ids.length - 1] : null;
  }

  // --- Gallery index ---

  /** Build the gallery index from R2 (parallel reads) */
  async buildGalleryIndex(): Promise<void> {
    const keys = await this.store.list("sessions/") as string[];
    const metaKeys = keys.filter(k => k.startsWith("sessions/") && k.endsWith("/meta.json"));
    const exportKeys = new Set(keys.filter(k => k.endsWith("/export.mp4")));
    const thumbKeys = new Set(keys.filter(k => k.endsWith("/thumb.jpg")));
    const videoKeys = keys.filter(k => k.includes("/video/") && k.endsWith(".mjpeg"));

    const sessionsWithVideo = new Set<string>();
    for (const vk of videoKeys) {
      const match = vk.match(/^sessions\/([^/]+)\/video\//);
      if (match) sessionsWithVideo.add(match[1]);
    }

    const entries = await Promise.all(metaKeys.map(async (mk) => {
      const sessionId = mk.slice("sessions/".length, mk.length - "/meta.json".length);
      try {
        const buf = await this.store.get(mk);
        if (!buf) return null;
        const meta = JSON.parse(new TextDecoder().decode(buf)) as SessionMeta;
        return {
          sessionId,
          meta,
          exportCached: exportKeys.has(`sessions/${sessionId}/export.mp4`),
          hasThumbnail: thumbKeys.has(`sessions/${sessionId}/thumb.jpg`) || sessionsWithVideo.has(sessionId),
        };
      } catch { return null; }
    }));

    for (const entry of entries) {
      if (!entry) continue;
      const existing = this.galleryIndex.get(entry.sessionId);
      if (!existing || existing.updatedAt < Date.now()) {
        this.galleryIndex.set(entry.sessionId, {
          meta: entry.meta,
          exportCached: entry.exportCached,
          hasThumbnail: entry.hasThumbnail,
          updatedAt: Date.now(),
        });
      }
    }
    this.galleryIndexReady = true;
  }

  /** Update a single session in the index (called when recorder finishes) */
  updateGalleryIndexEntry(sessionId: string, meta: SessionMeta, exportCached = false, hasThumbnail = true): void {
    this.galleryIndex.set(sessionId, { meta, exportCached, hasThumbnail, updatedAt: Date.now() });
  }

  /** Remove sessions from index that no longer exist in R2 */
  pruneGalleryIndex(currentIds: Set<string>): void {
    for (const id of this.galleryIndex.keys()) {
      if (!currentIds.has(id)) this.galleryIndex.delete(id);
    }
  }

  /** Build a filtered GallerySession[] from the in-memory index */
  galleryFromIndex(
    liveSessionIds: Set<string>,
    userId?: string,
    userEmail?: string,
    showAll?: boolean,
  ): GallerySession[] {
    const sessions: GallerySession[] = [];
    for (const [sessionId, entry] of this.galleryIndex) {
      const meta = entry.meta;
      const accessLevel: AccessLevel = meta.accessLevel || "link";
      const acl: AclEntry[] = meta.acl || [];
      const ownerId: string | undefined = meta.ownerId;
      const ownerEmail: string | undefined = meta.ownerEmail;
      const segments: number = meta.recording?.segmentsWritten || 0;
      const isLive = liveSessionIds.has(sessionId);

      if (segments === 0 && !isLive) continue;
      const visible = canSeeInGallery({ accessLevel, acl, ownerId, ownerEmail }, userId, userEmail);
      if (sessions.length < 2) console.log(`[gallery-filter] ${sessionId.slice(0,8)} access=${accessLevel} ownerEmail=${ownerEmail} ownerId=${ownerId} userId=${userId} userEmail=${userEmail} visible=${visible}`);
      if (!showAll && !visible) continue;

      let viewerRole: "owner" | "editor" | "viewer" | "public" | "none" = "none";
      if (userId && ownerId === userId) viewerRole = "owner";
      else if (userId && acl.find((e: AclEntry) => e.userId === userId)?.role === "editor") viewerRole = "editor";
      else if (userId && acl.find((e: AclEntry) => e.userId === userId)) viewerRole = "viewer";
      else if (accessLevel === "public") viewerRole = "public";

      sessions.push({
        sessionId,
        live: isLive,
        startedAt: meta.startedAt || new Date(0).toISOString(),
        finishedAt: meta.finishedAt,
        durationMs: meta.durationMs,
        device: {
          deviceName: meta.device?.deviceName || null,
          deviceModel: meta.device?.deviceModel || null,
          wearableType: meta.device?.wearableType || null,
        },
        segments,
        audioChunks: meta.recording?.audioChunks || 0,
        exportCached: entry.exportCached,
        hasThumbnail: entry.hasThumbnail,
        thumbnailUrl: `/session/${sessionId}/thumbnail`,
        videoUrl: `/session/${sessionId}/video.mp4?audio`,
        ownerId,
        ownerEmail,
        accessLevel,
        acl,
        viewerRole,
      });
    }
    sessions.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
    return sessions;
  }

  // --- Gallery cache (per-user, short TTL) ---

  async galleryCached(
    userId: string | undefined,
    userEmail: string | undefined,
    showAll: boolean | undefined,
    getLiveIds: () => Set<string>,
  ): Promise<GallerySession[]> {
    const cacheKey = showAll ? "__all" : (userId || "__anon");
    const now = Date.now();

    for (const [key, entry] of this.galleryCacheMap) {
      if (now >= entry.expiry) this.galleryCacheMap.delete(key);
    }
    const cached = this.galleryCacheMap.get(cacheKey);
    if (cached && now < cached.expiry) {
      const liveIds = getLiveIds();
      return cached.data.map(s => ({ ...s, live: liveIds.has(s.sessionId) }));
    }

    if (!this.galleryIndexReady) {
      await this.buildGalleryIndex();
    }

    const liveIds = getLiveIds();
    const data = this.galleryFromIndex(liveIds, userId, userEmail, showAll);
    this.galleryCacheMap.set(cacheKey, { data, expiry: now + this.GALLERY_TTL_MS });
    return data;
  }

  invalidateGalleryCache(userId?: string): void {
    if (userId) {
      this.galleryCacheMap.delete(userId);
      this.galleryCacheMap.delete("__anon");
    } else {
      this.galleryCacheMap.clear();
    }
  }

  invalidateSessionListCache(): void {
    this.sessionListCache = null;
  }

  // --- Cleanup ---

  /** Prune R2 sessions with 0 video segments (empty shells) */
  async pruneEmptyShells(): Promise<number> {
    const keys = await this.store.list("sessions/") as string[];
    const metaKeys = keys.filter(k => k.endsWith("/meta.json"));
    const videoKeys = new Set(
      keys.filter(k => k.includes("/video/") && k.endsWith(".mjpeg"))
        .map(k => { const m = k.match(/^sessions\/([^/]+)\//); return m ? m[1] : ""; })
        .filter(Boolean),
    );

    let pruned = 0;
    for (const mk of metaKeys) {
      const sessionId = mk.slice("sessions/".length, mk.length - "/meta.json".length);
      if (videoKeys.has(sessionId)) continue;

      const buf = await this.store.get(mk);
      if (!buf) continue;
      try {
        const meta = JSON.parse(new TextDecoder().decode(buf));
        const segments = meta.recording?.segmentsWritten || 0;
        if (segments > 0) continue;
      } catch { continue; }

      const sessionKeys = keys.filter(k => k.startsWith(`sessions/${sessionId}/`));
      await this.store.deleteBatch(sessionKeys);
      pruned++;
    }

    if (pruned > 0) {
      console.log(`[cleanup] Pruned ${pruned} empty shell session(s) from R2`);
      this.invalidateSessionListCache();
      this.invalidateGalleryCache();
    }
    return pruned;
  }

  // --- Background timers ---

  startBackgroundTimers(getLiveIds: () => Set<string>): void {
    // Refresh gallery index every 2 min
    setInterval(async () => {
      try {
        await this.buildGalleryIndex();
        const currentIds = new Set([...this.galleryIndex.keys()]);
        this.pruneGalleryIndex(currentIds);
      } catch (err) { console.error("[gallery-index] refresh failed:", err); }
    }, this.GALLERY_INDEX_TTL_MS);

    // One-time empty shell cleanup after 15s
    setTimeout(() => this.pruneEmptyShells(), 15_000);
  }
}
