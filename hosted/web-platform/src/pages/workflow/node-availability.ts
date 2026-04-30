/**
 * node-availability.ts — Composable availability layer for workflow nodes.
 *
 * Separated from node-defs so availability can change without touching definitions.
 * Add/remove entries in UNAVAILABLE_NODES to toggle visibility.
 *
 * UI: dimmed + lock badge, not clickable in palette.
 * Edge validation: still works (unavailable nodes can be targets in existing workflows).
 */

export type AvailabilityStatus = "available" | "unavailable";

/** Availability reason shown as tooltip on locked nodes. */
export type UnavailabilityReason = string;

interface AvailabilityEntry {
  status: "unavailable";
  reason: UnavailabilityReason;
}

/**
 * Nodes not yet confirmed for production use.
 * Key = node type, value = reason shown on hover.
 */
const UNAVAILABLE_NODES: Record<string, AvailabilityEntry> = {
  "deepgram-stt": { status: "unavailable", reason: "Deepgram integration pending" },
  "jepa-vision": { status: "unavailable", reason: "JEPA integration pending" },
  "jepa-trigger": { status: "unavailable", reason: "JEPA integration pending" },
};

/** Check if a node type is available for use. */
export function isAvailable(type: string): boolean {
  return getStatus(type) === "available";
}

/** Get the availability status of a node type. */
export function getStatus(type: string): AvailabilityStatus {
  return UNAVAILABLE_NODES[type]?.status ?? "available";
}

/** Get the unavailability reason, or null if available. */
export function getReason(type: string): UnavailabilityReason | null {
  return UNAVAILABLE_NODES[type]?.reason ?? null;
}
