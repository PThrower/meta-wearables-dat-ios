/**
 * Shared mutable state for the live player module.
 */

import { RelayPlayer } from "../player/relay-player.js";
import { GuidancePanel } from "../guidance.js";

// --- Player state ---
let player: RelayPlayer | null = null;
let guidancePanel: GuidancePanel | null = null;
let currentSessionId: string | null = null;
let currentDeviceId: string | null = null;
let uptimeInterval: ReturnType<typeof setInterval> | null = null;
let sessionConnectedAt = 0;

// Re-auth state
let pendingReauth: { sessionId: string; shareToken?: string } | null = null;

// --- Getters / Setters ---

export function getPlayer(): RelayPlayer | null { return player; }
export function setPlayer(p: RelayPlayer | null): void { player = p; }

export function getGuidancePanel(): GuidancePanel | null { return guidancePanel; }
export function setGuidancePanel(p: GuidancePanel | null): void { guidancePanel = p; }

export function getCurrentSessionId(): string | null { return currentSessionId; }
export function setCurrentSessionId(id: string | null): void { currentSessionId = id; }

export function getCurrentDeviceId(): string | null { return currentDeviceId; }
export function setCurrentDeviceId(id: string | null): void { currentDeviceId = id; }

export function getUptimeInterval(): ReturnType<typeof setInterval> | null { return uptimeInterval; }
export function setUptimeInterval(i: ReturnType<typeof setInterval> | null): void { uptimeInterval = i; }

export function getSessionConnectedAt(): number { return sessionConnectedAt; }
export function setSessionConnectedAt(t: number): void { sessionConnectedAt = t; }

export function getPendingReauth(): { sessionId: string; shareToken?: string } | null { return pendingReauth; }
export function setPendingReauth(r: { sessionId: string; shareToken?: string } | null): void { pendingReauth = r; }
