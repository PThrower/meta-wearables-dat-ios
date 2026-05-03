# PRD-015: Tiered Auth & Share Tokens for Recording Access

**Product:** com.mwdat-ios / Relay Platform Auth
**Owner:** @ebowwa
**Status:** P0 Complete (implemented)
**Last Updated:** 2026-04-10
**Depends On:** PRD-002 (Relay Platform), PRD-005 (Browser Viewer), PRD-007 (Auth)
**Aligns With:** PRD-013 (API Surface -- auth middleware migrates to new routes when that lands)

---

## Problem

The relay server streams live video from smart glasses and records sessions to R2 (Cloudflare object storage). Google OAuth protects `/stats`, WebSocket publish/view/audio-tap endpoints. But **all recording routes are unauthenticated**:

- `GET /gallery/api` -- returns every recorded session's metadata (no auth)
- `GET /sessions` -- lists active + historical sessions (no auth)
- `GET /session/{id}/thumbnail` -- first-frame JPEG (no auth)
- `GET /session/{id}/video.mp4` -- full MP4 download (no auth)
- `GET /session/{id}/export` -- JSON metadata (no auth)
- `GET /session/{id}` -- viewer HTML page (no auth)

Any person who discovers `relay.simulationapi.com` can browse every recording, download every MP4, and view every thumbnail.

The `Session` type has a binary `isPublic: boolean` -- no permission tiers, no sharing mechanism, no invite system, no time-limited access.

---

## Users

| Persona | Description | Primary Need |
|---------|-------------|--------------|
| **Session Owner** | Person wearing glasses / streaming | Own their recordings; control who sees them; share via time-limited links |
| **Editor** | Trusted collaborator | View owner's sessions; create share links; appear in gallery |
| **Viewer** | Person given a share link | Access specific recording via token; cannot browse all sessions |
| **Anonymous** | Unauthenticated visitor | See only `public` sessions in gallery; no access to private/link sessions |
| **Platform Operator** | CaringMind team | Monitor all sessions; manage access levels |

---

## Solution

### Access Levels

Replace `isPublic: boolean` with `accessLevel: AccessLevel`:

```
"public"  -- anyone can see (including anonymous)
"link"    -- accessible via share token (default for new sessions)
"private" -- only owner + ACL entries
```

### Role Hierarchy

```
owner  >  editor  >  viewer  >  public  >  none
```

- **owner**: session creator (set on first publisher claim). Full control: change access level, manage ACL, create/revoke share tokens.
- **editor**: added to ACL by owner. Can view, create share tokens, appears in gallery.
- **viewer**: anyone with a valid share token. View-only.
- **public**: anyone when `accessLevel === "public"`.
- **none**: no access.

### Share Tokens

Time-limited, revocable tokens stored in R2:

```
sessions/{sessionId}/shares/shr_{random}.json   -- individual token
sessions/{sessionId}/shares/_index.json           -- denormalized list
```

- Format: `shr_` + 32 hex chars (crypto-random)
- Default expiry: 7 days (configurable at creation: 1h, 1d, 7d, 30d)
- Role: always `viewer` (token holders cannot escalate)
- Revocable by owner at any time

### ACL (Access Control List)

Per-session list of explicit user grants:

```typescript
interface AclEntry {
  userId: string;   // Google OAuth sub
  email: string;    // Google email (for display)
  role: "editor" | "viewer";
}
```

---

## Implementation

### New Files

| File | Purpose |
|------|---------|
| `server/src/permissions.ts` | Core authorization: `resolvePermission`, `hasRole`, `createShareToken`, `revokeShareToken`, `listShareTokens`, `validateShareToken`, `canSeeInGallery` |
| `viewer/src/share.ts` | Share dialog: create link, copy to clipboard, set expiry, revoke tokens |

### Modified Files

