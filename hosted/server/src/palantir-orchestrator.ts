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
    const nodes = this.sessionNodes.get(sessionId);
    if (!nodes || nodes.size === 0) return;

    const vars: Record<string, string> = {
      triggerText: sanitizeInput(triggerText),
      timestamp: new Date().toISOString(),
    };

    const results = await Promise.allSettled(
      Array.from(nodes.values()).map(state => this.handleNode(state, sessionId, triggerText, vars))
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

    await this.handleNode(state, sessionId, triggerText, vars);
  }

  // --- Private handlers ---

  private async handleNode(
    state: PalantirNodeState,
    sessionId: string,
    triggerText: string,
    vars: Record<string, string>,
  ): Promise<void> {
    switch (state.nodeType) {
      case "palantir-ontology": return this.handleOntology(state, sessionId, triggerText, vars);
      case "palantir-aip":      return this.handleAip(state, sessionId, triggerText, vars);
      case "palantir-dataset":  return this.handleDataset(state, sessionId, triggerText, vars);
      case "palantir-llm":      return this.handleLlm(state, sessionId, triggerText, vars);
      case "palantir-action":   return this.handleAction(state, sessionId, triggerText, vars);
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
  ): Promise<void> {
    const { ontologies } = state;
    const c = state.config;
    const ontologyApiName = c.ontologyApiName as string;
    const objectTypeId = c.objectTypeId as string;
    const operation = c.operation as string;
    const selectFields = (c.selectFields as string)?.split(",").map(s => s.trim()).filter(Boolean);

    try {
      let result: unknown;

      switch (operation) {
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

      if (sessionMode === "streaming") {
        // Collect streaming chunks into a single result
        const chunks: string[] = [];
        for await (const chunk of aip.streamingContinue(agentRid, sessionRid, {
          userMessage: triggerText,
        })) {
          if (chunk.text) chunks.push(chunk.text);
        }
        const result = chunks.join("");
        this.emitEvent(sessionId, "palantir-aip", { text: result, sessionMode: "streaming" });
      } else {
        // Blocking
        const response = await aip.blockingContinue(agentRid, sessionRid, {
          userMessage: triggerText,
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

      // Upload detection data as file content
      const content = JSON.stringify({
        trigger: triggerText,
        timestamp: vars.timestamp,
        sessionId,
        nodeType: state.nodeType,
      });

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
