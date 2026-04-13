/**
 * AppRegistry — loads app definitions from JSON, resolves apps to pipeline specs
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AppsConfig, AppDefinition, PrimitiveDefinition, AppPipeline } from "./app-types.js";

export class AppRegistry {
  private primitives = new Map<string, PrimitiveDefinition>();
  private apps = new Map<string, AppDefinition>();

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

  /** Get a specific app definition */
  getApp(id: string): AppDefinition | undefined {
    return this.apps.get(id);
  }

  /** Get a primitive definition */
  getPrimitive(id: string): PrimitiveDefinition | undefined {
    return this.primitives.get(id);
  }

  /** Resolve an app to its pipeline spec (binding → primitive) */
  resolvePipeline(appId: string): AppPipeline | null {
    const app = this.apps.get(appId);
    if (!app) return null;

    const primitive = this.primitives.get(app.binding);
    if (!primitive) {
      console.warn(`[app-registry] App "${appId}" binds to unknown primitive "${app.binding}"`);
      return null;
    }

    return { appId, primitiveId: app.binding };
  }
}
