# R2 Bucket Data Handling Bugs

**Audited:** 2026-04-13
**Scope:** `hosted/server/src/` — server.ts, session-registry.ts, session-recorder.ts, session-export.ts
**Status:** Identified, unfixed

---

## Context: `sessionId` vs `recordingId`

Two different IDs are used throughout the codebase, and confusing them is the root cause of most bugs:

| ID | Source | Purpose | Example |
|----|--------|---------|---------|
| `session.id` | WebSocket `?session=` param (or `"default"`) | Live session routing, WebSocket connection grouping | `abc123...` |
| `session.recordingId` | `crypto.randomUUID()` in `claimPublisher()` | R2 object prefix — stable across publisher reconnects | `def456...` |

These are **always different UUIDs**. The recorder (`SessionRecorder`) receives `recordingId` as its constructor argument and uses it for all R2 keys. All HTTP endpoints and gallery entries use whichever ID they extract from the URL.

**Where `recordingId` is set:** `session-registry.ts:160-162`

```typescript
if (!session.recordingId) {
  session.recordingId = crypto.randomUUID();
}
session.recorder = new SessionRecorder(session.recordingId, this.store);
```

**Where `session.id` is set:** `session-registry.ts:47-51`

```typescript
getOrCreate(id: string): Session {
  // id comes from ?session= URL param or defaults to "default"
  session = { id, ... };
}
```

**What R2 keys look like:** `sessions/{recordingId}/video/seg-0001.mjpeg`

---

## Bug 1: Live session gallery entries use wrong ID (HIGH)

**Location:** `server.ts:540-576`
**Impact:** Duplicate gallery entries, broken thumbnail/video URLs for live sessions

### What happens

When the gallery API merges live sessions into the response, it uses `s.id` (WebSocket session ID) for everything:

```typescript
// server.ts:540-541
const r2Ids = new Set(recorded.map(s => s.sessionId)); // contains recordingIds from R2
const liveEntries = registry.listActive()
  .filter(s => !r2Ids.has(s.id))  // s.id is WebSocket session ID, never matches recordingId
```

```typescript
// server.ts:558, 570-571
sessionId: s.id,                          // wrong — should be s.recordingId if available
thumbnailUrl: `/session/${s.id}/thumbnail`, // wrong — R2 data is under recordingId
videoUrl: `/session/${s.id}/video.mp4?audio`, // wrong — same issue
```

### Consequences

1. **Duplicate entries** — After the first 10s flush, recording data appears in R2 under `recordingId`. The gallery index picks it up. But the live session entry uses `s.id`, which doesn't match any R2 key. So the dedup filter fails and the gallery shows two entries for the same recording.

2. **Broken URLs** — Thumbnail and video URLs for the live entry point to `/session/${s.id}/...`, but R2 data is under `sessions/${recordingId}/...`. When the viewer hits these URLs, `requireSessionAccess` looks for `sessions/${s.id}/meta.json` in R2 and gets 404.

### Root cause

`listActive()` does not expose `recordingId`:

```typescript
// session-registry.ts:436-446
listActive(): Array<{ id: string; ... }> {
  return [...this.sessions.values()].map(s => ({
    id: s.id,
    // recordingId is not included
  }));
}
```

### Fix

1. Add `recordingId` to the `listActive()` return type
2. In gallery merge, use `s.recordingId` for dedup and URLs when available
3. Fall back to `s.id` only for sessions that have never been recorded

---

## Bug 2: Access update writes to wrong R2 key (MEDIUM)

**Location:** `server.ts:720-725`
**Impact:** Orphaned meta.json files in R2, access level not persisted for live sessions

### What happens

The `PUT /session/{id}/access` endpoint extracts `sessionId` from the URL and writes to R2:

```typescript
// server.ts:720-725
const metaBuf = await store.get(`sessions/${sessionId}/meta.json`);
if (metaBuf) {
  const meta = JSON.parse(new TextDecoder().decode(metaBuf));
  if (body.accessLevel) meta.accessLevel = body.accessLevel;
  if (body.acl) meta.acl = body.acl;
  await store.put(`sessions/${sessionId}/meta.json`, Buffer.from(JSON.stringify(meta, null, 2)));
}
```

If the URL contains a WebSocket session ID (from a gallery live entry), this writes to `sessions/{ws-session-id}/meta.json` instead of `sessions/{recordingId}/meta.json`. The real R2 data is untouched.

### Mitigating factors

- The live session's in-memory access level IS updated correctly (line 704-716)
- The recorder's access level IS synced (line 713-715)
- When the recorder calls `writeMeta()`, it uses `this.sessionId` (which is `recordingId`), so the final R2 write is correct
- However, an orphaned `meta.json` is left at the wrong key

### Fix

When updating R2 for a live session, resolve the correct R2 key via `session.recordingId`:

```typescript
const liveSession = registry.get(sessionId);
const r2Key = liveSession?.recordingId
  ? `sessions/${liveSession.recordingId}/meta.json`
  : `sessions/${sessionId}/meta.json`;
```

---

## Bug 3: `getCachedMp4Url()` does expensive `store.list()` for existence check (LOW)

**Location:** `session-export.ts:106-116`
**Impact:** Unnecessary R2 list operation (returns all objects under prefix) on every MP4 request

### What happens

```typescript
export async function getCachedMp4Url(sessionId: string, store: ObjectStore): Promise<string | null> {
  const key = `sessions/${sessionId}/export.mp4`;
  const keys = await store.list(`sessions/${sessionId}/`);  // lists ALL objects
  if (!keys.includes(key)) return null;
  // ...
}
```

