/**
 * Workflow builder tests
 *
 * Covers:
 *   1. resolveWorkflowToApp — maps workflow nodes -> virtual AppDefinition
 *   2. resolveWorkflowToPipeline — multi-node pipeline resolution
 *   3. AppRegistry — listPrimitives, transient app registration/lifecycle
 *   4. Node definitions — completeness, structure, edge rules
 *   5. validateStructure — DAG structure validation
 *   6. Output config — OR-merge across multiple output sinks
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { resolveWorkflowToApp, resolveWorkflowToPipeline, AppRegistry } from "../src/app-registry.js";
import { NODE_DEFINITIONS, NODE_DEF_MAP, buildAllowedEdgeMap, validateStructure, TARGET_ROLE_SINK } from "../src/node-definitions.js";
import type { WorkflowNodeDef, WorkflowEdgeDef } from "../src/app-types.js";

// --- resolveWorkflowToApp ---

describe("resolveWorkflowToApp", () => {
  const defaultNodes: WorkflowNodeDef[] = [
    { id: "src1", type: "stream-input", label: "Camera", config: {}, positionX: 0, positionY: 0 },
    { id: "ai1", type: "s2s-live", label: "Gemini", config: { model: "gemini-2.5-flash-native-audio-latest" }, positionX: 300, positionY: 0 },
    { id: "out1", type: "output", label: "Output Full", config: { outputTarget: "guidance" }, positionX: 600, positionY: 0 },
  ];
  const defaultEdges: WorkflowEdgeDef[] = [
    { id: "e1", sourceNodeId: "src1", targetNodeId: "ai1" },
    { id: "e2", sourceNodeId: "ai1", targetNodeId: "out1" },
  ];

  test("maps s2s-live node to s2s-gemini-live binding", () => {
    const app = resolveWorkflowToApp(defaultNodes, defaultEdges, { id: "wf_abc", name: "Test" });
    expect(app.binding).toBe("s2s-gemini-live");
    expect(app.id).toBe("wf-wf_abc");
    expect(app.name).toBe("Test");
  });

  test("maps s2s-rest node to s2s-gemma4-rest binding", () => {
    const nodes = defaultNodes.map(n =>
      n.id === "ai1" ? { ...n, type: "s2s-rest" as const, config: { model: "gemma-4-27b" } } : n
    );
    const app = resolveWorkflowToApp(nodes, defaultEdges, { id: "wf_rest", name: "REST Flow" });
    expect(app.binding).toBe("s2s-gemma4-rest");
  });

  test("extracts model from AI node config", () => {
    const app = resolveWorkflowToApp(defaultNodes, defaultEdges, { id: "wf1", name: "X" });
    expect(app.config.model).toBe("gemini-2.5-flash-native-audio-latest");
  });

  test("extracts system prompt from AI node config", () => {
    const nodes = defaultNodes.map(n =>
      n.id === "ai1" ? { ...n, config: { ...n.config, systemPrompt: "You are helpful." } } : n
    );
    const app = resolveWorkflowToApp(nodes, defaultEdges, { id: "wf2", name: "X" });
    expect(app.systemPrompt).toBe("You are helpful.");
  });

  test("extracts voice config from AI node", () => {
    const nodes = defaultNodes.map(n =>
      n.id === "ai1" ? { ...n, config: { ...n.config, voice: "Kore" } } : n
    );
    const app = resolveWorkflowToApp(nodes, defaultEdges, { id: "wf3", name: "X" });
    expect(app.config.voice).toBe("Kore");
  });

  test("extracts visionFps from AI node", () => {
    const nodes = defaultNodes.map(n =>
      n.id === "ai1" ? { ...n, config: { ...n.config, visionFps: 0.5 } } : n
    );
    const app = resolveWorkflowToApp(nodes, defaultEdges, { id: "wf4", name: "X" });
    expect(app.config.visionFps).toBe(0.5);
  });

  test("extracts temperature from AI node", () => {
    const nodes = defaultNodes.map(n =>
      n.id === "ai1" ? { ...n, type: "s2s-rest" as const, config: { model: "gemma-4-27b", temperature: 0.3 } } : n
    );
    const app = resolveWorkflowToApp(nodes, defaultEdges, { id: "wf5", name: "X" });
    expect(app.config.temperature).toBe(0.3);
  });

  test("defaults model to gemini-2.5-flash when not specified", () => {
    const nodes = defaultNodes.map(n =>
      n.id === "ai1" ? { ...n, config: {} } : n
    );
    const app = resolveWorkflowToApp(nodes, defaultEdges, { id: "wf6", name: "X" });
    expect(app.config.model).toBe("gemini-2.5-flash-native-audio-latest");
  });

  test("defaults system prompt to empty string", () => {
    const nodes = defaultNodes.map(n =>
      n.id === "ai1" ? { ...n, config: { model: "gemini-2.5-flash" } } : n
    );
    const app = resolveWorkflowToApp(nodes, defaultEdges, { id: "wf7", name: "X" });
    expect(app.systemPrompt).toBe("");
  });

  test("throws when no AI node present", () => {
    const nodes: WorkflowNodeDef[] = [
      { id: "src1", type: "stream-input", label: "Camera", config: {}, positionX: 0, positionY: 0 },
      { id: "out1", type: "output", label: "Output Full", config: {}, positionX: 600, positionY: 0 },
    ];
    expect(() => resolveWorkflowToApp(nodes, [], { id: "wf_bad", name: "Bad" })).toThrow("No processable node found");
  });

  test("uses first AI node when multiple exist", () => {
    const nodes: WorkflowNodeDef[] = [
      { id: "src1", type: "stream-input", label: "Camera", config: {}, positionX: 0, positionY: 0 },
      { id: "ai1", type: "s2s-live", label: "Gemini", config: { model: "gemini-2.5-flash" }, positionX: 200, positionY: 0 },
      { id: "ai2", type: "s2s-rest", label: "Gemma", config: { model: "gemma-4-27b" }, positionX: 400, positionY: 0 },
      { id: "out1", type: "output", label: "Output Full", config: {}, positionX: 600, positionY: 0 },
    ];
    // s2s-live appears first, so binding should be gemini-live
    const app = resolveWorkflowToApp(nodes, [], { id: "wf_multi", name: "Multi" });
    expect(app.binding).toBe("s2s-gemini-live");
  });

  test("description is 'Workflow: {name}'", () => {
    const app = resolveWorkflowToApp(defaultNodes, defaultEdges, { id: "wf_desc", name: "My Flow" });
    expect(app.description).toBe("Workflow: My Flow");
  });
});

// --- AppRegistry ---

describe("AppRegistry", () => {
  let registry: AppRegistry;

  beforeEach(() => {
    registry = new AppRegistry();
  });

  test("loads primitives from apps.json", () => {
    const primitives = registry.listPrimitives();
    expect(primitives.length).toBeGreaterThan(0);
    const ids = primitives.map(p => p.id);
    expect(ids).toContain("s2s-gemini-live");
    expect(ids).toContain("s2s-gemma4-rest");
  });

  test("primitives have inputs and outputs", () => {
    const primitives = registry.listPrimitives();
    const gemini = primitives.find(p => p.id === "s2s-gemini-live");
    expect(gemini).toBeDefined();
    expect(gemini!.inputs.length).toBeGreaterThan(0);
    expect(gemini!.outputs.length).toBeGreaterThan(0);
  });

  test("loads apps from apps.json", () => {
    const apps = registry.listApps();
    expect(apps.length).toBeGreaterThan(0);
    const ids = apps.map(a => a.id);
    expect(ids).toContain("spanish-co-pilot");
  });

  test("getApp finds static apps", () => {
    const app = registry.getApp("spanish-co-pilot");
    expect(app).toBeDefined();
    expect(app!.name).toBe("Spanish Co-pilot");
  });

  test("registerTransientApp and getApp resolve transient", () => {
    const transientApp = {
      id: "wf_test123",
      name: "Test Workflow",
      description: "Test",
      icon: "workflow",
      binding: "s2s-gemini-live",
      systemPrompt: "Test prompt",
      config: { model: "gemini-2.5-flash" },
    };
    registry.registerTransientApp(transientApp);
    expect(registry.getApp("wf_test123")).toBe(transientApp);
  });

  test("getApp checks static before transient", () => {
    const transientApp = {
      id: "spanish-co-pilot", // same ID as static app
      name: "Override",
      description: "Override",
      icon: "workflow",
      binding: "s2s-gemini-live",
      systemPrompt: "",
      config: { model: "gemini-2.5-flash" },
    };
    registry.registerTransientApp(transientApp);
    // Static app takes precedence
    expect(registry.getApp("spanish-co-pilot")!.name).toBe("Spanish Co-pilot");
  });

  test("removeTransientApp deletes transient app", () => {
    const transientApp = {
      id: "wf_remove_me",
      name: "Remove Me",
      description: "X",
      icon: "workflow",
      binding: "s2s-gemini-live",
      systemPrompt: "",
      config: { model: "gemini-2.5-flash" },
    };
    registry.registerTransientApp(transientApp);
    expect(registry.getApp("wf_remove_me")).toBeDefined();
    registry.removeTransientApp("wf_remove_me");
    expect(registry.getApp("wf_remove_me")).toBeUndefined();
  });

  test("resolvePipeline resolves static app", () => {
    const pipeline = registry.resolvePipeline("spanish-co-pilot");
    expect(pipeline).not.toBeNull();
    expect(pipeline!.appId).toBe("spanish-co-pilot");
    expect(pipeline!.primitiveId).toBe("s2s-gemini-live");
  });

  test("resolvePipeline resolves transient app", () => {
    registry.registerTransientApp({
      id: "wf_pipe",
      name: "Wf",
      description: "X",
      icon: "workflow",
      binding: "s2s-gemini-live",
      systemPrompt: "",
      config: { model: "gemini-2.5-flash" },
    });
    const pipeline = registry.resolvePipeline("wf_pipe");
    expect(pipeline).not.toBeNull();
    expect(pipeline!.appId).toBe("wf_pipe");
    expect(pipeline!.primitiveId).toBe("s2s-gemini-live");
  });

  test("resolvePipeline returns null for unknown app", () => {
    expect(registry.resolvePipeline("nonexistent")).toBeNull();
  });

  test("resolveByGesture finds app by gesture", () => {
    const pipeline = registry.resolveByGesture("thumbs_up");
    expect(pipeline).not.toBeNull();
    expect(pipeline!.appId).toBe("spanish-co-pilot");
  });

  test("resolveByGesture returns null for unknown gesture", () => {
    expect(registry.resolveByGesture("unknown_gesture")).toBeNull();
  });
});

// --- Node Definitions ---

describe("NODE_DEFINITIONS", () => {
  const ALL_ROLES = ["source", "processor", "reference", "sink", "gating", "trigger", "transform"];

  test("each definition has required fields", () => {
    for (const def of NODE_DEFINITIONS) {
      expect(def.type).toBeTruthy();
      expect(def.label).toBeTruthy();
      expect(def.subtitle).toBeTruthy();
      expect(def.color).toBeDefined();
      expect(def.color.fill).toBeTruthy();
      expect(def.color.header).toBeTruthy();
      expect(def.color.stroke).toBeTruthy();
      expect(Array.isArray(def.allowedTargets)).toBe(true);
      expect(ALL_ROLES).toContain(def.role);
      expect(Array.isArray(def.configSchema)).toBe(true);
      expect(def.defaultConfig).toBeDefined();
      expect(def.defaultLabel).toBeTruthy();
    }
  });

  test("NODE_DEF_MAP matches NODE_DEFINITIONS", () => {
    expect(NODE_DEF_MAP.size).toBe(NODE_DEFINITIONS.length);
    for (const def of NODE_DEFINITIONS) {
      expect(NODE_DEF_MAP.get(def.type)).toBe(def);
    }
  });

  test("has source nodes", () => {
    const sources = NODE_DEFINITIONS.filter(d => d.role === "source");
    expect(sources.length).toBeGreaterThanOrEqual(1);
    const sourceTypes = sources.map(s => s.type);
    expect(sourceTypes).toContain("camera-source");
  });

  test("has sink nodes", () => {
    const sinks = NODE_DEFINITIONS.filter(d => d.role === "sink");
    expect(sinks.length).toBeGreaterThanOrEqual(1);
  });

  test("has reference node (text)", () => {
    const refs = NODE_DEFINITIONS.filter(d => d.role === "reference");
    expect(refs.length).toBe(1);
    expect(refs[0].type).toBe("text");
  });

  test("has processor nodes", () => {
    const processors = NODE_DEFINITIONS.filter(d => d.role === "processor");
    expect(processors.length).toBeGreaterThanOrEqual(4);
    const types = processors.map(p => p.type).sort();
    for (const expected of ["jepa-vision", "s2s-e4b", "s2s-live", "s2s-rest"]) {
      expect(types).toContain(expected);
    }
  });

  test("processable nodes have activationMode", () => {
    const processable = NODE_DEFINITIONS.filter(d => d.activationMode !== null);
    const validModes = ["ai", "jepa", "vision", "enhance", "sensor", "speech", "tracking", "stt", "measure"];
    for (const def of processable) {
      expect(validModes).toContain(def.activationMode);
    }
  });

  test("jepa-vision has activationMode jepa", () => {
    const jepa = NODE_DEF_MAP.get("jepa-vision")!;
    expect(jepa.activationMode).toBe("jepa");
    expect(jepa.binding).toBe("jepa-vjepa2");
    expect(jepa.defaultModel).toBe("vjepa2-vit-l");
    expect(jepa.allowedTargets).toContain(TARGET_ROLE_SINK);
  });

  test("AI nodes have activationMode ai", () => {
    for (const type of ["s2s-live", "s2s-rest", "s2s-e4b"]) {
      const def = NODE_DEF_MAP.get(type)!;
      expect(def.activationMode).toBe("ai");
      expect(def.binding).toBeTruthy();
    }
  });
});

// --- Edge Map ---

describe("buildAllowedEdgeMap", () => {
  const edgeMap = buildAllowedEdgeMap();

  test("has entry for every node type", () => {
    for (const def of NODE_DEFINITIONS) {
      expect(edgeMap.has(def.type)).toBe(true);
    }
  });

  test("camera-source can target processors and sinks", () => {
    const targets = edgeMap.get("camera-source")!;
    expect(targets.has("s2s-live")).toBe(true);
    expect(targets.has("s2s-rest")).toBe(true);
    expect(targets.has("s2s-e4b")).toBe(true);
    expect(targets.has("jepa-vision")).toBe(true);
    expect(targets.has("overlays")).toBe(true);
    expect(targets.has("text")).toBe(false);
    expect(targets.has("camera-source")).toBe(false);
  });

  test("text can target AI processors", () => {
    const targets = edgeMap.get("text")!;
    expect(targets.has("s2s-live")).toBe(true);
    expect(targets.has("s2s-rest")).toBe(true);
    expect(targets.has("s2s-e4b")).toBe(true);
    expect(targets.has("jepa-vision")).toBe(false);
    expect(targets.has("overlays")).toBe(false);
  });

  test("jepa-vision can target sinks (via <sink> expansion)", () => {
    const targets = edgeMap.get("jepa-vision")!;
    expect(targets.has("overlays")).toBe(true);
    expect(targets.size).toBeGreaterThanOrEqual(1);
  });

  test("sink nodes have no outgoing edges", () => {
    const sinks = NODE_DEFINITIONS.filter(d => d.role === "sink");
    for (const sink of sinks) {
      const targets = edgeMap.get(sink.type)!;
      expect(targets.size).toBe(0);
    }
  });

  test("processors can target other processors and sinks", () => {
    for (const type of ["s2s-live", "s2s-rest", "s2s-e4b"]) {
      const targets = edgeMap.get(type)!;
      expect(targets.has("s2s-live")).toBe(true);
      expect(targets.has("s2s-rest")).toBe(true);
      expect(targets.has("s2s-e4b")).toBe(true);
      expect(targets.has("jepa-vision")).toBe(true);
      expect(targets.has("overlays")).toBe(true);
    }
  });
});

// --- validateStructure ---

describe("validateStructure", () => {
  test("valid minimal workflow passes with source, processor, sink", () => {
    const nodes = [
      { type: "camera-source" },
      { type: "s2s-live" },
      { type: "overlays" },
    ];
    expect(validateStructure(nodes)).toBeNull();
  });

  test("valid with jepa-vision processor", () => {
    const nodes = [
      { type: "camera-source" },
      { type: "jepa-vision" },
      { type: "overlays" },
    ];
    expect(validateStructure(nodes)).toBeNull();
  });

  test("valid with multiple processors", () => {
    const nodes = [
      { type: "camera-source" },
      { type: "s2s-live" },
      { type: "jepa-vision" },
      { type: "overlays" },
    ];
    expect(validateStructure(nodes)).toBeNull();
  });

  test("valid with multiple sinks", () => {
    const nodes = [
      { type: "camera-source" },
      { type: "s2s-live" },
      { type: "overlays" },
      { type: "debug-sink" },
    ];
    expect(validateStructure(nodes)).toBeNull();
  });

  test("valid with trigger instead of sink", () => {
    const nodes = [
      { type: "camera-source" },
      { type: "s2s-live" },
      { type: "timer-trigger" },
    ];
    expect(validateStructure(nodes)).toBeNull();
  });

  test("fails with no source node", () => {
    const nodes = [
      { type: "s2s-live" },
      { type: "overlays" },
    ];
    expect(validateStructure(nodes)).toMatch(/at least 1 source or content/);
  });

  test("valid with text (reference) as source", () => {
    const nodes = [
      { type: "text" },
      { type: "s2s-live" },
      { type: "overlays" },
    ];
    expect(validateStructure(nodes)).toBeNull();
  });

  test("fails with no sink/transform/trigger node", () => {
    const nodes = [
      { type: "camera-source" },
      { type: "s2s-live" },
    ];
    expect(validateStructure(nodes)).toMatch(/at least 1 sink, transform, or trigger/);
  });
});

// --- resolveWorkflowToPipeline ---

describe("resolveWorkflowToPipeline", () => {
  test("single AI node produces one app", () => {
    const nodes: WorkflowNodeDef[] = [
      { id: "src", type: "stream-input", label: "In", config: {}, positionX: 0, positionY: 0 },
      { id: "ai", type: "s2s-live", label: "AI", config: { model: "gemini-2.5-flash" }, positionX: 300, positionY: 0 },
      { id: "out", type: "output", label: "Out", config: {}, positionX: 600, positionY: 0 },
    ];
    const pipeline = resolveWorkflowToPipeline(nodes, [], { id: "wf1", name: "Single" });
    expect(pipeline.length).toBe(1);
    expect(pipeline[0].id).toBe("wf-wf1");
    expect(pipeline[0].binding).toBe("s2s-gemini-live");
  });

  test("multiple AI nodes produce multiple apps", () => {
    const nodes: WorkflowNodeDef[] = [
      { id: "src", type: "stream-input", label: "In", config: {}, positionX: 0, positionY: 0 },
      { id: "ai1", type: "s2s-live", label: "Gemini", config: { model: "gemini-2.5-flash" }, positionX: 300, positionY: 0 },
      { id: "ai2", type: "s2s-rest", label: "Gemma", config: { model: "gemma-4-27b" }, positionX: 300, positionY: 200 },
      { id: "out", type: "output", label: "Out", config: {}, positionX: 600, positionY: 0 },
    ];
    const pipeline = resolveWorkflowToPipeline(nodes, [], { id: "wf2", name: "Multi" });
    expect(pipeline.length).toBe(2);
    expect(pipeline[0].id).toBe("wf-wf2-0");
    expect(pipeline[1].id).toBe("wf-wf2-1");
    expect(pipeline[0].binding).toBe("s2s-gemini-live");
    expect(pipeline[1].binding).toBe("s2s-gemma4-rest");
  });

  test("JEPA node gets jepa config and binding", () => {
    const nodes: WorkflowNodeDef[] = [
      { id: "src", type: "stream-input", label: "In", config: {}, positionX: 0, positionY: 0 },
      { id: "jepa", type: "jepa-vision", label: "JEPA", config: { provider: "modal", tier: "cloud", model: "vjepa2-vit-l" }, positionX: 300, positionY: 0 },
      { id: "out", type: "output", label: "Out", config: {}, positionX: 600, positionY: 0 },
    ];
    const pipeline = resolveWorkflowToPipeline(nodes, [], { id: "wf3", name: "JEPA" });
    expect(pipeline.length).toBe(1);
    expect(pipeline[0].binding).toBe("jepa-vjepa2");
    expect(pipeline[0].config.jepa).toBeDefined();
    expect((pipeline[0].config as any).jepa.provider).toBe("modal");
    // Model is at config.model (top level), not inside jepa sub-object
    expect(pipeline[0].config.model).toBe("vjepa2-vit-l");
  });

  test("JEPA node gets speaker=false", () => {
    const nodes: WorkflowNodeDef[] = [
      { id: "src", type: "stream-input", label: "In", config: {}, positionX: 0, positionY: 0 },
      { id: "jepa", type: "jepa-vision", label: "JEPA", config: {}, positionX: 300, positionY: 0 },
      { id: "out", type: "output", label: "Out", config: {}, positionX: 600, positionY: 0 },
    ];
    const pipeline = resolveWorkflowToPipeline(nodes, [], { id: "wf4", name: "JEPA" });
    expect((pipeline[0].config as any).output.speaker).toBe(false);
  });

  test("primary AI node gets speaker config from sink node", () => {
    const nodes: WorkflowNodeDef[] = [
      { id: "src", type: "stream-input", label: "In", config: {}, positionX: 0, positionY: 0 },
      { id: "ai", type: "s2s-live", label: "AI", config: { model: "gemini-2.5-flash" }, positionX: 300, positionY: 0 },
      { id: "out", type: "overlays", label: "Out", config: { speaker: true }, positionX: 600, positionY: 0 },
    ];
    const pipeline = resolveWorkflowToPipeline(nodes, [], { id: "wf5", name: "AI" });
    expect((pipeline[0].config as any).output.speaker).toBe(true);
  });

  test("extracts text node prompt via edges", () => {
    const nodes: WorkflowNodeDef[] = [
      { id: "src", type: "stream-input", label: "In", config: {}, positionX: 0, positionY: 0 },
      { id: "txt", type: "text", label: "Prompt", config: { text: "Be helpful" }, positionX: 100, positionY: -100 },
      { id: "ai", type: "s2s-live", label: "AI", config: { model: "gemini-2.5-flash" }, positionX: 300, positionY: 0 },
      { id: "out", type: "output", label: "Out", config: {}, positionX: 600, positionY: 0 },
    ];
    const edges: WorkflowEdgeDef[] = [
      { id: "e1", sourceNodeId: "src", targetNodeId: "ai" },
      { id: "e2", sourceNodeId: "txt", targetNodeId: "ai" },
      { id: "e3", sourceNodeId: "ai", targetNodeId: "out" },
    ];
    const pipeline = resolveWorkflowToPipeline(nodes, edges, { id: "wf6", name: "WithPrompt" });
    expect(pipeline[0].systemPrompt).toBe("Be helpful");
  });

  test("JEPA node gets systemPrompt 'jepa-vision'", () => {
    const nodes: WorkflowNodeDef[] = [
      { id: "src", type: "stream-input", label: "In", config: {}, positionX: 0, positionY: 0 },
      { id: "jepa", type: "jepa-vision", label: "JEPA", config: {}, positionX: 300, positionY: 0 },
      { id: "out", type: "output", label: "Out", config: {}, positionX: 600, positionY: 0 },
    ];
    const pipeline = resolveWorkflowToPipeline(nodes, [], { id: "wf7", name: "JEPA" });
    expect(pipeline[0].systemPrompt).toBe("jepa-vision");
  });

  test("returns empty array when no processable node present (passive workflow)", () => {
    const nodes: WorkflowNodeDef[] = [
      { id: "src", type: "stream-input", label: "In", config: {}, positionX: 0, positionY: 0 },
      { id: "out", type: "output", label: "Out", config: {}, positionX: 600, positionY: 0 },
    ];
    const pipeline = resolveWorkflowToPipeline(nodes, [], { id: "bad", name: "Bad" });
    expect(pipeline.length).toBe(0);
  });

  test("extracts input config from granular source nodes", () => {
    const nodes: WorkflowNodeDef[] = [
      { id: "cam", type: "camera-source", label: "Camera", config: {}, positionX: 0, positionY: 0 },
      { id: "gmic", type: "glasses-mic-source", label: "Glasses Mic", config: {}, positionX: 0, positionY: 100 },
      { id: "ai", type: "s2s-live", label: "AI", config: { model: "gemini-2.5-flash" }, positionX: 300, positionY: 0 },
      { id: "out", type: "overlays", label: "Out", config: {}, positionX: 600, positionY: 0 },
    ];
    const edges: WorkflowEdgeDef[] = [
      { id: "e1", sourceNodeId: "cam", targetNodeId: "ai" },
      { id: "e2", sourceNodeId: "gmic", targetNodeId: "ai" },
      { id: "e3", sourceNodeId: "ai", targetNodeId: "out" },
    ];
    const pipeline = resolveWorkflowToPipeline(nodes, edges, { id: "wf8", name: "InputCfg" });
    expect((pipeline[0].config as any).input.video).toBe(true);
    expect((pipeline[0].config as any).input.phoneMic).toBe(false);
    expect((pipeline[0].config as any).input.glassesMic).toBe(true);
  });

  test("extracts output config from output node", () => {
    const nodes: WorkflowNodeDef[] = [
      { id: "src", type: "stream-input", label: "In", config: {}, positionX: 0, positionY: 0 },
      { id: "ai", type: "s2s-live", label: "AI", config: { model: "gemini-2.5-flash" }, positionX: 300, positionY: 0 },
      { id: "out", type: "output", label: "Out", config: { viewers: false, recording: false }, positionX: 600, positionY: 0 },
    ];
    const pipeline = resolveWorkflowToPipeline(nodes, [], { id: "wf9", name: "OutCfg" });
    expect((pipeline[0].config as any).output.viewers).toBe(false);
    expect((pipeline[0].config as any).output.recording).toBe(false);
  });
});

// --- Multi-sink OR-merge ---

describe("multi-sink OR-merge", () => {
  test("two output sinks OR-merge their channel configs", () => {
    const nodes: WorkflowNodeDef[] = [
      { id: "src", type: "stream-input", label: "In", config: {}, positionX: 0, positionY: 0 },
      { id: "ai", type: "s2s-live", label: "AI", config: { model: "gemini-2.5-flash" }, positionX: 300, positionY: 0 },
      { id: "out1", type: "output", label: "Out1", config: { speaker: true, viewers: false }, positionX: 600, positionY: 0 },
      { id: "out2", type: "output", label: "Out2", config: { recording: true, viewers: true }, positionX: 600, positionY: 150 },
    ];
    const pipeline = resolveWorkflowToPipeline(nodes, [], { id: "wf_merge1", name: "Merge" });
    // OR-merge: viewers=true because out2 has it, speaker=true from out1, recording=true from out2
    expect((pipeline[0].config as any).output.speaker).toBe(true);
    expect((pipeline[0].config as any).output.recording).toBe(true);
    expect((pipeline[0].config as any).output.viewers).toBe(true);
  });
});
