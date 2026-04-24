/**
 * NodeDefinitions -- single source of truth for workflow node types.
 *
 * Each node type is a self-describing object. Adding a new node = one entry here + one primitive in apps.json.
 * No other files should need modification.
 *
 * Backend: validateEdges(), resolveWorkflowToPipeline(), activation dispatch all derive from this.
 * Frontend: palette, config panel, edge validation, SVG subtitles all derive from this via /api/node-definitions.
 */

// --- Config Schema Types (serializable, drives frontend form generation) ---

export type ConfigFieldSchema =
  | { kind: "text"; key: string; label: string; placeholder?: string }
  | { kind: "textarea"; key: string; label: string; rows?: number; placeholder?: string }
  | { kind: "select"; key: string; label: string; options: Array<{ value: string; label: string }> }
  | { kind: "range"; key: string; label: string; min: number; max: number; step: number; unit?: string }
  | { kind: "checkbox"; key: string; label: string }
  | { kind: "number"; key: string; label: string; min?: number; max?: number; step?: number }
  | { kind: "checkbox-group"; key: string; label: string; fields: Array<{ key: string; label: string }> }
  | { kind: "section"; label: string; fields: ConfigFieldSchema[] };

// --- Structural & Activation Types ---

export type StructuralRole = "source" | "processor" | "reference" | "sink" | "channel";

export type ActivationMode = "ai" | "jepa" | "passthrough";

export type RuntimeTarget = "mobile" | "server";

// --- Node Definition ---

export interface NodeDefinition {
  /** Unique node type identifier */
  type: string;
  /** Human-readable name for palette and headers */
  label: string;
  /** SVG subtitle template (${key} resolved against config at render time) */
  subtitle: string;
  /** Color scheme for SVG rendering */
  color: { fill: string; header: string; stroke: string };
  /** Which node types this node can connect TO (outgoing edges) */
  allowedTargets: string[];
  /** Structural role for DAG validation */
  role: StructuralRole;
  /** How this node is activated at runtime. null = not processable */
  activationMode: ActivationMode | null;
  /** Primitive binding (maps to apps.json). null = no binding */
  binding: string | null;
  /** Default model for processable nodes */
  defaultModel: string | null;
  /** Config field schema -- describes the form UI */
  configSchema: ConfigFieldSchema[];
  /** Default config values for new nodes */
  defaultConfig: Record<string, unknown>;
  /** Default label for new nodes */
  defaultLabel: string;
  /** Where this node executes at runtime */
  runtime: RuntimeTarget[];
}

// --- Sentinel ---

/** Sentinel value in allowedTargets: expands to all current sink types */
export const TARGET_ROLE_SINK = "<sink>";

/** Expand "<sink>" sentinel to all concrete sink types */
function expandTargets(targets: string[], sinkTypes: string[]): string[] {
  if (!targets.includes(TARGET_ROLE_SINK)) return targets;
  return [...targets.filter(t => t !== TARGET_ROLE_SINK), ...sinkTypes];
}

// --- Definitions ---

