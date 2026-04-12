/**
 * caringmind-frame-relay
 *
 * Bun WebSocket relay server (pure API — no HTML serving).
 * Viewer SPA is served by Caddy from hosted/viewer/dist.
 *
 * 1. Accepts multiple publishers (iOS apps) on separate sessions
 * 2. Fans out frames to per-session browser viewers in real-time
 * 3. Uses WASM module for frame throttling (falls back to pure JS)
 *
 * API Endpoints:
 *   /api/config              - Runtime config for SPA (auth, version)
 *   /publish?session=<id>    - WebSocket, iOS publisher connects here
 *   /view?session=<id>       - WebSocket, browser viewers connect here
 *   /tap/audio?session=<id>  - WebSocket, audio tap for AI pipeline
 *   /sessions                - JSON list of active + historical sessions
 *   /gallery/api             - JSON feed with metadata + thumbnails
 *   /session/<id>/thumbnail  - First-frame JPEG (cached to R2)
 *   /session/<id>/video.mp4  - MP4 export (cached to R2 after first build)
 *   /session/<id>/export     - JSON metadata about recorded session
 *   /session/<id>/share      - Create share token (POST)
 *   /session/<id>/shares     - List share tokens (GET)
 *   /session/<id>/access     - Update access level/ACL (PATCH)
 *   /session/<id>/audio-in   - Push audio to publisher (POST)
 *   /latest/video.mp4        - Redirect to most recent session's mp4 export
 *   /latest/export           - JSON metadata for most recent session
 *   /stats                   - JSON stats (platform-wide + per-session)
 *
 * Backward compatible: omitting ?session= routes to "default" session.
 *
 * Wire protocol (FRLY):
 *   [4B "FRLY"][8B sequence][4B width][4B height][1B quality][8B timestamp_ms][JPEG payload]
 */

import { join } from "node:path";
import os from "node:os";
import { createObjectStore, type ObjectStore } from "@ebowwa/object-store";

import type { WsData, QualityPreset, SessionRole, AccessLevel, AclEntry } from "./types.js";
import { QUALITY_PRESETS } from "./types.js";
import { isAudioFrame, isVideoFrame, parseAudioHeader } from "./protocol.js";
import { SessionRegistry } from "./session-registry.js";
import { AudioTapBus } from "./audio-tap.js";
import { verifyToken, extractToken, extractShareToken } from "./auth.js";
import {
  getSessionExportMeta,
  getSessionThumbnail,
  getCachedMp4Url,
  exportAndCacheMp4,
  getGalleryData,
  ExportError,
  type GallerySession,
} from "./session-export.js";
import {
  resolvePermission,
  hasRole,
  canSeeInGallery,
  createShareToken,
  revokeShareToken,
  listShareTokens,
} from "./permissions.js";

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

// --- Constants ---

const PORT = parseInt(process.env.RELAY_PORT || "8080");
const wifiIp = getWifiIp();
const serverStartTime = Date.now();

// --- Object Store ---

const store: ObjectStore = createObjectStore();

// --- Session Registry ---

const registry = new SessionRegistry(store);

// --- Audio Tap Bus ---
// Pluggable audio dispatch: custom taps subscribe to receive parsed audio frames.
// Built-in taps (fanout, recording) continue via their existing paths.
// Add custom taps via: audioTapBus.subscribe()

const audioTapBus = new AudioTapBus();

// --- WASM Loading ---
// Load the FrameRelay class constructor once, instantiate per-session (lazy)

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
    registry.setFrameRelayClass(FrameRelay);
    console.log("[relay] WASM FrameRelay class loaded (per-session throttle: 30 FPS)");
  } catch (err) {
    console.log("[relay] WASM load failed:", err);
    console.log("[relay] Running without WASM throttle");
  }
}

await loadWasm();

// --- Stale cleanup ---

setInterval(() => registry.cleanupStale(), 5_000);

// --- One-time empty shell cleanup (prunes R2 sessions with 0 video segments) ---

