/**
 * Node definitions, type aliases, fallback palette, and resolve helpers.
 */

import { fetchNodeDefinitions, esc } from "../../core/api-client.js";
import type { NodeDefinition } from "../../core/api-client.js";

let _nodeDefs: NodeDefinition[] = [];
let _nodeDefMap = new Map<string, NodeDefinition>();

/** Map old node type names to their current equivalents. */
const TYPE_ALIASES: Record<string, string> = {
  "stream-input": "camera-source",
  "output-full": "viewers",
  "output-viewers": "viewers",
  "output-speaker": "local-tts",
  "output-recording": "recording",
  "output-overlays": "overlays",
  "output": "viewers",
};

/** Static fallback palette — used when the /api/node-definitions fetch fails. */
export const FALLBACK_PALETTE: NodeDefinition[] = [
  { type: "camera-source", label: "Camera", subtitle: "${codec} ${visionFps}fps", color: { fill: "#0d3d38", header: "#14b8a6", stroke: "#14b8a6" }, allowedTargets: ["s2s-live", "s2s-rest", "s2s-e4b", "jepa-vision", "local-tts", "<sink>", "<trigger>"], role: "source", activationMode: null, binding: null, defaultModel: null, configSchema: [], defaultConfig: { visionFps: 1, codec: "jpeg" }, defaultLabel: "Camera", runtime: ["mobile"] },
  { type: "phone-mic-source", label: "Phone Mic", subtitle: "48kHz built-in", color: { fill: "#0d3d38", header: "#14b8a6", stroke: "#14b8a6" }, allowedTargets: ["s2s-live", "s2s-rest", "s2s-e4b", "jepa-vision", "local-tts", "deepgram-stt", "<sink>"], role: "source", activationMode: null, binding: null, defaultModel: null, configSchema: [], defaultConfig: {}, defaultLabel: "Phone Mic", runtime: ["mobile"] },
  { type: "glasses-mic-source", label: "Glasses Mic", subtitle: "8kHz HFP", color: { fill: "#0d3d38", header: "#14b8a6", stroke: "#14b8a6" }, allowedTargets: ["s2s-live", "s2s-rest", "s2s-e4b", "jepa-vision", "local-tts", "deepgram-stt", "<sink>"], role: "source", activationMode: null, binding: null, defaultModel: null, configSchema: [], defaultConfig: {}, defaultLabel: "Glasses Mic", runtime: ["mobile"] },
  { type: "gesture-source", label: "Gestures", subtitle: "hand gestures", color: { fill: "#0d3d38", header: "#14b8a6", stroke: "#14b8a6" }, allowedTargets: ["s2s-live", "s2s-rest", "s2s-e4b", "jepa-vision", "local-tts", "<sink>", "<trigger>"], role: "source", activationMode: null, binding: null, defaultModel: null, configSchema: [], defaultConfig: {}, defaultLabel: "Gestures", runtime: ["mobile"] },
  { type: "text", label: "Text", subtitle: "${text}", color: { fill: "#1a1a2e", header: "#e2e8f0", stroke: "#94a3b8" }, allowedTargets: ["s2s-live", "s2s-rest", "s2s-e4b", "local-tts"], role: "reference", activationMode: null, binding: null, defaultModel: null, configSchema: [], defaultConfig: { text: "" }, defaultLabel: "Text", runtime: ["server"] },
  { type: "s2s-live", label: "S2S Live", subtitle: "${model}", color: { fill: "#0d3320", header: "#22c55e", stroke: "#22c55e" }, allowedTargets: ["s2s-live", "s2s-rest", "s2s-e4b", "jepa-vision", "<sink>", "<trigger>"], role: "processor", activationMode: "ai", binding: "s2s-gemini-live", defaultModel: "gemini-2.5-flash-native-audio-latest", configSchema: [], defaultConfig: { model: "gemini-2.5-flash-native-audio-latest" }, defaultLabel: "S2S Live", runtime: ["server"] },
  { type: "s2s-rest", label: "S2S REST", subtitle: "${model}", color: { fill: "#0d2040", header: "#3b82f6", stroke: "#3b82f6" }, allowedTargets: ["s2s-live", "s2s-rest", "s2s-e4b", "jepa-vision", "<sink>", "<trigger>"], role: "processor", activationMode: "ai", binding: "s2s-gemma4-rest", defaultModel: "gemma-4-27b", configSchema: [], defaultConfig: { model: "gemma-4-27b" }, defaultLabel: "S2S REST", runtime: ["server"] },
  { type: "s2s-e4b", label: "S2S E4B", subtitle: "${model}", color: { fill: "#2d1050", header: "#a855f7", stroke: "#a855f7" }, allowedTargets: ["s2s-live", "s2s-rest", "s2s-e4b", "jepa-vision", "<sink>", "<trigger>"], role: "processor", activationMode: "ai", binding: "s2s-gemma4-e4b-rest", defaultModel: "gemma-4-e4b-it", configSchema: [], defaultConfig: { model: "gemma-4-e4b-it" }, defaultLabel: "S2S E4B", runtime: ["server"] },
  { type: "jepa-vision", label: "JEPA Vision", subtitle: "${model} | ${provider}", color: { fill: "#3d1a00", header: "#ef4444", stroke: "#ef4444" }, allowedTargets: ["<sink>", "<trigger>"], role: "processor", activationMode: "jepa", binding: "jepa-vjepa2", defaultModel: "vjepa2-vit-l", configSchema: [], defaultConfig: { provider: "modal", tier: "cloud", model: "vjepa2-vit-l", gpu: "A100-80GB", clipLength: 16, sampleFps: 2, resolution: 224, tasks: [{ type: "anomaly" }, { type: "action" }] }, defaultLabel: "JEPA Vision", runtime: ["server", "mobile"] },
  { type: "deepgram-stt", label: "Deepgram STT", subtitle: "${model} | ${language}", color: { fill: "#0d2040", header: "#3b82f6", stroke: "#3b82f6" }, allowedTargets: ["s2s-live", "s2s-rest", "s2s-e4b", "jepa-vision", "local-tts", "<sink>", "<trigger>"], role: "processor", activationMode: "stt", binding: "deepgram-stt", defaultModel: "nova-2", configSchema: [], defaultConfig: { model: "nova-2", language: "en-US", punctuation: true, diarize: false, profanityFilter: false }, defaultLabel: "Deepgram STT", runtime: ["server"] },
  { type: "jepa-trigger", label: "JEPA Trigger", subtitle: "on ${triggerOn} > ${confidenceThreshold}", color: { fill: "#3d3000", header: "#eab308", stroke: "#eab308" }, allowedTargets: ["s2s-live", "s2s-rest", "s2s-e4b", "local-tts", "<sink>"], role: "trigger" as const, activationMode: null, binding: null, defaultModel: null, configSchema: [], defaultConfig: { confidenceThreshold: 0.8, triggerOn: "anomaly", action: "activate", promptTemplate: "", cooldownSec: 30 }, defaultLabel: "JEPA Trigger", runtime: ["server"] },
  { type: "timer-trigger", label: "Timer Trigger", subtitle: "every ${intervalSec}s", color: { fill: "#3d3000", header: "#eab308", stroke: "#eab308" }, allowedTargets: ["s2s-live", "s2s-rest", "s2s-e4b", "jepa-vision", "local-tts", "<sink>"], role: "trigger" as const, activationMode: null, binding: null, defaultModel: null, configSchema: [], defaultConfig: { intervalSec: 30, maxTriggers: 0, action: "activate", promptTemplate: "" }, defaultLabel: "Timer Trigger", runtime: ["server"] },
  { type: "conditional", label: "Conditional", subtitle: "if ${field} ${operator} ${value}", color: { fill: "#3d3000", header: "#eab308", stroke: "#eab308" }, allowedTargets: ["s2s-live", "s2s-rest", "s2s-e4b", "local-tts", "<sink>"], role: "trigger" as const, activationMode: null, binding: null, defaultModel: null, configSchema: [], defaultConfig: { field: "confidence", operator: "gt", value: 0.8, cooldownSec: 30 }, defaultLabel: "Conditional", runtime: ["server"] },
  { type: "local-tts", label: "Local TTS", subtitle: "on-device speech", color: { fill: "#3d2000", header: "#f97316", stroke: "#f97316" }, allowedTargets: ["phone-speaker", "glasses-speaker"], role: "transform" as const, activationMode: null, binding: null, defaultModel: null, configSchema: [], defaultConfig: {}, defaultLabel: "Local TTS", runtime: ["mobile"] },
  { type: "tones", label: "Tones", subtitle: "alert sounds", color: { fill: "#3d2000", header: "#f97316", stroke: "#f97316" }, allowedTargets: [], role: "sink" as const, activationMode: null, binding: null, defaultModel: null, configSchema: [], defaultConfig: {}, defaultLabel: "Tones", runtime: ["mobile"] },
  { type: "phone-speaker", label: "Phone Speaker", subtitle: "phone audio out", color: { fill: "#3d2000", header: "#f97316", stroke: "#f97316" }, allowedTargets: [], role: "sink" as const, activationMode: null, binding: null, defaultModel: null, configSchema: [], defaultConfig: {}, defaultLabel: "Phone Speaker", runtime: ["mobile"] },
  { type: "glasses-speaker", label: "Glasses Speaker", subtitle: "HFP/A2DP audio", color: { fill: "#3d2000", header: "#f97316", stroke: "#f97316" }, allowedTargets: [], role: "sink" as const, activationMode: null, binding: null, defaultModel: null, configSchema: [], defaultConfig: {}, defaultLabel: "Glasses Speaker", runtime: ["mobile"] },
  { type: "overlays", label: "Overlays", subtitle: "bbox annotations", color: { fill: "#3d2000", header: "#f97316", stroke: "#f97316" }, allowedTargets: [], role: "sink" as const, activationMode: null, binding: null, defaultModel: null, configSchema: [], defaultConfig: {}, defaultLabel: "Overlays", runtime: ["mobile"] },
];

/** Resolve a node type, mapping old names to current definitions. */
export function resolveNodeType(type: string): string {
  return TYPE_ALIASES[type] ?? type;
}

/** Get node definition, resolving old type aliases. */
export function getNodeDef(type: string): NodeDefinition | undefined {
  return _nodeDefMap.get(resolveNodeType(type));
}

/** Get all loaded node definitions. */
export function getNodeDefs(): NodeDefinition[] {
  return _nodeDefs;
}

/** Fetch node definitions from server, falling back to FALLBACK_PALETTE. */
export async function loadNodeDefs(): Promise<void> {
  if (_nodeDefs.length === 0) {
    _nodeDefs = await fetchNodeDefinitions();
    if (_nodeDefs.length === 0) _nodeDefs = FALLBACK_PALETTE;
    _nodeDefMap = new Map(_nodeDefs.map(d => [d.type, d]));
  }
}
