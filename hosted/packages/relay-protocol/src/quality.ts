/**
 * Quality presets for viewer frame throttling
 */

export type QualityPreset = "high" | "medium" | "low" | "mini";

export const QUALITY_PRESETS: Record<QualityPreset, { maxFps: number; minIntervalMs: number; label: string }> = {
  high:   { maxFps: 30, minIntervalMs: 33,  label: "High (30 FPS)" },
  medium: { maxFps: 15, minIntervalMs: 67,  label: "Medium (15 FPS)" },
  low:    { maxFps: 8,  minIntervalMs: 125, label: "Low (8 FPS)" },
  mini:   { maxFps: 4,  minIntervalMs: 250, label: "Mini (4 FPS)" },
};

export const DEFAULT_QUALITY: QualityPreset = "high";