| File | Changes |
|------|---------|
| `server/src/types.ts` | New types: `AccessLevel`, `SessionRole`, `AclEntry`, `ShareToken`, `PermissionResult`. Extended `WsData` with `shareToken`, `SessionMetadata` with `accessLevel`/`acl`, replaced `Session.isPublic` with `accessLevel`/`acl`. |
| `server/src/auth.ts` | Added `extractShareToken(url)` to parse `?share=` query param |
| `server/src/session-registry.ts` | `getOrCreate()` defaults `accessLevel: "link"`, `acl: []`. `addViewer()` is now async, uses `resolvePermission()` instead of `isPublic` check, accepts `shareToken` param. |
| `server/src/session-recorder.ts` | New setters: `accessLevel`, `acl`, `ownerId`, `ownerEmail`. `writeMeta()` persists all auth fields to `meta.json`. |
| `server/src/session-export.ts` | `GallerySession` extended with `ownerId`, `ownerEmail`, `accessLevel`, `acl`, `viewerRole`. `getGalleryData()` takes optional `userId`, filters via `canSeeInGallery()`, lazy-migrates missing fields. |
| `server/src/server.ts` | Per-user gallery cache (`Map<string, {data,expiry}>`), `requireSessionAccess()` helper, auth gates on all recording routes, 4 new CRUD routes for share/access management, WebSocket share token passthrough. |
| `viewer/src/main.ts` | Auth-aware gallery fetch with Bearer token. Share token from URL param handling. |
| `viewer/src/gallery/render.ts` | Lock icons on private sessions. Owner badge. Share button for owner/editor. "My Sessions" filter. |
| `viewer/index.html` | Share dialog overlay. "My Sessions" filter button. |
| `viewer/style.css` | Share dialog, lock icon, owner badge, token list styles. |

---

## API Surface

### Auth-Gated Routes (changed from unauthenticated)

| Route | Before | After |
|-------|--------|-------|
| `GET /gallery/api` | No auth | Bearer token required; filtered by userId |
| `GET /sessions` | No auth | Bearer token required; filtered |
| `GET /session/{id}/thumbnail` | No auth | Auth if `accessLevel !== "public"`; share token valid |
| `GET /session/{id}/video.mp4` | No auth | Same as thumbnail |
| `GET /session/{id}/export` | No auth | Same as thumbnail |
| `GET /session/{id}` (HTML) | No auth | Share token passthrough to viewer |

### New Routes

| Route | Method | Who | Purpose |
|-------|--------|-----|---------|
| `/session/{id}/share` | POST | Owner/Editor | Create share token. Body: `{ expiresAt?: string }`. Returns `ShareToken`. |
| `/session/{id}/share/{token}` | DELETE | Owner | Revoke a share token. Returns `{ ok: true }`. |
| `/session/{id}/shares` | GET | Owner/Editor | List active (non-expired, non-revoked) share tokens. |
| `/session/{id}/access` | PATCH | Owner | Update `accessLevel` or `acl`. Body: `{ accessLevel?: AccessLevel, acl?: AclEntry[] }`. |

### WebSocket Changes

- `/view` upgrade: `?share=shr_xxx` query param passed to `ws.data.shareToken`
- `addViewer()` receives share token for permission resolution
- Share token validates against R2 (expiry + revoked check)

---

## Permission Resolution Logic

```
resolvePermission(session, userId?, shareToken?, store, sessionId):
  1. owner check:   userId === session.ownerId       -> role: "owner"
  2. acl check:     userId in session.acl             -> role: aclEntry.role
  3. token check:   shareToken valid in R2            -> role: "viewer"
  4. level check:   accessLevel === "public"          -> role: "public"
  5. fallback:                                       -> role: "none" (denied)
```

`canSeeInGallery()` is a sync-only subset (no R2 lookup) for fast gallery filtering:
- `accessLevel === "public"` -> visible to all
- `userId === ownerId` -> visible to owner
- `userId in acl` -> visible to ACL members
- Otherwise -> hidden

---

## Migration Strategy

**Lazy migration on read** -- no batch script, no migration tool.

Existing `meta.json` files lack `accessLevel`/`acl`/`ownerId`. The code defaults:

```typescript
const accessLevel = meta.accessLevel || "public";   // backward compat
const acl = meta.acl || [];
```

**All existing sessions remain publicly visible** -- matches current `isPublic: true` behavior. When an owner connects or changes permissions, `meta.json` gets upgraded in-place with the new fields.

