/**
 * auth.ts — Token verification for the gateway
 *
 * Supports two token types:
 *   1. Session tokens (HMAC-SHA256 signed JWT, minted by this gateway)
 *   2. Google ID tokens — DISABLED (OAuth commented out)
 *
 * Token sources: query param, Authorization header, cookie.
 *
 * Dev mode: Set GATEWAY_NO_AUTH=1 to bypass all auth checks (returns dev@localhost).
 */

import { createHmac } from "node:crypto";
// OAuth disabled — Google Sign-In removed
// import { OAuth2Client } from "google-auth-library";
import type { AuthUser } from "./types.js";

// OAuth disabled
// const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const NO_AUTH = process.env.GATEWAY_NO_AUTH === "1";
const SESSION_SECRET = process.env.SESSION_SECRET || "change-me-in-production";
const SESSION_TTL_SEC = 7 * 24 * 60 * 60; // 7 days
const REFRESH_THRESHOLD_SEC = 24 * 60 * 60; // refresh if < 24h remaining

// OAuth disabled
// const oauthClient = new OAuth2Client(CLIENT_ID);

// --- Revocation list (in-memory, lost on restart) ---
// Maps jti → expiry timestamp so we can prune expired entries

const revokedTokens = new Map<string, number>();

/** Prune expired entries from revocation list (called periodically) */
export function pruneRevokedTokens(): void {
  const now = Math.floor(Date.now() / 1000);
  for (const [jti, exp] of revokedTokens) {
    if (exp <= now) revokedTokens.delete(jti);
  }
}

/** Revoke a session token by its jti. Returns true if token was valid and revoked. */
export function revokeToken(token: string): boolean {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return false;
    const data = JSON.parse(b64urlDecode(parts[1]));
    if (!data.jti || !data.exp) return false;
    // Only revoke if not already expired
    if (data.exp * 1000 <= Date.now()) return false;
    revokedTokens.set(data.jti, data.exp);
    return true;
  } catch {
    return false;
  }
}

// Auto-prune every 5 minutes
setInterval(pruneRevokedTokens, 300_000);

// --- Session token minting (HMAC-SHA256 signed JWT) ---

function b64url(input: string | Buffer): string {
  const buf = typeof input === "string" ? Buffer.from(input) : input;
  return buf.toString("base64url");
}

function b64urlDecode(s: string): string {
  return Buffer.from(s, "base64url").toString();
}

export function mintSessionToken(sub: string, email: string, ttlSec = SESSION_TTL_SEC): string {
  const header = b64url('{"alg":"HS256","typ":"JWT"}');
  const now = Math.floor(Date.now() / 1000);
  const jti = crypto.randomUUID();
  const payload = b64url(JSON.stringify({ sub, email, iat: now, exp: now + ttlSec, jti }));
  const signature = createHmac("sha256", SESSION_SECRET).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

export function verifySessionToken(token: string): AuthUser | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts;
  const expected = createHmac("sha256", SESSION_SECRET).update(`${header}.${payload}`).digest("base64url");
  if (signature !== expected) return null;
  try {
    const data = JSON.parse(b64urlDecode(payload));
    if (!data.sub || !data.email) return null;
    if (data.exp && data.exp * 1000 < Date.now()) return null;
    // Check revocation list
    if (data.jti && revokedTokens.has(data.jti)) return null;
    return { sub: data.sub, email: data.email };
  } catch {
    return null;
  }
}

export function shouldRefreshSession(token: string): boolean {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return false;
    const data = JSON.parse(b64urlDecode(parts[1]));
    if (!data.exp) return false;
    const remaining = data.exp - Math.floor(Date.now() / 1000);
    return remaining > 0 && remaining < REFRESH_THRESHOLD_SEC;
  } catch {
    return false;
  }
}

// --- Token verification ---

/**
 * Verify a token and return the user identity.
 * Session tokens only (HMAC). Google JWT path disabled.
 * In dev mode, returns a synthetic dev user.
 */
export async function verifyToken(token: string | null | undefined): Promise<AuthUser | null> {
  if (NO_AUTH) return { sub: "dev", email: "dev@localhost" };
  if (!token) return null;

  // Session token (HMAC-SHA256, no network call)
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
  //   console.warn("[gateway:auth] token verify failed:", (err as Error).message?.slice(0, 120));
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
