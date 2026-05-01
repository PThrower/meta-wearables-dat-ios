/**
 * Workflow activation handler — extracted from server.ts.
 *
 * Handles POST /workflows/{id}/activate — the main dispatch endpoint
 * that resolves a workflow graph into pipeline apps, sends categorized
 * config messages to iOS, and activates AI/JEPA nodes.
 */

import type { AppDefinition, WorkflowSettings, WorkflowNodeType, FlowExecutionConfig } from "./app-types.js";
import { NODE_DEF_MAP, resolveNodeType, buildAllowedEdgeMap, validateStructure } from "./node-definitions.js";
import { resolveWorkflowToPipeline, resolveSourceInput, AppRegistry } from "./app-registry.js";
import { detectFlows } from "./flow-detection.js";
import { buildMobileWorkflowConfig, pushPassiveTTSChains } from "./workflow-utils.js";
import { GuidanceOrchestrator } from "./guidance-orchestrator.js";
import { JEPAOrchestrator } from "./jepa-orchestrator.js";
import { ReIDOrchestrator } from "./reid-orchestrator.js";
import { SessionRegistry } from "./session-registry.js";
import * as q from "./db/queries.js";
import { dbWriter } from "./db/db-writer.js";
import { isApnsConfigured, sendSilentWake, sendVisibleWake } from "./apns.js";
import { H264ToJpegDecoder } from "./h264-decoder.js";

/** Validate workflow edges — returns error string or null */
export function validateEdges(
  nodes: Array<{ id: string; type: string }>,
  edges: Array<{ sourceNodeId: string; targetNodeId: string }>,
): string | null {
  const ALLOWED_EDGE_MAP = buildAllowedEdgeMap();
  const nodeMap = new Map(nodes.map(n => [n.id, n.type]));
  const nodeIds = new Set(nodes.map(n => n.id));

  for (const e of edges) {
    if (!nodeIds.has(e.sourceNodeId) || !nodeIds.has(e.targetNodeId)) {
      return "Edge references unknown node";
    }
    const srcType = resolveNodeType(nodeMap.get(e.sourceNodeId)!);
    const tgtType = resolveNodeType(nodeMap.get(e.targetNodeId)!);
    if (!ALLOWED_EDGE_MAP.get(srcType)?.has(tgtType)) {
      return `Invalid edge: ${srcType} -> ${tgtType}`;
    }
  }
  return null;
}

export interface ActivationDeps {
  orchestrator: GuidanceOrchestrator;
  jepaOrchestrator: JEPAOrchestrator;
  reidOrchestrator: ReIDOrchestrator;
  appRegistry: AppRegistry;
  registry: SessionRegistry;
  pendingWakeActivations: Map<string, { workflowId: string; requestedAt: number }>;
  getH264Decoder: (sessionId: string) => H264ToJpegDecoder;
  sendCachedFrameToAI: (sessionId: string, frame: Uint8Array) => void;
}

