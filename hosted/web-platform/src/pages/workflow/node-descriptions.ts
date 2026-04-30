/**
 * node-descriptions.ts — Human-readable descriptions for palette hover tooltips.
 *
 * Separated from node-defs so descriptions evolve independently.
 * Key = node type, value = short hover description.
 */

export const NODE_DESCRIPTIONS: Record<string, string> = {
  // Inputs
  "camera-source": "Live camera feed from smart glasses or phone",
  "phone-mic-source": "Phone built-in microphone at 48kHz",
  "glasses-mic-source": "Glasses HFP microphone at 8kHz (beamformed)",

  // AI
  "s2s-live": "Real-time multimodal AI with audio in/out (Gemini Live)",
  "s2s-rest": "Request/response AI inference (Gemma 4)",
  "s2s-e4b": "Edge-optimized AI inference (Gemma 4 E4B)",
  "jepa-vision": "Self-supervised video understanding and anomaly detection",

  // Vision
  "vision-face-detect": "Detect and track faces with bounding boxes",
  "vision-barcode-scan": "Scan QR codes, barcodes, and data matrices",
  "vision-ocr": "Extract text from camera frames (on-device)",
  "vision-scene-classify": "Classify scene content and environment types",
  "vision-person-detect": "Detect and track people with bounding boxes",
  "vision-body-pose": "Detect body skeleton and joint positions",
  "vision-thumbnails": "Generate detection preview thumbnails on canvas",

  // Tracking
  "tracking-ocsort": "Multi-object tracking with persistent IDs through occlusion",

  // Enhance
  "enhance-brightness": "Adjust brightness, contrast, and saturation",
  "enhance-sharpen": "Sharpen image details and edges",
  "enhance-white-balance": "Correct color temperature and tint",
  "enhance-noise-reduce": "Reduce visual noise while preserving detail",
  "enhance-edge-detect": "Highlight edges and contours in the frame",
  "enhance-night-mode": "Brighten low-light frames with gamma correction",

  // Audio
  "mobile-stt": "On-device speech-to-text transcription",
  "vad": "Voice activity detection — gate processing on speech",
  "deepgram-stt": "Cloud speech-to-text via Deepgram API",

  // Sensors
  "sensor-sound": "Classify ambient sounds using on-device ML",
  "sensor-location": "Continuous GPS tracking with configurable accuracy and interval",
  "sensor-location-significant": "Battery-efficient GPS updates on ~500m changes",
  "sensor-location-visits": "Detect arrive, stay, and leave events at locations",
  "sensor-location-geofence": "Monitor circular regions for entry and exit events",

  // Triggers
  "gesture-source": "Hand gesture recognition from camera feed",
  "jepa-trigger": "Trigger actions on JEPA anomaly or event detection",
  "timer-trigger": "Periodic activation at a fixed interval",
  "conditional": "Conditional activation based on field comparison",

  // Outputs
  "local-tts": "On-device text-to-speech synthesis",
  "tones": "Play alert tones and notification sounds",
  "phone-speaker": "Route audio output to phone speaker",
  "glasses-speaker": "Route audio output to glasses speaker (HFP/A2DP)",
  "overlays": "Draw bounding boxes and annotations on camera preview",
  "debug-sink": "Log node output to relay viewer for debugging",

  // Reference
  "text": "Static text reference for prompt templates",
};

/** Get description for a node type, or a generic fallback. */
export function getDescription(type: string): string {
  return NODE_DESCRIPTIONS[type] ?? type.replace(/-/g, " ");
}
