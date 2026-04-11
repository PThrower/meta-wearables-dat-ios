# Google OAuth Integration -- Static Review

**Status:** Static analysis only. Not prioritized for implementation. Written 2026-04-03 against commit `33ea802` on `feat/telemetry-diagnostics`.

This document captures what Google OAuth would mean for the relay platform *at this point in the codebase*. It is a snapshot -- as the server, viewer, and iOS client evolve, the touchpoints listed here will shift. Re-evaluate before implementation.

---

## Why Auth Matters (Eventually)

Right now the relay is wide open:

- `/publish` -- any WebSocket client can claim the publisher slot
- `/view` -- any WebSocket client can receive the stream
- `/stats` -- unauthenticated JSON dump of publisher IP, device identity, viewer IPs
- `/` -- viewer HTML served to anyone

On a local network during development this is fine. On a deployed platform with multi-session routing (see `docs/multi-session-platform.md`), unauthenticated access means:

1. Any publisher can claim any session ID (session hijacking)
2. Any viewer can watch any session (privacy)
3. Stats endpoint leaks device IPs and identity (information disclosure)
4. No way to gate who can publish vs. who can only view

Google OAuth is the initial choice because the target users already live in Google Workspace.

---

## Current Auth Surface (None)

### relay/server (`server.ts`)

| Location | Current Behavior |
|----------|-----------------|
| `fetch()` line 353 | No auth check on any route. All requests pass through. |
| `open()` line 373 | Publisher accepted if slot is empty. No identity verification. |
| `message()` line 417 | Publisher identity comes from untrusted `{"type":"hello",...}` JSON. Any client can spoof `deviceId`, `deviceName`, `wearableType`. |
| `/stats` line 356 | Returns publisher IP, client IPs, device metadata to anyone. |

### relay/viewer (`index.html`)

| Location | Current Behavior |
|----------|-----------------|
| `connect()` line 290 | Opens WebSocket with no auth headers or tokens. |
| `setQuality()` line 282 | Sends config commands with no identity. |

### iOS Client (`RelayStage.swift`)

| Location | Current Behavior |
|----------|-----------------|
| `connect(to:)` line 89 | Opens `URLSessionWebSocketTask` with no auth. Bare URL. |
| `sendHello()` line 381 | Sends device identity as plain JSON. Not authenticated -- spoofable. |

---

## What Google OAuth Would Touch

### 1. Server: Token Verification Middleware

The server needs to verify a Google ID token (JWT) before allowing any WebSocket upgrade or HTTP response.

```
New flow:
  Client -> Google OAuth -> ID Token (JWT)
  Client -> Relay (token in query param or header)
  Relay -> Google (verify token via google-auth-library or jwks)
  Relay -> Allow/Deny
```

**Implementation approach:**

```ts
// New file: relay/server/src/auth.ts
import { OAuth2Client } from "google-auth-library";

const oauthClient = new OAuth2Client(GOOGLE_CLIENT_ID);

async function verifyToken(token: string): Promise<{ sub: string; email: string }> {
  const ticket = await oauthClient.verifyIdToken({
    idToken: token,
    audience: GOOGLE_CLIENT_ID,
  });
  const payload = ticket.getPayload();
  if (!payload) throw new Error("invalid token");
  return { sub: payload.sub, email: payload.email };
}
```

**Server changes (`server.ts`):**

| Route | Auth Required | Role Check |
|-------|---------------|------------|
| `GET /` | No (public directory page) | -- |
| `GET /sessions` | No (public session list) | -- |
| `GET /session/<id>` | No (serves viewer HTML) | -- |
| `GET /stats` | Yes | Any authenticated user |
| `WS /publish?session=<id>&token=<jwt>` | Yes | `publisher` role |
| `WS /view?session=<id>&token=<jwt>` | Yes | Any authenticated user |

The WebSocket upgrade in `fetch()` would need to:

1. Extract `token` from query params
2. Call `verifyToken(token)`
3. Attach the verified identity to `WsData` (new fields: `userId`, `email`)
4. Reject with `401` if token is invalid or missing

**New dependency:** `google-auth-library` (Node.js package, compatible with Bun)

### 2. Viewer: Login Flow

The viewer is a single HTML file with no build step. Adding OAuth to it means:

**Option A: Google Identity Services (GIS) -- popup redirect**

Add the GIS script tag to `index.html`:

```html
<script src="https://accounts.google.com/gsi/client" async defer></script>
```

Render a "Sign in with Google" button. On success, GIS returns an ID token. The viewer stores it and passes it as a query param when connecting to `/view?session=abc&token=<jwt>`.

