/**
 * AppRegistry — loads app definitions from JSON, resolves apps to pipeline specs
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AppsConfig, AppDefinition, PrimitiveDefinition, AppPipeline, WorkflowNodeDef, WorkflowEdgeDef, AppConfig, InputConfig, OutputConfig, LifecyclePolicy } from "./app-types.js";
import { NODE_DEF_MAP, resolveNodeType, isSinkType } from "./node-definitions.js";

export class AppRegistry {
  private primitives = new Map<string, PrimitiveDefinition>();
  private apps = new Map<string, AppDefinition>();
  private transientApps = new Map<string, AppDefinition>();

  constructor() {
    this.load();
  }

  private load() {
    const configPath = join(import.meta.dir, "..", "config", "apps.json");
    try {
      const raw = readFileSync(configPath, "utf-8");
      const config: AppsConfig = JSON.parse(raw);

      for (const p of config.primitives) {
        this.primitives.set(p.id, p);
      }
      for (const a of config.apps) {
        this.apps.set(a.id, a);
      }

      console.log(`[app-registry] Loaded ${this.primitives.size} primitive(s), ${this.apps.size} app(s)`);
    } catch (err) {
      console.warn("[app-registry] Failed to load apps.json:", err);
    }
  }

  /** List all available apps */
  listApps(): AppDefinition[] {
    return [...this.apps.values()];
  }

  /** List all available primitives */
  listPrimitives(): PrimitiveDefinition[] {
    return [...this.primitives.values()];
  }

  /** Get a specific app definition (checks static + transient) */
  getApp(id: string): AppDefinition | undefined {
    return this.apps.get(id) ?? this.transientApps.get(id);
  }

  /** Get a primitive definition */
  getPrimitive(id: string): PrimitiveDefinition | undefined {
    return this.primitives.get(id);
  }

  /** Register a transient app (from workflow activation, in-memory only) */
  registerTransientApp(app: AppDefinition): void {
    this.transientApps.set(app.id, app);
    console.log(`[app-registry] Registered transient app: ${app.id}`);
  }

  /** Remove a transient app */
  removeTransientApp(id: string): void {
    this.transientApps.delete(id);
  }

  /** Resolve an app to its pipeline spec (binding -> primitive) */
  resolvePipeline(appId: string): AppPipeline | null {
    const app = this.getApp(appId);
    if (!app) return null;

    const primitive = this.primitives.get(app.binding);
    if (!primitive) {
      console.warn(`[app-registry] App "${appId}" binds to unknown primitive "${app.binding}"`);
      return null;
    }

    return { appId, primitiveId: app.binding };
  }

  /** Find which app handles a given gesture by checking each app's config.gestures array */
  resolveByGesture(gesture: string): AppPipeline | null {
    for (const app of this.apps.values()) {
      if (app.config.gestures?.includes(gesture)) {
        return this.resolvePipeline(app.id);
      }
    }
    return null;
  }
}