export async function handleWorkflowActivation(
  deps: ActivationDeps,
  wfId: string,
  body: { sessionId?: string; deviceId?: string; override?: boolean; reason?: string; wakeActivation?: boolean },
): Promise<Response> {
  const { orchestrator, jepaOrchestrator, reidOrchestrator, appRegistry, registry, pendingWakeActivations, getH264Decoder, sendCachedFrameToAI } = deps;

  const wf = q.getWorkflow(wfId);
  if (!wf) return Response.json({ error: "Workflow not found" }, { status: 404 });

  // Device-first activation: wake device, store pending, return immediately
  if (!body.sessionId && body.deviceId) {
    const wakeSettings = wf.settings ? JSON.parse(wf.settings) as WorkflowSettings : null;
    if (!wakeSettings?.wakeOnActivate) {
      return Response.json({ error: "wakeOnActivate not enabled in workflow settings" }, { status: 400 });
    }
    const deviceToken = q.getDeviceToken(body.deviceId);
    if (!deviceToken) {
      return Response.json({ error: "Device has no APNs token — cannot wake" }, { status: 400 });
    }
    pendingWakeActivations.set(body.deviceId, { workflowId: wfId, requestedAt: Date.now() });
    sendVisibleWake(deviceToken, `wake_${wfId}`, wf.name).then(r => {
      if (r.success) {
        console.log(`[wake] Visible push delivered for workflow ${wfId} to device ${body.deviceId!.slice(0, 8)}...`);
        sendSilentWake(deviceToken, `wake_${wfId}`).catch(() => {});
      } else {
        console.warn(`[wake] Visible push failed: ${r.reason} — trying silent as fallback`);
        sendSilentWake(deviceToken, `wake_${wfId}`).catch(() => {});
      }
    }).catch(() => {
      sendSilentWake(deviceToken, `wake_${wfId}`).catch(() => {});
    });
    console.log(`[wake] Pending activation stored: device=${body.deviceId.slice(0, 8)}... workflow=${wfId}`);
    return Response.json({ status: "wake_sent", deviceId: body.deviceId });
  }

  if (!body.sessionId) return Response.json({ error: "sessionId or deviceId required" }, { status: 400 });

  const nodes = q.getWorkflowNodes(wfId).map(n => ({
    ...n, config: JSON.parse(n.config),
  }));
  const edges = q.getWorkflowEdges(wfId);

  // Validate chain
  const structErr = validateStructure(nodes);
  if (structErr) return Response.json({ error: structErr }, { status: 400 });
  const edgeErr = validateEdges(nodes, edges);
  if (edgeErr) return Response.json({ error: edgeErr }, { status: 400 });

  // --- Activation Guard: check for conflicts ---
  const conflict = orchestrator.checkConflict(body.sessionId);
  if (conflict.hasConflict && !body.override) {
    return Response.json({
      error: "Session has active AI",
      conflict: {
        activeAppId: conflict.appId,
        status: conflict.status,
        activatedAt: conflict.activatedAt,
      },
    }, { status: 409 });
  }

  // If overriding, mark the previous activation as overridden in the audit log
  if (conflict.hasConflict && body.override) {
    const prevActivation = q.getActiveActivation(body.sessionId);
    if (prevActivation) {
      dbWriter.enqueue(q.overrideActivation(prevActivation.id, "override"));
    }
    orchestrator.forceDeactivate(body.sessionId);
  }

  const pipelineApps = resolveWorkflowToPipeline(nodes as any, edges as any, { id: wfId, name: wf.name }, wf.flowConfig ? JSON.parse(wf.flowConfig) : null, wf.settings ? JSON.parse(wf.settings) : null);
  const primaryApp = pipelineApps[0];  // undefined for passive pipelines (no AI processor)
  for (const app of pipelineApps) {
    appRegistry.registerTransientApp(app);
  }

  const parsedSettings: WorkflowSettings | null = wf.settings ? JSON.parse(wf.settings) : null;

  const session = registry.get(body.sessionId);
  if (!session) {
    return Response.json({ error: "Session not found or not active" }, { status: 404 });
  }

  // Parse flow config for sequential mode handling
  const flowConfig: FlowExecutionConfig | null = wf.flowConfig ? JSON.parse(wf.flowConfig) : null;
  const flows = detectFlows(nodes as any, edges as any);

  // For sequential mode: only activate first flow's apps, register remaining as pending
  let appsToActivate = pipelineApps;
  if (flowConfig?.mode === "sequential" && flows.length > 1) {
    const firstFlowId = flowConfig.flowOrder[0] ?? flows[0]?.flowId;
    const firstFlow = flows.find(f => f.flowId === firstFlowId) ?? flows[0];
    const firstFlowNodeIds = new Set(firstFlow.nodeIds);

    appsToActivate = pipelineApps.filter(app => {
      const flowId = (app.config as any).flowId as string | undefined;
      return flowId === firstFlowId || (firstFlowNodeIds.size > 0 && !flowId);
    });

    // Build remaining flow schedule for sequential activation
    const remainingFlows = flowConfig.flowOrder
      .filter(fid => fid !== firstFlowId)
      .map(fid => {
        const flow = flows.find(f => f.flowId === fid);
        if (!flow) return null;
        return {
          flowId: flow.flowId,
          apps: pipelineApps.filter(app => (app.config as any).flowId === flow.flowId),
        };
      })
      .filter((f): f is { flowId: string; apps: AppDefinition[] } => f !== null);

    orchestrator.registerPendingFlows(
      body.sessionId,
      wfId,
      [{ flowId: firstFlowId, apps: appsToActivate }, ...remainingFlows],
      flowConfig,
    );
  }

  // For event-driven mode: separate immediate (no trigger) and pending (has trigger) flows
  if (flowConfig?.mode === "event-driven" && flows.length > 1) {
    const triggers = flowConfig.flowTriggers ?? {};
    const triggeredFlowMap = new Map<string, AppDefinition[]>();
    const immediateFlows: Array<{ flowId: string; apps: AppDefinition[] }> = [];

    for (const fid of flowConfig.flowOrder) {
      const flowApps = pipelineApps.filter(app => (app.config as Record<string, unknown>).flowId === fid);
      const trigger = triggers[fid];
      if (!trigger) {
        immediateFlows.push({ flowId: fid, apps: flowApps });
      } else {
        if (flowApps.length > 0) {
          triggeredFlowMap.set(fid, flowApps);
        }
      }
    }

    appsToActivate = immediateFlows.flatMap(f => f.apps);

    orchestrator.registerEventDrivenFlows(
      body.sessionId,
      wfId,
      immediateFlows,
      triggeredFlowMap,
      triggers,
    );
  }

  // Passive pipelines (no processable nodes) — configure session but skip AI activation
  if (!primaryApp) {
    session.activeAppId = null;
    session.appPipeline = null;

    // Request codec change if specified
    const inputCodec = (nodes as any[]).find((n: any) => n.type === "camera-source")?.config?.codec as string | undefined;
    if (inputCodec && ["jpeg", "h264"].includes(inputCodec) && session.publisher?.ws?.readyState === WebSocket.OPEN) {
      session.publisher.ws.send(JSON.stringify({ type: "set_codec", codec: inputCodec }));
    }

    // Audit log
    const activationId = `act_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    dbWriter.enqueue(q.insertActivation({
      id: activationId,
      sessionId: body.sessionId,
      workflowId: wfId,
      appId: "passive",
      activatedBy: session.activeAppId ?? "api",
      overrodeAppId: conflict.hasConflict ? conflict.appId ?? undefined : undefined,
      reason: body.reason ?? (conflict.hasConflict ? "Override" : "Activate"),
    }));
    dbWriter.flushNow();

    // Send workflow config to mobile for sink/transform setup
    const mobileConfig = buildMobileWorkflowConfig(nodes as any, edges as any);
    if (mobileConfig && session.publisher?.ws?.readyState === WebSocket.OPEN) {
      session.publisher.ws.send(JSON.stringify({ type: "workflow_config", config: mobileConfig }));
    }

    // For passive workflows with text→local-tts→speaker chains, push text as guidance_text
    if (session.publisher?.ws) {
      pushPassiveTTSChains(nodes as any, edges as any, session.publisher.ws, body.sessionId, flowConfig);
    }

    return Response.json({ appId: null, status: "passive", apps: [] });
  }

  session.activeAppId = primaryApp.id;
  session.appPipeline = { appId: primaryApp.id, primitiveId: primaryApp.binding };

  // Request codec change from publisher if workflow specifies one
  const inputCodec = (nodes as any[]).find((n: any) => n.type === "camera-source")?.config?.codec as string | undefined;
  if (inputCodec && ["jpeg", "h264"].includes(inputCodec) && session.publisher?.ws?.readyState === WebSocket.OPEN) {
    session.publisher.ws.send(JSON.stringify({ type: "set_codec", codec: inputCodec }));
    console.log(`[relay] Codec change from workflow: codec=${inputCodec} session=${body.sessionId}`);
    // Start H.264 decoder if needed
    if (inputCodec === "h264") getH264Decoder(body.sessionId).start();
  }

  // Audit log: record activation for the primary app
  const activationId = `act_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  dbWriter.enqueue(q.insertActivation({
    id: activationId,
    sessionId: body.sessionId,
    workflowId: wfId,
    appId: primaryApp.id,
    activatedBy: session.activeAppId ?? "api",
    overrodeAppId: conflict.hasConflict ? conflict.appId ?? undefined : undefined,
    reason: body.reason ?? (conflict.hasConflict ? "Override" : "Activate"),
  }));

  // Activate all apps in the pipeline, routing by activationMode
  const activatedAppIds: string[] = [];
  const processableNodes = (nodes as any[]).filter((n: any) => {
    const d = NODE_DEF_MAP.get(n.type);
    return d && d.activationMode !== null;
  });

  // Build app-id → raw-node lookup so sequential/event-driven filtering
  // of appsToActivate doesn't break the processableNodes index mapping.
  // pipelineApps[i] maps 1:1 to processableNodes[i] (same source, same filter).
  const rawNodeByAppId = new Map<string, any>();
  for (let i = 0; i < pipelineApps.length && i < processableNodes.length; i++) {
    rawNodeByAppId.set(pipelineApps[i].id, processableNodes[i]);
  }

  // Register workflow instance for execution controls
  session.activeWorkflowId = wfId;
  // Persist to DB so it survives server restarts
  dbWriter.enqueue(q.updateSession(body.sessionId!, { activeWorkflowId: wfId }));

  // Max session duration enforcement
  const maxDur = parsedSettings?.maxSessionDuration;
  if (maxDur && maxDur > 0) {
    setTimeout(() => {
      const sid = body.sessionId;
      if (!sid) return;
      orchestrator.handleWorkflowControl(sid, "stop_workflow", wfId, undefined, "system").catch(() => {});
      console.log(`[relay] Auto-deactivated (max session duration ${maxDur}min) session=${sid}`);
    }, maxDur * 60 * 1000);
  }

  // Device wake: send APNs push to trigger device to open app / start session
  if (parsedSettings?.wakeOnActivate && isApnsConfigured()) {
    const targetDeviceId = parsedSettings.targetDeviceId || session.metadata?.deviceId;
    if (targetDeviceId) {
      const deviceToken = q.getDeviceToken(targetDeviceId);
      if (deviceToken) {
        console.log(`[wake] Sending wake push to device ${targetDeviceId.slice(0, 8)}... on activate`);
        sendSilentWake(deviceToken, body.sessionId).then(r => {
          if (!r.success) console.warn(`[wake] Silent push failed: ${r.reason}`);
          else console.log(`[wake] Silent push delivered to ${targetDeviceId.slice(0, 8)}...`);
        }).catch(() => {});
      } else {
        console.warn(`[wake] No APNs token for target device ${targetDeviceId.slice(0, 8)}...`);
      }
    }
  }

  // Auto-start stream: if publisher is connected, send start_stream immediately
  // Triggered by autoStartStream setting OR wakeActivation (device was woken via APNs)
  if ((parsedSettings?.autoStartStream || body.wakeActivation) && session.publisher?.ws && session.publisher.ws.readyState === 1) {
    console.log(`[activate] Auto-starting stream for session ${body.sessionId} (wakeActivation=${!!body.wakeActivation})`);
    session.publisher.ws.send(JSON.stringify({ type: "start_stream" }));
  }

  const nodeEntries = (nodes as any[]).map((n: any) => ({
    nodeId: n.id,
    appId: n.id,
    nodeType: n.type as WorkflowNodeType,
    label: n.label || n.type,
    triggerChained: false,
  }));
  if ((nodes as any[]).length > 1) {
    orchestrator.activateWorkflow(body.sessionId, wfId, wf.name, nodeEntries);
  }
  // --- Parallel activation dispatch ---
  // Categorize processable nodes by dispatch type.
  // Independent nodes activate concurrently; dependsOn handles ordering
  // internally via the deferred activation mechanism in GuidanceOrchestrator.
  const sid = body.sessionId; // Guaranteed non-null by guard above
  const enhanceIdx: number[] = [];
  const visionIdx: number[] = [];
  const sensorIdx: number[] = [];
  const speechIdx: number[] = [];
  const trackingIdx: number[] = [];
  const measureIdx: number[] = [];
  const jepaIdx: number[] = [];
  const aiIdx: number[] = [];

  for (let i = 0; i < appsToActivate.length; i++) {
    const rawNode = rawNodeByAppId.get(appsToActivate[i].id);
    const pDef = rawNode ? NODE_DEF_MAP.get(rawNode.type) : null;
    if (pDef?.activationMode === "enhance")   { enhanceIdx.push(i);  continue; }
    if (pDef?.activationMode === "vision")    { visionIdx.push(i);   continue; }
    if (pDef?.activationMode === "sensor")    { sensorIdx.push(i);   continue; }
    if (pDef?.activationMode === "speech")    { speechIdx.push(i);   continue; }
    if (pDef?.activationMode === "tracking")  { trackingIdx.push(i); continue; }
    if (pDef?.activationMode === "measure")   { measureIdx.push(i);  continue; }
    if (pDef?.activationMode === "jepa")      { jepaIdx.push(i);     continue; }
    aiIdx.push(i);
  }

  // 1. Fire-and-forget: send all vision configs to iOS immediately
  // IMPORTANT: send ONE combined config with ALL detection types.
  // Sending per-node configs causes each to unregister the previous VisionStage,
  // so only the last node's detection type survives. Aggregate all types instead.
  // Check if a vision-thumbnails node exists in the workflow
  const thumbnailIdx = processableNodes.findIndex(n => n.type === "vision-thumbnails");
  const thumbnailConfig = thumbnailIdx >= 0
    ? (processableNodes[thumbnailIdx].config as any)
    : null;

  // Determine which detection types get thumbnails — only types upstream of the thumbnail node
  const activationThumbDetTypes: string[] = [];
  if (thumbnailIdx >= 0 && edges && edges.length > 0) {
    const thumbNodeId = processableNodes[thumbnailIdx].id;
    for (const edge of edges as Array<{ sourceNodeId: string; targetNodeId: string }>) {
      if (edge.targetNodeId === thumbNodeId) {
        const srcIdx = processableNodes.findIndex(n => n.id === edge.sourceNodeId);
        if (srcIdx >= 0) {
          const srcDef = NODE_DEF_MAP.get(processableNodes[srcIdx].type);
          if (srcDef?.activationMode === "vision") {
            activationThumbDetTypes.push(processableNodes[srcIdx].type);
          }
        }
      }
    }
  }

  if (visionIdx.length > 0) {
    const allDetectionTypes: string[] = [];
    let bestConfidence = 0.5;
    let bestSmoothing = 0.3;
    let bestFPS = 5;
    let bestMaxResults = 0;
    let bestLanguage = "en-US";
    let bestMaxLabels = 5;
    const allSymbologies: Record<string, boolean> = {};

    for (const i of visionIdx) {
      const rawNode = rawNodeByAppId.get(appsToActivate[i].id);
      if (!rawNode) continue;
      allDetectionTypes.push(rawNode.type);
      activatedAppIds.push(appsToActivate[i].id);

      const nc = rawNode.config as any;
      // Use the most restrictive confidence and smoothing across all nodes
      if (nc?.confidence != null) bestConfidence = Math.min(bestConfidence, nc.confidence);
      if (nc?.smoothingAlpha != null) bestSmoothing = Math.min(bestSmoothing, nc.smoothingAlpha);
      if (nc?.targetFPS != null) bestFPS = Math.max(bestFPS, nc.targetFPS);
      const maxR = nc?.maxFaces ?? nc?.maxPersons ?? nc?.maxPoses ?? 0;
      if (maxR > 0) bestMaxResults = Math.max(bestMaxResults, maxR);
      if (nc?.language) bestLanguage = nc.language;
      if (nc?.maxLabels) bestMaxLabels = Math.max(bestMaxLabels, nc.maxLabels);
      // Merge symbologies from barcode nodes
      if (nc?.symbologies) Object.assign(allSymbologies, nc.symbologies);
    }

    // Fallback symbologies if no barcode node specified any
    if (Object.keys(allSymbologies).length === 0 && allDetectionTypes.includes("vision-barcode-scan")) {
      Object.assign(allSymbologies, { qr: true });
    }

    const visionConfig = {
      type: "vision_stage_config" as const,
      nodeType: allDetectionTypes[0], // primary type for logging
      detectionTypes: allDetectionTypes,
      confidence: bestConfidence,
      smoothingAlpha: bestSmoothing,
      targetFPS: bestFPS,
      maxResults: bestMaxResults,
      language: bestLanguage,
      symbologies: Object.entries(allSymbologies).filter(([, v]) => v).map(([k]) => k),
      maxLabels: bestMaxLabels,
      thumbnailsEnabled: !!thumbnailConfig,
      thumbnailDetectionTypes: activationThumbDetTypes.length > 0 ? activationThumbDetTypes : (thumbnailConfig ? allDetectionTypes : []),
      thumbnailSize: thumbnailConfig?.thumbnailSize ?? 64,
      thumbnailMaxCount: thumbnailConfig?.maxCount ?? 4,
      thumbnailQuality: thumbnailConfig?.quality ?? 0.6,
    };
    if (session.publisher?.ws?.readyState === WebSocket.OPEN) {
      session.publisher.ws.send(JSON.stringify(visionConfig));
    }
    console.log(`[relay] Sent combined vision config: types=${allDetectionTypes.join(",")} session=${sid}`);
  }

  // 2. Activate all AI nodes in parallel (dependsOn defers internally)
  if (aiIdx.length > 0) {
    console.log(`[relay] Activating ${aiIdx.length} AI node(s) in parallel session=${sid}`);
    const aiResults = await Promise.allSettled(
      aiIdx.map(i => orchestrator.activateWithConfig(sid, appsToActivate[i]))
    );
    for (let r = 0; r < aiResults.length; r++) {
      if (aiResults[r].status === "fulfilled") {
        activatedAppIds.push(appsToActivate[aiIdx[r]].id);
      } else {
        console.error(`[relay] AI activation failed: ${appsToActivate[aiIdx[r]].id}`, (aiResults[r] as PromiseRejectedResult).reason);
      }
    }
  }

  // 3. Activate all JEPA nodes in parallel
  if (jepaIdx.length > 0) {
    console.log(`[relay] Activating ${jepaIdx.length} JEPA node(s) in parallel session=${sid}`);
    const jepaResults = await Promise.allSettled(
      jepaIdx.map(i => {
        const app = appsToActivate[i];
        const jc = app.config.jepa as any;
        activatedAppIds.push(app.id);
        return jepaOrchestrator.activate(sid, {
          provider: jc.provider,
          model: jc.model ?? app.config.model,
          gpu: jc.gpu,
          clipLength: jc.clipLength,
          sampleFps: jc.sampleFps,
          resolution: jc.resolution,
          tasks: jc.tasks,
          sessionId: sid,
        });
      })
    );
  }

  // 4. Collect all enhance nodes and send one combined config to iOS
  // IMPORTANT: use rawNode.config (raw node config with brightness/contrast/saturation)
  // NOT appsToActivate[i].config (resolved AppConfig with model/voice/input/output)
  if (enhanceIdx.length > 0) {
    const enhanceFilters: Array<{ type: string; params: Record<string, number> }> = [];
    for (const i of enhanceIdx) {
      const rawNode = rawNodeByAppId.get(appsToActivate[i].id);
      if (!rawNode) continue;
      enhanceFilters.push({
        type: rawNode.type,
        params: (rawNode.config ?? {}) as Record<string, number>,
      });
      activatedAppIds.push(appsToActivate[i].id);
    }
    if (session.publisher?.ws?.readyState === WebSocket.OPEN) {
      session.publisher.ws.send(JSON.stringify({
        type: "enhance_stage_config",
        filters: enhanceFilters,
        enabled: true,
      }));
      console.log(`[relay] Sent enhance config with ${enhanceFilters.length} filters session=${sid}`);
    }
  }

  // 5. Collect all sensor nodes and send one combined config to iOS
  if (sensorIdx.length > 0) {
    const sensorConfigs: Array<{ sensorType: string; config: Record<string, unknown> }> = [];
    for (const i of sensorIdx) {
      const rawNode = rawNodeByAppId.get(appsToActivate[i].id);
      if (!rawNode) continue;
      const rawConfig = { ...(rawNode.config ?? {}) as Record<string, unknown> };

      // Parse targetLabels from comma-separated string to array for sound classifier
      if (rawNode.type === "sensor-sound" && typeof rawConfig.targetLabels === "string") {
        const parsed = (rawConfig.targetLabels as string).split(",").map(s => s.trim()).filter(s => s.length > 0);
        rawConfig.targetLabels = parsed.length > 0 ? parsed : undefined;
      }

      // Resolve upstream audio source from workflow edges for sensor-sound
      if (rawNode.type === "sensor-sound") {
        const inputCfg = resolveSourceInput(rawNode.id, nodes as any, edges as any);
        if (inputCfg.glassesMic && !inputCfg.phoneMic) {
          rawConfig.audioSource = "glasses";
        } else {
          rawConfig.audioSource = "phone";
        }
      }

      // Normalize location variants to "sensor-location" + inject mode from type
      const effectiveType = rawNode.type.startsWith("sensor-location")
        ? "sensor-location"
        : rawNode.type;
      const modeOverride = rawNode.type.startsWith("sensor-location-")
        ? rawNode.type.replace("sensor-location-", "")
        : rawNode.type === "sensor-location" ? "continuous" : undefined;
      if (modeOverride) rawConfig.mode = modeOverride;

      sensorConfigs.push({
        sensorType: effectiveType,
        config: rawConfig,
      });
      activatedAppIds.push(appsToActivate[i].id);
    }
    if (session.publisher?.ws?.readyState === WebSocket.OPEN) {
      session.publisher.ws.send(JSON.stringify({
        type: "sensor_stage_config",
        sensors: sensorConfigs,
        enabled: true,
      }));
      console.log(`[relay] Sent sensor config with ${sensorConfigs.length} sensors session=${sid}`);
    }
  }

  // 6. Collect all speech nodes (mobile-stt, vad) and send one combined config to iOS
  if (speechIdx.length > 0) {
    const speechConfigs: Array<{ speechType: string; config: Record<string, unknown> }> = [];
    for (const i of speechIdx) {
      const rawNode = rawNodeByAppId.get(appsToActivate[i].id);
      if (!rawNode) continue;
      const rawConfig = { ...(rawNode.config ?? {}) as Record<string, unknown> };
      speechConfigs.push({
        speechType: rawNode.type,
        config: rawConfig,
      });
      activatedAppIds.push(appsToActivate[i].id);
    }
    if (session.publisher?.ws?.readyState === WebSocket.OPEN) {
      session.publisher.ws.send(JSON.stringify({
        type: "speech_stage_config",
        stages: speechConfigs,
        enabled: true,
      }));
      console.log(`[relay] Sent speech config with ${speechConfigs.length} stages session=${sid}`);
    }
  }

  // 7. Fire-and-forget: send tracking config to iOS
  // Ref: arXiv:2203.14360 Sec 4.2 — OCM parameters
  if (trackingIdx.length > 0) {
    // Collect gate/cost nodes from raw nodes (activationMode=null, role="gating")
    const gateNodes = (nodes as any[]).filter((n: any) =>
      n.type && typeof n.type === "string" && (n.type.startsWith("gate-") || n.type.startsWith("cost-"))
    );
    const gateNodeMap = new Map<string, any>();
    for (const gn of gateNodes) { gateNodeMap.set(gn.id, gn); }

    for (const i of trackingIdx) {
      const rawNode = rawNodeByAppId.get(appsToActivate[i].id);
      if (!rawNode) continue;
      const rawConfig = (rawNode.config ?? {}) as Record<string, unknown>;

      // Build ordered gate chain from edges pointing to this tracker
      const trackerNodeId = rawNode.id;
      const gates: Array<{ gateType: string; params: Record<string, number> }> = [];
      if (edges && (edges as any[]).length > 0) {
        const typedEdges = edges as Array<{ sourceNodeId: string; targetNodeId: string }>;
        const visited = new Set<string>();
        const queue: string[] = [trackerNodeId];
        while (queue.length > 0) {
          const targetId = queue.shift()!;
          if (visited.has(targetId)) continue;
          visited.add(targetId);
          for (const edge of typedEdges) {
            if (edge.targetNodeId === targetId && gateNodeMap.has(edge.sourceNodeId)) {
              const srcNode = gateNodeMap.get(edge.sourceNodeId)!;
              const gateDef = NODE_DEF_MAP.get(srcNode.type);
              if (gateDef && gateDef.role === "gating") {
                const gateConfig = (srcNode.config ?? {}) as Record<string, number>;
                gates.push({ gateType: srcNode.type, params: gateConfig });
                queue.push(edge.sourceNodeId);
              }
            }
          }
        }
        gates.reverse();
      }

      // Separate cost function from gate chain
      let costFunction: string | null = null;
      const pureGates = gates.filter(g => {
        if (g.gateType.startsWith("cost-")) {
          costFunction = g.gateType;
          return false;
        }
        return true;
      });

      const trackingConfig = {
        type: "tracking_stage_config" as const,
        enabled: true,
        targetClasses: typeof rawConfig.targetClasses === "string" && rawConfig.targetClasses.length > 0
          ? (rawConfig.targetClasses as string).split(",").map(s => s.trim()).filter(s => s.length > 0)
          : [],
        confidence: (rawConfig.confidence as number) ?? 0.5,
        iouThreshold: (rawConfig.iouThreshold as number) ?? 0.3,
        maxTracks: (rawConfig.maxTracks as number) ?? 0,
        maxAge: (rawConfig.maxAge as number) ?? 30,
        minHits: (rawConfig.minHits as number) ?? 3,
        targetFPS: (rawConfig.targetFPS as number) ?? 10,
        smoothingAlpha: (rawConfig.smoothingAlpha as number) ?? 0.3,
        zones: (rawConfig.zones as Array<Record<string, unknown>>) ?? [],
        deltaT: (rawConfig.deltaT as number) ?? 3,
        inertia: (rawConfig.inertia as number) ?? 0.2,
        detThresh: (rawConfig.detThresh as number) ?? 0.5,
        useByte: (rawConfig.useByte as boolean) ?? false,
        gates: pureGates,
        costFunction,
      };
      if (session.publisher?.ws?.readyState === WebSocket.OPEN) {
        session.publisher.ws.send(JSON.stringify(trackingConfig));
      }
      // ReID activation locked until provider is implemented.
      // Gate still passes through on-device (no embedding = accept all pairs).
      // When a provider exists, uncomment the block below:
      //
      // if (pureGates.some(g => g.gateType === "gate-reid")) {
      //   const reidConfig = (pureGates.find(g => g.gateType === "gate-reid")?.params ?? {}) as Record<string, unknown>;
      //   await reidOrchestrator.activate(sid, {
      //     provider: "modal",
      //     model: (reidConfig.model as string) ?? "osnet-x05",
      //     gpu: "A10G",
      //     sessionId: sid,
      //   }, session.publisher?.ws ?? null);
      // }
      activatedAppIds.push(appsToActivate[i].id);
    }
    console.log(`[relay] Sent tracking config for ${trackingIdx.length} nodes session=${sid}`);
  }

  // 8. Fire-and-forget: send tool measure config to iOS
  // Uses homography + reference object to measure fastener dimensions in mm.
  if (measureIdx.length > 0) {
    for (const i of measureIdx) {
      const rawNode = rawNodeByAppId.get(appsToActivate[i].id);
      if (!rawNode) continue;
      const rawConfig = (rawNode.config ?? {}) as Record<string, unknown>;
      const measureConfig = {
        type: "measure_stage_config" as const,
        enabled: true,
        referenceObject: (rawConfig.referenceObject as string) ?? "auto",
        maxMeasurementError: (rawConfig.maxMeasurementError as number) ?? 2.0,
        targetFPS: (rawConfig.targetFPS as number) ?? 1,
        smoothingAlpha: (rawConfig.smoothingAlpha as number) ?? 0.5,
        confidence: (rawConfig.confidence as number) ?? 0.6,
      };
      if (session.publisher?.ws?.readyState === WebSocket.OPEN) {
        session.publisher.ws.send(JSON.stringify(measureConfig));
      }
      activatedAppIds.push(appsToActivate[i].id);
    }
    console.log(`[relay] Sent measure config for ${measureIdx.length} nodes session=${sid}`);
  }

  const cachedFrame = registry.getLastFrame(body.sessionId);
  if (cachedFrame) sendCachedFrameToAI(body.sessionId, cachedFrame);

  dbWriter.flushNow();

  // Check actual activation status from orchestrator
  const aiStatus = orchestrator.getStatus(body.sessionId);
  const finalStatus = aiStatus.status === "error" ? "error" : "active";
  return Response.json({ appId: primaryApp.id, status: finalStatus, apps: activatedAppIds });
}
