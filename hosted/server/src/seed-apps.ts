/**
 * Seed Apps as Workflows
 *
 * Reads the "apps" array from apps.json and converts each into a
 * published workflow in SQLite.  Idempotent — skips if workflow
 * already exists (matched by deterministic seed ID).
 *
 * This replaces the old static app activation path with workflow-based
 * activation, so the guidance panel's /apps endpoint (which already
 * merges published workflows) becomes the single source of truth.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getWorkflow, insertWorkflow } from "./db/queries.js";

/** Map primitive binding → node type + default config */
const BINDING_TO_NODE: Record<string, { type: string; extraConfig: Record<string, unknown> }> = {
  "s2s-gemini-live": { type: "s2s-live", extraConfig: {} },
  "s2s-gemma4-rest": { type: "s2s-rest", extraConfig: {} },
  "s2s-gemma4-e4b-rest": { type: "s2s-e4b", extraConfig: {} },
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

/**
 * Seed all apps from apps.json as published workflows.
 * Called once during server startup, after DB init + migrations.
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
  let skipped = 0;

  for (const app of config.apps) {
    const wfId = `seed-${app.id}`;
    const existing = getWorkflow(wfId);
    if (existing) {
      skipped++;
      continue;
    }

    const nodeInfo = BINDING_TO_NODE[app.binding];
    if (!nodeInfo) {
      console.warn(`[seed-apps] Skipping "${app.id}": unknown binding "${app.binding}"`);
      continue;
    }

    // Use app ID as suffix to guarantee unique node IDs across workflows
    const s = app.id;
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
      ...(app.config.gestures ? { gestures: app.config.gestures } : {}),
    };

    const inputConfig: Record<string, unknown> = {
      video: true,
      phoneMic: nodeInfo.type !== "s2s-rest", // REST has no audio input
      glassesMic: false,
      gestures: !!app.config.gestures?.length,
      visionFps: app.config.visionFps ?? 1,
    };

    const outputConfig: Record<string, unknown> = {
      viewers: true,
      overlays: true,
      speaker: nodeInfo.type === "s2s-live", // only live has audio output
      recording: true,
    };

    insertWorkflow({
      id: wfId,
      name: app.name,
      description: app.description,
      status: "published",
      nodes: [
        { id: srcId, type: "stream-input", label: "Input", config: JSON.stringify(inputConfig), positionX: 100, positionY: 200 },
        { id: txtId, type: "text", label: "Prompt", config: JSON.stringify({ text: app.systemPrompt }), positionX: 400, positionY: 80 },
        { id: aiId, type: nodeInfo.type, label: app.name, config: JSON.stringify(processorConfig), positionX: 400, positionY: 250 },
        { id: outId, type: "output", label: "Output", config: JSON.stringify(outputConfig), positionX: 700, positionY: 250 },
      ],
      edges: [
        { id: `e_src_ai_${s}`, sourceNodeId: srcId, targetNodeId: aiId },
        { id: `e_txt_ai_${s}`, sourceNodeId: txtId, targetNodeId: aiId },
        { id: `e_ai_out_${s}`, sourceNodeId: aiId, targetNodeId: outId },
      ],
    })();

    seeded++;
    console.log(`[seed-apps] Seeded workflow: ${wfId} (${app.name})`);
  }

  console.log(`[seed-apps] Done: ${seeded} seeded, ${skipped} already existed`);
}
