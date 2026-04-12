/**
 * permissions.ts — tiered access control for recording sessions
 *
 * Role hierarchy: owner > editor > viewer > public > none
 * Access levels: "public" (anyone), "link" (share token), "private" (owner + acl only)
 *
 * Share tokens stored in R2 at:
 *   sessions/{sessionId}/shares/shr_{random}.json  — individual token
 *   sessions/{sessionId}/shares/_index.json          — denormalized token list
 */

import type { ObjectStore } from "@ebowwa/object-store";
import type { AccessLevel, SessionRole, AclEntry, ShareToken, PermissionResult } from "./types.js";

// --- Role hierarchy ---

const ROLE_RANK: Record<string, number> = {
  owner: 4,
  editor: 3,
  viewer: 2,
  public: 1,
  none: 0,
};

/** Check if `actual` role meets or exceeds `minimum` role */
export function hasRole(actual: SessionRole | "public" | "none", minimum: SessionRole): boolean {
  return (ROLE_RANK[actual] ?? 0) >= (ROLE_RANK[minimum] ?? 0);
}

// --- Permission resolution ---

interface PermissionInput {
  ownerId?: string;
  accessLevel: AccessLevel;
  acl: AclEntry[];
}

/**
 * Resolve the effective role for a user on a session.
 * Resolution order: owner -> acl -> share token -> accessLevel fallback
 */
export async function resolvePermission(
  input: PermissionInput,
  userId: string | undefined,
  shareToken: string | undefined,
  store: ObjectStore,
  sessionId: string,
): Promise<PermissionResult> {
  // 1. Owner check
  if (userId && input.ownerId === userId) {
    return { allowed: true, role: "owner" };
  }

  // 2. ACL check
  if (userId) {
    const aclEntry = input.acl.find(e => e.userId === userId);
    if (aclEntry) {
      return { allowed: true, role: aclEntry.role };
    }
  }

  // 3. Share token check
  if (shareToken) {
    const tokenResult = await validateShareToken(sessionId, shareToken, store);
    if (tokenResult) {
      return { allowed: true, role: tokenResult.role };
    }
    return { allowed: false, role: "none", reason: "invalid or expired share token" };
  }

  // 4. Orphaned sessions (no owner) — treat as viewer for any authenticated user
  if (!input.ownerId && !input.acl?.length) {
    return { allowed: true, role: "viewer" };
  }

  // 5. Access level fallback
  if (input.accessLevel === "public") {
    return { allowed: true, role: "viewer" };
  }

  return { allowed: false, role: "none", reason: "access denied" };
}

// --- Share token management ---

const SHARE_PREFIX = "shr_";
const MAX_SHARE_TOKENS_PER_SESSION = 20;

function shareKey(sessionId: string, token: string): string {
  return `sessions/${sessionId}/shares/${token}.json`;
}

function shareIndexKey(sessionId: string): string {
  return `sessions/${sessionId}/shares/_index.json`;
}

/** Generate a random share token */
function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const hex = Buffer.from(bytes).toString("hex");
  return `${SHARE_PREFIX}${hex}`;
}

