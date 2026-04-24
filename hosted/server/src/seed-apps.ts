/**
 * Seed Apps as Workflows
 *
 * Reads the "apps" array from apps.json and converts each into a
 * published workflow in SQLite.
 *
 * - New apps: inserted as published workflows.
 * - Existing apps: nodes/edges are rebuilt from apps.json to keep
 *   configs in sync with current node definitions (force-update).
 *
 * This replaces the old static app activation path with workflow-based
 * activation, so the guidance panel's /apps endpoint (which already
 * merges published workflows) becomes the single source of truth.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getWorkflow, insertWorkflow, updateWorkflow } from "./db/queries.js";

/** Map primitive binding -> node type + default config */
const BINDING_TO_NODE: Record<string, { type: string; extraConfig: Record<string, unknown> }> = {
  "s2s-gemini-live": { type: "s2s-live", extraConfig: {} },
  "s2s-gemma4-rest": { type: "s2s-rest", extraConfig: {} },
  "s2s-gemma4-e4b-rest": { type: "s2s-e4b", extraConfig: {} },
  "jepa-vjepa2": { type: "jepa-vision", extraConfig: { provider: "modal", tier: "cloud", gpu: "A100-80GB", clipLength: 16, sampleFps: 2, resolution: 224 } },
  "jepa-lewm": { type: "jepa-vision", extraConfig: { provider: "modal", tier: "cloud", model: "lewm-small", clipLength: 16, sampleFps: 2, resolution: 224 } },
};

interface StaticApp {
  id: string;
  name: string;
  description: string;
  icon: string;
  binding: string;
  systemPrompt: string;
  config: {
    model?: string;
    voice?: string;
    visionFps?: number;
    temperature?: number;
    gestures?: string[];
    analysisIntervalSec?: number;
  };
}

interface AppsConfig {
  primitives: unknown[];
  apps: StaticApp[];
}

/** Build the complete node set for a given app */
function buildWorkflowNodes(app: StaticApp, nodeInfo: { type: string; extraConfig: Record<string, unknown> }) {
  const s = app.id;
  const isJepa = nodeInfo.type === "jepa-vision";

  const srcId = `n_src_${s}`;
  const txtId = `n_txt_${s}`;
  const aiId = `n_ai_${s}`;
  const outId = `n_out_${s}`;

  const processorConfig: Record<string, unknown> = {
    ...nodeInfo.extraConfig,
    ...(app.config.model ? { model: app.config.model } : {}),
    ...(app.config.voice ? { voice: app.config.voice } : {}),
    ...(app.config.visionFps != null ? { visionFps: app.config.visionFps } : {}),
    ...(app.config.temperature != null ? { temperature: app.config.temperature } : {}),
    ...(app.config.analysisIntervalSec != null ? { analysisIntervalSec: app.config.analysisIntervalSec } : {}),
  };

  // Complete stream-input config matching current configSchema
  const inputConfig: Record<string, unknown> = {
    video: true,
    phoneMic: !isJepa && nodeInfo.type !== "s2s-rest",
    glassesMic: false,
    gestures: !isJepa && !!app.config.gestures?.length,
    visionFps: app.config.visionFps ?? 1,
    codec: "jpeg",
    onDisconnect: "stop",
    onReconnect: "restart",
    autoDeactivateMin: null,
  };

  const outputConfig: Record<string, unknown> = {
    viewers: true,
    overlays: !isJepa,
    speaker: nodeInfo.type === "s2s-live",
    recording: true,
  };

  return {
    nodes: [
      { id: srcId, type: "stream-input", label: "Input", config: JSON.stringify(inputConfig), positionX: 100, positionY: 200 },
      { id: txtId, type: "text", label: "Prompt", config: JSON.stringify({ text: app.systemPrompt }), positionX: 400, positionY: 80 },
      { id: aiId, type: nodeInfo.type, label: app.name, config: JSON.stringify(processorConfig), positionX: 400, positionY: 250 },
      { id: outId, type: "output", label: "Output", config: JSON.stringify(outputConfig), positionX: 700, positionY: 250 },
    ],
    edges: [
      { id: `e_src_ai_${s}`, sourceNodeId: srcId, targetNodeId: aiId },
      ...(isJepa ? [] : [{ id: `e_txt_ai_${s}`, sourceNodeId: txtId, targetNodeId: aiId }]),
      { id: `e_ai_out_${s}`, sourceNodeId: aiId, targetNodeId: outId },
    ],
  };
}

/**
 * Seed all apps from apps.json as published workflows.
 * Called once during server startup, after DB init + migrations.
 *
 * Force-updates existing seeded workflows to keep node configs
 * in sync with the current node definitions.
 */
export function seedAppsAsWorkflows(): void {
  const configPath = join(import.meta.dir, "..", "config", "apps.json");
  let config: AppsConfig;
  try {
    config = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    console.warn("[seed-apps] Could not read apps.json, skipping seed");
    return;
  }

  if (!config.apps || config.apps.length === 0) {
    console.log("[seed-apps] No apps to seed");
    return;
  }

  let seeded = 0;
  let updated = 0;
  let skipped = 0;

  for (const app of config.apps) {
    const wfId = `seed-${app.id}`;
    const nodeInfo = BINDING_TO_NODE[app.binding];
    if (!nodeInfo) {
      console.warn(`[seed-apps] Skipping "${app.id}": unknown binding "${app.binding}"`);
      skipped++;
      continue;
    }

    const { nodes, edges } = buildWorkflowNodes(app, nodeInfo);
    const existing = getWorkflow(wfId);

    if (!existing) {
      insertWorkflow({
        id: wfId,
        name: app.name,
        description: app.description,
        status: "published",
        nodes,
        edges,
      })();
      seeded++;
      console.log(`[seed-apps] Seeded workflow: ${wfId} (${app.name})`);
    } else {
      // Force-update nodes/edges to match current node definitions
      updateWorkflow(wfId, {
        name: app.name,
        description: app.description,
        nodes,
        edges,
      })();
      updated++;
      console.log(`[seed-apps] Updated workflow: ${wfId} (${app.name})`);
    }
  }

  console.log(`[seed-apps] Done: ${seeded} seeded, ${updated} updated, ${skipped} skipped`);
}