/** Resolve workflow nodes + edges into a virtual AppDefinition for activation */
export function resolveWorkflowToApp(
  nodes: WorkflowNodeDef[],
  edges: WorkflowEdgeDef[],
  workflow: { id: string; name: string },
): AppDefinition {
  const aiNode = nodes.find(n => {
    const def = NODE_DEF_MAP.get(resolveNodeType(n.type));
    return def && def.activationMode !== null;
  });
  if (!aiNode) throw new Error("No processable node found in workflow");

  const def = NODE_DEF_MAP.get(resolveNodeType(aiNode.type))!;
  const binding = def.binding ?? "s2s-gemini-live";
  const isJepa = def.activationMode === "jepa";

  const config: AppConfig = {
    model: (aiNode.config.model as string) ?? (def.defaultModel ?? "gemini-2.5-flash-native-audio-latest"),
    voice: aiNode.config.voice as string | undefined,
    visionFps: (aiNode.config.visionFps as number) ?? 1,
    temperature: aiNode.config.temperature as number | undefined,
  };

  // Read input node config for modality selection (device selection is stream-level)
  const inputNode = nodes.find(n => n.type === "stream-input");
  const input: InputConfig = {
    video: inputNode?.config.video !== false,
    phoneMic: inputNode?.config.phoneMic !== false,
    glassesMic: inputNode?.config.glassesMic === true,
    gestures: inputNode?.config.gestures !== false,
    visionFps: (inputNode?.config.visionFps as number) ?? config.visionFps ?? 1,
  };
  config.visionFps = input.visionFps;
  config.input = input;

  // Read output config from all sink nodes (OR-merge: if any sink enables a channel, it's on)
  const sinkNodes = nodes.filter(n => isSinkType(resolveNodeType(n.type)));
  const output: OutputConfig = {
    viewers: sinkNodes.some(n => n.config.viewers === true),
    overlays: sinkNodes.some(n => n.config.overlays === true),
    speaker: sinkNodes.some(n => n.config.speaker === true),
    recording: sinkNodes.some(n => n.config.recording === true),
  };
  // If no explicit channel is set, check legacy output-full with all-true defaults
  if (!output.viewers && !output.overlays && !output.speaker && !output.recording && sinkNodes.length > 0) {
    const fullNode = sinkNodes.find(n => resolveNodeType(n.type) === "output-full");
    if (fullNode) {
      output.viewers = fullNode.config.viewers !== false;
      output.overlays = fullNode.config.overlays !== false;
      output.speaker = fullNode.config.speaker !== false;
      output.recording = fullNode.config.recording !== false;
    }
  }
  config.output = output;

  // Read system prompt from text node (connected to AI node via edges)
  const textNode = nodes.find(n => n.type === "text");
  // Fallback: check edges for a text node connected to the AI node
  let promptSource = textNode;
  if (!promptSource) {
    const textEdge = edges.find(e => {
      const src = nodes.find(n => n.id === e.sourceNodeId);
      const tgt = nodes.find(n => n.id === e.targetNodeId);
      return (src?.type === "text" && tgt?.id === aiNode.id) || (tgt?.type === "text" && src?.id === aiNode.id);
    });
    if (textEdge) {
      const textNodeId = nodes.find(n => n.id === textEdge.sourceNodeId)?.type === "text" ? textEdge.sourceNodeId : textEdge.targetNodeId;
      promptSource = nodes.find(n => n.id === textNodeId);
    }
  }
  const systemPrompt = (promptSource?.config.text as string) ?? (aiNode.config.systemPrompt as string) ?? "";

  return {
    id: `wf-${workflow.id}`,
    name: workflow.name,
    description: `Workflow: ${workflow.name}`,
    icon: "workflow",
    binding,
    systemPrompt,
    config,
  };
}

/** Find the text node specifically connected to a given AI node via edges */
function findPromptForAiNode(aiNodeId: string, nodes: WorkflowNodeDef[], edges: WorkflowEdgeDef[]): string {
  // Check for a text node connected to this specific AI node
  const textEdge = edges.find(e => {
    const src = nodes.find(n => n.id === e.sourceNodeId);
    const tgt = nodes.find(n => n.id === e.targetNodeId);
    return (src?.type === "text" && tgt?.id === aiNodeId) || (tgt?.type === "text" && src?.id === aiNodeId);
  });
  if (textEdge) {
    const textNodeId = nodes.find(n => n.id === textEdge.sourceNodeId)?.type === "text" ? textEdge.sourceNodeId : textEdge.targetNodeId;
    const textNode = nodes.find(n => n.id === textNodeId);
    if (textNode) return (textNode.config.text as string) ?? "";
  }
  // Fallback: any text node (backward compat)
  const anyTextNode = nodes.find(n => n.type === "text");
  return (anyTextNode?.config.text as string) ?? "";
}

/** Extract lifecycle policy from the stream-input node config */
export function extractLifecyclePolicy(inputNode: WorkflowNodeDef | undefined): LifecyclePolicy {
  if (!inputNode) return { onDisconnect: "stop", onReconnect: "restart", autoDeactivateMin: null };
  return {
    onDisconnect: (inputNode.config.onDisconnect as LifecyclePolicy["onDisconnect"]) ?? "stop",
    onReconnect: (inputNode.config.onReconnect as LifecyclePolicy["onReconnect"]) ?? "restart",
    autoDeactivateMin: (inputNode.config.autoDeactivateMin as number | null) ?? null,
  };
}

/**
 * Resolve workflow into a multi-node pipeline.
 * Each processable node becomes its own AppDefinition with per-node prompt and config.
 * For single-node workflows, returns an array of one (backward compat with resolveWorkflowToApp).
 */
