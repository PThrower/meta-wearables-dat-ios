/**
 * session-state-machine.ts — Validates transitions, emits events, no side effects
 *
 * Standalone class consumed by SessionRegistry to enforce valid state transitions
 * and provide a typed event bus for session lifecycle observability.
 */

import type { SessionState, PublisherDropReason, SessionEvent } from "./session-state.js";

// --- Transition table ---

const TRANSITIONS: Record<SessionState, SessionState[]> = {
  created:  ["standby", "ended", "expired"],
  standby:  ["active", "orphaned", "ended", "expired"],
  active:   ["paused", "orphaned", "ended", "expired"],
  paused:   ["active", "orphaned", "ended", "expired"],
  orphaned: ["standby", "ended", "expired"],
  ended:    [],   // terminal
  expired:  [],   // terminal
};

// --- Event type mapping ---

function eventTypeForTransition(
  from: SessionState,
  to: SessionState,
  reason?: PublisherDropReason,
): SessionEvent["type"] {
  if (to === "standby" && from === "created") return "session.publisher_claimed";
  if (to === "standby" && from === "orphaned") return "session.publisher_reconnected";
  if (to === "active" && (from === "standby" || from === "paused")) return "session.activated";
  if (to === "paused") return "session.publisher_paused";
  if (to === "orphaned") return "session.orphaned";
  if (to === "ended") return reason ? "session.publisher_dropped" : "session.ended";
  if (to === "expired") return "session.expired";
  if (to === "standby") return "session.publisher_claimed";
  return "session.ended";
}

// --- State Machine ---

export class SessionStateMachine {
  private subscribers = new Set<(event: SessionEvent) => void>();

  /** Subscribe to state change events. Returns unsubscribe function. */
  subscribe(fn: (event: SessionEvent) => void): () => void {
    this.subscribers.add(fn);
    return () => { this.subscribers.delete(fn); };
  }

  /** Check if a transition is valid */
  canTransition(from: SessionState, to: SessionState): boolean {
    return TRANSITIONS[from]?.includes(to) ?? false;
  }

  /** Execute a transition. Returns the event. Throws if invalid. */
  transition(
    sessionId: string,
    from: SessionState,
    to: SessionState,
    reason?: PublisherDropReason,
    metadata?: SessionEvent["metadata"],
  ): SessionEvent {
    if (!this.canTransition(from, to)) {
      throw new Error(`Invalid state transition: ${from} -> ${to} (session=${sessionId})`);
    }

    const event: SessionEvent = {
      type: eventTypeForTransition(from, to, reason),
      sessionId,
      timestampMs: Date.now(),
      previousState: from,
      newState: to,
      reason,
      metadata,
    };

    for (const fn of this.subscribers) {
      try { fn(event); } catch { /* subscriber errors must not break transitions */ }
    }

    return event;
  }

  /** Check if a state is terminal (no further transitions possible) */
  isTerminal(state: SessionState): boolean {
    return TRANSITIONS[state].length === 0;
  }
}

/** Singleton instance shared across the server */
export const stateMachine = new SessionStateMachine();
