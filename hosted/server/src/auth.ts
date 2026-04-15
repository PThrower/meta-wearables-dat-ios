/**
 * auth.ts — user identity extraction for the relay server
 *
 * When requests come through the gateway (RELAY_TRUST_HEADERS=1), reads user
 * identity from trusted headers (X-User-Id, X-User-Email) set by the gateway.
 *
 * For WebSocket connections (which bypass the gateway), verifies session tokens
 * (HMAC-SHA256 signed JWTs minted by the gateway) first, then falls back to
 * direct Google JWT verification. For local dev (RELAY_NO_AUTH=1), returns dev user.
 */

import { createHmac } from "node:crypto";
// OAuth disabled — Google Sign-In removed
// import { OAuth2Client } from "google-auth-library";

// OAuth disabled
// const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const NO_AUTH = process.env.RELAY_NO_AUTH === "1";
const TRUST_HEADERS = process.env.RELAY_TRUST_HEADERS === "1";
const SESSION_SECRET = process.env.SESSION_SECRET || "change-me-in-production";

// OAuth disabled
// const oauthClient = new OAuth2Client(CLIENT_ID);

// --- Session token verification (mirrors gateway/src/auth.ts) ---

function b64urlDecode(s: string): string {
  return Buffer.from(s, "base64url").toString();
}

function verifySessionToken(token: string): AuthUser | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts;
  const expected = createHmac("sha256", SESSION_SECRET).update(`${header}.${payload}`).digest("base64url");
  if (signature !== expected) return null;
  try {
    const data = JSON.parse(b64urlDecode(payload));
    if (!data.sub || !data.email) return null;
    if (data.exp && data.exp * 1000 < Date.now()) return null;
    return { sub: data.sub, email: data.email };
  } catch {
    return null;
  }
}

export interface AuthUser {
  sub: string;
  email: string;
}

/**
 * Extract user identity from trusted headers set by the gateway.
 * Returns null if headers are not present.
 */
export function extractTrustedUser(req: Request): AuthUser | null {
  const sub = req.headers.get("X-User-Id");
  const email = req.headers.get("X-User-Email");
  if (sub && email) return { sub, email };
  return null;
}

/**
 * Get the authenticated user for a request.
 *
 * Resolution order:
 *   1. Dev mode (RELAY_NO_AUTH=1) → synthetic dev user
 *   2. Trusted headers (gateway) → read X-User-Id, X-User-Email
 *   3. Direct JWT verification → verify Google ID token
 */
export async function getAuthenticatedUser(req: Request, url: URL): Promise<AuthUser | null> {
  // 1. Dev mode bypass
  if (NO_AUTH) return { sub: "dev", email: "dev@localhost" };

  // 2. Trusted headers from gateway
  if (TRUST_HEADERS) {
    const trusted = extractTrustedUser(req);
    if (trusted) return trusted;
  }

  // 3. Direct JWT verification (fallback for WS connections / local dev)
  const token = extractToken(req, url);
  if (!token) return null;
  return verifyToken(token);
}

/**
 * Verify a token and return the user identity.
 * Tries session token first (fast HMAC, minted by gateway), then falls back to Google JWT.
 * Returns null if the token is invalid, expired, or missing required fields.
 */
export async function verifyToken(token: string | null | undefined): Promise<AuthUser | null> {
  if (NO_AUTH) return { sub: "dev", email: "dev@localhost" };
  if (!token) return null;

  // Fast path: session token (HMAC-SHA256, no network call)
  const sessionUser = verifySessionToken(token);
  if (sessionUser) return sessionUser;

  // OAuth disabled — Google JWT verification removed
  // try {
  //   const ticket = await oauthClient.verifyIdToken({
  //     idToken: token,
  //     audience: CLIENT_ID,
  //   });
  //   const payload = ticket.getPayload();
  //   if (!payload?.sub || !payload?.email) return null;
  //   return { sub: payload.sub, email: payload.email };
  // } catch (err) {
  //   console.warn("[auth] token verify failed:", (err as Error).message?.slice(0, 120));
  //   return null;
  // }

  return null;
}

/**
 * Extract a token from an incoming request.
 * Checks, in order:
 *   1. Query param: ?token=<jwt>
 *   2. Authorization header: Bearer <jwt>
 *   3. Cookie: relay_token=<jwt>
 */
export function extractToken(req: Request, url: URL): string | null {
  // 1. Query param: ?token=<jwt>
  const qp = url.searchParams.get("token");
  if (qp) return qp;

  // 2. Authorization header: Bearer <jwt>
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice(7);

  // 3. Cookie: relay_token=<jwt>
  const cookie = req.headers.get("cookie") || "";
  const match = cookie.match(/(?:^|;\s*)relay_token=([^;]+)/);
  if (match) return match[1];

  return null;
}

/**
 * Extract a share token from the URL query string.
 * Checks: ?share=<token>
 */
export function extractShareToken(url: URL): string | null {
  return url.searchParams.get("share");
}