async function pruneEmptyShells(): Promise<void> {
  try {
    const keys = await store.list("sessions/") as string[];
    const metaKeys = keys.filter(k => k.endsWith("/meta.json"));
    const videoKeys = new Set(
      keys.filter(k => k.includes("/video/") && k.endsWith(".mjpeg"))
        .map(k => { const m = k.match(/^sessions\/([^/]+)\//); return m ? m[1] : ""; })
        .filter(Boolean),
    );

    let pruned = 0;
    for (const mk of metaKeys) {
      const sessionId = mk.slice("sessions/".length, mk.length - "/meta.json".length);
      if (videoKeys.has(sessionId)) continue; // has video — keep

      const buf = await store.get(mk);
      if (!buf) continue;
      try {
        const meta = JSON.parse(new TextDecoder().decode(buf));
        const segments = meta.recording?.segmentsWritten || 0;
        if (segments > 0) continue; // has segments — keep
      } catch { continue; }

      // Empty shell — delete all keys for this session
      const sessionKeys = keys.filter(k => k.startsWith(`sessions/${sessionId}/`));
      for (const sk of sessionKeys) {
        await store.delete(sk);
      }
      pruned++;
    }
    if (pruned > 0) {
      console.log(`[cleanup] Pruned ${pruned} empty shell session(s) from R2`);
      invalidateSessionListCache();
      invalidateGalleryCache();
    }
  } catch (err) {
    console.error("[cleanup] Empty shell prune failed:", err);
  }
}

// Run once after first gallery index build
setTimeout(pruneEmptyShells, 15_000);

// --- Gallery index (server-side, updated incrementally) ---

const GALLERY_INDEX_TTL_MS = 120_000; // refresh full index every 2 min

// Background gallery index refresh — keeps index warm so requests aren't blocked
setInterval(async () => {
  try {
    await buildGalleryIndex();
    const currentIds = new Set([...galleryIndex.keys()]);
    pruneGalleryIndex(currentIds);
  } catch (err) { console.error("[gallery-index] refresh failed:", err); }
}, GALLERY_INDEX_TTL_MS);

// --- Gallery index (server-side, updated incrementally) ---

// Stores parsed meta.json per session — avoids full R2 scan on every request
const galleryIndex = new Map<string, { meta: Record<string, any>; exportCached: boolean; hasThumbnail: boolean; updatedAt: number }>();
let galleryIndexReady = false;

/** Build the gallery index from R2 (parallel reads) */
async function buildGalleryIndex(): Promise<void> {
  const keys = await store.list("sessions/") as string[];
  const metaKeys = keys.filter(k => k.startsWith("sessions/") && k.endsWith("/meta.json"));
  const exportKeys = new Set(keys.filter(k => k.endsWith("/export.mp4")));
  const thumbKeys = new Set(keys.filter(k => k.endsWith("/thumb.jpg")));
  const videoKeys = keys.filter(k => k.includes("/video/") && k.endsWith(".mjpeg"));

  // Build a set of sessions that have at least one video segment or a cached thumbnail
  const sessionsWithVideo = new Set<string>();
  for (const vk of videoKeys) {
    const match = vk.match(/^sessions\/([^/]+)\/video\//);
    if (match) sessionsWithVideo.add(match[1]);
  }

  // Parallel reads — much faster than serial loop
  const entries = await Promise.all(metaKeys.map(async (mk) => {
    const sessionId = mk.slice("sessions/".length, mk.length - "/meta.json".length);
    try {
      const buf = await store.get(mk);
      if (!buf) return null;
      const meta = JSON.parse(new TextDecoder().decode(buf));
      return {
        sessionId,
        meta,
        exportCached: exportKeys.has(`sessions/${sessionId}/export.mp4`),
        hasThumbnail: thumbKeys.has(`sessions/${sessionId}/thumb.jpg`) || sessionsWithVideo.has(sessionId),
      };
    } catch { return null; }
  }));

  // Merge into index (preserve newer entries if concurrent update)
  for (const entry of entries) {
    if (!entry) continue;
    const existing = galleryIndex.get(entry.sessionId);
    if (!existing || existing.updatedAt < Date.now()) {
      galleryIndex.set(entry.sessionId, {
        meta: entry.meta,
        exportCached: entry.exportCached,
        hasThumbnail: entry.hasThumbnail,
        updatedAt: Date.now(),
      });
    }
  }
  galleryIndexReady = true;
}

/** Update a single session in the index (called when recorder finishes) */
function updateGalleryIndexEntry(sessionId: string, meta: Record<string, any>, exportCached = false, hasThumbnail = true): void {
  galleryIndex.set(sessionId, { meta, exportCached, hasThumbnail, updatedAt: Date.now() });
}

/** Remove sessions from index that no longer exist in R2 */
function pruneGalleryIndex(currentIds: Set<string>): void {
  for (const id of galleryIndex.keys()) {
    if (!currentIds.has(id)) galleryIndex.delete(id);
  }
}

/** Build a filtered GallerySession[] from the in-memory index */
function galleryFromIndex(
  liveSessionIds: Set<string>,
  userId?: string,
  userEmail?: string,
  showAll?: boolean,
): GallerySession[] {
  const sessions: GallerySession[] = [];
  for (const [sessionId, entry] of galleryIndex) {
    const meta = entry.meta;
    const accessLevel: AccessLevel = meta.accessLevel || "link";
    const acl: AclEntry[] = meta.acl || [];
    const ownerId: string | undefined = meta.ownerId;
    const ownerEmail: string | undefined = meta.ownerEmail;
    const segments: number = meta.recording?.segmentsWritten || 0;
    const isLive = liveSessionIds.has(sessionId);

    // Filter out empty shell sessions (0 segments, not live)
    if (segments === 0 && !isLive) continue;

    if (!showAll && !canSeeInGallery({ accessLevel, acl, ownerId, ownerEmail }, userId, userEmail)) continue;

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

// --- Per-user response cache (short TTL, avoids re-filtering on every request) ---

const galleryCacheMap = new Map<string, { data: GallerySession[]; expiry: number }>();
const GALLERY_TTL_MS = 30_000;

// --- Session list cache ---

let sessionListCache: { ids: string[]; expiry: number } | null = null;
const SESSION_LIST_TTL_MS = 60_000;

async function getCachedSessionIds(): Promise<string[]> {
  const now = Date.now();
  if (sessionListCache && now < sessionListCache.expiry) {
    return sessionListCache.ids;
  }
  const keys = await store.list("sessions/") as string[];
  const metaKeys = keys.filter(k => k.startsWith("sessions/") && k.endsWith("/meta.json"));
  const ids = metaKeys.map(k => k.slice("sessions/".length, k.length - "/meta.json".length));
  sessionListCache = { ids, expiry: now + SESSION_LIST_TTL_MS };
  return ids;
}

function invalidateSessionListCache(): void {
  sessionListCache = null;
}

async function galleryCached(userId?: string, userEmail?: string, showAll?: boolean): Promise<GallerySession[]> {
  const cacheKey = showAll ? "__all" : (userId || "__anon");
  const now = Date.now();

  // Evict expired per-user caches
  for (const [key, entry] of galleryCacheMap) {
    if (now >= entry.expiry) galleryCacheMap.delete(key);
  }
  const cached = galleryCacheMap.get(cacheKey);
  if (cached && now < cached.expiry) {
    const liveIds = new Set(registry.listActive().map(s => s.id));
    return cached.data.map(s => ({ ...s, live: liveIds.has(s.sessionId) }));
  }

  // Build index on first request or when stale
  if (!galleryIndexReady) {
    await buildGalleryIndex();
  }

  const liveIds = new Set(registry.listActive().map(s => s.id));
  const data = galleryFromIndex(liveIds, userId, userEmail, showAll);
  galleryCacheMap.set(cacheKey, { data, expiry: now + GALLERY_TTL_MS });
  return data;
}

/** Invalidate gallery cache for a specific user (or all) */
function invalidateGalleryCache(userId?: string): void {
  if (userId) {
    galleryCacheMap.delete(userId);
    galleryCacheMap.delete("__anon"); // anon cache may change too
  } else {
    galleryCacheMap.clear();
  }
}

// --- Helpers ---

async function findLatestSessionId(): Promise<string | null> {
  const sessionIds = await getCachedSessionIds();
  if (sessionIds.length === 0) return null;

  let latestId: string | null = null;
  let latestTime = 0;
  for (const id of sessionIds) {
    const buf = await store.get(`sessions/${id}/meta.json`);
    if (!buf) continue;
    try {
      const meta = JSON.parse(new TextDecoder().decode(buf));
      const t = new Date(meta.startedAt).getTime();
      if (t > latestTime) { latestTime = t; latestId = id; }
    } catch { console.warn(`[findLatest] Corrupt meta for session ${id}`); }
  }
  return latestId;
}

/** Filter session IDs to only those visible to a given user */
async function filterSessionIdsByVisibility(
  ids: string[],
  userId?: string,
  userEmail?: string,
): Promise<string[]> {
  const visible: string[] = [];
  for (const id of ids) {
    const buf = await store.get(`sessions/${id}/meta.json`);
    if (!buf) continue;
    try {
      const meta = JSON.parse(new TextDecoder().decode(buf));
      if (canSeeInGallery(
        { accessLevel: meta.accessLevel, acl: meta.acl, ownerId: meta.ownerId, ownerEmail: meta.ownerEmail },
        userId,
        userEmail,
      )) {
        visible.push(id);
      }
    } catch { /* skip corrupt meta */ }
  }
  return visible;
}

// --- Auth config injection into viewer HTML ---

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const NO_AUTH_FLAG = process.env.RELAY_NO_AUTH === "1";
const VIEWER_GIT_COMMIT = process.env.GIT_COMMIT?.slice(0, 7) ?? "dev";
const VIEWER_BUILD_VERSION = process.env.BUILD_VERSION ?? "dev";

// --- Auth helper for session access ---

interface SessionMetaFromR2 {
  accessLevel?: AccessLevel;
  acl?: AclEntry[];
  ownerId?: string;
  ownerEmail?: string;
}

async function getSessionMetaFromR2(sessionId: string): Promise<SessionMetaFromR2 | null> {
  const buf = await store.get(`sessions/${sessionId}/meta.json`);
  if (!buf) return null;
  try {
    return JSON.parse(new TextDecoder().decode(buf));
  } catch {
    return null;
  }
}

type AuthResult = { user: { sub: string; email: string }; role: SessionRole | "public" | "none" } | Response;

/**
 * Require session access at a minimum role level.
 * Checks live session first, then falls back to R2 meta.json.
 * Returns user+role on success, or a Response (401/403) on failure.
 */
async function requireSessionAccess(
  sessionId: string,
  req: Request,
  url: URL,
  minimumRole: SessionRole | "public",
): Promise<AuthResult> {
  const token = extractToken(req, url);
  const user = await verifyToken(token);
  const shareTok = extractShareToken(url) ?? undefined;

  // Check live session first
  const liveSession = registry.get(sessionId);
  if (liveSession) {
    const perm = await resolvePermission(
      { ownerId: liveSession.ownerId, accessLevel: liveSession.accessLevel, acl: liveSession.acl },
      user?.sub,
      shareTok,
      store,
      sessionId,
    );
    if (!perm.allowed || !hasRole(perm.role, minimumRole as SessionRole)) {
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }
    return { user: user || { sub: "", email: "" }, role: perm.role };
  }

  // Fall back to R2 meta.json for recorded sessions
  const meta = await getSessionMetaFromR2(sessionId);
  if (!meta) {
    return Response.json({ error: "Session not found" }, { status: 404 });
  }

  const perm = await resolvePermission(
    { ownerId: meta.ownerId, accessLevel: meta.accessLevel || "public", acl: meta.acl || [] },
    user?.sub,
    shareTok,
    store,
    sessionId,
  );
  if (!perm.allowed || !hasRole(perm.role, minimumRole as SessionRole)) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }
  return { user: user || { sub: "", email: "" }, role: perm.role };
}

// --- Server ---

const server = Bun.serve<WsData>({
  hostname: "0.0.0.0",
  port: PORT,
  idleTimeout: 120,
  async fetch(req, server) {
    const url = new URL(req.url, `http://${req.headers.get("host") || "localhost"}`);

    // --- Latest session (timestamp-ordered, most recent) ---

    if (url.pathname === "/latest/video.mp4") {
      const latestId = await findLatestSessionId();
      if (!latestId) {
        return Response.json({ error: "No recorded sessions" }, { status: 404 });
      }
      const proto = req.headers.get("x-forwarded-proto") || "https";
      const host = req.headers.get("host") || url.host;
      return Response.redirect(`${proto}://${host}/session/${latestId}/video.mp4?audio`);
    }

    if (url.pathname === "/latest/export") {
      const latestId = await findLatestSessionId();
      if (!latestId) {
        return Response.json({ error: "No recorded sessions" }, { status: 404 });
      }
      const meta = await getSessionExportMeta(latestId, store);
      return Response.json({ ...meta, sessionId: latestId });
    }

    // --- Stats ---

    if (url.pathname === "/stats") {
      const token = extractToken(req, url);
      const user = await verifyToken(token);
      if (!user) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      const s = await registry.stats(wifiIp, PORT, serverStartTime, store);
      return Response.json({ ...s, audioTaps: audioTapBus.tapCount() });
    }

    // --- Gallery API ---

    if (url.pathname === "/gallery/api") {
      const token = extractToken(req, url);
      const user = await verifyToken(token);
      // NO_AUTH mode: show all sessions regardless of ownership
      const showAll = NO_AUTH_FLAG;
      const userId = user?.sub;
      const recorded = await galleryCached(userId, user?.email, showAll);

      // Merge live sessions that aren't in R2 yet (apply same visibility rules)
      const r2Ids = new Set(recorded.map(s => s.sessionId));
      const liveEntries = registry.listActive()
        .filter(s => !r2Ids.has(s.id))
        .filter(s => showAll || canSeeInGallery(
          { accessLevel: s.accessLevel, acl: s.acl, ownerId: s.ownerId, ownerEmail: s.ownerEmail },
          userId,
          user?.email,
        ))
        .map(s => {
          // Determine viewer role for this live session
          let viewerRole: "owner" | "editor" | "viewer" | "public" | "none" = "none";

          if (userId && s.ownerId === userId) viewerRole = "owner";
          else if (userId && s.acl.find((e: AclEntry) => e.userId === userId)?.role === "editor") viewerRole = "editor";
          else if (userId && s.acl.find((e: AclEntry) => e.userId === userId)) viewerRole = "viewer";
          else if (s.accessLevel === "public") viewerRole = "public";

          return {
            sessionId: s.id,
            live: true,
            startedAt: new Date(Date.now() - s.uptimeMs).toISOString(),
            device: {
              deviceName: s.metadata.deviceName,
              deviceModel: s.metadata.deviceModel,
              wearableType: s.metadata.wearableType,
            },
            segments: 0,
            audioChunks: 0,
            exportCached: false,
            hasThumbnail: false,
            thumbnailUrl: `/session/${s.id}/thumbnail`,
            videoUrl: `/session/${s.id}/video.mp4?audio`,
            accessLevel: s.accessLevel as AccessLevel,
            acl: s.acl as AclEntry[],
            viewerRole,
          };
        });

      return Response.json([...liveEntries, ...recorded], {
        headers: { "Cache-Control": userId ? "private, max-age=30" : "public, max-age=30" },
      });
    }

    // --- Live Sessions (active relay sessions) ---

    if (url.pathname === "/sessions") {
      const token = extractToken(req, url);
      const user = await verifyToken(token);
      if (!user) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }

      const active = registry.listActive();
      const showAll = NO_AUTH_FLAG;

      // Filter active sessions by visibility
      const visibleActive = showAll ? active : active.filter(s =>
        canSeeInGallery(
          { accessLevel: s.accessLevel, acl: s.acl, ownerId: s.ownerId, ownerEmail: s.ownerEmail },
          user.sub,
          user.email,
        ),
      );

      // Use cached session list instead of scanning all R2 keys
      const historicalSessionIds = await getCachedSessionIds();

      // Filter historical sessions by ownership
      const visibleHistorical = showAll ? historicalSessionIds : await filterSessionIdsByVisibility(
        historicalSessionIds, user.sub, user.email,
      );

      // Combine: active sessions (with live metadata) + historical (id only)
      const activeIds = new Set(visibleActive.map(s => s.id));
      const result = [
        ...visibleActive.map(s => ({
          id: s.id,
          live: true,
          publisherConnected: s.publisherConnected,
          viewerCount: s.viewerCount,
          metadata: s.metadata,
          uptimeMs: s.uptimeMs,
        })),
        ...visibleHistorical
          .filter(id => !activeIds.has(id))
          .map(id => ({ id, live: false })),
      ];
      return Response.json(result);
    }

    // --- Share token management: POST /session/{id}/share ---

    const shareCreateMatch = url.pathname.match(/^\/session\/([^/]+)\/share$/);
    if (shareCreateMatch && req.method === "POST") {
      const sessionId = shareCreateMatch[1];
      const token = extractToken(req, url);
      const user = await verifyToken(token);
      if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

      const authResult = await requireSessionAccess(sessionId, req, url, "editor");
      if (authResult instanceof Response) return authResult;

      try {
        const body = await req.json() as { expiresAt?: string };
        const expiresAt = body.expiresAt || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
        const shareToken = await createShareToken(sessionId, user.sub, expiresAt, store);
        return Response.json(shareToken, { status: 201 });
      } catch {
        return Response.json({ error: "Invalid request body" }, { status: 400 });
      }
    }

    // --- Revoke share token: DELETE /session/{id}/share/{token} ---

    const shareRevokeMatch = url.pathname.match(/^\/session\/([^/]+)\/share\/(shr_[^/]+)$/);
    if (shareRevokeMatch && req.method === "DELETE") {
      const sessionId = shareRevokeMatch[1];
      const tokenStr = shareRevokeMatch[2];
      const token = extractToken(req, url);
      const user = await verifyToken(token);
      if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

      const authResult = await requireSessionAccess(sessionId, req, url, "owner");
      if (authResult instanceof Response) return authResult;

      const revoked = await revokeShareToken(sessionId, tokenStr, store);
      if (!revoked) return Response.json({ error: "Token not found" }, { status: 404 });
      return Response.json({ ok: true });
    }

    // --- List share tokens: GET /session/{id}/shares ---

    const shareListMatch = url.pathname.match(/^\/session\/([^/]+)\/shares$/);
    if (shareListMatch && req.method === "GET") {
      const sessionId = shareListMatch[1];
      const token = extractToken(req, url);
      const user = await verifyToken(token);
      if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

      const authResult = await requireSessionAccess(sessionId, req, url, "editor");
      if (authResult instanceof Response) return authResult;

      const tokens = await listShareTokens(sessionId, store);
      return Response.json(tokens);
    }

    // --- Update access level/ACL: PATCH /session/{id}/access ---

    const accessMatch = url.pathname.match(/^\/session\/([^/]+)\/access$/);
    if (accessMatch && req.method === "PATCH") {
      const sessionId = accessMatch[1];
      const token = extractToken(req, url);
      const user = await verifyToken(token);
      if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

      const authResult = await requireSessionAccess(sessionId, req, url, "owner");
      if (authResult instanceof Response) return authResult;

      try {
        const body = await req.json() as { accessLevel?: AccessLevel; acl?: AclEntry[] };

        // Update live session if active
        const liveSession = registry.get(sessionId);
        if (liveSession) {
          if (body.accessLevel) {
            liveSession.accessLevel = body.accessLevel;
            liveSession.metadata.accessLevel = body.accessLevel;
          }
          if (body.acl) {
            liveSession.acl = body.acl;
            liveSession.metadata.acl = body.acl;
          }
          // Sync to recorder
          if (liveSession.recorder) {
            if (body.accessLevel) liveSession.recorder.accessLevel = body.accessLevel;
            if (body.acl) liveSession.recorder.acl = body.acl;
          }
        }

        // Update R2 meta.json
        const metaBuf = await store.get(`sessions/${sessionId}/meta.json`);
        if (metaBuf) {
          const meta = JSON.parse(new TextDecoder().decode(metaBuf));
          if (body.accessLevel) meta.accessLevel = body.accessLevel;
          if (body.acl) meta.acl = body.acl;
          await store.put(`sessions/${sessionId}/meta.json`, Buffer.from(JSON.stringify(meta, null, 2)));
        }

        invalidateGalleryCache();
        invalidateSessionListCache();
        return Response.json({ ok: true });
      } catch {
        return Response.json({ error: "Invalid request body" }, { status: 400 });
      }
    }

    // --- Push audio to publisher: POST /session/<id>/audio-in ---

    const audioInMatch = url.pathname.match(/^\/session\/([^/]+)\/audio-in$/);
    if (audioInMatch && req.method === "POST") {
      const sessionId = audioInMatch[1];
      const authResult = await requireSessionAccess(sessionId, req, url, "editor");
      if (authResult instanceof Response) return authResult;

      const buf = await req.arrayBuffer();
      if (buf.byteLength < 29) return Response.json({ error: "Payload too small" }, { status: 400 });

      const data = new Uint8Array(buf);
      if (!isAudioFrame(data)) return Response.json({ error: "Not a FRAU frame" }, { status: 400 });

      const audioHdr = parseAudioHeader(data);

      // Record inbound audio to session
      const session = registry.get(sessionId);
      session?.recorder?.appendAudio(data);

      // Fan out to viewers so they hear it too
      registry.fanoutAudio(sessionId, data, audioHdr?.codecType ?? 3, audioHdr?.sampleRate ?? 22050);

      // Push to publisher for local playback
      const sent = registry.sendToPublisher(sessionId, data);
      if (!sent) return Response.json({ error: "No connected publisher" }, { status: 404 });

      return Response.json({ ok: true, bytes: data.length });
    }

    // --- Session Thumbnail ---

    const thumbMatch = url.pathname.match(/^\/session\/([^/]+)\/thumbnail$/);
    if (thumbMatch) {
      const sessionId = thumbMatch[1];
      // Auth gate: require at least viewer role (public sessions allowed without auth)
      const authResult = await requireSessionAccess(sessionId, req, url, "viewer");
      if (authResult instanceof Response) return authResult;

      try {
        const jpeg = await getSessionThumbnail(sessionId, store);
        if (!jpeg) return Response.json({ error: "No video data" }, { status: 404 });
        return new Response(new Uint8Array(jpeg), {
          headers: {
            "Content-Type": "image/jpeg",
            "Cache-Control": "public, max-age=86400",
          },
        });
      } catch (err) {
        console.error("[thumbnail]", err);
        return Response.json({ error: "Thumbnail failed" }, { status: 500 });
      }
    }

    // --- Session Export (mp4) — serves cached R2 version or builds + caches ---

    const mp4Match = url.pathname.match(/^\/session\/([^/]+)\/video\.mp4$/);
    if (mp4Match) {
      const sessionId = mp4Match[1];
      // Auth gate: require at least viewer role
      const authResult = await requireSessionAccess(sessionId, req, url, "viewer");
      if (authResult instanceof Response) return authResult;

      const includeAudio = url.searchParams.has("audio");
      try {
        // Serve from R2 cache if available — proxy through server to avoid
        // cross-origin redirect issues (R2 signed URLs are different origin).
        const cachedUrl = await getCachedMp4Url(sessionId, store);
        if (cachedUrl) {
          console.log(`[export] Proxying cached MP4 for ${sessionId.slice(0, 8)}`);
          const mp4Resp = await fetch(cachedUrl);
          if (mp4Resp.ok) {
            return new Response(mp4Resp.body, {
              headers: {
                "Content-Type": "video/mp4",
                "Content-Length": mp4Resp.headers.get("content-length") || "",
                "Cache-Control": "public, max-age=3600",
              },
            });
          }
          // R2 fetch failed — fall through to rebuild
          console.warn(`[export] R2 cache fetch failed (${mp4Resp.status}), rebuilding`);
        }
        // Build, stream to client, and persist to R2
        return await exportAndCacheMp4({ sessionId, store, includeAudio });
      } catch (err) {
        if (err instanceof ExportError) {
          return Response.json({ error: err.message }, { status: err.status });
        }
        console.error("[export] Unexpected error:", err);
        return Response.json({ error: "Export failed" }, { status: 500 });
      }
    }

    // --- Session Export Metadata ---

    const exportMetaMatch = url.pathname.match(/^\/session\/([^/]+)\/export$/);
    if (exportMetaMatch) {
      const sessionId = exportMetaMatch[1];
      // Auth gate: require at least viewer role
      const authResult = await requireSessionAccess(sessionId, req, url, "viewer");
      if (authResult instanceof Response) return authResult;

      const meta = await getSessionExportMeta(sessionId, store);
      return Response.json(meta);
    }

    // --- S3 Retrieval Endpoints (auth-gated) ---

    const videoMatch = url.pathname.match(/^\/session\/([^/]+)\/video\/(.+)$/);
    if (videoMatch) {
      const [, id, seg] = videoMatch;
      const authResult = await requireSessionAccess(id, req, url, "viewer");
      if (authResult instanceof Response) return authResult;

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
      const authResult = await requireSessionAccess(id, req, url, "viewer");
      if (authResult instanceof Response) return authResult;

      const key = `sessions/${id}/audio/${chunk}`;
      try {
        const signed = await store.signedUrl(key, 3600);
        return Response.redirect(signed);
      } catch {
        return Response.json({ error: "Not found" }, { status: 404 });
      }
    }

    // --- Runtime config for SPA ---

    if (url.pathname === "/api/config") {
      return Response.json({
        googleClientId: GOOGLE_CLIENT_ID,
        noAuth: NO_AUTH_FLAG,
        version: { gitCommit: VIEWER_GIT_COMMIT, buildVersion: VIEWER_BUILD_VERSION },
      });
    }

    // --- Audio tap WebSocket: /tap/audio?session=<id> ---

    if (url.pathname === "/tap/audio") {
      const token = extractToken(req, url);
      const user = await verifyToken(token);
      if (!user) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      const sessionId = url.searchParams.get("session") || "default";
      const clientIp = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
        || req.headers.get("x-real-ip")
        || "unknown";
      server.upgrade(req, { data: { role: "audio-tap", clientIp, sessionId, userId: user.sub, email: user.email } });
      return new Response(null, { status: 204 });
    }

    // --- /view as HTML page (browser GET) or WebSocket upgrade ---

    const isPublish = url.pathname === "/publish";
    const isView = url.pathname === "/view";
    if (!isPublish && !isView) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    // Viewer page now served by Caddy (SPA) — only handle WebSocket upgrades
    const wsUpgrade = req.headers.get("upgrade")?.toLowerCase() === "websocket";
    if (isView && !wsUpgrade) {
      const proto = req.headers.get("x-forwarded-proto") || "https";
      const host = req.headers.get("host") || url.host;
      return Response.redirect(`${proto}://${host}/`);
    }

    const role = isPublish ? "publish" : "view";
    const sessionId = registry.resolveSessionId(url);
    const clientIp = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
      || req.headers.get("x-real-ip")
      || "unknown";
    const shareTok = extractShareToken(url);

    // Auth: accept token from query param (backward compat) or defer to hello message
    const token = extractToken(req, url);
    const user = token ? await verifyToken(token) : null;
    // If no token in URL, upgrade will succeed but viewer/publisher auth is deferred
    // to the hello message handler which sends the token
    if (!user && !NO_AUTH_FLAG) {
      // Allow upgrade without token — auth will be verified on hello message
      server.upgrade(req, { data: { role, clientIp, sessionId, userId: undefined, email: undefined, shareToken: shareTok || undefined, authPending: true } });
      return new Response(null, { status: 204 });
    }

    server.upgrade(req, { data: { role, clientIp, sessionId, userId: user?.sub, email: user?.email, shareToken: shareTok || undefined, authPending: false } });
    return new Response(null, { status: 204 });
  },
  websocket: {
    async open(ws) {
      const { role, clientIp, sessionId, authPending } = ws.data;

      // If auth is deferred to hello message, don't register yet
      if (authPending) {
        console.log(`[relay] ${role} connected (auth pending) session=${sessionId}`);
        return;
      }

      if (role === "audio-tap") {
        const unsub = audioTapBus.onFrame((frame) => {
          if (ws.readyState !== WebSocket.OPEN) { unsub(); return; }
          // Send binary FRAU frame (raw PCM) instead of base64 JSON for efficiency
          // Reconstruct the original binary frame from the parsed AudioFrame
          const pcmLen = frame.pcm.length;
          const buf = new ArrayBuffer(29 + pcmLen);
          const view = new DataView(buf);
          // Magic "FRAU"
          view.setUint8(0, 0x46); view.setUint8(1, 0x52);
          view.setUint8(2, 0x41); view.setUint8(3, 0x55);
          view.setUint8(4, frame.codecType);
          view.setBigUint64(5, BigInt(frame.sequence), true);
          view.setUint32(13, frame.sampleRate, true);
          view.setUint16(17, frame.channels, true);
          view.setUint16(19, frame.bitsPerSample, true);
          view.setBigUint64(21, BigInt(frame.timestampMs), true);
          new Uint8Array(buf, 29).set(frame.pcm);
          ws.send(new Uint8Array(buf));
        });
        ws.data = { ...ws.data, unsub };
        console.log(`[relay] Audio tap connected: session=${sessionId} taps=${audioTapBus.tapCount()}`);
        return;
      }

      if (role === "publish") {
        const err = registry.claimPublisher(sessionId, ws, clientIp, ws.data.userId, ws.data.email);
        if (err) {
          ws.close(err === "session owned by another user" ? 4003 : 4001, err);
          return;
        }
      } else {
        const result = await registry.addViewer(sessionId, ws, clientIp, ws.data.userId, ws.data.email, ws.data.shareToken);
        if (result.startsWith("error:")) {
          ws.close(4003, result.slice(6));
          return;
        }
      }
    },
    async message(ws, message) {
      const { role, sessionId, authPending } = ws.data;

      // Handle deferred auth: verify token sent in hello message
      if (authPending && typeof message === "string") {
        try {
          const cmd = JSON.parse(message);
          if (cmd.type === "hello") {
            const token = cmd.token || "";
            const shareTok = cmd.shareToken || ws.data.shareToken;
            const user = await verifyToken(token);

            // Allow publishers without auth (iOS client doesn't send tokens yet)
            if (!user && role !== "publish") {
              ws.close(4001, "auth failed");
              return;
            }

            ws.data.userId = user?.sub;
            ws.data.email = user?.email;
            ws.data.shareToken = shareTok || undefined;
            ws.data.authPending = false;

            // Now register the connection
            if (role === "publish") {
              const err = registry.claimPublisher(sessionId, ws, ws.data.clientIp, user?.sub, user?.email);
              if (err) {
                ws.close(err === "session owned by another user" ? 4003 : 4001, err);
                return;
              }
              // Process hello fields
              const session = registry.get(sessionId);
              if (session?.publisher) {
                const MAX_FIELD_LEN = 256;
                const strField = (v: unknown): string | null => {
                  if (typeof v !== "string") return null;
                  const trimmed = v.slice(0, MAX_FIELD_LEN);
                  return trimmed || null;
                };
                session.publisher.deviceId = strField(cmd.deviceId);
                session.publisher.deviceName = strField(cmd.deviceName);
                session.publisher.wearableId = strField(cmd.wearableId);
                session.publisher.wearableType = strField(cmd.wearableType);
                session.publisher.deviceModel = strField(cmd.deviceModel);
                session.publisher.systemVersion = strField(cmd.systemVersion);
                session.publisher.appVersion = strField(cmd.appVersion);
                session.publisher.buildNumber = strField(cmd.buildNumber);
                session.metadata.deviceName = strField(cmd.deviceName);
                session.metadata.deviceModel = strField(cmd.deviceModel);
                session.metadata.deviceId = strField(cmd.deviceId);
                session.metadata.systemVersion = strField(cmd.systemVersion);
                session.metadata.wearableType = strField(cmd.wearableType);
                console.log(`[relay] Publisher hello: device=${cmd.deviceName || "?"} wearable=${cmd.wearableType || "none"} ip=${ws.data.clientIp} session=${sessionId}`);
                if (session.recorder) {
                  session.recorder.deviceInfo = {
                    deviceId: cmd.deviceId || null,
                    deviceName: cmd.deviceName || null,
                    wearableId: cmd.wearableId || null,
                    wearableType: cmd.wearableType || null,
                    deviceModel: cmd.deviceModel || null,
                    systemVersion: cmd.systemVersion || null,
                  };
                  session.recorder.accessLevel = session.accessLevel;
                  session.recorder.acl = session.acl;
                  session.recorder.ownerId = session.ownerId;
                  session.recorder.ownerEmail = session.ownerEmail;
                }
              }
            } else if (role === "view") {
              const result = await registry.addViewer(sessionId, ws, ws.data.clientIp, user?.sub, user?.email, shareTok);
              if (result.startsWith("error:")) {
                ws.close(4003, result.slice(6));
                return;
              }
              // Store viewer version info
              const viewerId = ws.data.viewerId;
              if (viewerId) {
                const found = registry.findViewerSession(viewerId);
                if (found) {
                  found.viewer.gitCommit = cmd.gitCommit || null;
                  found.viewer.buildVersion = cmd.buildVersion || null;
                }
              }
            }
            return;
          }
        } catch {
          ws.close(4001, "invalid hello");
          return;
        }
        // Any non-hello message before auth is rejected
        ws.close(4001, "auth required");
        return;
      }

      const session = registry.get(sessionId);
      if (!session) return;

      if (role === "publish" && session.publisher?.ws === ws) {
        if (typeof message === "string") {
          // Publisher JSON control messages
          try {
            const cmd = JSON.parse(message);
            if (cmd.type === "hello" && session.publisher) {
              const MAX_FIELD_LEN = 256;
              const strField = (v: unknown): string | null => {
                if (typeof v !== "string") return null;
                const trimmed = v.slice(0, MAX_FIELD_LEN);
                return trimmed || null;
              };
              session.publisher.deviceId = strField(cmd.deviceId);
              session.publisher.deviceName = strField(cmd.deviceName);
              session.publisher.wearableId = strField(cmd.wearableId);
              session.publisher.wearableType = strField(cmd.wearableType);
              session.publisher.deviceModel = strField(cmd.deviceModel);
              session.publisher.systemVersion = strField(cmd.systemVersion);
              session.publisher.appVersion = strField(cmd.appVersion);
              session.publisher.buildNumber = strField(cmd.buildNumber);

              // Update session metadata
              session.metadata.deviceName = strField(cmd.deviceName);
              session.metadata.deviceModel = strField(cmd.deviceModel);
              session.metadata.deviceId = strField(cmd.deviceId);
              session.metadata.systemVersion = strField(cmd.systemVersion);
              session.metadata.wearableType = strField(cmd.wearableType);

              console.log(`[relay] Publisher hello: device=${session.publisher.deviceName || "?"} wearable=${session.publisher.wearableType || "none"} ip=${session.publisher.clientIp} session=${sessionId}`);

              // Update recorder device info
              if (session.recorder) {
                session.recorder.deviceInfo = {
                  deviceId: strField(cmd.deviceId),
                  deviceName: strField(cmd.deviceName),
                  wearableId: strField(cmd.wearableId),
                  wearableType: strField(cmd.wearableType),
                  deviceModel: strField(cmd.deviceModel),
                  systemVersion: strField(cmd.systemVersion),
                };
                // Sync access control to recorder
                session.recorder.accessLevel = session.accessLevel;
                session.recorder.acl = session.acl;
                session.recorder.ownerId = session.ownerId;
                session.recorder.ownerEmail = session.ownerEmail;
              }
            }
          } catch (err) { console.warn("[relay] Publisher hello parse error:", err); }
        } else {
          // Binary frame (Uint8Array in Bun)
          const buf = message as Uint8Array;

          if (isAudioFrame(buf)) {
            // Audio frame (FRAU)
            session.publisher.audioCount++;
            session.publisher.audioBytes += buf.length;
            const audioHdr = parseAudioHeader(buf);
            registry.fanoutAudio(sessionId, buf, audioHdr?.codecType ?? 0, audioHdr?.sampleRate ?? 0);
            session.recorder?.appendAudio(buf);
            audioTapBus.publish(buf);
          } else if (isVideoFrame(buf)) {
            // Video frame (FRLY)
            session.publisher.frameCount++;
            session.publisher.totalBytes += buf.length;
            registry.fanout(sessionId, buf);
            session.recorder?.appendVideo(buf);
          }
        }
      } else if (role === "view") {
        // Viewer control messages
        if (typeof message === "string") {
          try {
            const cmd = JSON.parse(message);
            if (cmd.type === "stats") {
              const s = await registry.stats(wifiIp, PORT, serverStartTime);
              ws.send(JSON.stringify({ type: "stats", ...s }));
            } else if (cmd.type === "hello") {
              // Viewer identity — store version info
              const viewerId = ws.data.viewerId;
              if (viewerId) {
                const found = registry.findViewerSession(viewerId);
                if (found) {
                  found.viewer.gitCommit = cmd.gitCommit || null;
                  found.viewer.buildVersion = cmd.buildVersion || null;
                }
              }
            } else if (cmd.type === "config" && cmd.quality && cmd.quality in QUALITY_PRESETS) {
              const viewerId = ws.data.viewerId;
              if (!viewerId) return;
              const found = registry.findViewerSession(viewerId);
              if (found) {
                const newQuality = cmd.quality as QualityPreset;
                found.viewer.quality = newQuality;
                console.log(`[relay] Viewer ${viewerId.slice(0, 8)} quality: ${newQuality} (${QUALITY_PRESETS[newQuality].maxFps} FPS)`);
                ws.send(JSON.stringify({
                  type: "quality",
                  preset: newQuality,
                  maxFps: QUALITY_PRESETS[newQuality].maxFps,
                  label: QUALITY_PRESETS[newQuality].label,
                }));
              }
            }
          } catch (err) { console.warn("[relay] Viewer message parse error:", err); }
        } else {
          // Binary frame from viewer — forward FRAU audio to publisher
          const buf = message as Uint8Array;
          if (isAudioFrame(buf)) {
            const viewerId = ws.data.viewerId;
            if (viewerId) {
              const found = registry.findViewerSession(viewerId);
              if (found && found.session.publisher) {
                found.session.publisher.ws.send(buf);
              }
            }
          }
        }
      }
    },
    async close(ws) {
      const { role, sessionId } = ws.data;

      if (role === "audio-tap") {
        if (ws.data.unsub) ws.data.unsub();
        console.log(`[relay] Audio tap disconnected: session=${sessionId} taps=${audioTapBus.tapCount()}`);
        return;
      }

      if (role === "publish") {
        await registry.releasePublisher(sessionId);
        // Update gallery index incrementally and generate thumbnail
        try {
          const metaBuf = await store.get(`sessions/${sessionId}/meta.json`);
          if (metaBuf) {
            const meta = JSON.parse(new TextDecoder().decode(metaBuf));
            const exportCached = (await store.list(`sessions/${sessionId}/`)).includes(`sessions/${sessionId}/export.mp4`);
            updateGalleryIndexEntry(sessionId, meta, exportCached);
          }
        } catch { /* non-critical */ }
        // Generate thumbnail in background — don't block disconnect
        getSessionThumbnail(sessionId, store).catch(() => {});
        invalidateGalleryCache();
        invalidateSessionListCache();
      } else {
        const viewerId = ws.data.viewerId;
        if (viewerId) {
          registry.removeViewer(sessionId, viewerId);
        }
      }
    },
  },
});

console.log(`[relay] Server on 0.0.0.0:${PORT}`);
console.log(`[relay] Publisher: ws://${wifiIp}:${PORT}/publish[?session=<id>]`);
console.log(`[relay] Viewer:   http://${wifiIp}:${PORT}/ (served by Caddy)`);
console.log(`[relay] API:      http://${wifiIp}:${PORT}/api/config`);
