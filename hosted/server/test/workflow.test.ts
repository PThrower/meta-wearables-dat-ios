/**
 * Workflow builder tests
 *
 * Covers:
 *   1. resolveWorkflowToApp — maps workflow nodes -> virtual AppDefinition
 *   2. resolveWorkflowToPipeline — multi-node pipeline resolution
 *   3. AppRegistry — listPrimitives, transient app registration/lifecycle
 *   4. Node definitions — completeness, structure, edge rules
 *   5. validateStructure — DAG structure validation
 *   6. Multi-sink OR-merge — combining specialized output nodes
 *   7. Backward compat — legacy "output" type resolution
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { resolveWorkflowToApp, resolveWorkflowToPipeline, AppRegistry } from "../src/app-registry.js";
import { NODE_DEFINITIONS, NODE_DEF_MAP, buildAllowedEdgeMap, validateStructure, resolveNodeType, isSinkType, TARGET_ROLE_SINK } from "../src/node-definitions.js";
import type { WorkflowNodeDef, WorkflowEdgeDef } from "../src/app-types.js";

// --- resolveWorkflowToApp ---

describe("resolveWorkflowToApp", () => {
  const defaultNodes: WorkflowNodeDef[] = [
    { id: "src1", type: "stream-input", label: "Camera", config: {}, positionX: 0, positionY: 0 },
    { id: "ai1", type: "s2s-live", label: "Gemini", config: { model: "gemini-2.5-flash-native-audio-latest" }, positionX: 300, positionY: 0 },
    { id: "out1", type: "output-full", label: "Output Full", config: { outputTarget: "guidance" }, positionX: 600, positionY: 0 },
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
      { id: "out1", type: "output-full", label: "Output Full", config: {}, positionX: 600, positionY: 0 },
    ];
    expect(() => resolveWorkflowToApp(nodes, [], { id: "wf_bad", name: "Bad" })).toThrow("No processable node found");
  });

  test("uses first AI node when multiple exist", () => {
    const nodes: WorkflowNodeDef[] = [
      { id: "src1", type: "stream-input", label: "Camera", config: {}, positionX: 0, positionY: 0 },
      { id: "ai1", type: "s2s-live", label: "Gemini", config: { model: "gemini-2.5-flash" }, positionX: 200, positionY: 0 },
      { id: "ai2", type: "s2s-rest", label: "Gemma", config: { model: "gemma-4-27b" }, positionX: 400, positionY: 0 },
      { id: "out1", type: "output-full", label: "Output Full", config: {}, positionX: 600, positionY: 0 },
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
  test("defines all 11 node types", () => {
    const types = NODE_DEFINITIONS.map(d => d.type);
    expect(types).toEqual([
      "stream-input", "text", "s2s-live", "s2s-rest", "s2s-e4b", "jepa-vision",
      "output-speaker", "output-viewers", "output-recording", "output-overlays", "output-full",
    ]);
  });

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
      expect(["source", "processor", "reference", "sink"]).toContain(def.role);
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

  test("exactly 1 source node (stream-input)", () => {
    const sources = NODE_DEFINITIONS.filter(d => d.role === "source");
    expect(sources.length).toBe(1);
    expect(sources[0].type).toBe("stream-input");
  });

  test("5 sink nodes (output-speaker, output-viewers, output-recording, output-overlays, output-full)", () => {
    const sinks = NODE_DEFINITIONS.filter(d => d.role === "sink");
    expect(sinks.length).toBe(5);
    expect(sinks.map(s => s.type).sort()).toEqual([
      "output-full", "output-overlays", "output-recording", "output-speaker", "output-viewers",
    ]);
    for (const sink of sinks) {
      expect(sink.allowedTargets).toEqual([]);
    }
  });

  test("exactly 1 reference node (text)", () => {
    const refs = NODE_DEFINITIONS.filter(d => d.role === "reference");
    expect(refs.length).toBe(1);
    expect(refs[0].type).toBe("text");
  });

  test("4 processor nodes (s2s-live, s2s-rest, s2s-e4b, jepa-vision)", () => {
    const processors = NODE_DEFINITIONS.filter(d => d.role === "processor");
    expect(processors.length).toBe(4);
    expect(processors.map(p => p.type).sort()).toEqual(["jepa-vision", "s2s-e4b", "s2s-live", "s2s-rest"]);
  });

  test("processable nodes have activationMode and binding", () => {
    const processable = NODE_DEFINITIONS.filter(d => d.activationMode !== null);
    for (const def of processable) {
      expect(def.binding).toBeTruthy();
      expect(def.defaultModel).toBeTruthy();
      expect(["ai", "jepa"]).toContain(def.activationMode);
    }
  });

  test("non-processable nodes have null activationMode and binding", () => {
    const structural = NODE_DEFINITIONS.filter(d => d.activationMode === null);
    for (const def of structural) {
      expect(def.binding).toBeNull();
    }
  });

  test("jepa-vision has activationMode jepa and targets <sink> sentinel", () => {
    const jepa = NODE_DEF_MAP.get("jepa-vision")!;
    expect(jepa.activationMode).toBe("jepa");
    expect(jepa.binding).toBe("jepa-vjepa2");
    expect(jepa.defaultModel).toBe("vjepa2-vit-l");
    expect(jepa.allowedTargets).toEqual([TARGET_ROLE_SINK]);
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

  test("stream-input can target processors and all output types", () => {
    const targets = edgeMap.get("stream-input")!;
    expect(targets.has("s2s-live")).toBe(true);
    expect(targets.has("s2s-rest")).toBe(true);
    expect(targets.has("s2s-e4b")).toBe(true);
    expect(targets.has("jepa-vision")).toBe(true);
    expect(targets.has("output-speaker")).toBe(true);
    expect(targets.has("output-viewers")).toBe(true);
    expect(targets.has("output-recording")).toBe(true);
    expect(targets.has("output-overlays")).toBe(true);
    expect(targets.has("output-full")).toBe(true);
    expect(targets.has("text")).toBe(false);
    expect(targets.has("stream-input")).toBe(false);
  });

  test("text can only target AI processors", () => {
    const targets = edgeMap.get("text")!;
    expect(targets.has("s2s-live")).toBe(true);
    expect(targets.has("s2s-rest")).toBe(true);
    expect(targets.has("s2s-e4b")).toBe(true);
    expect(targets.has("jepa-vision")).toBe(false);
    expect(targets.has("output-full")).toBe(false);
    expect(targets.has("output-speaker")).toBe(false);
  });

  test("jepa-vision can target all output types", () => {
    const targets = edgeMap.get("jepa-vision")!;
    expect(targets.has("output-speaker")).toBe(true);
    expect(targets.has("output-viewers")).toBe(true);
    expect(targets.has("output-recording")).toBe(true);
    expect(targets.has("output-overlays")).toBe(true);
    expect(targets.has("output-full")).toBe(true);
    expect(targets.size).toBe(5);
  });

  test("all output types have no outgoing edges", () => {
    for (const type of ["output-speaker", "output-viewers", "output-recording", "output-overlays", "output-full"]) {
      const targets = edgeMap.get(type)!;
      expect(targets.size).toBe(0);
    }
  });

  test("processors can target other processors and all output types", () => {
    for (const type of ["s2s-live", "s2s-rest", "s2s-e4b"]) {
      const targets = edgeMap.get(type)!;
      expect(targets.has("s2s-live")).toBe(true);
      expect(targets.has("s2s-rest")).toBe(true);
      expect(targets.has("s2s-e4b")).toBe(true);
      expect(targets.has("jepa-vision")).toBe(true);
      expect(targets.has("output-speaker")).toBe(true);
      expect(targets.has("output-viewers")).toBe(true);
      expect(targets.has("output-recording")).toBe(true);
      expect(targets.has("output-overlays")).toBe(true);
      expect(targets.has("output-full")).toBe(true);
    }
  });
});

// --- validateStructure ---

describe("validateStructure", () => {
  test("valid minimal workflow passes with output-full", () => {
    const nodes = [
      { type: "stream-input" },
      { type: "s2s-live" },
      { type: "output-full" },
    ];
    expect(validateStructure(nodes)).toBeNull();
  });

  test("valid with specialized output-speaker sink", () => {
    const nodes = [
      { type: "stream-input" },
      { type: "s2s-live" },
      { type: "output-speaker" },
    ];
    expect(validateStructure(nodes)).toBeNull();
  });

  test("valid with jepa-vision processor", () => {
    const nodes = [
      { type: "stream-input" },
      { type: "jepa-vision" },
      { type: "output-full" },
    ];
    expect(validateStructure(nodes)).toBeNull();
  });

  test("valid with multiple processors", () => {
    const nodes = [
      { type: "stream-input" },
      { type: "s2s-live" },
      { type: "jepa-vision" },
      { type: "output-full" },
    ];
    expect(validateStructure(nodes)).toBeNull();
  });

  test("valid with multiple sinks", () => {
    const nodes = [
      { type: "stream-input" },
      { type: "s2s-live" },
      { type: "output-speaker" },
      { type: "output-recording" },
    ];
    expect(validateStructure(nodes)).toBeNull();
  });

  test("valid with all 5 sink types", () => {
    const nodes = [
      { type: "stream-input" },
      { type: "s2s-live" },
      { type: "output-speaker" },
      { type: "output-viewers" },
      { type: "output-recording" },
      { type: "output-overlays" },
      { type: "output-full" },
    ];
    expect(validateStructure(nodes)).toBeNull();
  });

  test("fails with no source node", () => {
    const nodes = [
      { type: "s2s-live" },
      { type: "output-full" },
    ];
    expect(validateStructure(nodes)).toMatch(/exactly 1 source/);
  });

  test("fails with multiple source nodes", () => {
    const nodes = [
      { type: "stream-input" },
      { type: "stream-input" },
      { type: "s2s-live" },
      { type: "output-full" },
    ];
    expect(validateStructure(nodes)).toMatch(/exactly 1 source/);
  });

  test("fails with no processor nodes", () => {
    const nodes = [
      { type: "stream-input" },
      { type: "text" },
      { type: "output-full" },
    ];
    expect(validateStructure(nodes)).toMatch(/at least 1 processor/);
  });

  test("fails with no output node", () => {
    const nodes = [
      { type: "stream-input" },
      { type: "s2s-live" },
    ];
    expect(validateStructure(nodes)).toMatch(/at least 1 output/);
  });
});

// --- resolveWorkflowToPipeline ---

describe("resolveWorkflowToPipeline", () => {
  test("single AI node produces one app", () => {
    const nodes: WorkflowNodeDef[] = [
      { id: "src", type: "stream-input", label: "In", config: {}, positionX: 0, positionY: 0 },
      { id: "ai", type: "s2s-live", label: "AI", config: { model: "gemini-2.5-flash" }, positionX: 300, positionY: 0 },
      { id: "out", type: "output-full", label: "Out", config: {}, positionX: 600, positionY: 0 },
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
      { id: "out", type: "output-full", label: "Out", config: {}, positionX: 600, positionY: 0 },
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
      { id: "out", type: "output-full", label: "Out", config: {}, positionX: 600, positionY: 0 },
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
      { id: "out", type: "output-full", label: "Out", config: {}, positionX: 600, positionY: 0 },
    ];
    const pipeline = resolveWorkflowToPipeline(nodes, [], { id: "wf4", name: "JEPA" });
    expect((pipeline[0].config as any).output.speaker).toBe(false);
  });

  test("primary AI node gets speaker=true by default", () => {
    const nodes: WorkflowNodeDef[] = [
      { id: "src", type: "stream-input", label: "In", config: {}, positionX: 0, positionY: 0 },
      { id: "ai", type: "s2s-live", label: "AI", config: { model: "gemini-2.5-flash" }, positionX: 300, positionY: 0 },
      { id: "out", type: "output-full", label: "Out", config: {}, positionX: 600, positionY: 0 },
    ];
    const pipeline = resolveWorkflowToPipeline(nodes, [], { id: "wf5", name: "AI" });
    expect((pipeline[0].config as any).output.speaker).toBe(true);
  });

  test("extracts text node prompt via edges", () => {
    const nodes: WorkflowNodeDef[] = [
      { id: "src", type: "stream-input", label: "In", config: {}, positionX: 0, positionY: 0 },
      { id: "txt", type: "text", label: "Prompt", config: { text: "Be helpful" }, positionX: 100, positionY: -100 },
      { id: "ai", type: "s2s-live", label: "AI", config: { model: "gemini-2.5-flash" }, positionX: 300, positionY: 0 },
      { id: "out", type: "output-full", label: "Out", config: {}, positionX: 600, positionY: 0 },
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
      { id: "out", type: "output-full", label: "Out", config: {}, positionX: 600, positionY: 0 },
    ];
    const pipeline = resolveWorkflowToPipeline(nodes, [], { id: "wf7", name: "JEPA" });
    expect(pipeline[0].systemPrompt).toBe("jepa-vision");
  });

  test("throws when no processable node present", () => {
    const nodes: WorkflowNodeDef[] = [
      { id: "src", type: "stream-input", label: "In", config: {}, positionX: 0, positionY: 0 },
      { id: "out", type: "output-full", label: "Out", config: {}, positionX: 600, positionY: 0 },
    ];
    expect(() => resolveWorkflowToPipeline(nodes, [], { id: "bad", name: "Bad" })).toThrow("No processable node found");
  });

  test("extracts input config from stream-input node", () => {
    const nodes: WorkflowNodeDef[] = [
      { id: "src", type: "stream-input", label: "In", config: { video: true, phoneMic: false, glassesMic: true }, positionX: 0, positionY: 0 },
      { id: "ai", type: "s2s-live", label: "AI", config: { model: "gemini-2.5-flash" }, positionX: 300, positionY: 0 },
      { id: "out", type: "output-full", label: "Out", config: {}, positionX: 600, positionY: 0 },
    ];
    const pipeline = resolveWorkflowToPipeline(nodes, [], { id: "wf8", name: "InputCfg" });
    expect((pipeline[0].config as any).input.video).toBe(true);
    expect((pipeline[0].config as any).input.phoneMic).toBe(false);
    expect((pipeline[0].config as any).input.glassesMic).toBe(true);
  });

  test("extracts output config from output-full node", () => {
    const nodes: WorkflowNodeDef[] = [
      { id: "src", type: "stream-input", label: "In", config: {}, positionX: 0, positionY: 0 },
      { id: "ai", type: "s2s-live", label: "AI", config: { model: "gemini-2.5-flash" }, positionX: 300, positionY: 0 },
      { id: "out", type: "output-full", label: "Out", config: { viewers: false, recording: false }, positionX: 600, positionY: 0 },
    ];
    const pipeline = resolveWorkflowToPipeline(nodes, [], { id: "wf9", name: "OutCfg" });
    expect((pipeline[0].config as any).output.viewers).toBe(false);
    expect((pipeline[0].config as any).output.recording).toBe(false);
  });
});

// --- Multi-sink OR-merge ---

describe("multi-sink OR-merge", () => {
  test("separate speaker + recording sinks enable both channels", () => {
    const nodes: WorkflowNodeDef[] = [
      { id: "src", type: "stream-input", label: "In", config: {}, positionX: 0, positionY: 0 },
      { id: "ai", type: "s2s-live", label: "AI", config: { model: "gemini-2.5-flash" }, positionX: 300, positionY: 0 },
      { id: "spk", type: "output-speaker", label: "Speaker", config: { speaker: true }, positionX: 600, positionY: 0 },
      { id: "rec", type: "output-recording", label: "Recording", config: { recording: true }, positionX: 600, positionY: 150 },
    ];
    const pipeline = resolveWorkflowToPipeline(nodes, [], { id: "wf_merge1", name: "Merge" });
    expect((pipeline[0].config as any).output.speaker).toBe(true);
    expect((pipeline[0].config as any).output.recording).toBe(true);
    expect((pipeline[0].config as any).output.viewers).toBe(false);
    expect((pipeline[0].config as any).output.overlays).toBe(false);
  });

  test("all 4 specialized sinks enable all channels", () => {
    const nodes: WorkflowNodeDef[] = [
      { id: "src", type: "stream-input", label: "In", config: {}, positionX: 0, positionY: 0 },
      { id: "ai", type: "s2s-live", label: "AI", config: { model: "gemini-2.5-flash" }, positionX: 300, positionY: 0 },
      { id: "spk", type: "output-speaker", label: "Speaker", config: { speaker: true }, positionX: 600, positionY: 0 },
      { id: "view", type: "output-viewers", label: "Viewers", config: { viewers: true }, positionX: 600, positionY: 100 },
      { id: "rec", type: "output-recording", label: "Recording", config: { recording: true }, positionX: 600, positionY: 200 },
      { id: "ovr", type: "output-overlays", label: "Overlays", config: { overlays: true }, positionX: 600, positionY: 300 },
    ];
    const pipeline = resolveWorkflowToPipeline(nodes, [], { id: "wf_merge2", name: "AllSinks" });
    expect((pipeline[0].config as any).output.speaker).toBe(true);
    expect((pipeline[0].config as any).output.viewers).toBe(true);
    expect((pipeline[0].config as any).output.recording).toBe(true);
    expect((pipeline[0].config as any).output.overlays).toBe(true);
  });
});

// --- Backward Compat ---

describe("backward compat", () => {
  test("resolveNodeType maps legacy 'output' to 'output-full'", () => {
    expect(resolveNodeType("output")).toBe("output-full");
    expect(resolveNodeType("output-full")).toBe("output-full");
    expect(resolveNodeType("s2s-live")).toBe("s2s-live");
  });

  test("isSinkType identifies all sink types", () => {
    expect(isSinkType("output-speaker")).toBe(true);
    expect(isSinkType("output-viewers")).toBe(true);
    expect(isSinkType("output-recording")).toBe(true);
    expect(isSinkType("output-overlays")).toBe(true);
    expect(isSinkType("output-full")).toBe(true);
    expect(isSinkType("output")).toBe(false);
    expect(isSinkType("s2s-live")).toBe(false);
    expect(isSinkType("stream-input")).toBe(false);
  });

  test("legacy 'output' type resolves correctly in resolveWorkflowToApp", () => {
    const nodes: WorkflowNodeDef[] = [
      { id: "src1", type: "stream-input", label: "Camera", config: {}, positionX: 0, positionY: 0 },
      { id: "ai1", type: "s2s-live", label: "Gemini", config: { model: "gemini-2.5-flash" }, positionX: 300, positionY: 0 },
      { id: "out1", type: "output", label: "Output", config: {}, positionX: 600, positionY: 0 },
    ];
    const app = resolveWorkflowToApp(nodes, [], { id: "wf_legacy", name: "Legacy" });
    expect(app.binding).toBe("s2s-gemini-live");
    // Legacy "output" maps to "output-full" which defaults all channels to true
    expect(app.config.output?.speaker).toBe(true);
    expect(app.config.output?.viewers).toBe(true);
  });

  test("legacy 'output' type resolves correctly in resolveWorkflowToPipeline", () => {
    const nodes: WorkflowNodeDef[] = [
      { id: "src", type: "stream-input", label: "In", config: {}, positionX: 0, positionY: 0 },
      { id: "ai", type: "s2s-live", label: "AI", config: { model: "gemini-2.5-flash" }, positionX: 300, positionY: 0 },
      { id: "out", type: "output", label: "Output", config: {}, positionX: 600, positionY: 0 },
    ];
    const pipeline = resolveWorkflowToPipeline(nodes, [], { id: "wf_legacy2", name: "Legacy" });
    expect(pipeline.length).toBe(1);
    expect(pipeline[0].binding).toBe("s2s-gemini-live");
    expect((pipeline[0].config as any).output.speaker).toBe(true);
  });
});