export const NODE_DEFINITIONS: NodeDefinition[] = [
  {
    type: "stream-input",
    label: "Stream Input",
    subtitle: "${_modalities}",
    color: { fill: "#0d3d38", header: "#14b8a6", stroke: "#14b8a6" },
    allowedTargets: ["s2s-live", "s2s-rest", "s2s-e4b", "jepa-vision", TARGET_ROLE_SINK],
    role: "source",
    activationMode: null,
    binding: null,
    defaultModel: null,
    configSchema: [
      { kind: "text", key: "label", label: "Label" },
      { kind: "checkbox-group", key: "modalities", label: "Modalities", fields: [
        { key: "video", label: "Video (frames)" },
        { key: "phoneMic", label: "Phone mic (48kHz)" },
        { key: "glassesMic", label: "Glasses HFP mic (8kHz)" },
        { key: "gestures", label: "Gestures" },
      ]},
      { kind: "range", key: "visionFps", label: "Vision FPS", min: 0.2, max: 2, step: 0.1 },
      { kind: "select", key: "codec", label: "Video Codec", options: [
        { value: "jpeg", label: "JPEG (compatible with AI models)" },
        { value: "h264", label: "H.264 (lower bandwidth, viewer-only)" },
      ]},
      { kind: "section", label: "Lifecycle Policy", fields: [
        { kind: "select", key: "onDisconnect", label: "On publisher disconnect", options: [
          { value: "stop", label: "Stop AI" },
          { value: "pause", label: "Pause AI" },
          { value: "continue", label: "Continue until timeout" },
        ]},
        { kind: "select", key: "onReconnect", label: "On publisher reconnect", options: [
          { value: "restart", label: "Restart AI" },
          { value: "resume", label: "Resume AI" },
          { value: "noop", label: "No-op" },
        ]},
        { kind: "number", key: "autoDeactivateMin", label: "Auto-deactivate after (min, 0 = never)", min: 0, max: 480, step: 5 },
      ]},
    ],
    defaultConfig: { video: true, phoneMic: true, glassesMic: false, gestures: true, visionFps: 1, codec: "jpeg", onDisconnect: "stop", onReconnect: "restart", autoDeactivateMin: null },
    defaultLabel: "Stream Input",
    runtime: ["mobile"],
  },
  {
    type: "text",
    label: "Text",
    subtitle: "${text}",
    color: { fill: "#1a1a2e", header: "#e2e8f0", stroke: "#94a3b8" },
    allowedTargets: ["s2s-live", "s2s-rest", "s2s-e4b"],
    role: "reference",
    activationMode: null,
    binding: null,
    defaultModel: null,
    configSchema: [
      { kind: "text", key: "label", label: "Label" },
      { kind: "textarea", key: "text", label: "System Prompt", rows: 10, placeholder: "Enter system prompt..." },
    ],
    defaultConfig: { text: "" },
    defaultLabel: "Text",
    runtime: ["server"],
  },
  {
    type: "s2s-live",
    label: "S2S Live",
    subtitle: "${model}",
    color: { fill: "#0d3320", header: "#22c55e", stroke: "#22c55e" },
    allowedTargets: ["s2s-live", "s2s-rest", "s2s-e4b", "jepa-vision", TARGET_ROLE_SINK],
    role: "processor",
    activationMode: "ai",
    binding: "s2s-gemini-live",
    defaultModel: "gemini-2.5-flash-native-audio-latest",
    configSchema: [
      { kind: "text", key: "label", label: "Label" },
      { kind: "select", key: "model", label: "Model", options: [
        { value: "gemini-2.5-flash-native-audio-latest", label: "gemini-2.5-flash-native-audio" },
        { value: "gemini-2.0-flash", label: "gemini-2.0-flash" },
      ]},
      { kind: "select", key: "voice", label: "Voice", options: [
        { value: "", label: "Default" },
        { value: "Aoede", label: "Aoede" },
        { value: "Puck", label: "Puck" },
        { value: "Charon", label: "Charon" },
        { value: "Fenchir", label: "Fenchir" },
        { value: "Kore", label: "Kore" },
        { value: "Leda", label: "Leda" },
      ]},
      { kind: "range", key: "visionFps", label: "Vision FPS", min: 0.2, max: 2, step: 0.1 },
      { kind: "range", key: "temperature", label: "Temperature", min: 0, max: 2, step: 0.1 },
      { kind: "number", key: "analysisIntervalSec", label: "Analysis interval (sec)", min: 1, max: 30, step: 1 },
    ],
    defaultConfig: { model: "gemini-2.5-flash-native-audio-latest" },
    defaultLabel: "S2S Live",
    runtime: ["server"],
  },
  {
    type: "s2s-rest",
    label: "S2S REST",
    subtitle: "${model}",
    color: { fill: "#0d2040", header: "#3b82f6", stroke: "#3b82f6" },
    allowedTargets: ["s2s-live", "s2s-rest", "s2s-e4b", "jepa-vision", TARGET_ROLE_SINK],
    role: "processor",
    activationMode: "ai",
    binding: "s2s-gemma4-rest",
    defaultModel: "gemma-4-27b",
    configSchema: [
      { kind: "text", key: "label", label: "Label" },
      { kind: "select", key: "model", label: "Model", options: [
        { value: "gemma-4-27b", label: "gemma-4-27b" },
        { value: "gemma-4-12b", label: "gemma-4-12b" },
      ]},
      { kind: "range", key: "visionFps", label: "Vision FPS", min: 0.2, max: 2, step: 0.1 },
      { kind: "range", key: "temperature", label: "Temperature", min: 0, max: 2, step: 0.1 },
      { kind: "number", key: "analysisIntervalSec", label: "Analysis interval (sec)", min: 1, max: 30, step: 1 },
    ],
    defaultConfig: { model: "gemma-4-27b" },
    defaultLabel: "S2S REST",
    runtime: ["server"],
  },
  {
    type: "s2s-e4b",
    label: "S2S E4B",
    subtitle: "${model}",
    color: { fill: "#2d1050", header: "#a855f7", stroke: "#a855f7" },
    allowedTargets: ["s2s-live", "s2s-rest", "s2s-e4b", "jepa-vision", TARGET_ROLE_SINK],
    role: "processor",
    activationMode: "ai",
    binding: "s2s-gemma4-e4b-rest",
    defaultModel: "gemma-4-e4b-it",
    configSchema: [
      { kind: "text", key: "label", label: "Label" },
      { kind: "select", key: "model", label: "Model", options: [
        { value: "gemma-4-e4b-it", label: "gemma-4-e4b-it" },
      ]},
      { kind: "select", key: "voice", label: "Voice", options: [
        { value: "", label: "Default" },
        { value: "Aoede", label: "Aoede" },
        { value: "Puck", label: "Puck" },
        { value: "Charon", label: "Charon" },
        { value: "Kore", label: "Kore" },
      ]},
      { kind: "range", key: "visionFps", label: "Vision FPS", min: 0.2, max: 2, step: 0.1 },
      { kind: "range", key: "temperature", label: "Temperature", min: 0, max: 2, step: 0.1 },
      { kind: "number", key: "analysisIntervalSec", label: "Analysis interval (sec)", min: 1, max: 30, step: 1 },
    ],
    defaultConfig: { model: "gemma-4-e4b-it" },
    defaultLabel: "S2S E4B",
    runtime: ["server"],
  },
  {
    type: "jepa-vision",
    label: "JEPA Vision",
    subtitle: "${model} | ${provider}",
    color: { fill: "#3d1a00", header: "#ef4444", stroke: "#ef4444" },
    allowedTargets: [TARGET_ROLE_SINK],
    role: "processor",
    activationMode: "jepa",
    binding: "jepa-vjepa2",
    defaultModel: "vjepa2-vit-l",
    configSchema: [
      { kind: "text", key: "label", label: "Label" },
      { kind: "select", key: "model", label: "Model", options: [
        { value: "vjepa2-vit-l", label: "V-JEPA 2 ViT-L (1.2B)" },
        { value: "lewm-small", label: "LeWorldModel (15M)" },
      ]},
      { kind: "select", key: "tier", label: "Tier", options: [
        { value: "cloud", label: "Cloud (Modal GPU)" },
        { value: "mobile", label: "Mobile (On-device)" },
      ]},
      { kind: "select", key: "provider", label: "Provider", options: [
        { value: "modal", label: "Modal (cloud)" },
        { value: "coreml", label: "CoreML (iOS)" },
        { value: "onnx", label: "ONNX (Android)" },
      ]},
      { kind: "select", key: "gpu", label: "GPU", options: [
        { value: "A100-80GB", label: "A100 80GB ($2.10/hr)" },
        { value: "H100", label: "H100 ($3.95/hr)" },
        { value: "A10G", label: "A10G ($1.10/hr)" },
      ]},
      { kind: "range", key: "clipLength", label: "Clip Length", min: 4, max: 64, step: 4, unit: " frames" },
      { kind: "range", key: "sampleFps", label: "Sample FPS", min: 0.5, max: 5, step: 0.5 },
      { kind: "select", key: "resolution", label: "Resolution", options: [
        { value: "224", label: "224x224" },
        { value: "384", label: "384x384" },
      ]},
    ],
    defaultConfig: { provider: "modal", tier: "cloud", model: "vjepa2-vit-l", gpu: "A100-80GB", clipLength: 16, sampleFps: 2, resolution: 224, tasks: [{ type: "anomaly" }, { type: "action" }] },
    defaultLabel: "JEPA Vision",
    runtime: ["server", "mobile"],
  },
  {
    type: "output",
    label: "Output",
    subtitle: "hub",
    color: { fill: "#3d2000", header: "#f97316", stroke: "#f97316" },
    allowedTargets: ["local-tts", "tones", "phone-speaker", "glasses-speaker", "viewers", "overlays", "recording"],
    role: "sink",
    activationMode: null,
    binding: null,
    defaultModel: null,
    configSchema: [
      { kind: "text", key: "label", label: "Label" },
    ],
    defaultConfig: {},
    defaultLabel: "Output",
    runtime: ["server", "mobile"],
  },
  // --- Output channel nodes (connect FROM output only) ---
  {
    type: "local-tts",
    label: "Local TTS",
    subtitle: "on-device speech",
    color: { fill: "#3d2000", header: "#f97316", stroke: "#f97316" },
    allowedTargets: [],
    role: "channel",
    activationMode: null,
    binding: null,
    defaultModel: null,
    configSchema: [
      { kind: "text", key: "label", label: "Label" },
      { kind: "select", key: "voice", label: "Voice", options: [
        { value: "", label: "Default" },
        { value: "Aoede", label: "Aoede" },
        { value: "Puck", label: "Puck" },
        { value: "Charon", label: "Charon" },
        { value: "Kore", label: "Kore" },
      ]},
    ],
    defaultConfig: {},
    defaultLabel: "Local TTS",
    runtime: ["mobile"],
  },
  {
    type: "tones",
    label: "Tones",
    subtitle: "alert sounds",
    color: { fill: "#3d2000", header: "#f97316", stroke: "#f97316" },
    allowedTargets: [],
    role: "channel",
    activationMode: null,
    binding: null,
    defaultModel: null,
    configSchema: [
      { kind: "text", key: "label", label: "Label" },
    ],
    defaultConfig: {},
    defaultLabel: "Tones",
    runtime: ["mobile"],
  },
  {
    type: "phone-speaker",
    label: "Phone Speaker",
    subtitle: "phone audio out",
    color: { fill: "#3d2000", header: "#f97316", stroke: "#f97316" },
    allowedTargets: [],
    role: "channel",
    activationMode: null,
    binding: null,
    defaultModel: null,
    configSchema: [
      { kind: "text", key: "label", label: "Label" },
    ],
    defaultConfig: {},
    defaultLabel: "Phone Speaker",
    runtime: ["mobile"],
  },
  {
    type: "glasses-speaker",
    label: "Glasses Speaker",
    subtitle: "HFP/A2DP audio",
    color: { fill: "#3d2000", header: "#f97316", stroke: "#f97316" },
    allowedTargets: [],
    role: "channel",
    activationMode: null,
    binding: null,
    defaultModel: null,
    configSchema: [
      { kind: "text", key: "label", label: "Label" },
      { kind: "select", key: "profile", label: "BT Profile", options: [
        { value: "hfp", label: "HFP (8kHz bidirectional)" },
        { value: "a2dp", label: "A2DP (high quality, output only)" },
      ]},
    ],
    defaultConfig: { profile: "hfp" },
    defaultLabel: "Glasses Speaker",
    runtime: ["mobile"],
  },
  {
    type: "viewers",
    label: "Viewers",
    subtitle: "WS fanout",
    color: { fill: "#3d2000", header: "#f97316", stroke: "#f97316" },
    allowedTargets: [],
    role: "channel",
    activationMode: null,
    binding: null,
    defaultModel: null,
    configSchema: [
      { kind: "text", key: "label", label: "Label" },
    ],
    defaultConfig: {},
    defaultLabel: "Viewers",
    runtime: ["server"],
  },
  {
    type: "overlays",
    label: "Overlays",
    subtitle: "bbox annotations",
    color: { fill: "#3d2000", header: "#f97316", stroke: "#f97316" },
    allowedTargets: [],
    role: "channel",
    activationMode: null,
    binding: null,
    defaultModel: null,
    configSchema: [
      { kind: "text", key: "label", label: "Label" },
    ],
    defaultConfig: {},
    defaultLabel: "Overlays",
    runtime: ["mobile"],
  },
  {
    type: "recording",
    label: "Recording",
    subtitle: "R2 persist",
    color: { fill: "#3d2000", header: "#f97316", stroke: "#f97316" },
    allowedTargets: [],
    role: "channel",
    activationMode: null,
    binding: null,
    defaultModel: null,
    configSchema: [
      { kind: "text", key: "label", label: "Label" },
    ],
    defaultConfig: {},
    defaultLabel: "Recording",
    runtime: ["server"],
  },
];

