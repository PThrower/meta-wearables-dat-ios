/**
 * AppRegistry — loads app definitions from JSON, resolves apps to pipeline specs
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AppsConfig, AppDefinition, PrimitiveDefinition, AppPipeline, WorkflowNodeDef, WorkflowEdgeDef, AppConfig, InputConfig, OutputConfig } from "./app-types.js";

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
  const aiNode = nodes.find(n => n.type === "s2s-live" || n.type === "s2s-rest" || n.type === "s2s-e4b");
  if (!aiNode) throw new Error("No AI node found in workflow");

  // Map node type to primitive binding
  const bindingMap: Record<string, string> = {
    "s2s-live": "s2s-gemini-live",
    "s2s-rest": "s2s-gemma4-rest",
    "s2s-e4b": "s2s-gemma4-e4b-rest",
  };
  const binding = bindingMap[aiNode.type] ?? "s2s-gemini-live";

  const config: AppConfig = {
    model: (aiNode.config.model as string) ?? "gemini-2.5-flash-native-audio-latest",
    voice: aiNode.config.voice as string | undefined,
    visionFps: (aiNode.config.visionFps as number) ?? 1,
    temperature: aiNode.config.temperature as number | undefined,
  };

  // Read input node config for modality selection (device selection is stream-level)
  const inputNode = nodes.find(n => n.type === "camera-source");
  const input: InputConfig = {
    video: inputNode?.config.video !== false,
    phoneMic: inputNode?.config.phoneMic !== false,
    glassesMic: inputNode?.config.glassesMic === true,
    gestures: inputNode?.config.gestures !== false,
    visionFps: (inputNode?.config.visionFps as number) ?? config.visionFps ?? 1,
  };
  config.visionFps = input.visionFps;
  config.input = input;

  // Read output node config for channel gating
  const outputNode = nodes.find(n => n.type === "output");
  const output: OutputConfig = {
    viewers: outputNode?.config.viewers !== false,
    overlays: outputNode?.config.overlays !== false,
    speaker: outputNode?.config.speaker !== false,
    recording: outputNode?.config.recording !== false,
  };
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