New sessions default to `accessLevel: "link"` -- owner must explicitly set to `"public"` or `"private"`.

---

## R2 Storage Layout

```
sessions/{sessionId}/
  meta.json                          -- includes accessLevel, acl, ownerId, ownerEmail
  manifest.json                      -- unchanged
  video/seg-0001.mjpeg               -- unchanged
  audio/chunk-0001.pcm               -- unchanged
  thumb.jpg                          -- unchanged
  export.mp4                         -- unchanged
  shares/
    shr_a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4.json  -- individual token
    _index.json                                   -- denormalized token list
```

---

## Dev Mode

`RELAY_NO_AUTH=1` still works as before. `verifyToken()` returns `{ sub: "dev", email: "dev@localhost" }`. All routes accessible. New share/access routes functional with dev user.

---

## Alignment with PRD-013

PRD-013 restructures the API surface (`/api/v1/`, `/media/`). This PRD builds auth on **current routes** so it ships independently. When PRD-013 lands:

1. Auth middleware (`requireSessionAccess`) moves to the new route handler layer
2. Share/access CRUD routes move from `/session/{id}/share` to `/api/v1/sessions/{id}/share`
3. Media routes move from `/session/{id}/thumbnail` to `/media/{id}/thumbnail.jpg` with the same auth gate
4. `permissions.ts` module is unchanged -- it's route-agnostic

No conflicts. The auth module is designed to be portable.

---

## Verification Checklist

| # | Test | Expected |
|---|------|----------|
| 1 | `curl /gallery/api` without token | 401 Unauthorized |
| 2 | `curl /gallery/api` with Bearer token | 200, only owned + shared + public sessions |
| 3 | `curl /session/{id}/thumbnail` for private session | 403 Forbidden (non-owner) |
| 4 | `curl /session/{id}/thumbnail?share=shr_xxx` | 200 OK (valid token) |
| 5 | Expired share token | 403 Forbidden |
| 6 | Revoked share token | 403 Forbidden |
| 7 | `PATCH /session/{id}/access { accessLevel: "public" }` | Unauthed user sees it in gallery |
| 8 | `PATCH /session/{id}/access { acl: [...] }` | Added user sees session in gallery |
| 9 | `RELAY_NO_AUTH=1` | All routes accessible with dev user |
| 10 | WebSocket `/view?session=x&token=JWT&share=shr_xxx` | Connects if share token valid |

---

## Types Reference

```typescript
type AccessLevel = "public" | "link" | "private";
type SessionRole = "owner" | "editor" | "viewer";

interface AclEntry {
  userId: string;
  email: string;
  role: "editor" | "viewer";
}

interface ShareToken {
  token: string;        // "shr_" + 32 hex chars
  sessionId: string;
  role: "viewer";       // tokens always grant viewer
  createdBy: string;    // userId of token creator
  createdAt: string;    // ISO timestamp
  expiresAt: string;    // ISO timestamp
  revoked: boolean;
}

interface PermissionResult {
  allowed: boolean;
  role: SessionRole | "public" | "none";
  reason?: string;
}
```

---

## Success Metrics

| Metric | Target |
|--------|--------|
| Zero unauthenticated recording access | All `/session/{id}/*` routes return 401/403 without valid credentials or share token |
| Gallery isolation | Users see only their own + shared + public sessions |
| Share token expiry enforcement | Expired tokens return 403 within 1 second of expiry |
| Dev mode compatibility | `RELAY_NO_AUTH=1` preserves existing developer workflow |
| Zero data loss | Migration is lazy/read-only; existing `meta.json` files untouched until owner action |

---

## Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Gallery cache returns stale permission data | Low | Per-user cache with 30s TTL; invalidated on PATCH /access |
| Share token brute force | Low | 128-bit random tokens; rate limiting on thumbnail/media endpoints |
| R2 latency on share token validation | Medium | Token index cached per-request; single R2 GET per media request |
| Existing sessions all become "public" | Expected | Lazy migration defaults missing `accessLevel` to `"public"` -- matches current behavior |
