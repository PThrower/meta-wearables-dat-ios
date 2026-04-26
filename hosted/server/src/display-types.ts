/**
 * Display types for smart glasses with monochrome/text displays
 * (Even Realities G1, G2, and similar devices).
 *
 * The server renders guidance text into DisplayFrames and pushes them
 * to the iOS publisher, which bridges them to the glasses over BLE.
 */

// --- Device Profiles ---

export interface DisplayDeviceProfile {
  /** Device model identifier (e.g. "even-g1", "even-g2") */
  model: string;
  /** Display width in pixels */
  displayWidth: number;
  /** Display height in pixels */
  displayHeight: number;
  /** Maximum lines of text the display can show */
  maxLines: number;
  /** BLE chunk size for G1 UART (NUS MTU limit) */
  bleChunkSize: number;
  /** Minimum interval between display updates (ms) — BLE bandwidth constraint */
  minUpdateIntervalMs: number;
  /** Protocol type: "uart" for G1 NUS, "protobuf" for G2 EvenHub */
  protocol: "uart" | "protobuf";
}

// --- Display Frame (server → publisher) ---

export interface DisplayFrame {
  /** Target device model (matches DisplayDeviceProfile.model) */
  target: string;
  /** Rendered text lines to display */
  lines: string[];
  /** Optional layout identifier for multi-screen devices */
  layoutId?: string;
  /** Display target area: "main", "dashboard", "always_on" */
  displayTarget?: "main" | "dashboard" | "always_on";
  /** Priority for display contention: low, normal, high */
  priority?: "low" | "normal" | "high";
}

// --- Publisher Display Info (parsed from hello) ---

export interface DisplayViewerInfo {
  /** Device model (e.g. "even-g1", "even-g2") */
  model: string;
  /** Protocol: "uart" or "protobuf" */
  protocol: "uart" | "protobuf";
}
