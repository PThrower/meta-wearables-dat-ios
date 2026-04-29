/**
 * detection-throttle.ts
 *
 * Temporal deduplication for detection results before AI trigger injection.
 *
 * Problem: VisionStage fires ~5fps, each frame sends a vision_result to the
 * server, which injects every detection as `[Vision: Face detected (87%)]`
 * into the AI context. This floods the context window with near-identical
 * messages.
 *
 * Solution: Track the last forwarded summary per (session, category) pair.
 * Only inject a trigger if:
 *   1. The summary changed (different detections or confidence shifted), OR
 *   2. The refresh interval elapsed (keeps AI aware of persistent detections)
 *
 * Viewer fan-out is NOT throttled — viewers see every frame for overlay rendering.
 */

export class DetectionThrottle {
  private lastForwarded = new Map<string, { summary: string; timestamp: number }>();
  private refreshIntervalMs: number;

  constructor(refreshIntervalMs = 2000) {
    this.refreshIntervalMs = refreshIntervalMs;
  }

  /**
   * Check whether a detection summary should be forwarded to AI.
   * Returns the summary if it should be injected, null if throttled.
   *
   * @param sessionId - Active relay session ID
   * @param category  - Detection category ("vision", "sensor", "vad")
   * @param summary   - Human-readable detection summary
   */
  check(sessionId: string, category: string, summary: string): string | null {
    const key = `${sessionId}:${category}`;
    const last = this.lastForwarded.get(key);
    const now = Date.now();

    if (last) {
      // Forward if summary changed
      if (last.summary !== summary) {
        this.lastForwarded.set(key, { summary, timestamp: now });
        return summary;
      }
      // Forward if refresh interval elapsed (re-inform AI of persistent detection)
      if (now - last.timestamp >= this.refreshIntervalMs) {
        this.lastForwarded.set(key, { summary, timestamp: now });
        return summary;
      }
      // Same summary within throttle window — skip
      return null;
    }

    // First detection in this category
    this.lastForwarded.set(key, { summary, timestamp: now });
    return summary;
  }

  /** Clear all throttle state for a session (on disconnect/deactivate). */
  clear(sessionId: string): void {
    const prefix = `${sessionId}:`;
    for (const key of this.lastForwarded.keys()) {
      if (key.startsWith(prefix)) {
        this.lastForwarded.delete(key);
      }
    }
  }

  /** Clear all state. */
  reset(): void {
    this.lastForwarded.clear();
  }
}
