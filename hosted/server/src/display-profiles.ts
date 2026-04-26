/**
 * Display device profiles for Even Realities smart glasses.
 *
 * G1: Nordic UART Service, text-based 0x4E command, ~180 byte chunks
 * G2: Protobuf EvenHub protocol, container-based layout, 512 byte MTU
 */

import type { DisplayDeviceProfile } from "./display-types.js";

// --- G1 Profile ---

export const G1_PROFILE: DisplayDeviceProfile = {
  model: "even-g1",
  displayWidth: 640,
  displayHeight: 200,
  maxLines: 5,
  bleChunkSize: 176, // NUS safe payload (~180 minus command header)
  minUpdateIntervalMs: 250,
  protocol: "uart",
};

// Approximate character width for G1 monospace-like display
// G1 uses LVGL font, roughly 8px per character at default size
export const G1_CHAR_WIDTH_PX = 8;
export const G1_LINE_CAPACITY = Math.floor(G1_PROFILE.displayWidth / G1_CHAR_WIDTH_PX); // ~80 chars

// --- G2 Profile ---

export const G2_PROFILE: DisplayDeviceProfile = {
  model: "even-g2",
  displayWidth: 576,
  displayHeight: 288,
  maxLines: 5,
  bleChunkSize: 496, // 512 MTU minus 16-byte packet header
  minUpdateIntervalMs: 200,
  protocol: "protobuf",
};

// G2 uses LVGL font, roughly 6px per character at default size
export const G2_CHAR_WIDTH_PX = 6;
export const G2_LINE_CAPACITY = Math.floor(G2_PROFILE.displayWidth / G2_CHAR_WIDTH_PX); // ~96 chars

// --- Lookup ---

const PROFILES: Record<string, DisplayDeviceProfile> = {
  "even-g1": G1_PROFILE,
  "even-g2": G2_PROFILE,
};

export function getDisplayProfile(model: string): DisplayDeviceProfile | null {
  return PROFILES[model] ?? null;
}
