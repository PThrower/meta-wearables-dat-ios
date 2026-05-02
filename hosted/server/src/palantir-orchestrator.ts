/**
 * PalantirOrchestrator -- manages Palantir Foundry node lifecycle and event routing.
 *
 * Mirrors JEPAOrchestrator pattern: creates PalantirClient per stackUrl, routes
 * detection triggers to the right namespace handler, emits results as GuidanceEvents.
 *
 * iOS detection -> ws-message-handler -> palantirOrchestrator.fanoutTrigger()
 *   -> PalantirNodeState handler (ontology/aip/dataset/llm/action)
 *   -> @ebowwa/palantir SDK call
 *   -> GuidanceEvent -> fanout to viewers + trigger downstream nodes
 *
 * Auth: service user credentials from env (PALANTIR_CLIENT_ID, PALANTIR_CLIENT_SECRET).
 * Client cached per stackUrl to reuse tokens.
 */

import {
  createServiceClient,
  OntologiesNamespace,
  AipNamespace,
  DatasetsNamespace,
  PalantirApiError,
} from "@ebowwa/palantir";
import type { PalantirClient } from "@ebowwa/palantir";
import type { GuidanceEvent } from "./guidance-orchestrator.js";

// --- Types ---

export interface PalantirActivationConfig {
  nodeType: string;
  stackUrl: string;
  /** All raw config from the workflow node */
  [key: string]: unknown;
}

export interface PalantirNodeState {
  appId: string;
  nodeType: string;
  config: PalantirActivationConfig;
  client: PalantirClient;
  ontologies: OntologiesNamespace;
  aip: AipNamespace;
  datasets: DatasetsNamespace;
  /** AIP session RID (lazy-created on first trigger) */
  aipSessionRid: string | null;
}

// --- Callback types ---

export type PalantirEventFanoutFn = (sessionId: string, event: GuidanceEvent) => void;
export type PalantirFlowTriggerFn = (sessionId: string, event: GuidanceEvent) => void;

// --- Template interpolation ---

function interpolateTemplate(template: string, vars: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`\${${key}}`, value);
  }
  return result;
}

function sanitizeInput(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/'/g, "\\'");
}

// --- Orchestrator ---

export class PalantirOrchestrator {
  /** sessionId -> Map<appId, PalantirNodeState> */
  private sessionNodes = new Map<string, Map<string, PalantirNodeState>>();

  /** Cache PalantirClient per stackUrl to reuse tokens */
  private clientCache = new Map<string, PalantirClient>();

  /** Fan out Palantir results to viewer WebSockets */
  private eventFanoutFn: PalantirEventFanoutFn | null = null;

  /** Push Palantir results to flow trigger evaluation engine */
  private flowTriggerFn: PalantirFlowTriggerFn | null = null;

  // --- Setters for wiring ---

  setEventFanoutFn(fn: PalantirEventFanoutFn): void {
    this.eventFanoutFn = fn;
  }

  setFlowTriggerFn(fn: PalantirFlowTriggerFn): void {
    this.flowTriggerFn = fn;
  }

  // --- Client management ---

  private getOrCreateClient(stackUrl: string): PalantirClient | null {
    const cached = this.clientCache.get(stackUrl);
    if (cached) return cached;

    const clientId = process.env.PALANTIR_CLIENT_ID;
    const clientSecret = process.env.PALANTIR_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      console.warn("[palantir] Missing PALANTIR_CLIENT_ID or PALANTIR_CLIENT_SECRET env vars");
      return null;
    }

