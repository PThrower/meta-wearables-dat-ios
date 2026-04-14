/**
 * types.ts — shared types for the auth gateway
 */

export interface AuthUser {
  sub: string;
  email: string;
}

export type AccessLevel = "public" | "link" | "private";
export type SessionRole = "owner" | "editor" | "viewer";

export interface AclEntry {
  userId: string;
  email: string;
  role: "editor" | "viewer";
}

export interface ShareToken {
  token: string;
  sessionId: string;
  role: "viewer";
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  revoked: boolean;
}

export interface PermissionResult {
  allowed: boolean;
  role: SessionRole | "public" | "none";
  reason?: string;
}

export interface SessionMeta {
  accessLevel?: AccessLevel;
  acl?: AclEntry[];
  ownerId?: string;
  ownerEmail?: string;
}
