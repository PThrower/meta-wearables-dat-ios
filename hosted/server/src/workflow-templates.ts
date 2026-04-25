/**
 * Workflow templates — predefined DAGs that can be instantiated via API or UI.
 *
 * GET  /workflow-templates          → list available templates
 * POST /workflow-templates/:id      → instantiate (creates a real workflow)
 */

export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  nodes: Array<{
    id: string;
    type: string;
    label: string;
    config: Record<string, unknown>;
    positionX: number;
    positionY: number;
  }>;
  edges: Array<{
    id: string;
    sourceNodeId: string;
    targetNodeId: string;
  }>;
}

const now = () => Date.now().toString(36);

export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  {
    id: "streaming-ai",
    name: "Streaming AI Assistant",
    description: "Live camera stream with speech-to-speech AI processing and overlay annotations.",
    nodes: [
      { id: "src", type: "stream-input", label: "Input", config: { video: true, phoneMic: true, glassesMic: false, gestures: true, visionFps: 1 }, positionX: 50, positionY: 220 },
      { id: "prompt", type: "text", label: "System Prompt", config: { text: "You are a helpful assistant." }, positionX: 320, positionY: 100 },
      { id: "ai", type: "s2s-live", label: "AI Assistant", config: { model: "gemini-2.5-flash-native-audio-latest" }, positionX: 320, positionY: 260 },
      { id: "ovl", type: "overlays", label: "Overlays", config: {}, positionX: 600, positionY: 260 },
    ],
    edges: [
      { id: "e1", sourceNodeId: "src", targetNodeId: "ai" },
      { id: "e2", sourceNodeId: "prompt", targetNodeId: "ai" },
      { id: "e3", sourceNodeId: "ai", targetNodeId: "ovl" },
    ],
  },
  {
    id: "tts-announcement",
    name: "TTS Announcement",
    description: "Speak a text announcement through phone and glasses speakers. Ready for triggers.",
    nodes: [
      { id: "text", type: "text", label: "Announcement", config: { text: "Hello! I'm your smart glasses assistant. I'm here to help." }, positionX: 80, positionY: 200 },
      { id: "tts", type: "local-tts", label: "Speak", config: {}, positionX: 380, positionY: 200 },
      { id: "phone", type: "phone-speaker", label: "Phone Speaker", config: {}, positionX: 650, positionY: 140 },
      { id: "glasses", type: "glasses-speaker", label: "Glasses Speaker", config: { profile: "hfp" }, positionX: 650, positionY: 260 },
    ],
    edges: [
      { id: "e1", sourceNodeId: "text", targetNodeId: "tts" },
      { id: "e2", sourceNodeId: "tts", targetNodeId: "phone" },
      { id: "e3", sourceNodeId: "tts", targetNodeId: "glasses" },
    ],
  },
];

export const TEMPLATE_MAP = new Map(WORKFLOW_TEMPLATES.map(t => [t.id, t]));

/** De-duplicate template node/edge IDs so multiple instances don't collide */
export function instantiateTemplate(templateId: string, name?: string): { template: WorkflowTemplate; nodes: WorkflowTemplate["nodes"]; edges: WorkflowTemplate["edges"] } | null {
  const tpl = TEMPLATE_MAP.get(templateId);
  if (!tpl) return null;

  const suffix = `_${now()}_${Math.random().toString(36).slice(2, 6)}`;
  const idMap = new Map(tpl.nodes.map(n => [n.id, `${n.id}${suffix}`]));

  return {
    template: tpl,
    nodes: tpl.nodes.map(n => ({
      ...n,
      id: idMap.get(n.id)!,
    })),
    edges: tpl.edges.map(e => ({
      ...e,
      id: `${e.id}${suffix}`,
      sourceNodeId: idMap.get(e.sourceNodeId)!,
      targetNodeId: idMap.get(e.targetNodeId)!,
    })),
  };
}
