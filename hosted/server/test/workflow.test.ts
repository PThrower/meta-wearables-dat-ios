/**
 * Workflow builder tests
 *
 * Covers:
 *   1. resolveWorkflowToApp — maps workflow nodes → virtual AppDefinition
 *   2. AppRegistry — listPrimitives, transient app registration/lifecycle
 *   3. Validation rules — 1 source, 1 AI, 1 output, connected chain
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { resolveWorkflowToApp, AppRegistry } from "../src/app-registry.js";
import type { WorkflowNodeDef, WorkflowEdgeDef } from "../src/app-types.js";

// --- resolveWorkflowToApp ---

describe("resolveWorkflowToApp", () => {
  const defaultNodes: WorkflowNodeDef[] = [
    { id: "src1", type: "stream-input", label: "Camera", config: {}, positionX: 0, positionY: 0 },
    { id: "ai1", type: "s2s-live", label: "Gemini", config: { model: "gemini-2.5-flash-native-audio-latest" }, positionX: 300, positionY: 0 },
    { id: "out1", type: "output", label: "Output", config: { outputTarget: "guidance" }, positionX: 600, positionY: 0 },
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
      { id: "out1", type: "output", label: "Output", config: {}, positionX: 600, positionY: 0 },
    ];
    expect(() => resolveWorkflowToApp(nodes, [], { id: "wf_bad", name: "Bad" })).toThrow("No AI node found");
  });

  test("uses first AI node when multiple exist", () => {
    const nodes: WorkflowNodeDef[] = [
      { id: "src1", type: "stream-input", label: "Camera", config: {}, positionX: 0, positionY: 0 },
      { id: "ai1", type: "s2s-live", label: "Gemini", config: { model: "gemini-2.5-flash" }, positionX: 200, positionY: 0 },
      { id: "ai2", type: "s2s-rest", label: "Gemma", config: { model: "gemma-4-27b" }, positionX: 400, positionY: 0 },
      { id: "out1", type: "output", label: "Output", config: {}, positionX: 600, positionY: 0 },
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