export function resolveWorkflowToPipeline(
  nodes: WorkflowNodeDef[],
  edges: WorkflowEdgeDef[],
  workflow: { id: string; name: string },
): AppDefinition[] {
  const processableNodes = nodes.filter(n => {
    const def = NODE_DEF_MAP.get(resolveNodeType(n.type));
    return def && def.activationMode !== null;
  });
  if (processableNodes.length === 0) throw new Error("No processable node found in workflow");

  // Shared input config from stream-input node
  const inputNode = nodes.find(n => n.type === "stream-input");
  const lifecycle = extractLifecyclePolicy(inputNode);
  const baseInput: InputConfig = {
    video: inputNode?.config.video !== false,
    phoneMic: inputNode?.config.phoneMic !== false,
    glassesMic: inputNode?.config.glassesMic === true,
    gestures: inputNode?.config.gestures !== false,
    visionFps: (inputNode?.config.visionFps as number) ?? 1,
  };

  // Shared output config from all sink nodes (OR-merge)
  const sinkNodes = nodes.filter(n => isSinkType(resolveNodeType(n.type)));
  const baseOutput: OutputConfig = {
    viewers: sinkNodes.some(n => n.config.viewers === true),
    overlays: sinkNodes.some(n => n.config.overlays === true),
    speaker: sinkNodes.some(n => n.config.speaker === true),
    recording: sinkNodes.some(n => n.config.recording === true),
  };
  // Fallback: if no explicit channel, check legacy output-full with all-true defaults
  if (!baseOutput.viewers && !baseOutput.overlays && !baseOutput.speaker && !baseOutput.recording && sinkNodes.length > 0) {
    const fullNode = sinkNodes.find(n => resolveNodeType(n.type) === "output-full");
    if (fullNode) {
      baseOutput.viewers = fullNode.config.viewers !== false;
      baseOutput.overlays = fullNode.config.overlays !== false;
      baseOutput.speaker = fullNode.config.speaker !== false;
      baseOutput.recording = fullNode.config.recording !== false;
    }
  }

  return processableNodes.map((node, idx) => {
    const def = NODE_DEF_MAP.get(resolveNodeType(node.type))!;
    const isJepa = def.activationMode === "jepa";
    const binding = def.binding ?? "s2s-gemini-live";
    const systemPrompt = isJepa ? "jepa-vision" : findPromptForAiNode(node.id, nodes, edges);
    const visionFps = (node.config.visionFps as number) ?? baseInput.visionFps;

    // Per-node input config: each node can override the shared input
    const input: InputConfig = {
      video: node.config.video !== undefined ? node.config.video as boolean : baseInput.video,
      phoneMic: node.config.phoneMic !== undefined ? node.config.phoneMic as boolean : baseInput.phoneMic,
      glassesMic: node.config.glassesMic !== undefined ? node.config.glassesMic as boolean : baseInput.glassesMic,
      gestures: node.config.gestures !== undefined ? node.config.gestures as boolean : baseInput.gestures,
      visionFps,
    };

    // Per-node output config
    const isPrimary = idx === 0 && !isJepa;
    const output: OutputConfig = {
      viewers: node.config.viewers !== undefined ? node.config.viewers as boolean : baseOutput.viewers,
      overlays: node.config.overlays !== undefined ? node.config.overlays as boolean : baseOutput.overlays,
      speaker: isJepa ? false : (node.config.speaker !== undefined ? node.config.speaker as boolean : (isPrimary && baseOutput.speaker)),
      recording: node.config.recording !== undefined ? node.config.recording as boolean : baseOutput.recording,
    };

    const config: AppConfig = {
      model: (node.config.model as string) ?? (def.defaultModel ?? "gemini-2.5-flash-native-audio-latest"),
      voice: node.config.voice as string | undefined,
      visionFps,
      temperature: node.config.temperature as number | undefined,
      input,
      output,
      lifecycle,
      ...(isJepa ? {
        jepa: {
          provider: (node.config.provider as string) ?? "modal",
          tier: (node.config.tier as string) ?? "cloud",
          gpu: (node.config.gpu as string) ?? "A100-80GB",
          clipLength: (node.config.clipLength as number) ?? 16,
          sampleFps: (node.config.sampleFps as number) ?? 2,
          resolution: (node.config.resolution as number) ?? 224,
          tasks: node.config.tasks ?? [{ type: "anomaly" }, { type: "action" }],
        },
      } : {}),
    };

    // Use node label in the app name if available
    const nodeLabel = node.label ? ` - ${node.label}` : "";
    const suffix = processableNodes.length > 1 ? ` [${idx + 1}]` : "";

    return {
      id: processableNodes.length === 1 ? `wf-${workflow.id}` : `wf-${workflow.id}-${idx}`,
      name: `${workflow.name}${nodeLabel}${suffix}`,
      description: `Workflow: ${workflow.name} (${node.type})`,
      icon: "workflow",
      binding,
      systemPrompt,
      config,
    };
  });
}
