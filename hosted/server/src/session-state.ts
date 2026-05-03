/**
 * session-state.ts — Session state machine types
 *
 * Defines the formal lifecycle states, drop reasons, events, and flags
 * for session management. Consumed by SessionStateMachine and SessionRegistry.
 */

// --- States ---

export type SessionState =
  | "created"    // In-memory, no publisher yet
  | "standby"    // Publisher connected, not streaming
  | "active"     // Publisher streaming frames
  | "paused"     // Publisher went standby, resources released
  | "orphaned"   // Publisher disconnected, viewers remain
  | "ended"      // Clean shutdown, all gone
  | "expired";   // Timeout cleanup

// --- Drop Reasons ---

export type PublisherDropReason =
  | "ws_close"          // Normal WebSocket close (1000/1001)
  | "ws_error"          // Abnormal close (1006) or error
  | "stale_timeout"     // No frames for 15s
  | "dead_ws"           // WS not OPEN in cleanup sweep
  | "force_takeover"    // New publisher evicted old one
  | "server_shutdown";  // Graceful server shutdown

// --- Events ---

export interface SessionEvent {
  type: "session.created" | "session.publisher_claimed" | "session.activated"
      | "session.publisher_paused" | "session.publisher_dropped"
      | "session.orphaned" | "session.publisher_reconnected"
      | "session.ended" | "session.expired" | "session.destroyed";
  sessionId: string;
  timestampMs: number;
  previousState: SessionState;
  newState: SessionState;
  reason?: PublisherDropReason;
  metadata?: {
    publisherId?: string;
    viewerCount?: number;
    deviceId?: string;
    ephemeral?: boolean;
  };
}

// --- Flags ---

export interface SessionFlags {
  ephemeral: boolean;       // Skip DB + gallery
  orphanGraceMs: number;    // Grace period before expiring orphaned session
}

// --- Helpers ---

/** Map state to legacy DB `status` column */
export function stateToLegacyStatus(state: SessionState): "active" | "standby" | "ended" | "expired" {
  switch (state) {
    case "created":
    case "standby":
    case "active":
    case "orphaned":
      return "active";
    case "paused":
      return "standby";
    case "ended":
      return "ended";
    case "expired":
      return "expired";
  }
}

/** Derive drop reason from WebSocket close code */
export function dropReasonFromCloseCode(code: number | undefined): PublisherDropReason {
  if (code === 1000 || code === 1001) return "ws_close";
  if (code === 1006) return "ws_error";
  return "ws_error";
}
