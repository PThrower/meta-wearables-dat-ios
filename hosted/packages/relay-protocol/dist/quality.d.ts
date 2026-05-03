/**
 * Quality presets for viewer frame throttling
 */
export type QualityPreset = "high" | "medium" | "low" | "mini";
export declare const QUALITY_PRESETS: Record<QualityPreset, {
    maxFps: number;
    minIntervalMs: number;
    label: string;
}>;
export declare const DEFAULT_QUALITY: QualityPreset;