    const client = createServiceClient(stackUrl, clientId, clientSecret);
    this.clientCache.set(stackUrl, client);
    return client;
  }

  // --- Lifecycle ---

  /** Activate a Palantir node for a session */
  async activate(sessionId: string, appId: string, config: PalantirActivationConfig): Promise<boolean> {
    if (!config.stackUrl) {
      console.error(`[palantir] No stackUrl configured for node ${config.nodeType}`);
      return false;
    }

    const client = this.getOrCreateClient(config.stackUrl);
    if (!client) return false;

    // Authenticate if not already done
    try {
      await client.authenticateWithClientCredentials();
    } catch (err) {
      console.error(`[palantir] Authentication failed for ${config.stackUrl}:`, (err as Error).message);
      return false;
    }

    const nodeState: PalantirNodeState = {
      appId,
      nodeType: config.nodeType,
      config,
      client,
      ontologies: new OntologiesNamespace(client),
      aip: new AipNamespace(client),
      datasets: new DatasetsNamespace(client),
      aipSessionRid: null,
    };

    if (!this.sessionNodes.has(sessionId)) {
      this.sessionNodes.set(sessionId, new Map());
    }
    this.sessionNodes.get(sessionId)!.set(appId, nodeState);

    console.log(`[palantir] Activated ${config.nodeType} session=${sessionId} stack=${config.stackUrl.replace(/^https?:\/\//, "").slice(0, 30)}`);
    return true;
  }

  /** Deactivate a specific node */
  deactivate(sessionId: string, appId: string): void {
    const nodes = this.sessionNodes.get(sessionId);
    if (!nodes) return;
    const state = nodes.get(appId);
    if (state) {
      console.log(`[palantir] Deactivated ${state.nodeType} session=${sessionId}`);
      nodes.delete(appId);
    }
    if (nodes.size === 0) {
      this.sessionNodes.delete(sessionId);
    }
  }

  /** Deactivate all nodes for a session */
  deactivateAll(sessionId: string): void {
    const nodes = this.sessionNodes.get(sessionId);
    if (!nodes) return;
    console.log(`[palantir] Deactivated ${nodes.size} node(s) session=${sessionId}`);
    this.sessionNodes.delete(sessionId);
  }

  /** Check if any Palantir nodes are active for a session */
  isActive(sessionId: string): boolean {
    const nodes = this.sessionNodes.get(sessionId);
    return !!nodes && nodes.size > 0;
  }

  // --- Trigger routing ---

  /** Route trigger text to all active Palantir nodes for a session */
  async fanoutTrigger(sessionId: string, triggerText: string): Promise<void> {
    return this.fanoutStructuredTrigger(sessionId, triggerText, {});
  }

  /** Route trigger with structured data to all active Palantir nodes */
  async fanoutStructuredTrigger(sessionId: string, triggerText: string, structuredData: Record<string, unknown>): Promise<void> {
    const nodes = this.sessionNodes.get(sessionId);
    if (!nodes || nodes.size === 0) return;

    const vars: Record<string, string> = {
      triggerText: sanitizeInput(triggerText),
      timestamp: new Date().toISOString(),
    };

    const results = await Promise.allSettled(
      Array.from(nodes.values()).map(state => this.handleNode(state, sessionId, triggerText, vars, structuredData))
    );

    for (let i = 0; i < results.length; i++) {
      if (results[i].status === "rejected") {
        const state = Array.from(nodes.values())[i];
        console.error(`[palantir] Node ${state.nodeType} error session=${sessionId}:`, (results[i] as PromiseRejectedResult).reason);
      }
    }
  }

  /** Route trigger to a specific node */
  async sendTrigger(sessionId: string, appId: string, triggerText: string): Promise<void> {
    const nodes = this.sessionNodes.get(sessionId);
    if (!nodes) return;
    const state = nodes.get(appId);
    if (!state) return;

    const vars: Record<string, string> = {
      triggerText: sanitizeInput(triggerText),
      timestamp: new Date().toISOString(),
    };

    await this.handleNode(state, sessionId, triggerText, vars, {});
  }

  // --- Private handlers ---

  private async handleNode(
    state: PalantirNodeState,
    sessionId: string,
    triggerText: string,
    vars: Record<string, string>,
    structuredData: Record<string, unknown> = {},
  ): Promise<void> {
    switch (state.nodeType) {
      case "palantir-ontology": return this.handleOntology(state, sessionId, triggerText, vars, structuredData);
      case "palantir-aip":      return this.handleAip(state, sessionId, triggerText, vars, structuredData);
      case "palantir-dataset":  return this.handleDataset(state, sessionId, triggerText, vars, structuredData);
      case "palantir-llm":      return this.handleLlm(state, sessionId, triggerText, vars, structuredData);
      case "palantir-action":   return this.handleAction(state, sessionId, triggerText, vars, structuredData);
      default:
        console.warn(`[palantir] Unknown node type: ${state.nodeType}`);
    }
  }

  private emitEvent(sessionId: string, nodeType: string, result: unknown): void {
    const event: GuidanceEvent = {
      type: "palantir_result",
      content: JSON.stringify({ nodeType, result }),
      confidence: 1.0,
      source: "palantir",
      trigger: nodeType,
      timestampMs: Date.now(),
    };

    if (this.eventFanoutFn) {
      this.eventFanoutFn(sessionId, event);
    }
    if (this.flowTriggerFn) {
      this.flowTriggerFn(sessionId, event);
    }
  }

  // --- Ontology handler ---

  private async handleOntology(
    state: PalantirNodeState,
    sessionId: string,
    triggerText: string,
    vars: Record<string, string>,
    structuredData: Record<string, unknown> = {},
  ): Promise<void> {
    const { ontologies } = state;
    const c = state.config;
    const ontologyApiName = c.ontologyApiName as string;
    const objectTypeId = c.objectTypeId as string;
    const transitionObjectTypeId = (c.transitionObjectTypeId as string) || objectTypeId;
    const zoneObjectTypeId = (c.zoneObjectTypeId as string) || objectTypeId;
    const operation = c.operation as string;
    const selectFields = (c.selectFields as string)?.split(",").map(s => s.trim()).filter(Boolean);

    try {
      let result: unknown;

      switch (operation) {
        case "tracking_sync": {
          // Sync tracking data to ontology objects
          // objectTypeId       -> TrackedPerson (create/update)
          // transitionObjectTypeId -> ZoneTransition (create)
          // zoneObjectTypeId       -> MonitoringZone (update)
          const tracks = structuredData.tracks as Array<Record<string, unknown>> ?? [];
          const registry = structuredData.registry as Record<string, unknown> ?? {};
          const zones = structuredData.zones as Array<Record<string, unknown>> ?? [];
          const transitions = (registry as any)?.recentTransitions as Array<Record<string, unknown>> ?? [];
          const zoneCounts = (registry as any)?.zoneCounts as Record<string, number> ?? {};
          const zoneDwellTimes = (registry as any)?.zoneDwellTimes as Record<string, Record<string, number>> ?? {};

          const results: unknown[] = [];

          // --- TrackedPerson: create/update ---
          for (const track of tracks) {
            if (track.state !== "confirmed") continue;
            const personId = `track-${track.trackId}`;
            try {
              const existing = await ontologies.search(ontologyApiName, objectTypeId, {
                where: { personId: { exactMatch: personId } },
                pageSize: 1,
              });
              const items = (existing as any)?.data ?? [];
              if (items.length > 0) {
                await ontologies.updateObject(ontologyApiName, objectTypeId, personId, {
                  properties: {
                    confidence: track.confidence,
                    speed: track.speed ?? 0,
                    heading: track.heading ?? 0,
                    zoneId: track.zoneId ?? "",
                    dwellTimeSeconds: track.dwellTimeSeconds ?? 0,
                    lastSeenTimestamp: vars.timestamp,
                  },
                });
              } else {
                await ontologies.createObject(ontologyApiName, objectTypeId, {
                  properties: {
                    personId,
                    classLabel: track.classLabel ?? "person",
                    confidence: track.confidence,
                    state: track.state,
                    speed: track.speed ?? 0,
                    heading: track.heading ?? 0,
                    zoneId: track.zoneId ?? "",
                    dwellTimeSeconds: track.dwellTimeSeconds ?? 0,
                    firstSeenTimestamp: vars.timestamp,
                    lastSeenTimestamp: vars.timestamp,
                  },
                });
              }
              results.push({ action: "upsert_person", personId });
            } catch (e) {
              console.warn(`[palantir] tracking_sync person upsert error for ${personId}: ${(e as Error).message}`);
            }
          }

          // --- ZoneTransition: create ---
          for (const transition of transitions.slice(-5)) {
            try {
              const transitionId = `${transition.trackId}-${transition.fromZone}-${transition.toZone}-${Date.now()}`;
              await ontologies.createObject(ontologyApiName, transitionObjectTypeId, {
                properties: {
                  transitionId,
                  personId: `track-${transition.trackId}`,
                  fromZone: transition.fromZone ?? "",
                  toZone: transition.toZone ?? "",
                  predicted: transition.predicted ?? false,
                  timestamp: vars.timestamp,
                  speedAtTransition: transition.speed ?? 0,
                },
              });
              results.push({ action: "transition", transitionId });
            } catch { /* skip */ }
          }

          // --- MonitoringZone: update occupancy ---
          for (const [zoneId, occupancyCount] of Object.entries(zoneCounts)) {
            try {
              await ontologies.updateObject(ontologyApiName, zoneObjectTypeId, zoneId, {
                properties: {
                  occupancyCount,
                  totalEntries: zoneDwellTimes[zoneId] ? Object.keys(zoneDwellTimes[zoneId]).length : 0,
                  lastUpdated: vars.timestamp,
                },
              });
              results.push({ action: "update_zone", zoneId });
            } catch { /* skip */ }
          }

          this.emitEvent(sessionId, "palantir-ontology", {
            operation: "tracking_sync",
            syncedTracks: results.length,
            zoneCounts,
            zoneDwellTimes,
          });
          console.log(`[palantir] tracking_sync: ${results.length} ops session=${sessionId}`);
          break;
        }
        case "search": {
          const whereTemplate = c.whereTemplate as string;
          let where: Record<string, unknown> | undefined;
          if (whereTemplate) {
            try {
              where = JSON.parse(interpolateTemplate(whereTemplate, vars));
            } catch {
              console.warn(`[palantir] Invalid where template JSON for ontology search`);
            }
          }
          result = await ontologies.search(ontologyApiName, objectTypeId, {
            where,
            select: selectFields,
            pageSize: 10,
          });
          break;
        }
        case "get": {
          const pk = objectTypeId || vars.triggerText;
          result = await ontologies.getObject(ontologyApiName, objectTypeId, pk, {
            select: selectFields,
          });
          break;
        }
        case "list": {
          result = await ontologies.listObjects(ontologyApiName, objectTypeId, {
            select: selectFields,
          });
          break;
        }
        case "aggregate": {
          const whereTemplate = c.whereTemplate as string;
          let where: Record<string, unknown> | undefined;
          if (whereTemplate) {
            try {
              where = JSON.parse(interpolateTemplate(whereTemplate, vars));
            } catch { /* ignore parse error */ }
          }
          // Aggregate requires an aggregation spec — default to count
          result = await ontologies.aggregate(ontologyApiName, objectTypeId, {
            aggregation: { type: "count" },
            where,
          });
          break;
        }
        default:
          console.warn(`[palantir] Unknown ontology operation: ${operation}`);
          return;
      }

      this.emitEvent(sessionId, "palantir-ontology", result);
      console.log(`[palantir] Ontology ${operation} completed session=${sessionId}`);
    } catch (err) {
      const msg = err instanceof PalantirApiError ? `${err.errorName}: ${err.message}` : (err as Error).message;
      console.error(`[palantir] Ontology error: ${msg} session=${sessionId}`);
      this.emitEvent(sessionId, "palantir-ontology", { error: msg });
    }
  }

  // --- AIP Agent handler ---

  private async handleAip(
    state: PalantirNodeState,
    sessionId: string,
    triggerText: string,
    vars: Record<string, string>,
    structuredData: Record<string, unknown> = {},
  ): Promise<void> {
    const { aip } = state;
    const c = state.config;
    const agentRid = c.agentRid as string;
    const sessionMode = c.sessionMode as string;

    if (!agentRid) {
      console.warn(`[palantir] AIP node missing agentRid`);
      return;
    }

    try {
      // Lazy-create session on first trigger
      if (!state.aipSessionRid) {
        const session = await aip.createSession(agentRid);
        state.aipSessionRid = session.sessionId;
        console.log(`[palantir] Created AIP session ${session.sessionId} for agent ${agentRid}`);
      }

      const sessionRid = state.aipSessionRid!;

      // Build rich prompt from structured tracking data when available
      let prompt = triggerText;
      const tracks = structuredData.tracks as Array<Record<string, unknown>> | undefined;
      if (tracks && Array.isArray(tracks)) {
        const registry = structuredData.registry as Record<string, unknown> ?? {};
        const zoneCounts = (registry as any)?.zoneCounts as Record<string, number> ?? {};
        const zoneDwellTimes = (registry as any)?.zoneDwellTimes as Record<string, Record<string, number>> ?? {};
        const zoneTraffic = (registry as any)?.zoneTraffic as Record<string, any> ?? {};
        const zoneSpeeds = (registry as any)?.zoneSpeeds as Record<string, any> ?? {};
        const predictedBreaches = structuredData.predictedZoneBreaches as Array<Record<string, unknown>> ?? [];
        const confirmedCount = tracks.filter(t => t.state === "confirmed").length;

        const lines = [
          `[Visual Intelligence Report - ${vars.timestamp}]`,
          `Active tracks: ${tracks.length} (${confirmedCount} confirmed)`,
        ];
        if (Object.keys(zoneCounts).length > 0) {
          lines.push(`Zone occupancy: ${JSON.stringify(zoneCounts)}`);
        }
        if (Object.keys(zoneDwellTimes).length > 0) {
          lines.push(`Dwell times: ${JSON.stringify(zoneDwellTimes)}`);
        }
        if (Object.keys(zoneTraffic).length > 0) {
          lines.push(`Zone traffic: ${JSON.stringify(zoneTraffic)}`);
        }
        if (Object.keys(zoneSpeeds).length > 0) {
          lines.push(`Speed stats: ${JSON.stringify(zoneSpeeds)}`);
        }
        if (predictedBreaches.length > 0) {
          lines.push(`PREDICTED BREACHES: ${JSON.stringify(predictedBreaches.map(b => ({
            trackId: b.trackId,
            fromZone: b.fromZone,
            toZone: b.toZone,
          })))}`);
        }
        prompt = lines.join("\n");
      }

      if (sessionMode === "streaming") {
        // Collect streaming chunks into a single result
        const chunks: string[] = [];
        for await (const chunk of aip.streamingContinue(agentRid, sessionRid, {
          userMessage: prompt,
        })) {
          if (chunk.text) chunks.push(chunk.text);
        }
        const result = chunks.join("");
        this.emitEvent(sessionId, "palantir-aip", { text: result, sessionMode: "streaming" });
      } else {
        // Blocking
        const response = await aip.blockingContinue(agentRid, sessionRid, {
          userMessage: prompt,
        });
        this.emitEvent(sessionId, "palantir-aip", response);
      }
      console.log(`[palantir] AIP ${sessionMode} completed session=${sessionId}`);
    } catch (err) {
      const msg = err instanceof PalantirApiError ? `${err.errorName}: ${err.message}` : (err as Error).message;
      console.error(`[palantir] AIP error: ${msg} session=${sessionId}`);
      // Reset session on error so it's recreated on next trigger
      state.aipSessionRid = null;
      this.emitEvent(sessionId, "palantir-aip", { error: msg });
    }
  }

  // --- Dataset handler ---

  private async handleDataset(
    state: PalantirNodeState,
    sessionId: string,
    triggerText: string,
    vars: Record<string, string>,
    structuredData: Record<string, unknown> = {},
  ): Promise<void> {
    const { datasets } = state;
    const c = state.config;
    const datasetRid = c.datasetRid as string;
    const branchId = (c.branchId as string) || "master";
    const format = (c.format as string) || "json";
    const filePathTemplate = c.filePathTemplate as string;

    if (!datasetRid) {
      console.warn(`[palantir] Dataset node missing datasetRid`);
      return;
    }

    try {
      // Create an UPDATE transaction
      const tx = await datasets.createTransaction(datasetRid, {
        branchId,
        type: "UPDATE",
      });

      // Build file path from template
      const filePath = filePathTemplate
        ? interpolateTemplate(filePathTemplate, vars)
        : `detections/${vars.timestamp}.${format}`;

      // Upload detection data as file content — prefer structured data when available
      const content = JSON.stringify(
        Object.keys(structuredData).length > 0
          ? { structured: structuredData, timestamp: vars.timestamp, sessionId }
          : { trigger: triggerText, timestamp: vars.timestamp, sessionId, nodeType: state.nodeType }
      );

      await datasets.uploadFile(datasetRid, tx.rid, filePath, content);
      await datasets.commitTransaction(datasetRid, tx.rid);

      this.emitEvent(sessionId, "palantir-dataset", {
        datasetRid,
        branchId,
        filePath,
        transactionRid: tx.rid,
        format,
      });
      console.log(`[palantir] Dataset upload completed: ${filePath} session=${sessionId}`);
    } catch (err) {
      const msg = err instanceof PalantirApiError ? `${err.errorName}: ${err.message}` : (err as Error).message;
      console.error(`[palantir] Dataset error: ${msg} session=${sessionId}`);
      this.emitEvent(sessionId, "palantir-dataset", { error: msg });
    }
  }

  // --- LLM handler ---

  private async handleLlm(
    state: PalantirNodeState,
    sessionId: string,
    triggerText: string,
    vars: Record<string, string>,
    structuredData: Record<string, unknown> = {},
  ): Promise<void> {
    const { aip } = state;
    const c = state.config;
    const modelId = (c.modelId as string) || "openai-gpt-4o";
    const provider = (c.provider as string) || "openai";
    const temperature = (c.temperature as number) ?? 0.7;
    const maxTokens = (c.maxTokens as number) ?? 1024;
    const systemPrompt = c.systemPrompt as string;

    try {
      const messages: Array<{ role: string; content: string }> = [];
      if (systemPrompt) {
        messages.push({ role: "system", content: systemPrompt });
      }
      messages.push({ role: "user", content: triggerText });

      const params = {
        model: modelId,
        messages,
        temperature,
        max_tokens: maxTokens,
      };

      let result: unknown;
      switch (provider) {
        case "anthropic":
          result = await aip.anthropicChatCompletion(params as Record<string, unknown>);
          break;
        case "xai":
          result = await aip.xaiChatCompletion(params as any);
          break;
        case "google":
          result = await aip.googleChatCompletion(params as Record<string, unknown>);
          break;
        case "openai":
        default:
          result = await aip.openaiChatCompletion(params as any);
          break;
      }

      this.emitEvent(sessionId, "palantir-llm", { provider, modelId, result });
      console.log(`[palantir] LLM ${provider}/${modelId} completed session=${sessionId}`);
    } catch (err) {
      const msg = err instanceof PalantirApiError ? `${err.errorName}: ${err.message}` : (err as Error).message;
      console.error(`[palantir] LLM error: ${msg} session=${sessionId}`);
      this.emitEvent(sessionId, "palantir-llm", { error: msg });
    }
  }

  // --- Action handler ---

  private async handleAction(
    state: PalantirNodeState,
    sessionId: string,
    triggerText: string,
    vars: Record<string, string>,
    structuredData: Record<string, unknown> = {},
  ): Promise<void> {
    const { ontologies } = state;
    const c = state.config;
    const ontologyApiName = c.ontologyApiName as string;
    const actionTypeId = c.actionTypeId as string;
    const executeMode = c.executeMode as string;

    if (!ontologyApiName || !actionTypeId) {
      console.warn(`[palantir] Action node missing ontologyApiName or actionTypeId`);
      return;
    }

    try {
      // Parse parameter templates with interpolation
      const paramTemplateStr = (c.parameterTemplates as string) || "{}";
      let parameters: Record<string, unknown>;
      try {
        parameters = JSON.parse(interpolateTemplate(paramTemplateStr, vars));
      } catch {
        parameters = { triggerText: vars.triggerText };
      }

      const actionParams = { parameters };

      if (executeMode === "validate") {
        const validation = await ontologies.validateAction(ontologyApiName, actionTypeId, actionParams);
        this.emitEvent(sessionId, "palantir-action", { validation, mode: "validate" });
      } else {
        const response = await ontologies.applyAction(ontologyApiName, actionTypeId, actionParams);
        this.emitEvent(sessionId, "palantir-action", { response, mode: "execute" });
      }

      console.log(`[palantir] Action ${executeMode} completed session=${sessionId}`);
    } catch (err) {
      const msg = err instanceof PalantirApiError ? `${err.errorName}: ${err.message}` : (err as Error).message;
      console.error(`[palantir] Action error: ${msg} session=${sessionId}`);
      this.emitEvent(sessionId, "palantir-action", { error: msg });
    }
  }
}
