/**
 * auth.ts -- Google OAuth token verification for the relay server
 *
 * Verifies Google ID tokens (JWTs) on WebSocket upgrades and protected HTTP routes.
 * Supports three token sources: query param, Authorization header, cookie.
 *
 * Dev mode: Set RELAY_NO_AUTH=1 to bypass all auth checks (returns dev@localhost).
 */

import { OAuth2Client } from "google-auth-library";

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const NO_AUTH = process.env.RELAY_NO_AUTH === "1";

const oauthClient = new OAuth2Client(CLIENT_ID);

export interface AuthUser {
  sub: string;
  email: string;
}

/**
 * Verify a Google ID token and return the user identity.
 * Returns null if the token is invalid, expired, or missing required fields.
 * In dev mode (RELAY_NO_AUTH=1), returns a synthetic dev user.
 */
export async function verifyToken(token: string | null | undefined): Promise<AuthUser | null> {
  if (NO_AUTH) return { sub: "dev", email: "dev@localhost" };
  if (!token) return null;
  try {
    const ticket = await oauthClient.verifyIdToken({
      idToken: token,
      audience: CLIENT_ID,
    });
    const payload = ticket.getPayload();
    if (!payload?.sub || !payload?.email) return null;
    return { sub: payload.sub, email: payload.email };
  } catch {
    return null;
  }
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
