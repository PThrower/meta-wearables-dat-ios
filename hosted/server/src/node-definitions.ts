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

export type StructuralRole = "source" | "reference" | "processor" | "trigger" | "transform" | "sink";

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

/** Sentinel value in allowedTargets: expands to all current trigger types */
export const TARGET_ROLE_TRIGGER = "<trigger>";

/** Sentinel value in allowedTargets: expands to all current source types */
export const TARGET_ROLE_SOURCE = "<source>";

/** Expand "<sink>", "<trigger>", and "<source>" sentinels to concrete types */
function expandTargets(targets: string[], sinkTypes: string[], triggerTypes: string[], sourceTypes: string[]): string[] {
  let expanded = targets;
  if (expanded.includes(TARGET_ROLE_SINK)) {
    expanded = [...expanded.filter(t => t !== TARGET_ROLE_SINK), ...sinkTypes];
  }
  if (expanded.includes(TARGET_ROLE_TRIGGER)) {
    expanded = [...expanded.filter(t => t !== TARGET_ROLE_TRIGGER), ...triggerTypes];
  }
  if (expanded.includes(TARGET_ROLE_SOURCE)) {
    expanded = [...expanded.filter(t => t !== TARGET_ROLE_SOURCE), ...sourceTypes];
  }
  return expanded;
}

// --- Definitions ---

