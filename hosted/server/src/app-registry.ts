/**
 * AppRegistry — loads app definitions from JSON, resolves apps to pipeline specs
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AppsConfig, AppDefinition, PrimitiveDefinition, AppPipeline, WorkflowNodeDef, WorkflowEdgeDef, AppConfig, InputConfig, OutputConfig, LifecyclePolicy } from "./app-types.js";
import { NODE_DEF_MAP, resolveNodeType, isSinkType, isTriggerType, isSourceType } from "./node-definitions.js";

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

/** Walk edges from a processor to find reachable sink types (BFS through transforms/triggers) */
function resolveProcessorSinkTarget(
  processorId: string,
  nodes: WorkflowNodeDef[],
  edges: WorkflowEdgeDef[],
): "phone" | "glasses" {
  const visited = new Set<string>();
  const queue = [processorId];
  visited.add(processorId);

  while (queue.length > 0) {
    const currentId = queue.shift()!;
    for (const edge of edges) {
      if (edge.sourceNodeId !== currentId) continue;
      if (visited.has(edge.targetNodeId)) continue;
      visited.add(edge.targetNodeId);

      const targetNode = nodes.find(n => n.id === edge.targetNodeId);
      if (!targetNode) continue;
      const resolvedType = resolveNodeType(targetNode.type);
      const targetDef = NODE_DEF_MAP.get(resolvedType);

      if (resolvedType === "glasses-speaker") return "glasses";
      if (targetDef?.role === "transform" || targetDef?.role === "trigger") {
        queue.push(edge.targetNodeId);
      }
      // Don't walk into other processors — they're a different thread
    }
  }
  return "phone";
}

/** Resolve output config from all sink nodes using OR-merge semantics */
function resolveSinkOutput(nodes: WorkflowNodeDef[]): OutputConfig {
  const sinkNodes = nodes.filter(n => isSinkType(resolveNodeType(n.type)));
  const output: OutputConfig = {
    viewers: sinkNodes.some(n => n.config.viewers === true),
    overlays: sinkNodes.some(n => n.config.overlays === true),
    speaker: sinkNodes.some(n => n.config.speaker === true),
    recording: sinkNodes.some(n => n.config.recording === true),
  };
  // Fallback: if no explicit channel, apply output's all-true defaults
  if (!output.viewers && !output.overlays && !output.speaker && !output.recording && sinkNodes.length > 0) {
    const fullNode = sinkNodes.find(n => resolveNodeType(n.type) === "output");
    if (fullNode) {
      output.viewers = fullNode.config.viewers !== false;
      output.overlays = fullNode.config.overlays !== false;
      output.speaker = fullNode.config.speaker !== false;
      output.recording = fullNode.config.recording !== false;
    }
  }
  return output;
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
    analysisIntervalSec: aiNode.config.analysisIntervalSec as number | undefined,
  };

  // Read input config from granular source nodes via DAG edges
  const input: InputConfig = resolveSourceInput(aiNode.id, nodes, edges);
  config.visionFps = input.visionFps;
  config.input = input;

  // Read output config from all sink nodes (OR-merge)
  config.output = resolveSinkOutput(nodes);

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

/** Extract lifecycle policy from any source node config that has lifecycle fields */
export function extractLifecyclePolicy(nodes: WorkflowNodeDef[]): LifecyclePolicy {
  const sourceNode = nodes.find(n => {
    const resolved = resolveNodeType(n.type);
    return isSourceType(resolved);
  });
  if (!sourceNode) return { onDisconnect: "stop", onReconnect: "restart", autoDeactivateMin: null };
  return {
    onDisconnect: (sourceNode.config.onDisconnect as LifecyclePolicy["onDisconnect"]) ?? "stop",
    onReconnect: (sourceNode.config.onReconnect as LifecyclePolicy["onReconnect"]) ?? "restart",
    autoDeactivateMin: (sourceNode.config.autoDeactivateMin as number | null) ?? null,
  };
}

/**
 * Resolve trigger chains: find trigger nodes connected to each processable node.
 * Returns a map of processorNodeId -> trigger config (for conditional activation).
 *
 * Trigger chain: processor → trigger → processor
 *   e.g. jepa-vision → jepa-trigger → s2s-live
 *   means s2s-live should only activate when jepa-trigger fires.
 */
function resolveTriggerChains(
  nodes: WorkflowNodeDef[],
  edges: WorkflowEdgeDef[],
): Map<string, { triggerType: string; config: Record<string, unknown>; sourceProcessorId: string | null }> {
  const chains = new Map<string, { triggerType: string; config: Record<string, unknown>; sourceProcessorId: string | null }>();
  const edgeMap = new Map(edges.map(e => [e.sourceNodeId, e.targetNodeId]));

  for (const node of nodes) {
    if (!isTriggerType(resolveNodeType(node.type))) continue;
    const triggerDef = NODE_DEF_MAP.get(resolveNodeType(node.type));
    if (!triggerDef) continue;

    // Find what feeds INTO this trigger (upstream processor)
    const inEdge = edges.find(e => e.targetNodeId === node.id);
    const sourceProcessorId = inEdge?.sourceNodeId ?? null;

    // Find what this trigger targets (downstream nodes)
    for (const edge of edges) {
      if (edge.sourceNodeId !== node.id) continue;
      const targetNode = nodes.find(n => n.id === edge.targetNodeId);
      if (!targetNode) continue;
      const targetDef = NODE_DEF_MAP.get(resolveNodeType(targetNode.type));
      // Only annotate processable targets (processors)
      if (targetDef && targetDef.activationMode !== null) {
        chains.set(targetNode.id, {
          triggerType: triggerDef.type,
          config: node.config,
          sourceProcessorId,
        });
      }
    }
  }
  return chains;
}