This lists every object under `sessions/{id}/` (potentially hundreds of segments and chunks) just to check if one file exists.

### Fix

Use `store.get()` or a HEAD request:

```typescript
export async function getCachedMp4Url(sessionId: string, store: ObjectStore): Promise<string | null> {
  const key = `sessions/${sessionId}/export.mp4`;
  try {
    // Try to get the object directly — returns null if not found
    const exists = await store.get(key);
    if (!exists) return null;
    return await store.signedUrl(key, 3600);
  } catch {
    return null;
  }
}
```

Or if `@ebowwa/object-store` supports a head/exists method, use that instead.

---

## Bug 4: `getGalleryData()` is dead code (CLEANUP)

**Location:** `session-export.ts:275-348`
**Impact:** Misleading — 74 lines of code that look active but are never called

### What happens

The function `getGalleryData()` does a full R2 scan with serial meta.json reads to build gallery data. It was the original gallery implementation.

The server switched to an index-based approach:

```
galleryCached() → buildGalleryIndex() → galleryFromIndex()
```

But `getGalleryData()` was never removed. It still does full R2 scans on every call if invoked.

### Verification

```bash
grep -r "getGalleryData" hosted/server/src/
# session-export.ts:275  export async function getGalleryData(
# (no other files import or call it)
```

### Fix

Remove the function entirely, or mark it `@deprecated` if kept for reference.

---

## Bug 5: Gallery index merge condition is always true (NO-OP)

**Location:** `server.ts:220-232`
**Impact:** None — works correctly, but the "preserve newer entries" comment is misleading

### What happens

```typescript
// server.ts:224
const existing = galleryIndex.get(entry.sessionId);
if (!existing || existing.updatedAt < Date.now()) {
  // always true — updatedAt was set to a past Date.now()
  galleryIndex.set(entry.sessionId, { ... });
}
```

`existing.updatedAt` was set during a previous `buildGalleryIndex()` call. Since `Date.now()` always increases, `existing.updatedAt < Date.now()` is always true. The condition effectively becomes `if (!existing || true)`, which always overwrites.

### Why it doesn't matter

`buildGalleryIndex()` is the only writer to the index. It runs on a 2-minute interval. There's no concurrent writer that could create a "newer" entry. The overwrite is the desired behavior.

### Fix (cosmetic)

Either:
- Remove the condition entirely (just always set)
- Or change the comment to match reality: "always update from fresh R2 scan"

---

## Bug 6: `requireSessionAccess` R2 fallback uses URL session ID (MEDIUM)

**Location:** `server.ts:468-479`
**Impact:** 404 for viewers trying to access recorded sessions via WebSocket session ID

### What happens

```typescript
// server.ts:453
const liveSession = registry.get(sessionId);  // checks by WebSocket session ID
if (liveSession) { /* check live permissions */ }

// server.ts:469 — fallback for recorded sessions
const meta = await getSessionMetaFromR2(sessionId);  // looks up sessions/${sessionId}/meta.json
```

For live sessions, `registry.get(sessionId)` finds the session by its WebSocket ID. This works.

For recorded sessions (session no longer in memory), the fallback reads `sessions/${sessionId}/meta.json` from R2. If `sessionId` came from a gallery entry, it IS the `recordingId` (gallery uses R2 key prefixes), so this works.

But if `sessionId` came from a live session's URL (which uses the WebSocket ID), and the session has since gone offline, the R2 lookup fails because R2 uses `recordingId`.

### Scenario

1. Publisher starts recording — gallery shows live entry with `sessionId = ws-id`
2. Viewer opens the live session — works (in-memory)
3. Publisher disconnects — session evicted from memory after 60s
4. Viewer refreshes page — tries `/session/ws-id/thumbnail` — R2 lookup for `sessions/ws-id/meta.json` fails — 404

### Fix

Maintain a mapping from WebSocket session ID to recordingId, or ensure gallery entries always use recordingId (see Bug 1 fix).

---

## Summary Table

| # | Bug | Severity | Location | Status |
|---|-----|----------|----------|--------|
| 1 | Live gallery entries use wrong ID | HIGH | `server.ts:540-576` | Unfixed |
| 2 | Access update writes to wrong R2 key | MEDIUM | `server.ts:720-725` | Unfixed |
| 3 | Expensive `store.list()` for MP4 cache check | LOW | `session-export.ts:106-116` | Unfixed |
| 4 | Dead code `getGalleryData()` | CLEANUP | `session-export.ts:275-348` | Unfixed |
| 5 | Gallery merge condition always true | NO-OP | `server.ts:220-232` | Unfixed |
| 6 | R2 fallback fails for expired live sessions | MEDIUM | `server.ts:468-479` | Unfixed |

### Dependencies

Bug 1 and Bug 6 share the same root cause: the codebase conflates WebSocket `session.id` with R2 `recordingId`. Fixing Bug 1 (exposing `recordingId` from `listActive()` and using it in gallery entries) would also fix Bug 6, because gallery URLs would then consistently use `recordingId`.

### Recommended fix order

1. **Bug 1** — Expose `recordingId` from `listActive()`, use it in gallery merge. This fixes Bugs 1 and 6.
2. **Bug 2** — Resolve correct R2 key via `recordingId` in access update.
3. **Bug 3** — Replace `store.list()` with `store.get()` in MP4 cache check.
4. **Bug 4** — Remove dead code.
5. **Bug 5** — Cosmetics only.