**Option B: Server-side redirect flow**

The viewer hits `/auth/login` on the relay server, which redirects to Google. On callback, the server sets an HTTP-only session cookie. The WebSocket upgrade reads the cookie instead of a query param.

Option A is simpler for a single-file viewer. Option B is more secure (no token in URL/logs) but requires server-side session management.

**Viewer changes (`index.html`):**

| Area | Change |
|------|--------|
| Connect form | Replace with "Sign in with Google" button before showing relay URL input |
| `connect()` | Append `&token=<jwt>` to WebSocket URL |
| Token storage | `localStorage` for persistence across reconnects |
| Token refresh | GIS handles refresh; on token expiry, prompt re-login |
| Session directory | Show login-required state for protected sessions |

### 3. iOS Client: OAuth Token Acquisition

The iOS app needs to obtain a Google ID token and pass it to the relay.

**Mechanism:** Use `GTMAppAuth` (Google's recommended iOS OAuth library) or ASWebAuthenticationSession with custom scheme redirect.

**RelayStage changes:**

```swift
// Before
func connect(to urlString: String) async throws { ... }

// After
func connect(to urlString: String, idToken: String) async throws {
    guard let url = URL(string: "\(urlString)&token=\(idToken)") else { ... }
    // ... rest unchanged
}
```

The relay URL construction shifts from:
```
ws://host:8080/publish
```
to:
```
ws://host:8080/publish?session=abc&token=eyJhbGciOiJSUzI1NiIs...
```

**iOS dependencies:** `GTMAppAuth` (via SPM), Google Cloud client ID configuration in `Info.plist`.

### 4. Session Ownership Model

With auth in place, sessions gain an owner:

```ts
interface Session {
  id: string;
  ownerId: string;              // Google sub (user ID)
  ownerEmail: string;           // Google email
  publisher: Publisher | null;
  viewers: Map<string, Viewer>;
  createdAt: number;
  isPublic: boolean;            // if false, only owner can view
  allowedViewers: Set<string>;  // Google subs allowed to view (optional)
}
```

Publisher claim logic changes:

1. No session -> create, set `ownerId` from verified token
2. Session exists, token `sub` matches `ownerId` -> allow claim
3. Session exists, token `sub` does not match -> reject with `403`

Viewer logic:

1. Session is public -> any authenticated user can view
2. Session is private -> only `ownerId` or `allowedViewers` can view

---

## Data Flow with Auth

```
iOS App (GTMAppAuth)           Browser (GIS)
      |                              |
      v Google                       v Google
  ID Token (JWT)                ID Token (JWT)
      |                              |
      v ws://.../publish?token=JWT   v ws://.../view?token=JWT
  +----------------------------------------------+
  |              Bun Relay Server                |
  |  verifyToken() on every WS upgrade           |
  |  attach userId/email to WsData               |
  |  enforce session ownership                   |
  +----------------------------------------------+
```

---

## What Does NOT Change

- FRLY/FRAU wire protocol -- frames are the same, auth is at the connection level
- WASM throttle crate -- stateless, no auth awareness
- Frame fanout logic -- routing by session, not by auth
- Audio ring buffer (viewer) -- pure client-side, no auth
- Stale connection cleanup -- same timers, same eviction logic
- Quality presets -- same mechanism, per-viewer

---

## Open Questions (Deferred)

| Question | Impact | Notes |
|----------|--------|-------|
| Token in query param vs. cookie? | Server + Viewer | Query param is simpler but tokens appear in server logs. Cookie requires session state. |
| Token refresh on long-lived connections? | iOS + Viewer | WebSocket can be open for hours. Token expiry (1hr) needs a refresh mechanism over WS. |
| Publisher role vs. viewer role? | Server | Need a way to designate who can publish. Could be: anyone can publish their own session, or require a `publisher` role in the token. |
| Google Cloud project setup? | All | Need OAuth client IDs for iOS, web, and possibly server. |
| Existing local-network dev flow? | Server | Need a bypass for `--dev` mode where no auth is required. Check `NODE_ENV` or a `RELAY_NO_AUTH` env var. |

---

## Staleness Warning

This review was written against the codebase as it exists on `feat/telemetry-diagnostics` at commit `33ea802`. Specific line numbers, interface shapes, and endpoint definitions will change as:

- Multi-session routing is implemented (see `docs/multi-session-platform.md`)
- The viewer gains a session directory
- The iOS client adds session-aware connection logic
- Additional endpoints are added (recording, playback, etc.)

Before implementing auth, re-read the affected files and update this document.