/**
 * Resolve input config from granular source nodes via DAG edges.
 * Walks edges backward from a processor to find connected source nodes,
 * then OR-merges the source types into an InputConfig.
 */
function resolveSourceInput(
  processorId: string,
  nodes: WorkflowNodeDef[],
  edges: WorkflowEdgeDef[],
): InputConfig {
  // Find source nodes directly connected to this processor (BFS backward through edges)
  const connectedSources = new Set<string>();
  const visited = new Set<string>();
  const queue = [processorId];
  visited.add(processorId);

  while (queue.length > 0) {
    const currentId = queue.shift()!;
    for (const edge of edges) {
      if (edge.targetNodeId !== currentId) continue;
      if (visited.has(edge.sourceNodeId)) continue;
      visited.add(edge.sourceNodeId);

      const sourceNode = nodes.find(n => n.id === edge.sourceNodeId);
      if (!sourceNode) continue;
      const resolvedType = resolveNodeType(sourceNode.type);
      const sourceDef = NODE_DEF_MAP.get(resolvedType);

      if (sourceDef?.role === "source") {
        connectedSources.add(resolvedType);
      }
      // Walk backward through non-source, non-sink nodes (transforms, triggers)
      if (sourceDef?.role === "transform" || sourceDef?.role === "trigger") {
        queue.push(edge.sourceNodeId);
      }
    }
  }

  const hasCamera = connectedSources.has("camera-source");
  const hasPhoneMic = connectedSources.has("phone-mic-source");
  const hasGlassesMic = connectedSources.has("glasses-mic-source");
  const hasGestures = connectedSources.has("gesture-source");

  // Read visionFps from camera-source config if present
  const cameraNode = nodes.find(n => resolveNodeType(n.type) === "camera-source");
  const visionFps = (cameraNode?.config.visionFps as number) ?? 1;

  return {
    video: hasCamera,
    phoneMic: hasPhoneMic,
    glassesMic: hasGlassesMic,
    gestures: hasGestures,
    visionFps,
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
  // Passive pipelines (no AI processor) are valid — return empty so activation
  // skips AI orchestration and just configures sinks/transforms on the mobile side.
  if (processableNodes.length === 0) return [];

  // Resolve trigger chains: map processorNodeId -> trigger metadata
  const triggerChains = resolveTriggerChains(nodes, edges);

  // Resolve processor-to-processor dependencies (sequential activation)
  // If processor B has an incoming edge from processor A, B waits for A's first output
  const processorIds = new Set(processableNodes.map(n => n.id));
  const dependsOnMap = new Map<string, string>(); // processorNodeId -> upstream processorNodeId
  for (const edge of edges) {
    if (processorIds.has(edge.targetNodeId) && processorIds.has(edge.sourceNodeId)) {
      dependsOnMap.set(edge.targetNodeId, edge.sourceNodeId);
    }
  }

  const lifecycle = extractLifecyclePolicy(nodes);

  // Base input config (defaults, overridden per-processor by resolveSourceInput)
  const baseInput: InputConfig = { video: false, phoneMic: false, glassesMic: false, gestures: false, visionFps: 1 };

  // Shared output config from all sink nodes (OR-merge)
  const baseOutput = resolveSinkOutput(nodes);

  return processableNodes.map((node, idx) => {
    const def = NODE_DEF_MAP.get(resolveNodeType(node.type))!;
    const isJepa = def.activationMode === "jepa";
    const binding = def.binding ?? "s2s-gemini-live";
    const systemPrompt = isJepa ? "jepa-vision" : findPromptForAiNode(node.id, nodes, edges);
    const visionFps = (node.config.visionFps as number) ?? baseInput.visionFps;

    // Per-node input config: resolve from DAG edges connecting source nodes to this processor
    const input: InputConfig = resolveSourceInput(node.id, nodes, edges);

    // Per-node output config
    const isPrimary = idx === 0 && !isJepa;
    const speakerTarget = resolveProcessorSinkTarget(node.id, nodes, edges);
    const output: OutputConfig = {
      viewers: node.config.viewers !== undefined ? node.config.viewers as boolean : baseOutput.viewers,
      overlays: node.config.overlays !== undefined ? node.config.overlays as boolean : baseOutput.overlays,
      speaker: isJepa ? false : (node.config.speaker !== undefined ? node.config.speaker as boolean : (isPrimary && baseOutput.speaker)),
      speakerTarget,
      recording: node.config.recording !== undefined ? node.config.recording as boolean : baseOutput.recording,
    };

    const config: AppConfig = {
      model: (node.config.model as string) ?? (def.defaultModel ?? "gemini-2.5-flash-native-audio-latest"),
      voice: node.config.voice as string | undefined,
      visionFps,
      temperature: node.config.temperature as number | undefined,
      analysisIntervalSec: node.config.analysisIntervalSec as number | undefined,
      input,
      output,
      lifecycle,
      // Annotate with sequential dependency if this processor depends on another
      ...(dependsOnMap.has(node.id) ? {
        dependsOn: dependsOnMap.get(node.id),
      } : {}),
      // Annotate with trigger chain if this processor is downstream of a trigger
      ...(triggerChains.has(node.id) ? {
        trigger: {
          type: triggerChains.get(node.id)!.triggerType,
          config: triggerChains.get(node.id)!.config,
          sourceProcessorId: triggerChains.get(node.id)!.sourceProcessorId,
        },
      } : {}),
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

    console.log(`[app-registry] Pipeline node ${idx}: type=${node.type} id=${node.id} speakerTarget=${speakerTarget} speaker=${output.speaker} dependsOn=${dependsOnMap.get(node.id) ?? "none"}`);

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
