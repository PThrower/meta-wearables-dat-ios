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
  | { kind: "number"; key: string; label: string; min?: number; max?: number; step?: number; placeholder?: string }
  | { kind: "checkbox-group"; key: string; label: string; fields: Array<{ key: string; label: string }> }
  | { kind: "geofence-map"; key: string; label: string }
  | { kind: "section"; label: string; fields: ConfigFieldSchema[] };

// --- Structural & Activation Types ---

export type StructuralRole = "source" | "reference" | "processor" | "trigger" | "transform" | "sink" | "gating";

export type ActivationMode = "ai" | "jepa" | "stt" | "vision" | "enhance" | "sensor" | "speech" | "tracking" | "measure" | "passthrough" | "gating";

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
    allowedTargets: ["s2s-live", "s2s-rest", "s2s-e4b", "jepa-vision", "vision-thumbnails", "vision-face-detect", "vision-barcode-scan", "vision-ocr", "vision-scene-classify", "vision-person-detect", "vision-body-pose", "tracking-ocsort", "vision-tool-measure", "sensor-sound", "sensor-location", "sensor-location-significant", "sensor-location-visits", "sensor-location-geofence", "enhance-brightness", "enhance-sharpen", "enhance-white-balance", "enhance-noise-reduce", "enhance-edge-detect", "enhance-night-mode", "local-tts", TARGET_ROLE_SINK, TARGET_ROLE_TRIGGER],
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
      { kind: "section", label: "Lifecycle (managed in Workflow Settings)", fields: [
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
    allowedTargets: ["s2s-live", "s2s-rest", "s2s-e4b", "jepa-vision", "local-tts", "deepgram-stt", "mobile-stt", "vad", "sensor-sound", TARGET_ROLE_SINK],
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
    allowedTargets: ["s2s-live", "s2s-rest", "s2s-e4b", "jepa-vision", "local-tts", "deepgram-stt", "mobile-stt", "vad", "sensor-sound", TARGET_ROLE_SINK],
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
  {
    type: "deepgram-stt",
    label: "Deepgram STT",
    subtitle: "${model} | ${language}",
    color: { fill: "#0d2040", header: "#3b82f6", stroke: "#3b82f6" },
    allowedTargets: ["s2s-live", "s2s-rest", "s2s-e4b", "jepa-vision", "local-tts", TARGET_ROLE_SINK, TARGET_ROLE_TRIGGER],
    role: "processor",
    activationMode: "stt",
    binding: "deepgram-stt",
    defaultModel: "nova-2",
    configSchema: [
      { kind: "text", key: "label", label: "Label" },
      { kind: "select", key: "model", label: "Model", options: [
        { value: "nova-2", label: "Nova-2 (best accuracy)" },
        { value: "nova-3", label: "Nova-3 (latest)" },
        { value: "enhanced", label: "Enhanced" },
        { value: "base", label: "Base" },
      ]},
      { kind: "select", key: "language", label: "Language", options: [
        { value: "en-US", label: "English (US)" },
        { value: "en-GB", label: "English (UK)" },
        { value: "es-ES", label: "Spanish" },
        { value: "fr-FR", label: "French" },
        { value: "de-DE", label: "German" },
        { value: "it-IT", label: "Italian" },
        { value: "pt-BR", label: "Portuguese (BR)" },
        { value: "ja-JP", label: "Japanese" },
        { value: "ko-KR", label: "Korean" },
        { value: "zh-CN", label: "Chinese (Simplified)" },
        { value: "multi", label: "Auto-detect" },
      ]},
      { kind: "checkbox", key: "punctuation", label: "Smart punctuation" },
      { kind: "checkbox", key: "diarize", label: "Speaker diarization" },
      { kind: "checkbox", key: "profanityFilter", label: "Profanity filter" },
    ],
    defaultConfig: { model: "nova-2", language: "en-US", punctuation: true, diarize: false, profanityFilter: false },
    defaultLabel: "Deepgram STT",
    runtime: ["server"],
  },
  // --- Vision processor nodes (on-device Apple Vision framework) ---
  {
    type: "vision-face-detect",
    label: "Face Detect",
    subtitle: "${maxFaces} faces | ${confidence}",
    color: { fill: "#1a0d3d", header: "#8b5cf6", stroke: "#8b5cf6" },
    allowedTargets: ["s2s-live", "s2s-rest", "s2s-e4b", "jepa-vision", "local-tts", "overlays", "vision-thumbnails", "tracking-ocsort", "gate-mahalanobis", "gate-iou", "gate-bhattacharyya", "gate-reid", "cost-iou", TARGET_ROLE_SINK, TARGET_ROLE_TRIGGER],
    role: "processor",
    activationMode: "vision",
    binding: "vision-face-detect",
    defaultModel: null,
    configSchema: [
      { kind: "text", key: "label", label: "Label" },
      { kind: "range", key: "confidence", label: "Confidence Threshold", min: 0, max: 1, step: 0.05 },
      { kind: "range", key: "smoothingAlpha", label: "Smoothing (0=heavy, 1=off)", min: 0, max: 1, step: 0.05 },
      { kind: "number", key: "maxFaces", label: "Max Faces (0 = unlimited)", min: 0, max: 20, step: 1 },
      { kind: "range", key: "targetFPS", label: "Detection FPS", min: 1, max: 15, step: 1 },
    ],
    defaultConfig: { confidence: 0.5, smoothingAlpha: 0.3, maxFaces: 0, targetFPS: 5 },
    defaultLabel: "Face Detect",
    runtime: ["mobile"],
  },
  {
    type: "vision-barcode-scan",
    label: "Barcode Scan",
    subtitle: "${symbologies}",
    color: { fill: "#1a0d3d", header: "#8b5cf6", stroke: "#8b5cf6" },
    allowedTargets: ["s2s-live", "s2s-rest", "s2s-e4b", "jepa-vision", "local-tts", "overlays", "vision-thumbnails", "tracking-ocsort", "gate-mahalanobis", "gate-iou", "gate-bhattacharyya", "gate-reid", "cost-iou", TARGET_ROLE_SINK, TARGET_ROLE_TRIGGER],
    role: "processor",
    activationMode: "vision",
    binding: "vision-barcode-scan",
    defaultModel: null,
    configSchema: [
      { kind: "text", key: "label", label: "Label" },
      { kind: "checkbox-group", key: "symbologies", label: "Barcode Types", fields: [
        { key: "qr", label: "QR Code" },
        { key: "ean13", label: "EAN-13" },
        { key: "code128", label: "Code 128" },
        { key: "dataMatrix", label: "Data Matrix" },
        { key: "pdf417", label: "PDF417" },
        { key: "aztec", label: "Aztec" },
      ]},
      { kind: "range", key: "targetFPS", label: "Detection FPS", min: 1, max: 15, step: 1 },
    ],
    defaultConfig: { symbologies: { qr: true, ean13: true, code128: false, dataMatrix: false, pdf417: false, aztec: false }, targetFPS: 5 },
    defaultLabel: "Barcode Scan",
    runtime: ["mobile"],
  },
  {
    type: "vision-ocr",
    label: "OCR",
    subtitle: "${language} | ${confidence}",
    color: { fill: "#1a0d3d", header: "#8b5cf6", stroke: "#8b5cf6" },
    allowedTargets: ["s2s-live", "s2s-rest", "s2s-e4b", "jepa-vision", "local-tts", "overlays", "vision-thumbnails", "tracking-ocsort", "gate-mahalanobis", "gate-iou", "gate-bhattacharyya", "gate-reid", "cost-iou", TARGET_ROLE_SINK, TARGET_ROLE_TRIGGER],
    role: "processor",
    activationMode: "vision",
    binding: "vision-ocr",
    defaultModel: null,
    configSchema: [
      { kind: "text", key: "label", label: "Label" },
      { kind: "select", key: "language", label: "Recognition Language", options: [
        { value: "en-US", label: "English" },
        { value: "es-ES", label: "Spanish" },
        { value: "fr-FR", label: "French" },
        { value: "de-DE", label: "German" },
        { value: "it-IT", label: "Italian" },
        { value: "pt-BR", label: "Portuguese" },
        { value: "zh-Hans", label: "Chinese (Simplified)" },
        { value: "ja-JP", label: "Japanese" },
        { value: "ko-KR", label: "Korean" },
      ]},
      { kind: "range", key: "confidence", label: "Confidence Threshold", min: 0, max: 1, step: 0.05 },
      { kind: "range", key: "smoothingAlpha", label: "Smoothing (0=heavy, 1=off)", min: 0, max: 1, step: 0.05 },
      { kind: "range", key: "targetFPS", label: "Detection FPS", min: 0.5, max: 10, step: 0.5 },
    ],
    defaultConfig: { language: "en-US", confidence: 0.5, smoothingAlpha: 0.3, targetFPS: 2 },
    defaultLabel: "OCR",
    runtime: ["mobile"],
  },
  {
    type: "vision-scene-classify",
    label: "Scene Classify",
    subtitle: "top ${maxLabels} | ${confidence}",
    color: { fill: "#1a0d3d", header: "#8b5cf6", stroke: "#8b5cf6" },
    allowedTargets: ["s2s-live", "s2s-rest", "s2s-e4b", "jepa-vision", "local-tts", "vision-thumbnails", TARGET_ROLE_SINK, TARGET_ROLE_TRIGGER],
    role: "processor",
    activationMode: "vision",
    binding: "vision-scene-classify",
    defaultModel: null,
    configSchema: [
      { kind: "text", key: "label", label: "Label" },
      { kind: "range", key: "confidence", label: "Confidence Threshold", min: 0, max: 1, step: 0.05 },
      { kind: "range", key: "smoothingAlpha", label: "Smoothing (0=heavy, 1=off)", min: 0, max: 1, step: 0.05 },
      { kind: "number", key: "maxLabels", label: "Max Labels", min: 1, max: 20, step: 1 },
      { kind: "range", key: "targetFPS", label: "Detection FPS", min: 1, max: 15, step: 1 },
    ],
    defaultConfig: { confidence: 0.3, smoothingAlpha: 0.3, maxLabels: 5, targetFPS: 5 },
    defaultLabel: "Scene Classify",
    runtime: ["mobile"],
  },
  {
    type: "vision-person-detect",
    label: "Person Detect",
    subtitle: "${maxPersons} persons | ${confidence}",
    color: { fill: "#1a0d3d", header: "#8b5cf6", stroke: "#8b5cf6" },
    allowedTargets: ["s2s-live", "s2s-rest", "s2s-e4b", "jepa-vision", "local-tts", "overlays", "vision-thumbnails", "tracking-ocsort", "gate-mahalanobis", "gate-iou", "gate-bhattacharyya", "gate-reid", "cost-iou", TARGET_ROLE_SINK, TARGET_ROLE_TRIGGER],
    role: "processor",
    activationMode: "vision",
    binding: "vision-person-detect",
    defaultModel: null,
    configSchema: [
      { kind: "text", key: "label", label: "Label" },
      { kind: "range", key: "confidence", label: "Confidence Threshold", min: 0, max: 1, step: 0.05 },
      { kind: "range", key: "smoothingAlpha", label: "Smoothing (0=heavy, 1=off)", min: 0, max: 1, step: 0.05 },
      { kind: "number", key: "maxPersons", label: "Max Persons (0 = unlimited)", min: 0, max: 20, step: 1 },
      { kind: "range", key: "targetFPS", label: "Detection FPS", min: 1, max: 15, step: 1 },
    ],
    defaultConfig: { confidence: 0.5, smoothingAlpha: 0.3, maxPersons: 0, targetFPS: 5 },
    defaultLabel: "Person Detect",
    runtime: ["mobile"],
  },
  {
    type: "vision-body-pose",
    label: "Body Pose",
    subtitle: "${maxPoses} poses | ${confidence}",
    color: { fill: "#1a0d3d", header: "#8b5cf6", stroke: "#8b5cf6" },
    allowedTargets: ["s2s-live", "s2s-rest", "s2s-e4b", "jepa-vision", "local-tts", "overlays", "vision-thumbnails", "tracking-ocsort", "gate-mahalanobis", "gate-iou", "gate-bhattacharyya", "gate-reid", "cost-iou", TARGET_ROLE_SINK, TARGET_ROLE_TRIGGER],
    role: "processor",
    activationMode: "vision",
    binding: "vision-body-pose",
    defaultModel: null,
    configSchema: [
      { kind: "text", key: "label", label: "Label" },
      { kind: "range", key: "confidence", label: "Confidence Threshold", min: 0, max: 1, step: 0.05 },
      { kind: "range", key: "smoothingAlpha", label: "Smoothing (0=heavy, 1=off)", min: 0, max: 1, step: 0.05 },
      { kind: "number", key: "maxPoses", label: "Max Poses (0 = unlimited)", min: 0, max: 10, step: 1 },
      { kind: "range", key: "targetFPS", label: "Detection FPS", min: 1, max: 15, step: 1 },
    ],
    defaultConfig: { confidence: 0.5, smoothingAlpha: 0.3, maxPoses: 0, targetFPS: 5 },
    defaultLabel: "Body Pose",
    runtime: ["mobile"],
  },
  {
    type: "vision-thumbnails",
    label: "Thumbnails",
    subtitle: "${thumbnailSize}px | max ${maxCount}",
    color: { fill: "#1a0d3d", header: "#8b5cf6", stroke: "#8b5cf6" },
    allowedTargets: ["s2s-live", "s2s-rest", "s2s-e4b", "jepa-vision", "local-tts", "overlays", TARGET_ROLE_SINK, TARGET_ROLE_TRIGGER],
    role: "processor",
    activationMode: "vision",
    binding: "vision-thumbnails",
    defaultModel: null,
    configSchema: [
      { kind: "number", key: "thumbnailSize", label: "Thumbnail Size (px)", min: 32, max: 256, step: 16 },
      { kind: "number", key: "maxCount", label: "Max Thumbnails (0=unlimited)", min: 0, max: 20, step: 1 },
      { kind: "range", key: "quality", label: "JPEG Quality", min: 0.1, max: 1.0, step: 0.1 },
    ],
    defaultConfig: { thumbnailSize: 64, maxCount: 4, quality: 0.6 },
    defaultLabel: "Thumbnails",
    runtime: ["mobile"],
  },
  // --- Object Tracking nodes (on-device OC-SORT multi-object tracker) ---
  //
  // Tracking nodes use OC-SORT to maintain persistent object IDs through
  // occlusion. Uses Apple Vision for detection front-end (VNDetectHumanRectanglesRequest).
  // activationMode: "tracking" sends config to iOS publisher.
  // Ref: arXiv:2203.14360 — deltaT (OCM velocity lookback), inertia (direction weight), detThresh
  //
  // --- Association Gate nodes (configurable pre-gating chain for OC-SORT) ---
  //
  // Gate nodes configure the tracker's internal association pipeline.
  // They are config-only — the server collects them from the workflow graph
  // and sends the ordered chain to iOS as `gates: [{gateType, params}]`.
  // The iOS tracker builds its GatingPipeline from this chain.
  //
  // Chain order matters: Mahalanobis (cheap KF motion filter) → IoU (spatial) → future gates.
  // Users compose the right strategy per domain:
  //   Surveillance: gate-mahalanobis (strict) → gate-iou
  //   Sports/fast motion: gate-mahalanobis (loose) → gate-iou
  //   Close-range: gate-iou only
  //
  // Ref: Bar-Shalom & Fortmann, "Tracking and Data Association" (1988)
  //
  {
    type: "gate-mahalanobis",
    label: "Mahalanobis Gate",
    subtitle: "chi-sq: ${chiSquaredThreshold} | KF motion filter",
    color: { fill: "#0d2d2d", header: "#06b6d4", stroke: "#06b6d4" },
    allowedTargets: ["tracking-ocsort", "gate-mahalanobis", "gate-iou", "gate-bhattacharyya", "gate-reid"],
    role: "gating",
    activationMode: null,
    binding: null,
    defaultModel: null,
    configSchema: [
      { kind: "range", key: "chiSquaredThreshold", label: "Chi-squared threshold (4 DOF)", min: 1, max: 25, step: 0.5 },
    ],
    defaultConfig: { chiSquaredThreshold: 9.49 },
    defaultLabel: "Mahalanobis Gate",
    runtime: ["mobile"],
  },
  {
    type: "gate-iou",
    label: "IoU Gate",
    subtitle: "iou >= ${iouThreshold} | spatial overlap",
    color: { fill: "#0d2d2d", header: "#06b6d4", stroke: "#06b6d4" },
    allowedTargets: ["tracking-ocsort", "gate-mahalanobis", "gate-iou", "gate-bhattacharyya", "gate-reid"],
    role: "gating",
    activationMode: null,
    binding: null,
    defaultModel: null,
    configSchema: [
      { kind: "range", key: "iouThreshold", label: "IoU Threshold", min: 0.05, max: 0.9, step: 0.05 },
    ],
    defaultConfig: { iouThreshold: 0.3 },
    defaultLabel: "IoU Gate",
    runtime: ["mobile"],
  },
  {
    type: "gate-bhattacharyya",
    label: "Bhattacharyya Gate",
    subtitle: "hist dist <= ${histDistance} | color histogram",
    color: { fill: "#0d2d2d", header: "#06b6d4", stroke: "#06b6d4" },
    allowedTargets: ["tracking-ocsort", "gate-mahalanobis", "gate-iou", "gate-bhattacharyya", "gate-reid"],
    role: "gating",
    activationMode: null,
    binding: null,
    defaultModel: null,
    configSchema: [
      { kind: "range", key: "histDistance", label: "Histogram distance threshold (0=same, 1=opposite)", min: 0.1, max: 1.0, step: 0.05 },
      { kind: "select", key: "colorSpace", label: "Color space", options: [
        { value: "rgb", label: "RGB (3x16 bins)" },
        { value: "hsv", label: "HSV (H:16 S:8 bins)" },
      ] },
    ],
    defaultConfig: { histDistance: 0.5, colorSpace: "hsv" },
    defaultLabel: "Bhattacharyya Gate",
    runtime: ["mobile"],
  },
  {
    type: "gate-reid",
    label: "ReID Gate",
    subtitle: "embed dist <= ${embedDistance} | appearance",
    color: { fill: "#0d2d2d", header: "#06b6d4", stroke: "#06b6d4" },
    allowedTargets: ["tracking-ocsort", "gate-mahalanobis", "gate-iou", "gate-bhattacharyya", "gate-reid"],
    role: "gating",
    activationMode: null,
    binding: null,
    defaultModel: null,
    configSchema: [
      { kind: "range", key: "embedDistance", label: "Embedding distance threshold", min: 0.1, max: 2.0, step: 0.05 },
      { kind: "select", key: "model", label: "ReID model", options: [
        { value: "osnet-x025", label: "OSNet x0.25 (fastest)" },
        { value: "osnet-x05", label: "OSNet x0.5 (balanced)" },
        { value: "osnet-x10", label: "OSNet x1.0 (accurate)" },
      ] },
      { kind: "range", key: "gallerySize", label: "Gallery size (frames kept per track)", min: 1, max: 50, step: 1 },
    ],
    defaultConfig: { embedDistance: 0.5, model: "osnet-x05", gallerySize: 10 },
    defaultLabel: "ReID Gate",
    runtime: ["mobile"],
  },
  {
    type: "cost-iou",
    label: "IoU Cost Matrix",
    subtitle: "IoU-only cost | ByteTrack compatible",
    color: { fill: "#1a0d1a", header: "#d946ef", stroke: "#d946ef" },
    allowedTargets: ["tracking-ocsort"],
    role: "gating",
    activationMode: null,
    binding: null,
    defaultModel: null,
    configSchema: [
      { kind: "range", key: "highThreshold", label: "High confidence threshold (first pass)", min: 0.1, max: 0.9, step: 0.05 },
      { kind: "range", key: "lowThreshold", label: "Low confidence threshold (second pass)", min: 0.01, max: 0.5, step: 0.01 },
    ],
    defaultConfig: { highThreshold: 0.5, lowThreshold: 0.1 },
    defaultLabel: "IoU Cost Matrix",
    runtime: ["mobile"],
  },
  {
    type: "tracking-ocsort",
    label: "OC-SORT Tracker",
    subtitle: "iou: ${iouThreshold} | maxAge: ${maxAge} | minHits: ${minHits}",
    color: { fill: "#0d2d1a", header: "#10b981", stroke: "#10b981" },
    allowedTargets: ["s2s-live", "s2s-rest", "s2s-e4b", "jepa-vision", "vision-face-detect", "vision-barcode-scan", "vision-ocr", "vision-scene-classify", "vision-person-detect", "vision-body-pose", "local-tts", "overlays", TARGET_ROLE_SINK, TARGET_ROLE_TRIGGER],
    role: "processor",
    activationMode: "tracking",
    binding: "tracking-ocsort",
    defaultModel: null,
    configSchema: [
      { kind: "text", key: "targetClasses", label: "Target Classes (comma-separated, empty=all)", placeholder: "person,vehicle" },
      { kind: "range", key: "confidence", label: "Detection Confidence", min: 0.1, max: 1.0, step: 0.05 },
      { kind: "range", key: "iouThreshold", label: "IoU Threshold", min: 0.1, max: 0.9, step: 0.05 },
      { kind: "number", key: "maxTracks", label: "Max Concurrent Tracks (0=unlimited)", min: 0, max: 100, step: 1 },
      { kind: "number", key: "maxAge", label: "Max Age (frames without detection)", min: 1, max: 120, step: 1 },
      { kind: "number", key: "minHits", label: "Min Hits (frames to confirm)", min: 1, max: 30, step: 1 },
      { kind: "range", key: "targetFPS", label: "Target FPS", min: 1, max: 30, step: 1 },
      { kind: "range", key: "smoothingAlpha", label: "Confidence Smoothing", min: 0.1, max: 1.0, step: 0.05 },
      { kind: "number", key: "deltaT", label: "Velocity lookback (frames)", placeholder: "3" },
      { kind: "range", key: "inertia", label: "Direction weight (OCM)", min: 0, max: 1, step: 0.05 },
      { kind: "range", key: "detThresh", label: "Detection threshold", min: 0, max: 1, step: 0.05 },
      { kind: "checkbox", key: "useByte", label: "ByteTrack two-pass (low-conf recovery)" },
    ],
    defaultConfig: { targetClasses: "", confidence: 0.5, iouThreshold: 0.3, maxTracks: 0, maxAge: 30, minHits: 3, targetFPS: 10, smoothingAlpha: 0.3, deltaT: 3, inertia: 0.2, detThresh: 0.5, useByte: false },
    defaultLabel: "OC-SORT Tracker",
    runtime: ["mobile"],
  },
  // --- Frame Enhancement nodes (on-device CIFilter transforms) ---
  //
  // Enhancement nodes apply CIFilter chains to video frames on the GPU.
  // They run as a pre-broadcast transform — all downstream stages see the
  // enhanced frame. activationMode: "enhance" sends config to iOS publisher.
  //
  {
    type: "enhance-brightness",
    label: "Brightness",
    subtitle: "bright: ${brightness} | contrast: ${contrast}",
    color: { fill: "#1a2000", header: "#84cc16", stroke: "#84cc16" },
    allowedTargets: ["s2s-live", "s2s-rest", "s2s-e4b", "jepa-vision", "vision-face-detect", "vision-barcode-scan", "vision-ocr", "vision-scene-classify", "vision-person-detect", "vision-body-pose", "enhance-brightness", "enhance-sharpen", "enhance-white-balance", "enhance-noise-reduce", "enhance-edge-detect", "enhance-night-mode", "overlays", TARGET_ROLE_SINK, TARGET_ROLE_TRIGGER],
    role: "processor",
    activationMode: "enhance",
    binding: "enhance-brightness",
    defaultModel: null,
    configSchema: [
      { kind: "range", key: "brightness", label: "Brightness", min: -0.5, max: 0.5, step: 0.05 },
      { kind: "range", key: "contrast", label: "Contrast", min: 0.5, max: 2.0, step: 0.05 },
      { kind: "range", key: "saturation", label: "Saturation", min: 0, max: 2.0, step: 0.05 },
    ],
    defaultConfig: { brightness: 0.1, contrast: 1.0, saturation: 1.0 },
    defaultLabel: "Brightness",
    runtime: ["mobile"],
  },
  {
    type: "enhance-sharpen",
    label: "Sharpen",
    subtitle: "sharpness: ${sharpness}",
    color: { fill: "#1a2000", header: "#84cc16", stroke: "#84cc16" },
    allowedTargets: ["s2s-live", "s2s-rest", "s2s-e4b", "jepa-vision", "vision-face-detect", "vision-barcode-scan", "vision-ocr", "vision-scene-classify", "vision-person-detect", "vision-body-pose", "enhance-brightness", "enhance-sharpen", "enhance-white-balance", "enhance-noise-reduce", "enhance-edge-detect", "enhance-night-mode", "overlays", TARGET_ROLE_SINK, TARGET_ROLE_TRIGGER],
    role: "processor",
    activationMode: "enhance",
    binding: "enhance-sharpen",
    defaultModel: null,
    configSchema: [
      { kind: "range", key: "sharpness", label: "Sharpness", min: 0, max: 2.0, step: 0.05 },
    ],
    defaultConfig: { sharpness: 0.4 },
    defaultLabel: "Sharpen",
    runtime: ["mobile"],
  },
  {
    type: "enhance-white-balance",
    label: "White Balance",
    subtitle: "warmth: ${warmth}K | tint: ${tint}",
    color: { fill: "#1a2000", header: "#84cc16", stroke: "#84cc16" },
    allowedTargets: ["s2s-live", "s2s-rest", "s2s-e4b", "jepa-vision", "vision-face-detect", "vision-barcode-scan", "vision-ocr", "vision-scene-classify", "vision-person-detect", "vision-body-pose", "enhance-brightness", "enhance-sharpen", "enhance-white-balance", "enhance-noise-reduce", "enhance-edge-detect", "enhance-night-mode", "overlays", TARGET_ROLE_SINK, TARGET_ROLE_TRIGGER],
    role: "processor",
    activationMode: "enhance",
    binding: "enhance-white-balance",
    defaultModel: null,
    configSchema: [
      { kind: "range", key: "warmth", label: "Temperature (K)", min: 2000, max: 9000, step: 100 },
      { kind: "range", key: "tint", label: "Tint", min: -100, max: 100, step: 5 },
    ],
    defaultConfig: { warmth: 5500, tint: 0 },
    defaultLabel: "White Balance",
    runtime: ["mobile"],
  },
  {
    type: "enhance-noise-reduce",
    label: "Noise Reduce",
    subtitle: "noise: ${noiseLevel} | sharp: ${sharpness}",
    color: { fill: "#1a2000", header: "#84cc16", stroke: "#84cc16" },
    allowedTargets: ["s2s-live", "s2s-rest", "s2s-e4b", "jepa-vision", "vision-face-detect", "vision-barcode-scan", "vision-ocr", "vision-scene-classify", "vision-person-detect", "vision-body-pose", "enhance-brightness", "enhance-sharpen", "enhance-white-balance", "enhance-noise-reduce", "enhance-edge-detect", "enhance-night-mode", "overlays", TARGET_ROLE_SINK, TARGET_ROLE_TRIGGER],
    role: "processor",
    activationMode: "enhance",
    binding: "enhance-noise-reduce",
    defaultModel: null,
    configSchema: [
      { kind: "range", key: "noiseLevel", label: "Noise Level", min: 0, max: 0.1, step: 0.005 },
      { kind: "range", key: "sharpness", label: "Sharpness", min: 0, max: 2.0, step: 0.05 },
    ],
    defaultConfig: { noiseLevel: 0.02, sharpness: 0.4 },
    defaultLabel: "Noise Reduce",
    runtime: ["mobile"],
  },
  {
    type: "enhance-edge-detect",
    label: "Edge Detect",
    subtitle: "intensity: ${intensity}",
    color: { fill: "#1a2000", header: "#84cc16", stroke: "#84cc16" },
    allowedTargets: ["s2s-live", "s2s-rest", "s2s-e4b", "jepa-vision", "vision-face-detect", "vision-barcode-scan", "vision-ocr", "vision-scene-classify", "vision-person-detect", "vision-body-pose", "enhance-brightness", "enhance-sharpen", "enhance-white-balance", "enhance-noise-reduce", "enhance-edge-detect", "enhance-night-mode", "overlays", TARGET_ROLE_SINK, TARGET_ROLE_TRIGGER],
    role: "processor",
    activationMode: "enhance",
    binding: "enhance-edge-detect",
    defaultModel: null,
    configSchema: [
      { kind: "range", key: "intensity", label: "Intensity", min: 0, max: 5.0, step: 0.1 },
    ],
    defaultConfig: { intensity: 1.0 },
    defaultLabel: "Edge Detect",
    runtime: ["mobile"],
  },
  {
    type: "enhance-night-mode",
    label: "Night Mode",
    subtitle: "bright: ${brightness} | gamma: ${gamma}",
    color: { fill: "#1a2000", header: "#84cc16", stroke: "#84cc16" },
    allowedTargets: ["s2s-live", "s2s-rest", "s2s-e4b", "jepa-vision", "vision-face-detect", "vision-barcode-scan", "vision-ocr", "vision-scene-classify", "vision-person-detect", "vision-body-pose", "enhance-brightness", "enhance-sharpen", "enhance-white-balance", "enhance-noise-reduce", "enhance-edge-detect", "enhance-night-mode", "overlays", TARGET_ROLE_SINK, TARGET_ROLE_TRIGGER],
    role: "processor",
    activationMode: "enhance",
    binding: "enhance-night-mode",
    defaultModel: null,
    configSchema: [
      { kind: "range", key: "brightness", label: "Brightness", min: 0, max: 0.5, step: 0.05 },
      { kind: "range", key: "gamma", label: "Gamma", min: 0.3, max: 1.0, step: 0.05 },
      { kind: "range", key: "highlightAmount", label: "Highlight Recovery", min: 0, max: 3.0, step: 0.1 },
    ],
    defaultConfig: { brightness: 0.15, gamma: 0.8, highlightAmount: 1.5 },
    defaultLabel: "Night Mode",
    runtime: ["mobile"],
  },
  // --- Sensor nodes (on-device sound classification + location) ---
  {
    type: "sensor-sound",
    label: "Sound Classify",
    subtitle: "top ${maxLabels} | ${confidence}",
    color: { fill: "#0d2d3d", header: "#06b6d4", stroke: "#06b6d4" },
    allowedTargets: ["s2s-live", "s2s-rest", "s2s-e4b", "jepa-vision", "local-tts", TARGET_ROLE_SINK, TARGET_ROLE_TRIGGER],
    role: "processor",
    activationMode: "sensor",
    binding: "sensor-sound",
    defaultModel: null,
    configSchema: [
      { kind: "text", key: "label", label: "Label" },
      { kind: "range", key: "windowDuration", label: "Window Duration", min: 0.5, max: 5, step: 0.5, unit: "s" },
      { kind: "range", key: "overlapFactor", label: "Overlap Factor", min: 0, max: 0.9, step: 0.1 },
      { kind: "range", key: "confidence", label: "Confidence Threshold", min: 0, max: 1, step: 0.05 },
      { kind: "range", key: "smoothingAlpha", label: "Smoothing (0=heavy, 1=off)", min: 0, max: 1, step: 0.05 },
      { kind: "number", key: "maxLabels", label: "Max Labels", min: 1, max: 20, step: 1 },
      { kind: "text", key: "targetLabels", label: "Target Labels (comma-separated, leave empty for all)" },
    ],
    defaultConfig: { windowDuration: 1.5, overlapFactor: 0.5, confidence: 0.3, smoothingAlpha: 0.3, maxLabels: 5, targetLabels: "" },
    defaultLabel: "Sound Classify",
    runtime: ["mobile"],
  },
  {
    type: "sensor-location",
    label: "GPS Continuous",
    subtitle: "${accuracy} | ${updateIntervalSec}s",
    color: { fill: "#0d2d3d", header: "#06b6d4", stroke: "#06b6d4" },
    allowedTargets: ["s2s-live", "s2s-rest", "s2s-e4b", "jepa-vision", "local-tts", TARGET_ROLE_SINK, TARGET_ROLE_TRIGGER],
    role: "processor",
    activationMode: "sensor",
    binding: "sensor-location",
    defaultModel: null,
    configSchema: [
      { kind: "text", key: "label", label: "Label" },
      { kind: "select", key: "accuracy", label: "Accuracy", options: [
        { value: "best", label: "Best for navigation" },
        { value: "tenMeters", label: "10 meters" },
        { value: "hundredMeters", label: "100 meters" },
        { value: "kilometer", label: "1 kilometer" },
        { value: "threeKilometers", label: "3 kilometers" },
      ]},
      { kind: "number", key: "minDistance", label: "Min Distance (meters)", min: 0, max: 1000, step: 1 },
      { kind: "number", key: "updateIntervalSec", label: "Update Interval (sec)", min: 1, max: 300, step: 1 },
    ],
    defaultConfig: { mode: "continuous", accuracy: "best", minDistance: 5, updateIntervalSec: 5 },
    defaultLabel: "GPS Continuous",
    runtime: ["mobile"],
  },
  {
    type: "sensor-location-significant",
    label: "GPS Significant",
    subtitle: "battery efficient | ~500m",
    color: { fill: "#0d2d3d", header: "#06b6d4", stroke: "#06b6d4" },
    allowedTargets: ["s2s-live", "s2s-rest", "s2s-e4b", "jepa-vision", "local-tts", TARGET_ROLE_SINK, TARGET_ROLE_TRIGGER],
    role: "processor",
    activationMode: "sensor",
    binding: "sensor-location-significant",
    defaultModel: null,
    configSchema: [
      { kind: "text", key: "label", label: "Label" },
    ],
    defaultConfig: { mode: "significant" },
    defaultLabel: "GPS Significant",
    runtime: ["mobile"],
  },
  {
    type: "sensor-location-visits",
    label: "GPS Visits",
    subtitle: "arrive | stay | leave",
    color: { fill: "#0d2d3d", header: "#06b6d4", stroke: "#06b6d4" },
    allowedTargets: ["s2s-live", "s2s-rest", "s2s-e4b", "jepa-vision", "local-tts", TARGET_ROLE_SINK, TARGET_ROLE_TRIGGER],
    role: "processor",
    activationMode: "sensor",
    binding: "sensor-location-visits",
    defaultModel: null,
    configSchema: [
      { kind: "text", key: "label", label: "Label" },
    ],
    defaultConfig: { mode: "visits" },
    defaultLabel: "GPS Visits",
    runtime: ["mobile"],
  },
  {
    type: "sensor-location-geofence",
    label: "GPS Geofence",
    subtitle: "${geofences} regions",
    color: { fill: "#0d2d3d", header: "#06b6d4", stroke: "#06b6d4" },
    allowedTargets: ["s2s-live", "s2s-rest", "s2s-e4b", "jepa-vision", "local-tts", TARGET_ROLE_SINK, TARGET_ROLE_TRIGGER],
    role: "processor",
    activationMode: "sensor",
    binding: "sensor-location-geofence",
    defaultModel: null,
    configSchema: [
      { kind: "text", key: "label", label: "Label" },
      { kind: "geofence-map", key: "geofences", label: "Geofences" },
    ],
    defaultConfig: { mode: "geofence", geofences: [] },
    defaultLabel: "GPS Geofence",
    runtime: ["mobile"],
  },
  // --- Speech nodes (on-device STT + VAD) ---
  {
    type: "mobile-stt",
    label: "Mobile STT",
    subtitle: "${language} | ${recognitionMode}",
    color: { fill: "#0d2d3d", header: "#06b6d4", stroke: "#06b6d4" },
    allowedTargets: ["s2s-live", "s2s-rest", "s2s-e4b", "jepa-vision", "local-tts", "mobile-stt", "vad", TARGET_ROLE_SINK, TARGET_ROLE_TRIGGER],
    role: "processor",
    activationMode: "speech",
    binding: null,
    defaultModel: null,
    configSchema: [
      { kind: "text", key: "label", label: "Label" },
      { kind: "select", key: "language", label: "Language", options: [
        { value: "en-US", label: "English (US)" },
        { value: "en-GB", label: "English (UK)" },
        { value: "es-ES", label: "Spanish" },
        { value: "fr-FR", label: "French" },
        { value: "de-DE", label: "German" },
        { value: "it-IT", label: "Italian" },
        { value: "pt-BR", label: "Portuguese (BR)" },
        { value: "ja-JP", label: "Japanese" },
        { value: "ko-KR", label: "Korean" },
        { value: "zh-CN", label: "Chinese (Simplified)" },
      ]},
      { kind: "select", key: "recognitionMode", label: "Recognition Mode", options: [
        { value: "onDevice", label: "On-device only (no network)" },
        { value: "hybrid", label: "Hybrid (on-device + server fallback)" },
      ]},
      { kind: "checkbox", key: "partialResults", label: "Stream partial results" },
    ],
    defaultConfig: { language: "en-US", recognitionMode: "onDevice", partialResults: true },
    defaultLabel: "Mobile STT",
    runtime: ["mobile"],
  },
  {
    type: "vad",
    label: "VAD",
    subtitle: "threshold: ${energyThreshold}dB",
    color: { fill: "#0d2d3d", header: "#06b6d4", stroke: "#06b6d4" },
    allowedTargets: ["s2s-live", "s2s-rest", "s2s-e4b", "jepa-vision", "local-tts", "mobile-stt", TARGET_ROLE_SINK, TARGET_ROLE_TRIGGER],
    role: "processor",
    activationMode: "speech",
    binding: null,
    defaultModel: null,
    configSchema: [
      { kind: "text", key: "label", label: "Label" },
      { kind: "range", key: "energyThreshold", label: "Energy Threshold", min: -80, max: -10, step: 1, unit: " dB" },
      { kind: "number", key: "speechDurationMs", label: "Speech Onset (ms)", min: 50, max: 1000, step: 50 },
      { kind: "number", key: "silenceDurationMs", label: "Silence Duration (ms)", min: 100, max: 2000, step: 50 },
      { kind: "number", key: "cooldownMs", label: "Cooldown (ms)", min: 0, max: 1000, step: 50 },
    ],
    defaultConfig: { energyThreshold: -40, speechDurationMs: 100, silenceDurationMs: 300, cooldownMs: 200 },
    defaultLabel: "VAD",
    runtime: ["mobile"],
  },
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
  // --- Tool Measurement nodes (fastener sizing for maintenance/training) ---
  //
  // vision-tool-measure uses homography + reference object to measure fastener
  // dimensions in mm. activationMode: "measure" sends config to iOS publisher.
  //
  {
    type: "vision-tool-measure",
    label: "Tool Measure",
    subtitle: "ref: ${referenceObject} | tol: ${maxMeasurementError}mm",
    color: { fill: "#1a0a3d", header: "#a78bfa", stroke: "#a78bfa" },
    allowedTargets: ["s2s-live", "s2s-rest", "s2s-e4b", "local-tts", "overlays", TARGET_ROLE_SINK, TARGET_ROLE_TRIGGER],
    role: "processor",
    activationMode: "measure",
    binding: "vision-tool-measure",
    defaultModel: null,
    configSchema: [
      { kind: "select", key: "referenceObject", label: "Reference Object", options: [
        { value: "auto", label: "Auto-detect" },
        { value: "credit_card", label: "Credit Card (85.6 x 54mm)" },
        { value: "us_quarter", label: "US Quarter (24.26mm)" },
        { value: "us_penny", label: "US Penny (19.05mm)" },
        { value: "us_nickel", label: "US Nickel (21.21mm)" },
        { value: "us_dime", label: "US Dime (17.91mm)" },
      ]},
      { kind: "range", key: "maxMeasurementError", label: "Max Error Tolerance (mm)", min: 0.5, max: 5.0, step: 0.25, unit: "mm" },
      { kind: "range", key: "targetFPS", label: "Measurement FPS", min: 0.5, max: 5, step: 0.5 },
      { kind: "range", key: "smoothingAlpha", label: "Smoothing", min: 0.1, max: 1.0, step: 0.05 },
      { kind: "range", key: "confidence", label: "Confidence Threshold", min: 0.1, max: 1.0, step: 0.05 },
    ],
    defaultConfig: { referenceObject: "auto", maxMeasurementError: 2.0, targetFPS: 1, smoothingAlpha: 0.5, confidence: 0.6 },
    defaultLabel: "Tool Measure",
    runtime: ["mobile"],
  },
  {
    type: "tool-suggest",
    label: "Tool Suggestion",
    subtitle: "fastener sizing overlay",
    color: { fill: "#3d2000", header: "#f97316", stroke: "#f97316" },
    allowedTargets: [],
    role: "sink",
    activationMode: null,
    binding: null,
    defaultModel: null,
    configSchema: [
      { kind: "checkbox", key: "showDimensions", label: "Show dimensions (mm)" },
      { kind: "checkbox", key: "showToolSize", label: "Show suggested tool" },
      { kind: "checkbox", key: "showConfidence", label: "Show confidence indicator" },
    ],
    defaultConfig: { showDimensions: true, showToolSize: true, showConfidence: true },
    defaultLabel: "Tool Suggestion",
    runtime: ["mobile"],
  },
  {
    type: "overlays",
    label: "Overlays",
    subtitle: "bbox + ${transcription}",
    color: { fill: "#3d2000", header: "#f97316", stroke: "#f97316" },
    allowedTargets: [],
    role: "sink",
    activationMode: null,
    binding: null,
    defaultModel: null,
    configSchema: [
      { kind: "text", key: "label", label: "Label" },
      { kind: "checkbox", key: "bbox", label: "Bounding box annotations" },
      { kind: "checkbox", key: "transcription", label: "Live transcription overlay" },
    ],
    defaultConfig: { bbox: true, transcription: false },
    defaultLabel: "Overlays",
    runtime: ["mobile"],
  },
  {
    type: "debug-sink",
    label: "Debug Log",
    subtitle: "shows output in viewer",
    color: { fill: "#1a1a1a", header: "#6b7280", stroke: "#6b7280" },
    allowedTargets: [],
    role: "sink",
    activationMode: null,
    binding: null,
    defaultModel: null,
    configSchema: [
      { kind: "text", key: "label", label: "Label" },
    ],
    defaultConfig: {},
    defaultLabel: "Debug Log",
    runtime: ["server"],
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
    return role === "source" || role === "reference";
  }).length;
  if (sourceCount < 1) return "Must have at least 1 source or content node";
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
