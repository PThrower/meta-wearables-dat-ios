/**
 * Display renderer for smart glasses.
 *
 * Accepts text + device profile, returns a formatted DisplayFrame.
 * Throttles updates to respect BLE bandwidth constraints.
 */

import type { DisplayDeviceProfile } from "./display-types.js";
import type { DisplayFrame } from "./display-types.js";
import { getDisplayProfile } from "./display-profiles.js";
import { wrapText } from "./text-wrapper.js";

// --- Renderer ---

export class DisplayRenderer {
  private lastUpdateTime: Map<string, number> = new Map(); // sessionId → last send time

  /**
   * Render text into a DisplayFrame for the given device model.
   * Returns null if throttled (update sent too recently).
   */
  render(
    sessionId: string,
    text: string,
    model: string,
    options?: {
      displayTarget?: "main" | "dashboard" | "always_on";
      priority?: "low" | "normal" | "high";
      layoutId?: string;
    },
  ): DisplayFrame | null {
    const profile = getDisplayProfile(model);
    if (!profile) return null;

    // Throttle: skip if last update was too recent
    const now = Date.now();
    const lastUpdate = this.lastUpdateTime.get(sessionId) ?? 0;
    if (now - lastUpdate < profile.minUpdateIntervalMs) {
      return null;
    }
    this.lastUpdateTime.set(sessionId, now);

    const maxCharsPerLine = Math.floor(profile.displayWidth / 8); // ~8px per char
    const lines = wrapText(text, maxCharsPerLine).slice(0, profile.maxLines);

    if (lines.length === 0) return null;

    return {
      target: model,
      lines,
      layoutId: options?.layoutId,
      displayTarget: options?.displayTarget ?? "main",
      priority: options?.priority ?? "normal",
    };
  }

  /** Clear throttle state for a session (on disconnect) */
  clearSession(sessionId: string): void {
    this.lastUpdateTime.delete(sessionId);
  }
}

// Singleton
export const displayRenderer = new DisplayRenderer();