// --- Derived Helpers ---

export const NODE_DEF_MAP = new Map(NODE_DEFINITIONS.map(d => [d.type, d]));

/** All current sink + channel type identifiers (derived from definitions) */
const SINK_TYPES = NODE_DEFINITIONS.filter(d => d.role === "sink" || d.role === "channel").map(d => d.type);

/** Build the allowed edge map from definitions (for validateEdges) */
export function buildAllowedEdgeMap(): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const def of NODE_DEFINITIONS) {
    map.set(def.type, new Set(expandTargets(def.allowedTargets, SINK_TYPES)));
  }
  return map;
}

/** Validate workflow DAG structure using role-based rules */
export function validateStructure(nodes: Array<{ type: string }>): string | null {
  const sourceCount = nodes.filter(n => NODE_DEF_MAP.get(resolveNodeType(n.type))?.role === "source").length;
  const processorCount = nodes.filter(n => NODE_DEF_MAP.get(resolveNodeType(n.type))?.role === "processor").length;
  const sinkOrChannelCount = nodes.filter(n => {
    const role = NODE_DEF_MAP.get(resolveNodeType(n.type))?.role;
    return role === "sink" || role === "channel";
  }).length;
  if (sourceCount !== 1) return "Must have exactly 1 source (stream-input) node";
  if (processorCount < 1) return "Must have at least 1 processor (AI/JEPA) node";
  if (sinkOrChannelCount < 1) return "Must have at least 1 output or channel node";
  return null;
}

/** Resolve node types — maps old names to current definitions */
const TYPE_ALIASES: Record<string, string> = {
  "camera-source": "stream-input",
  "output-full": "output",
  "output-viewers": "output",
  "output-speaker": "local-tts",
  "output-recording": "output",
  "output-overlays": "output",
  "speaker": "local-tts",
};

export function resolveNodeType(type: string): string {
  return TYPE_ALIASES[type] ?? type;
}

/** Check if a node type is a sink (resolves aliases first) */
export function isSinkType(type: string): boolean {
  return SINK_TYPES.includes(resolveNodeType(type));
}