export const NODE_DEFINITIONS: NodeDefinition[] = [
  // --- Source nodes (granular input modalities) ---
  {
    type: "camera-source",
    label: "Camera",
    subtitle: "${codec} ${visionFps}fps",
    color: { fill: "#0d3d38", header: "#14b8a6", stroke: "#14b8a6" },
    allowedTargets: ["s2s-live", "s2s-rest", "s2s-e4b", "jepa-vision", "local-tts", TARGET_ROLE_SINK, TARGET_ROLE_TRIGGER],
    role: "source",
    activationMode: null,
    binding: null,
    defaultModel: null,
    configSchema: [
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
    defaultConfig: { visionFps: 1, codec: "jpeg", onDisconnect: "stop", onReconnect: "restart", autoDeactivateMin: null },
    defaultLabel: "Camera",
    runtime: ["mobile"],
  },
  {
    type: "phone-mic-source",
    label: "Phone Mic",
    subtitle: "48kHz built-in",
    color: { fill: "#0d3d38", header: "#14b8a6", stroke: "#14b8a6" },
    allowedTargets: ["s2s-live", "s2s-rest", "s2s-e4b", "jepa-vision", "local-tts", TARGET_ROLE_SINK],
    role: "source",
    activationMode: null,
    binding: null,
    defaultModel: null,
    configSchema: [
      { kind: "checkbox", key: "noiseSuppression", label: "Noise suppression" },
      { kind: "checkbox", key: "echoCancellation", label: "Echo cancellation" },
      { kind: "checkbox", key: "autoGainControl", label: "Auto gain control" },
    ],
    defaultConfig: { noiseSuppression: true, echoCancellation: true, autoGainControl: true },
    defaultLabel: "Phone Mic",
    runtime: ["mobile"],
  },
  {
    type: "glasses-mic-source",
    label: "Glasses Mic",
    subtitle: "8kHz HFP",
    color: { fill: "#0d3d38", header: "#14b8a6", stroke: "#14b8a6" },
    allowedTargets: ["s2s-live", "s2s-rest", "s2s-e4b", "jepa-vision", "local-tts", TARGET_ROLE_SINK],
    role: "source",
    activationMode: null,
    binding: null,
    defaultModel: null,
    configSchema: [
      { kind: "number", key: "hfpSetupDelayMs", label: "HFP setup delay (ms)", min: 0, max: 10000, step: 500 },
      { kind: "checkbox", key: "beamforming", label: "Beamforming (focuses on wearer voice)" },
    ],
    defaultConfig: { hfpSetupDelayMs: 2000, beamforming: true },
    defaultLabel: "Glasses Mic",
    runtime: ["mobile"],
  },
  {
    type: "gesture-source",
    label: "Gestures",
    subtitle: "hand gestures",
    color: { fill: "#0d3d38", header: "#14b8a6", stroke: "#14b8a6" },
    allowedTargets: ["s2s-live", "s2s-rest", "s2s-e4b", "jepa-vision", "local-tts", TARGET_ROLE_SINK, TARGET_ROLE_TRIGGER],
    role: "source",
    activationMode: null,
    binding: null,
    defaultModel: null,
    configSchema: [
      { kind: "checkbox-group", key: "gestures", label: "Gestures", fields: [
        { key: "thumbsUp", label: "Thumbs up" },
        { key: "thumbsDown", label: "Thumbs down" },
        { key: "openPalm", label: "Open palm" },
        { key: "pointing", label: "Pointing" },
      ]},
    ],
    defaultConfig: { gestures: { thumbsUp: true, thumbsDown: true, openPalm: true, pointing: true } },
    defaultLabel: "Gestures",
    runtime: ["mobile"],
  },
  {
    type: "text",
    label: "Text",
    subtitle: "${text}",
    color: { fill: "#1a1a2e", header: "#e2e8f0", stroke: "#94a3b8" },
    allowedTargets: ["s2s-live", "s2s-rest", "s2s-e4b", "local-tts"],
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
    allowedTargets: ["s2s-live", "s2s-rest", "s2s-e4b", "jepa-vision", "local-tts", TARGET_ROLE_SINK, TARGET_ROLE_TRIGGER],
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
    allowedTargets: ["s2s-live", "s2s-rest", "s2s-e4b", "jepa-vision", "local-tts", TARGET_ROLE_SINK, TARGET_ROLE_TRIGGER],
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
    allowedTargets: ["s2s-live", "s2s-rest", "s2s-e4b", "jepa-vision", "local-tts", TARGET_ROLE_SINK, TARGET_ROLE_TRIGGER],
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
    allowedTargets: ["local-tts", TARGET_ROLE_SINK, TARGET_ROLE_TRIGGER],
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
  // --- Trigger nodes (event-driven conditional routers) ---
  //
  // Triggers are event-driven routers that bridge processors to other nodes.
  // They receive discrete events from upstream processors and conditionally
  // activate downstream processors/transforms/sinks.
  //
  // Contract:
  //   - role: "trigger"
  //   - activationMode: null (not directly activated; routes events)
  //   - Produces discrete events, not continuous streams
  //   - Can receive from processors (downstream of their output)
  //   - Can target processors, transforms, or sinks
  //   - Runtime: evaluate condition -> activate downstream
  //
  {
    type: "jepa-trigger",
    label: "JEPA Trigger",
    subtitle: "on ${triggerOn} > ${confidenceThreshold}",
    color: { fill: "#3d3000", header: "#eab308", stroke: "#eab308" },
    allowedTargets: ["s2s-live", "s2s-rest", "s2s-e4b", "local-tts", TARGET_ROLE_SINK],
    role: "trigger",
    activationMode: null,
    binding: null,
    defaultModel: null,
    configSchema: [
      { kind: "text", key: "label", label: "Label" },
      { kind: "range", key: "confidenceThreshold", label: "Confidence Threshold", min: 0, max: 1, step: 0.05 },
      { kind: "select", key: "triggerOn", label: "Trigger On", options: [
        { value: "anomaly", label: "Anomaly detected" },
        { value: "action", label: "Action recognized" },
        { value: "any", label: "Any JEPA event" },
      ]},
      { kind: "select", key: "action", label: "Action", options: [
        { value: "activate", label: "Activate AI processor" },
        { value: "speak", label: "Speak alert via TTS" },
        { value: "notify", label: "Send notification" },
      ]},
      { kind: "textarea", key: "promptTemplate", label: "Prompt Template", rows: 4, placeholder: "Anomaly detected: ${description}. Confidence: ${confidence}" },
      { kind: "number", key: "cooldownSec", label: "Cooldown (sec, 0 = none)", min: 0, max: 300, step: 5 },
    ],
    defaultConfig: { confidenceThreshold: 0.8, triggerOn: "anomaly", action: "activate", promptTemplate: "", cooldownSec: 30 },
    defaultLabel: "JEPA Trigger",
    runtime: ["server"],
  },
  {
    type: "timer-trigger",
    label: "Timer Trigger",
    subtitle: "every ${intervalSec}s",
    color: { fill: "#3d3000", header: "#eab308", stroke: "#eab308" },
    allowedTargets: ["s2s-live", "s2s-rest", "s2s-e4b", "jepa-vision", "local-tts", TARGET_ROLE_SINK],
    role: "trigger",
    activationMode: null,
    binding: null,
    defaultModel: null,
    configSchema: [
      { kind: "text", key: "label", label: "Label" },
      { kind: "number", key: "intervalSec", label: "Interval (seconds)", min: 5, max: 3600, step: 5 },
      { kind: "number", key: "maxTriggers", label: "Max triggers (0 = unlimited)", min: 0, max: 100, step: 1 },
      { kind: "select", key: "action", label: "Action", options: [
        { value: "activate", label: "Activate AI processor" },
        { value: "speak", label: "Speak text via TTS" },
        { value: "capture", label: "Capture frame for analysis" },
      ]},
      { kind: "textarea", key: "promptTemplate", label: "Prompt Template", rows: 3, placeholder: "Analyze the current scene." },
    ],
    defaultConfig: { intervalSec: 30, maxTriggers: 0, action: "activate", promptTemplate: "" },
    defaultLabel: "Timer Trigger",
    runtime: ["server"],
  },
  {
    type: "conditional",
    label: "Conditional",
    subtitle: "if ${field} ${operator} ${value}",
    color: { fill: "#3d3000", header: "#eab308", stroke: "#eab308" },
    allowedTargets: ["s2s-live", "s2s-rest", "s2s-e4b", "local-tts", TARGET_ROLE_SINK],
    role: "trigger",
    activationMode: null,
    binding: null,
    defaultModel: null,
    configSchema: [
      { kind: "text", key: "label", label: "Label" },
      { kind: "text", key: "field", label: "Field", placeholder: "confidence" },
      { kind: "select", key: "operator", label: "Operator", options: [
        { value: "gt", label: "> (greater than)" },
        { value: "gte", label: ">= (greater or equal)" },
        { value: "lt", label: "< (less than)" },
        { value: "lte", label: "<= (less or equal)" },
        { value: "eq", label: "= (equals)" },
        { value: "neq", label: "!= (not equals)" },
      ]},
      { kind: "number", key: "value", label: "Value", step: 0.01 },
      { kind: "number", key: "cooldownSec", label: "Cooldown (sec, 0 = none)", min: 0, max: 300, step: 5 },
    ],
    defaultConfig: { field: "confidence", operator: "gt", value: 0.8, cooldownSec: 30 },
    defaultLabel: "Conditional",
    runtime: ["server"],
  },
  // --- Transform nodes (data format conversion) ---
  {
    type: "local-tts",
    label: "Local TTS",
    subtitle: "on-device speech",
    color: { fill: "#3d2000", header: "#f97316", stroke: "#f97316" },
    allowedTargets: ["phone-speaker", "glasses-speaker"],
    role: "transform",
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
  // --- Sink nodes (final delivery endpoints) ---
  {
    type: "tones",
    label: "Tones",
    subtitle: "alert sounds",
    color: { fill: "#3d2000", header: "#f97316", stroke: "#f97316" },
    allowedTargets: [],
    role: "sink",
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
    role: "sink",
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
    role: "sink",
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
    type: "overlays",
    label: "Overlays",
    subtitle: "bbox annotations",
    color: { fill: "#3d2000", header: "#f97316", stroke: "#f97316" },
    allowedTargets: [],
    role: "sink",
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
];

// --- Derived Helpers ---

export const NODE_DEF_MAP = new Map(NODE_DEFINITIONS.map(d => [d.type, d]));

/** All current sink type identifiers (derived from definitions) */
const SINK_TYPES = NODE_DEFINITIONS.filter(d => d.role === "sink").map(d => d.type);

/** All current trigger type identifiers (derived from definitions) */
const TRIGGER_TYPES = NODE_DEFINITIONS.filter(d => d.role === "trigger").map(d => d.type);

/** All current source type identifiers (derived from definitions) */
const SOURCE_TYPES = NODE_DEFINITIONS.filter(d => d.role === "source").map(d => d.type);

/** Build the allowed edge map from definitions (for validateEdges) */
export function buildAllowedEdgeMap(): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const def of NODE_DEFINITIONS) {
    map.set(def.type, new Set(expandTargets(def.allowedTargets, SINK_TYPES, TRIGGER_TYPES, SOURCE_TYPES)));
  }
  return map;
}

/** Validate workflow DAG structure using role-based rules */
export function validateStructure(nodes: Array<{ type: string }>): string | null {
  if (nodes.length === 0) return "Workflow must have at least 1 node";
  const sourceCount = nodes.filter(n => {
    const role = NODE_DEF_MAP.get(resolveNodeType(n.type))?.role;
    return role === "source";
  }).length;
  if (sourceCount < 1) return "Must have at least 1 source node";
  const sinkTransformTriggerCount = nodes.filter(n => {
    const role = NODE_DEF_MAP.get(resolveNodeType(n.type))?.role;
    return role === "sink" || role === "transform" || role === "trigger";
  }).length;
  if (sinkTransformTriggerCount < 1) return "Must have at least 1 sink, transform, or trigger node";
  return null;
}

/** Resolve node types — maps old names to current definitions */
const TYPE_ALIASES: Record<string, string> = {
  // Legacy monolithic source -> granular camera-source (lifecycle config lives there)
  "stream-input": "camera-source",
  "output-full": "viewers",
  "output-viewers": "viewers",
  "output-speaker": "local-tts",
  "output-recording": "recording",
  "output-overlays": "overlays",
  "output": "viewers",
  "speaker": "local-tts",
};

export function resolveNodeType(type: string): string {
  return TYPE_ALIASES[type] ?? type;
}

/** Check if a node type is a sink (resolves aliases first) */
export function isSinkType(type: string): boolean {
  return SINK_TYPES.includes(resolveNodeType(type));
}

/** Check if a node type is a trigger (resolves aliases first) */
export function isTriggerType(type: string): boolean {
  return TRIGGER_TYPES.includes(resolveNodeType(type));
}

/** Check if a node type is a source (resolves aliases first) */
export function isSourceType(type: string): boolean {
  return SOURCE_TYPES.includes(resolveNodeType(type));
}