/** Validate a share token against R2 storage. Returns the token if valid. */
export async function validateShareToken(
  sessionId: string,
  token: string,
  store: ObjectStore,
): Promise<ShareToken | null> {
  if (!token.startsWith(SHARE_PREFIX)) return null;

  const buf = await store.get(shareKey(sessionId, token));
  if (!buf) return null;

  try {
    const data: ShareToken = JSON.parse(new TextDecoder().decode(buf));
    if (data.revoked) return null;
    if (new Date(data.expiresAt).getTime() < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

/** Create a new share token and persist to R2. Throws if limit reached. */
export async function createShareToken(
  sessionId: string,
  createdBy: string,
  expiresAt: string,
  store: ObjectStore,
): Promise<ShareToken> {
  // Enforce max active tokens per session
  const activeTokens = await listShareTokens(sessionId, store);
  if (activeTokens.length >= MAX_SHARE_TOKENS_PER_SESSION) {
    throw new Error(`Session already has ${MAX_SHARE_TOKENS_PER_SESSION} active share tokens`);
  }
  const token = generateToken();
  const shareToken: ShareToken = {
    token,
    sessionId,
    role: "viewer",
    createdBy,
    createdAt: new Date().toISOString(),
    expiresAt,
    revoked: false,
  };

  // Write individual token
  await store.put(
    shareKey(sessionId, token),
    Buffer.from(JSON.stringify(shareToken, null, 2)),
  );

  // Update index
  await updateShareIndex(sessionId, shareToken, store);

  return shareToken;
}

/** Revoke a share token */
export async function revokeShareToken(
  sessionId: string,
  token: string,
  store: ObjectStore,
): Promise<boolean> {
  const buf = await store.get(shareKey(sessionId, token));
  if (!buf) return false;

  try {
    const data: ShareToken = JSON.parse(new TextDecoder().decode(buf));
    data.revoked = true;
    await store.put(
      shareKey(sessionId, token),
      Buffer.from(JSON.stringify(data, null, 2)),
    );
    return true;
  } catch {
    return false;
  }
}

/** List all share tokens for a session */
export async function listShareTokens(
  sessionId: string,
  store: ObjectStore,
): Promise<ShareToken[]> {
  const buf = await store.get(shareIndexKey(sessionId));
  if (!buf) return [];

  try {
    const tokens: ShareToken[] = JSON.parse(new TextDecoder().decode(buf));
    // Filter out expired and revoked
    const now = Date.now();
    return tokens.filter(t => !t.revoked && new Date(t.expiresAt).getTime() > now);
  } catch {
    return [];
  }
}

/** Update the denormalized share token index, pruning expired/revoked entries */
async function updateShareIndex(
  sessionId: string,
  newToken: ShareToken,
  store: ObjectStore,
): Promise<void> {
  const existing = await listShareTokensRaw(sessionId, store);
  existing.push(newToken);
  // Prune expired and revoked tokens to prevent unbounded growth
  const now = Date.now();
  const pruned = existing.filter(t => !t.revoked && new Date(t.expiresAt).getTime() > now);
  await store.put(
    shareIndexKey(sessionId),
    Buffer.from(JSON.stringify(pruned, null, 2)),
  );
}

/** List all tokens (including expired/revoked) from index */
async function listShareTokensRaw(
  sessionId: string,
  store: ObjectStore,
): Promise<ShareToken[]> {
  const buf = await store.get(shareIndexKey(sessionId));
  if (!buf) return [];
  try {
    return JSON.parse(new TextDecoder().decode(buf));
  } catch {
    return [];
  }
}

// --- Gallery visibility ---

/**
 * Sync check: can a user see a session in the gallery?
 * Uses only meta.json fields (no R2 share token lookup).
 */
export function canSeeInGallery(
  meta: {
    accessLevel?: AccessLevel;
    acl?: AclEntry[];
    ownerId?: string;
    ownerEmail?: string;
  },
  userId?: string,
  userEmail?: string,
): boolean {
  // Public sessions visible to all
  if (meta.accessLevel === "public") return true;

  // Link sessions with no owner are discoverable (anyone with the link)
  if (meta.accessLevel === "link" && !meta.ownerId && !meta.ownerEmail) return true;

  // Private sessions with no owner — treat as public (orphaned)
  if (meta.accessLevel === "private" && !meta.ownerId && !meta.ownerEmail) return true;

  // Owner always sees their sessions (by sub ID or email fallback)
  if (userId && meta.ownerId === userId) return true;
  if (userEmail && meta.ownerEmail === userEmail) return true;

  // ACL match
  if (userId && meta.acl) {
    if (meta.acl.some(e => e.userId === userId)) return true;
  }

  return false;
}
