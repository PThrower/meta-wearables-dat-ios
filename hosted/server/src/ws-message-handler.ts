import type { SessionRegistry } from "./session-registry.js";
import type { GuidanceOrchestrator } from "./guidance-orchestrator.js";
import type { JEPAOrchestrator } from "./jepa-orchestrator.js";
import type { ReIDOrchestrator } from "./reid-orchestrator.js";
import type { PalantirOrchestrator } from "./palantir-orchestrator.js";
import type { AppRegistry } from "./app-registry.js";
import type { AudioTapBus } from "./audio-tap.js";
import type { ControlEventBus } from "./control-event-bus.js";
import type { DetectionThrottle } from "./detection-throttle.js";
import type { H264ToJpegDecoder } from "./h264-decoder.js";
import type { QualityPreset, Session } from "./types.js";
import { QUALITY_PRESETS, createTokenBucket } from "./types.js";
import type { FlowExecutionConfig, WorkflowNodeType } from "./app-types.js";
import { isSttResult, isVadResult } from "./message-types.js";
import { resolveWorkflowToPipeline as resolvePipeline } from "./app-registry.js";
import { pushPassiveTTSChains } from "./workflow-utils.js";
import * as q from "./db/queries.js";
import { dbWriter } from "./db/db-writer.js";

import {
  HEADER_SIZE, AUDIO_HEADER_SIZE,
  isAudioFrame, isVideoFrame, isSensorFrame,
  parseAudioHeader, parseSensorHeader,
  isBackpressureMessage, isBackpressureAckMessage,
} from "./protocol.js";
import { decodeOpusFrame } from "./opus-decode.js";

type WsLike = { send: (data: string) => void; readyState: number; data: any };

/** Dependencies injected from server.ts closure scope */
export interface WsMessageDeps {
  registry: SessionRegistry;
  orchestrator: GuidanceOrchestrator;
  jepaOrchestrator: JEPAOrchestrator;
  reidOrchestrator: ReIDOrchestrator;
  palantirOrchestrator: PalantirOrchestrator;
  appRegistry: AppRegistry;
  detectionThrottle: DetectionThrottle;
  audioTapBus: AudioTapBus;
  controlEventBus: ControlEventBus;
  getH264Decoder: (sessionId: string) => H264ToJpegDecoder;
  stopH264Decoder: (sessionId: string) => void;
  sendCachedFrameToAI: (sessionId: string, frame: Uint8Array) => void;
  broadcastToViewers: (session: Session | undefined, msg: object) => void;
  buildSessionInfo: (session: any) => any;
  pendingWakeActivations: Map<string, { workflowId: string; requestedAt: number }>;
  wifiIp: string;
  PORT: number;
  serverStartTime: number;
}

/** Send enabled:false for ALL pipeline stage types to the publisher. */
function sendAllStageDisables(session: { publisher?: { ws?: WsLike } | null }): void {
  const ws = session.publisher?.ws;
  if (!ws || ws.readyState !== 1 /* OPEN */) return;
  const disable = (type: string) => ws.send(JSON.stringify({ type, enabled: false }));
  disable("vision_stage_config");
  disable("enhance_stage_config");
  disable("sensor_stage_config");
  disable("speech_stage_config");
  disable("tracking_stage_config");
  disable("measure_stage_config");
  disable("yolo_stage_config");
}

/** Build session_info payload for viewer info strip */
export function buildSessionInfo(session: {
  metadata: any; viewers: Map<any, any>; recorder: any;
  createdAt: number; publisher: any; linkState?: string;
  state?: string; dropReason?: string;
}) {
  const publisherStatus = session.publisher
    ? (session.publisher.standby ? "standby" : "live")
    : "offline";
  return {
    deviceId: session.metadata.deviceId || null,
    deviceName: session.metadata.deviceName || null,
    deviceModel: session.metadata.deviceModel || null,
    wearableType: session.metadata.wearableType || null,
    systemVersion: session.metadata.systemVersion || null,
    appVersion: session.metadata.appVersion || null,
    buildNumber: session.metadata.buildNumber || null,
    viewerCount: session.viewers.size,
    recording: !!session.recorder?.getStats?.()?.active,
    linkState: session.linkState || null,
    publisherStatus,
    sessionAge: Date.now() - session.createdAt,
    connectedAt: session.createdAt,
    state: session.state || null,
    dropReason: session.dropReason || null,
  };
}

/** Broadcast a JSON message to all viewers in a session */
export function broadcastToViewers(session: Session | undefined, msg: object): void {
  if (!session) return;
  const data = JSON.stringify(msg);
  for (const viewer of session.viewers.values()) {
    if (viewer.ws.readyState === 1 /* WebSocket.OPEN */) {
      try { viewer.ws.send(data); } catch { /* skip */ }
    }
  }
}

/**
 * Handle incoming WebSocket messages (publisher + viewer, JSON + binary).
 * Extracted from server.ts Bun.serve message callback.
 */
export async function handleWsMessage(
  ws: WsLike,
  message: string | Uint8Array,
  deps: WsMessageDeps,
): Promise<void> {
  const { role, sessionId } = ws.data;
  const {
    registry, orchestrator, jepaOrchestrator, reidOrchestrator, palantirOrchestrator, appRegistry,
    detectionThrottle, audioTapBus, controlEventBus,
    getH264Decoder, stopH264Decoder, sendCachedFrameToAI,
    broadcastToViewers: broadcast, buildSessionInfo: buildInfo,
    pendingWakeActivations, wifiIp, PORT, serverStartTime,
  } = deps;

  const session = registry.get(sessionId);
  if (!session) return;

  if (role === "publish" && session.publisher?.ws === ws) {
    if (typeof message === "string") {
      // Publisher JSON control messages
      try {
        const cmd = JSON.parse(message);
        if (cmd.type === "hello" && session.publisher) {
          const MAX_FIELD_LEN = 256;
          const strField = (v: unknown): string | null => {
            if (typeof v !== "string") return null;
            const trimmed = v.slice(0, MAX_FIELD_LEN);
            return trimmed || null;
          };
          session.publisher.deviceId = strField(cmd.deviceId);
          session.publisher.deviceName = strField(cmd.deviceName);
          session.publisher.wearableId = strField(cmd.wearableId);
          session.publisher.wearableType = strField(cmd.wearableType);
          session.publisher.deviceModel = strField(cmd.deviceModel);
          session.publisher.systemVersion = strField(cmd.systemVersion);
          session.publisher.appVersion = strField(cmd.appVersion);
          session.publisher.buildNumber = strField(cmd.buildNumber);
          session.publisher.batteryLevel = typeof cmd.batteryLevel === "number" ? cmd.batteryLevel : null;
          session.publisher.batteryState = strField(cmd.batteryState);
          session.publisher.lowPowerMode = !!cmd.lowPowerMode;

          // Update session metadata
          session.metadata.deviceName = strField(cmd.deviceName);
          session.metadata.deviceModel = strField(cmd.deviceModel);
          session.metadata.deviceId = strField(cmd.deviceId);
          session.metadata.systemVersion = strField(cmd.systemVersion);
          session.metadata.wearableType = strField(cmd.wearableType);
          session.metadata.appVersion = strField(cmd.appVersion);
          session.metadata.buildNumber = strField(cmd.buildNumber);

          // Bind device→session so reconnects resume the same session
          if (cmd.deviceId && typeof cmd.deviceId === "string") {
            registry.bindDeviceToSession(cmd.deviceId, sessionId);
          }

          console.log(`[relay] Publisher hello: device=${session.publisher.deviceName || "?"} wearable=${session.publisher.wearableType || "none"} ip=${session.publisher.clientIp} session=${sessionId}`);

          // Shadow write: upsert device + link session to device
          if (session.publisher.deviceId) {
            dbWriter.enqueue(q.upsertDevice({
              id: session.publisher.deviceId,
              name: session.publisher.deviceName ?? undefined,
              model: session.publisher.deviceModel ?? undefined,
              systemVersion: session.publisher.systemVersion ?? undefined,
              wearableType: session.publisher.wearableType ?? undefined,
              wearableId: session.publisher.wearableId ?? undefined,
              appVersion: session.publisher.appVersion ?? undefined,
              buildNumber: session.publisher.buildNumber ?? undefined,
              batteryLevel: session.publisher.batteryLevel ?? undefined,
              status: session.publisher.standby ? "standby" : "online",
              lastSessionId: sessionId,
            }));
            if (session.publisher.appVersion && session.publisher.buildNumber) {
              dbWriter.enqueue(q.recordBuildSighting({
                deviceId: session.publisher.deviceId,
                appVersion: session.publisher.appVersion,
                buildNumber: session.publisher.buildNumber,
              }));
            }
            dbWriter.enqueue(q.upsertSession({
              id: sessionId,
              publisherDeviceId: session.publisher.deviceId,
            }));
          }

          // Auto-activate pending wake workflows when device connects
          const pendingWake = session.publisher.deviceId ? pendingWakeActivations.get(session.publisher.deviceId) : null;
          if (pendingWake) {
            pendingWakeActivations.delete(session.publisher.deviceId!);
            const pwId = pendingWake.workflowId;
            console.log(`[wake-auto] Device ${session.publisher.deviceId!.slice(0, 8)}... connected, auto-activating workflow ${pwId}`);
            fetch(`http://127.0.0.1:${PORT}/workflows/${pwId}/activate`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ sessionId, wakeActivation: true }),
            }).then(r => r.json()).then(result => {
              console.log(`[wake-auto] Activation result for ${pwId}:`, JSON.stringify(result));
            }).catch(err => {
              console.error(`[wake-auto] Activation failed for ${pwId}:`, err);
            });
          }

          // Broadcast session_info to all viewers (device info now available)
          broadcast(session, { type: "session_info", ...buildInfo(session) });

          // Update recorder device info
          if (session.recorder) {
            session.recorder.deviceInfo = {
              deviceId: strField(cmd.deviceId),
              deviceName: strField(cmd.deviceName),
              deviceModel: strField(cmd.deviceModel),
              systemVersion: strField(cmd.systemVersion),
            };
            if (cmd.wearableId || cmd.wearableType) {
              session.recorder.wearableInfo = {
                wearableId: strField(cmd.wearableId),
                wearableType: strField(cmd.wearableType),
              };
            }
            session.recorder.accessLevel = session.accessLevel;
            session.recorder.acl = session.acl;
            session.recorder.ownerId = session.ownerId;
            session.recorder.ownerEmail = session.ownerEmail;
          }
        } else if (cmd.type === "gesture") {
          controlEventBus.publish({
            type: "gesture",
            gesture: cmd.gesture,
            confidence: cmd.confidence,
            timestampMs: cmd.timestampMs || Date.now(),
          });
          console.log(`[relay] Gesture: ${cmd.gesture} confidence=${cmd.confidence} session=${sessionId}`);
          const gesturePipeline = appRegistry.resolveByGesture(cmd.gesture);
          if (gesturePipeline) {
            orchestrator.activateApp(sessionId, gesturePipeline.appId).catch(() => {});
            const cachedFrame = registry.getLastFrame(sessionId);
            if (cachedFrame) sendCachedFrameToAI(sessionId, cachedFrame);
          }
          if (session.activeAppId) {
            orchestrator.sendTrigger(sessionId, `[Gesture detected: ${cmd.gesture}, confidence: ${cmd.confidence ?? 1.0}]`);
          }
        } else if (cmd.type === "activate_app") {
          const appId = cmd.appId as string;
          if (appId.startsWith("wf-")) {
            const wfId = appId.slice(3);
            try {
              const wf = q.getWorkflow(wfId);
              if (!wf) throw new Error("Workflow not found");
              const nodes = q.getWorkflowNodes(wfId).map(n => ({ ...n, config: JSON.parse(n.config) }));
              const edges = q.getWorkflowEdges(wfId);
              const pipelineApps = resolvePipeline(nodes as any, edges as any, { id: wfId, name: wf.name }, undefined, wf.settings ? JSON.parse(wf.settings) : null);
              const primaryApp = pipelineApps[0];
              for (const app of pipelineApps) {
                appRegistry.registerTransientApp(app);
              }
              if (primaryApp) {
                session.activeAppId = primaryApp.id;
                session.activeWorkflowId = wfId;
                session.appPipeline = { appId: primaryApp.id, primitiveId: primaryApp.binding };
                dbWriter.enqueue(q.updateSession(sessionId, { activeWorkflowId: wfId }));
                if ((nodes as any[]).length > 1) {
                  const nodeEntries = (nodes as any[]).map((n: any) => ({
                    nodeId: n.id,
                    appId: n.id,
                    nodeType: n.type as WorkflowNodeType,
                    label: n.label || n.type,
                    triggerChained: false,
                  }));
                  orchestrator.activateWorkflow(sessionId, wfId, wf.name, nodeEntries);
                }
                for (const app of pipelineApps) {
                  await orchestrator.activateWithConfig(sessionId, app);
                }
                ws.send(JSON.stringify({ type: "app_status", appId: primaryApp.id, status: "active" }));
                const ic = orchestrator.getInputConfig(sessionId);
                if (ic && session.publisher) session.publisher.ws.send(JSON.stringify({ type: "configure_sources", input: ic }));
                const cachedFrame = registry.getLastFrame(sessionId);
                if (cachedFrame) sendCachedFrameToAI(sessionId, cachedFrame);
              } else {
                ws.send(JSON.stringify({ type: "app_status", appId, status: "active", info: "passive pipeline" }));
                if (session.publisher?.ws) {
                  const publisherFlowConfig: FlowExecutionConfig | null = wf.flowConfig ? JSON.parse(wf.flowConfig) : null;
                  pushPassiveTTSChains(nodes as any, edges as any, session.publisher.ws, sessionId, publisherFlowConfig);
                }
              }
            } catch (e) {
              ws.send(JSON.stringify({ type: "app_status", appId, status: "error", error: String(e) }));
            }
          } else {
            const pipeline = appRegistry.resolvePipeline(appId);
            if (pipeline) {
              session.activeAppId = appId;
              session.appPipeline = pipeline;
              console.log(`[relay] App activated: ${appId} binding=${pipeline.primitiveId} session=${sessionId}`);
              ws.send(JSON.stringify({ type: "app_status", appId, status: "active" }));
              orchestrator.activateApp(sessionId, appId).catch(() => {});
              const cachedFrame = registry.getLastFrame(sessionId);
              if (cachedFrame) sendCachedFrameToAI(sessionId, cachedFrame);
            } else {
              console.warn(`[relay] App activation failed: ${appId} not found`);
              ws.send(JSON.stringify({ type: "app_status", appId, status: "error", error: "App not found" }));
            }
          }
        } else if (cmd.type === "deactivate_app") {
          const prevApp = session.activeAppId;
          session.activeAppId = null;
          session.activeWorkflowId = null;
          session.appPipeline = null;
          console.log(`[relay] App deactivated: ${prevApp} session=${sessionId}`);
          if (prevApp) {
            dbWriter.enqueue(q.deactivateActivation(sessionId, "publisher"));
            dbWriter.flushNow();
          }
          sendAllStageDisables(session);
          ws.send(JSON.stringify({ type: "app_status", appId: prevApp, status: "inactive" }));
          orchestrator.deactivateApp(sessionId).catch(() => {});
        } else if (cmd.type === "activate_workflow") {
          const workflowId = cmd.workflowId as string;
          try {
            const wf = q.getWorkflow(workflowId);
            if (!wf) { ws.send(JSON.stringify({ type: "workflow_error", error: "Workflow not found" })); return; }
            const nodes = q.getWorkflowNodes(workflowId).map(n => ({ ...n, config: JSON.parse(n.config) }));
            const edges = q.getWorkflowEdges(workflowId);
            const pipelineApps = resolvePipeline(nodes as any, edges as any, { id: workflowId, name: wf.name }, undefined, wf.settings ? JSON.parse(wf.settings) : null);
            const primaryApp = pipelineApps[0];
            for (const app of pipelineApps) {
              appRegistry.registerTransientApp(app);
            }
            if (primaryApp) {
              session.activeAppId = primaryApp.id;
              session.activeWorkflowId = workflowId;
              session.appPipeline = { appId: primaryApp.id, primitiveId: primaryApp.binding };
              if ((nodes as any[]).length > 1) {
                const nodeEntries = (nodes as any[]).map((n: any) => ({
                  nodeId: n.id,
                  appId: n.id,
                  nodeType: n.type as WorkflowNodeType,
                  label: n.label || n.type,
                  triggerChained: false,
                }));
                orchestrator.activateWorkflow(sessionId, workflowId, wf.name, nodeEntries);
              }
              for (const app of pipelineApps) {
                await orchestrator.activateWithConfig(sessionId, app);
              }
              for (const app of pipelineApps) {
                if (app.config?.jepa) {
                  const jc = app.config.jepa as Record<string, any>;
                  await jepaOrchestrator.activate(sessionId, {
                    provider: jc.provider,
                    model: jc.model ?? app.config.model,
                    gpu: jc.gpu,
                    clipLength: jc.clipLength,
                    sampleFps: jc.sampleFps,
                    resolution: jc.resolution,
                    tasks: jc.tasks,
                    sessionId,
                  });
                }
              }
            }
            ws.send(JSON.stringify({ type: "workflow_activated", appId: primaryApp?.id ?? "passive" }));
            if (!primaryApp && session.publisher?.ws) {
              const viewerFlowConfig: FlowExecutionConfig | null = wf.flowConfig ? JSON.parse(wf.flowConfig) : null;
              pushPassiveTTSChains(nodes as any, edges as any, session.publisher.ws, sessionId, viewerFlowConfig);
            }
            const ic = orchestrator.getInputConfig(sessionId);
            if (ic && session.publisher) session.publisher.ws.send(JSON.stringify({ type: "configure_sources", input: ic }));
            const cachedFrame = registry.getLastFrame(sessionId);
            if (cachedFrame) sendCachedFrameToAI(sessionId, cachedFrame);
          } catch (e) {
            ws.send(JSON.stringify({ type: "workflow_error", error: String(e) }));
          }
        } else if (cmd.type === "set_vision_fps" && typeof cmd.fps === "number") {
          const fps = Math.max(0.1, Math.min(cmd.fps, 5));
          orchestrator.setVisionFps(sessionId, fps);
          ws.send(JSON.stringify({ type: "vision_fps", fps }));
        } else if (cmd.type === "vision_result" && Array.isArray(cmd.detections)) {
          if (session.activeAppId) {
            const summary = (cmd.detections as any[]).map((d: any) => {
              if (d.type === "vision-face-detect") return `Face detected (confidence: ${(d.confidence * 100).toFixed(0)}%)`;
              if (d.type === "vision-barcode-scan") return `Barcode: ${d.label}`;
              if (d.type === "vision-ocr") return `OCR text: ${d.label}`;
              if (d.type === "vision-scene-classify") {
                const labels = (d.labels as any[] || []).map((l: any) => `${l.label} ${(l.confidence * 100).toFixed(0)}%`).join(", ");
                return `Scene: ${labels}`;
              }
              if (d.type === "vision-person-detect") return `Person detected (confidence: ${(d.confidence * 100).toFixed(0)}%)`;
              if (d.type === "vision-body-pose") {
                const jointCount = (d.joints as any[] || []).length;
                return `Body pose detected (${jointCount} joints, confidence: ${(d.confidence * 100).toFixed(0)}%)`;
              }
              return `${d.type}: ${d.label}`;
            }).join("; ");
            if (summary) {
              const throttled = detectionThrottle.check(sessionId, "vision", summary);
              if (throttled) {
                orchestrator.sendTrigger(sessionId, `[Vision: ${throttled}]`);
              }
              // Fan out to Palantir nodes (non-blocking)
              if (palantirOrchestrator.isActive(sessionId)) {
                palantirOrchestrator.fanoutTrigger(sessionId, summary).catch(() => {});
              }
            }
          }
          broadcast(session, cmd);
        } else if (cmd.type === "sensor_result") {
          if (session.activeAppId) {
            const sensorType = cmd.sensorType as string;
            let summary = "";
            if (sensorType === "sensor-sound") {
              const labels = (cmd.labels as any[] || []).map((l: any) => `${l.label} ${(l.confidence * 100).toFixed(0)}%`).join(", ");
              summary = `Sound: ${labels}`;
            } else if (sensorType === "sensor-location") {
              const eventType = cmd.eventType as string ?? "location_update";
              const lat = (cmd.latitude as number)?.toFixed(6);
              const lon = (cmd.longitude as number)?.toFixed(6);
              if (eventType === "geofence_enter") {
                const label = cmd.regionLabel ?? cmd.regionId ?? "unknown";
                summary = `Geofence entered: ${label} (${lat}, ${lon})`;
              } else if (eventType === "geofence_exit") {
                const label = cmd.regionLabel ?? cmd.regionId ?? "unknown";
                summary = `Geofence exited: ${label} (${lat}, ${lon})`;
              } else if (eventType === "visit_detected") {
                summary = `Visit detected at ${lat}, ${lon}`;
              } else {
                const speed = (cmd.speed as number) >= 0 ? ` speed=${(cmd.speed as number).toFixed(1)}m/s` : "";
                summary = `Location: ${lat}, ${lon}${speed}`;
              }
            }
            if (summary) {
              const throttled = detectionThrottle.check(sessionId, `sensor:${sensorType}`, summary);
              if (throttled) {
                orchestrator.sendTrigger(sessionId, `[Sensor: ${throttled}]`);
              }
              // Fan out to Palantir nodes (non-blocking)
              if (palantirOrchestrator.isActive(sessionId)) {
                palantirOrchestrator.fanoutTrigger(sessionId, summary).catch(() => {});
              }
            }
          }
          broadcast(session, cmd);
        } else if (cmd.type === "stt_result") {
          if (isSttResult(cmd) && session.activeAppId) {
            const text = (cmd.text || "").trim();
            if (text && cmd.isFinal) {
              const summary = `Transcription: "${text}"`;
              orchestrator.sendTrigger(sessionId, `[STT: ${summary}]`);
              // Fan out to Palantir nodes (non-blocking)
              if (palantirOrchestrator.isActive(sessionId)) {
                palantirOrchestrator.fanoutTrigger(sessionId, summary).catch(() => {});
              }
            }
            if (cmd.error) {
              console.warn(`[relay] STT error from publisher: ${cmd.error} session=${sessionId}`);
            }
          }
          broadcast(session, cmd);
        } else if (cmd.type === "vad_result") {
          if (isVadResult(cmd) && session.activeAppId) {
            const { eventType } = cmd;
            const energyDb = cmd.energyDb?.toFixed(1);
            let summary = "";
            if (eventType === "speech_start") {
              summary = `Speech started (energy: ${energyDb}dB)`;
            } else if (eventType === "speech_end") {
              const duration = cmd.durationMs?.toFixed(0);
              summary = `Speech ended (${duration}ms, energy: ${energyDb}dB)`;
            } else if (eventType === "speech_active") {
              summary = `Speech active (energy: ${energyDb}dB)`;
            }
            if (summary) {
              orchestrator.sendTrigger(sessionId, `[VAD: ${summary}]`);
            }
            if (cmd.error) {
              console.warn(`[relay] VAD error from publisher: ${cmd.error} session=${sessionId}`);
            }
          }
          broadcast(session, cmd);
        } else if (cmd.type === "tracking_result" && Array.isArray(cmd.tracks)) {
          if (session.activeAppId) {
            const tracks = cmd.tracks as any[];
            const confirmedCount = tracks.filter((t: any) => t.state === "confirmed").length;
            const totalActive = tracks.length;
            const zoneCounts = cmd.registry?.zoneCounts as Record<string, number> ?? {};
            const zoneSummary = Object.entries(zoneCounts).map(([z, c]) => `${z}:${c}`).join(", ");
            const summary = `Tracking: ${totalActive} objects (${confirmedCount} confirmed)${zoneSummary ? ` zones[${zoneSummary}]` : ""}`;

            const throttled = detectionThrottle.check(sessionId, "tracking", summary);
            if (throttled) {
              orchestrator.sendTrigger(sessionId, `[Tracking: ${throttled}]`);
            }
            // Fan out to Palantir nodes (non-blocking)
            if (palantirOrchestrator.isActive(sessionId)) {
              palantirOrchestrator.fanoutTrigger(sessionId, summary).catch(() => {});
            }
          }
          broadcast(session, cmd);
        } else if (cmd.type === "reid_crops" && Array.isArray(cmd.crops)) {
          // Person crops for ReID embedding extraction (JEPA pattern)
          if (reidOrchestrator.isActive(sessionId)) {
            const crops = cmd.crops as Array<{ detectionIndex: number; data: string }>;
            reidOrchestrator.sendCrops(sessionId, crops).catch((err: Error) => {
              console.error(`[relay] ReID crop processing error session=${sessionId}:`, err.message);
            });
          }
        } else if (cmd.type === "tool_measure_result" && cmd.suggestions) {
          if (session.activeAppId) {
            const dims = cmd.dimensions as Record<string, any> ?? {};
            const suggestions = cmd.suggestions as any[] ?? [];
            const bestSuggestion = suggestions[0];
            let summary = `Tool Measure: ${dims.isCircular ? `dia ${dims.diameterMm?.toFixed(1)}` : `${dims.widthMm?.toFixed(1)} x ${dims.heightMm?.toFixed(1)}`}mm`;
            if (bestSuggestion) {
              summary += ` → ${bestSuggestion.sizeLabel} ${bestSuggestion.toolCategory} (${(bestSuggestion.confidence * 100).toFixed(0)}%)`;
            }
            if (cmd.fastenerType) {
              summary += ` [${cmd.fastenerType}]`;
            }
            const throttled = detectionThrottle.check(sessionId, "measure", summary);
            if (throttled) {
              orchestrator.sendTrigger(sessionId, `[Measure: ${throttled}]`);
            }
            // Fan out to Palantir nodes (non-blocking)
            if (palantirOrchestrator.isActive(sessionId)) {
              palantirOrchestrator.fanoutTrigger(sessionId, summary).catch(() => {});
            }
          }
          broadcast(session, cmd);
        } else if (isBackpressureAckMessage(cmd)) {
          console.log(`[relay] Backpressure ack from publisher: targetFps=${cmd.targetFps} session=${sessionId}`);
        } else if (cmd.type === "audio_mode_changed") {
          console.log(`[relay] Audio mode changed by publisher: mode=${cmd.mode} session=${sessionId}`);
          broadcast(session, { type: "audio_mode_changed", mode: cmd.mode });
        } else if (cmd.type === "workflow_control") {
          const action = cmd.action as string;
          const workflowId = cmd.workflowId as string;
          const nodeId = cmd.nodeId as string | undefined;
          if (action && workflowId) {
            await orchestrator.handleWorkflowControl(sessionId, action as any, workflowId, nodeId, "publisher");
            if (action === "stop_workflow") {
              session.activeAppId = null;
              session.activeWorkflowId = null;
              session.appPipeline = null;
              dbWriter.enqueue(q.deactivateActivation(sessionId, "publisher"));
              dbWriter.flushNow();
              sendAllStageDisables(session);
              if (session.publisher?.ws?.readyState === 1) {
                session.publisher.ws.send(JSON.stringify({ type: "app_status", appId: null, status: "inactive" }));
              }
              broadcast(session, { type: "app_status", appId: null, status: "inactive" });
            }
          }
        } else if (cmd.type === "audio_config") {
          broadcast(session, cmd);
        } else if (cmd.type === "photo_captured") {
          broadcast(session, { type: "photo_captured" });
        } else if (cmd.type === "recording_changed") {
          broadcast(session, { type: "recording_changed", recording: !!cmd.recording });
        } else if (cmd.type === "stream_changed") {
          if (cmd.streaming) {
            const sess = registry.get(sessionId);
            if (sess?.state === "paused") {
              registry.resumeSession(sessionId).catch(() => {});
            } else {
              registry.activatePublisher(sessionId).catch(() => {});
            }
          } else {
            registry.pauseSession(sessionId).catch(() => {});
          }
          broadcast(session, { type: "stream_changed", streaming: !!cmd.streaming });
        } else if (cmd.type === "publisher_telemetry") {
          if (cmd.battery && session.publisher) {
            session.publisher.batteryLevel = typeof cmd.battery.level === "number" ? cmd.battery.level : null;
            session.publisher.batteryState = typeof cmd.battery.state === "string" ? cmd.battery.state : null;
            session.publisher.lowPowerMode = !!cmd.battery.lowPowerMode;
          }
          broadcast(session, { type: "publisher_telemetry", ...cmd });
        } else if (cmd.type === "link_state_changed") {
          session.linkState = cmd.state as string || "unknown";
          broadcast(session, { type: "link_state_changed", state: session.linkState });
        } else if (cmd.type === "publisher_error") {
          broadcast(session, { type: "publisher_error", error: cmd.error, state: cmd.state });
        } else if (cmd.type === "codec_changed") {
          console.log(`[relay] Publisher codec changed: codec=${cmd.codec} session=${sessionId}`);
          broadcast(session, { type: "codec_changed", codec: cmd.codec });
        } else if (cmd.type === "spoken_text") {
          broadcast(session, { type: "spoken_text", text: cmd.text });
        } else if (cmd.type === "standby") {
          const isReady = cmd.status === "ready";
          if (isReady) {
            registry.pauseSession(sessionId).catch(() => {});
          } else {
            if (session.state === "paused" || session.state === "standby") {
              registry.activatePublisher(sessionId).catch(() => {});
            }
          }
          console.log(`[relay] Publisher standby: ${isReady} session=${sessionId}`);
          broadcast(session, { type: "publisher_status", status: isReady ? "standby" : "live" });
        }
      } catch (err) { console.warn("[relay] Publisher message parse error:", err); }
    } else {
      // Binary frame (Uint8Array in Bun)
      const buf = message as Uint8Array;

      if (isAudioFrame(buf)) {
        if (session.publisher?.standby) {
          registry.activatePublisher(sessionId).catch(() => {});
        }
        session.publisher.audioCount++;
        session.publisher.audioBytes += buf.length;
        const audioHdr = parseAudioHeader(buf);
        registry.fanoutAudio(sessionId, buf, audioHdr?.codecType ?? 0, audioHdr?.sampleRate ?? 0);
        session.recorder?.appendAudio(buf);
        audioTapBus.publish(buf, sessionId);

        if (audioHdr && session.activeAppId) {
          if (audioHdr.isOpus) {
            const opusPayload = buf.slice(AUDIO_HEADER_SIZE);
            const pcmBytes = decodeOpusFrame(opusPayload, audioHdr.sampleRate);
            if (pcmBytes.length > 0) {
              orchestrator.sendAudio(sessionId, pcmBytes, audioHdr.codecType, audioHdr.sampleRate);
            }
          } else {
            const pcmPayload = buf.slice(AUDIO_HEADER_SIZE);
            orchestrator.sendAudio(sessionId, pcmPayload, audioHdr.codecType, audioHdr.sampleRate);
          }
        }
      } else if (isVideoFrame(buf)) {
        if (session.publisher?.standby) {
          registry.activatePublisher(sessionId).catch(() => {});
        }
        session.publisher.frameCount++;
        session.publisher.totalBytes += buf.length;
        registry.fanout(sessionId, buf);
        session.recorder?.appendVideo(buf);

        const codecFlags = buf[25];
        const codecType = (codecFlags >> 4) & 0x0F;

        if (codecType === 0) {
          if (session.activeAppId) {
            const jpegPayload = buf.slice(HEADER_SIZE);
            orchestrator.sendVideoFrame(sessionId, jpegPayload);
          }
          if (jepaOrchestrator.isActive(sessionId)) {
            const jpegPayload = buf.slice(HEADER_SIZE);
            jepaOrchestrator.sendFrame(sessionId, jpegPayload, Date.now());
          }
        } else if (codecType === 1) {
          const decoder = getH264Decoder(sessionId);
          if (!decoder.active) decoder.start();
          decoder.feed(buf.slice(HEADER_SIZE));
        }
      } else if (isSensorFrame(buf)) {
        const sensorHdr = parseSensorHeader(buf);
        registry.fanout(sessionId, buf);

        if (sensorHdr && session.activeAppId) {
          orchestrator.sendSensor(sessionId, sensorHdr.json, sensorHdr.sensorFlags);
        }

        session.publisher.sensorCount = (session.publisher.sensorCount ?? 0) + 1;
        session.publisher.sensorBytes = (session.publisher.sensorBytes ?? 0) + buf.length;
      }
    }
  } else if (role === "view") {
    // Viewer control messages
    if (typeof message === "string") {
      try {
        const cmd = JSON.parse(message);
        if (cmd.type === "stats") {
          const s = await registry.stats(wifiIp, PORT, serverStartTime);
          ws.send(JSON.stringify({ type: "stats", ...s }));
        } else if (cmd.type === "hello") {
          const viewerId = ws.data.viewerId;
          if (viewerId) {
            const found = registry.findViewerSession(viewerId);
            if (found) {
              found.viewer.gitCommit = cmd.gitCommit || null;
              found.viewer.buildVersion = cmd.buildVersion || null;
            }
          }
        } else if (cmd.type === "config" && cmd.quality && cmd.quality in QUALITY_PRESETS) {
          const viewerId = ws.data.viewerId;
          if (!viewerId) return;
          const found = registry.findViewerSession(viewerId);
          if (found) {
            const newQuality = cmd.quality as QualityPreset;
            found.viewer.quality = newQuality;
            found.viewer.bucket = createTokenBucket(newQuality);
            console.log(`[relay] Viewer ${viewerId.slice(0, 8)} quality: ${newQuality} (${QUALITY_PRESETS[newQuality].maxFps} FPS)`);
            ws.send(JSON.stringify({
              type: "quality",
              preset: newQuality,
              maxFps: QUALITY_PRESETS[newQuality].maxFps,
              label: QUALITY_PRESETS[newQuality].label,
            }));
          }
        } else if (cmd.type === "activate_app" && cmd.appId) {
          const appId = cmd.appId as string;
          if (appId.startsWith("wf-")) {
            const wfId = appId.slice(3);
            try {
              const wf = q.getWorkflow(wfId);
              if (!wf) throw new Error("Workflow not found");
              const nodes = q.getWorkflowNodes(wfId).map(n => ({ ...n, config: JSON.parse(n.config) }));
              const edges = q.getWorkflowEdges(wfId);
              const pipelineApps = resolvePipeline(nodes as any, edges as any, { id: wfId, name: wf.name }, undefined, wf.settings ? JSON.parse(wf.settings) : null);
              const primaryApp = pipelineApps[0];
              for (const app of pipelineApps) {
                appRegistry.registerTransientApp(app);
              }
              if (primaryApp) {
                session.activeAppId = primaryApp.id;
                session.activeWorkflowId = wfId;
                session.appPipeline = { appId: primaryApp.id, primitiveId: primaryApp.binding };
                dbWriter.enqueue(q.updateSession(sessionId, { activeWorkflowId: wfId }));
                if ((nodes as any[]).length > 1) {
                  const nodeEntries = (nodes as any[]).map((n: any) => ({
                    nodeId: n.id,
                    appId: n.id,
                    nodeType: n.type as WorkflowNodeType,
                    label: n.label || n.type,
                    triggerChained: false,
                  }));
                  orchestrator.activateWorkflow(sessionId, wfId, wf.name, nodeEntries);
                }
                for (const app of pipelineApps) {
                  if (app.config?.jepa) {
                    const jc = app.config.jepa as any;
                    await jepaOrchestrator.activate(sessionId, {
                      provider: jc.provider,
                      model: jc.model ?? app.config.model,
                      gpu: jc.gpu,
                      clipLength: jc.clipLength,
                      sampleFps: jc.sampleFps,
                      resolution: jc.resolution,
                      tasks: jc.tasks,
                      sessionId,
                    });
                  } else {
                    await orchestrator.activateWithConfig(sessionId, app);
                  }
                }
                console.log(`[relay] Viewer activated workflow app: ${primaryApp.id} session=${sessionId}`);
                ws.send(JSON.stringify({ type: "app_status", appId: primaryApp.id, status: "active" }));
                const ic = orchestrator.getInputConfig(sessionId);
                if (ic && session.publisher) session.publisher.ws.send(JSON.stringify({ type: "configure_sources", input: ic }));
                const cachedFrame = registry.getLastFrame(sessionId);
                if (cachedFrame) sendCachedFrameToAI(sessionId, cachedFrame);
              } else {
                ws.send(JSON.stringify({ type: "app_status", appId, status: "active", info: "passive pipeline" }));
                if (session.publisher?.ws) {
                  const publisherFlowConfig: FlowExecutionConfig | null = wf.flowConfig ? JSON.parse(wf.flowConfig) : null;
                  pushPassiveTTSChains(nodes as any, edges as any, session.publisher.ws, sessionId, publisherFlowConfig);
                }
              }
            } catch (e) {
              ws.send(JSON.stringify({ type: "app_status", appId, status: "error", error: String(e) }));
            }
          } else {
            const pipeline = appRegistry.resolvePipeline(appId);
            if (pipeline) {
              session.activeAppId = appId;
              session.appPipeline = pipeline;
              console.log(`[relay] Viewer activated app: ${appId} session=${sessionId}`);
              ws.send(JSON.stringify({ type: "app_status", appId, status: "active" }));
              orchestrator.activateApp(sessionId, appId).catch(() => {});
              const cachedFrame = registry.getLastFrame(sessionId);
              if (cachedFrame) sendCachedFrameToAI(sessionId, cachedFrame);
            } else {
              ws.send(JSON.stringify({ type: "app_status", appId, status: "error", error: "App not found" }));
            }
          }
        } else if (cmd.type === "deactivate_app") {
          const prevApp = session.activeAppId;
          const prevWorkflowId = session.activeWorkflowId;
          session.activeAppId = null;
          session.activeWorkflowId = null;
          session.appPipeline = null;
          console.log(`[relay] Viewer deactivated app: ${prevApp} session=${sessionId}`);
          if (prevApp) {
            dbWriter.enqueue(q.deactivateActivation(sessionId, "viewer"));
            dbWriter.flushNow();
          }
          sendAllStageDisables(session);
          ws.send(JSON.stringify({ type: "app_status", appId: prevApp, status: "inactive" }));
          broadcast(session, { type: "app_status", appId: null, status: "inactive" });
          // Also notify publisher directly so iOS app_status handler fires
          if (session.publisher?.ws?.readyState === 1) {
            session.publisher.ws.send(JSON.stringify({ type: "app_status", appId: prevApp, status: "inactive" }));
          }
          if (prevWorkflowId) {
            orchestrator.handleWorkflowControl(sessionId, "stop_workflow", prevWorkflowId, undefined, "viewer").catch(() => {});
          }
          orchestrator.deactivateApp(sessionId).catch(() => {});
        } else if (cmd.type === "trigger_gesture" && cmd.gesture) {
          controlEventBus.publish({
            type: "gesture",
            gesture: cmd.gesture,
            confidence: cmd.confidence ?? 1.0,
            timestampMs: Date.now(),
          });
          console.log(`[relay] Viewer gesture: ${cmd.gesture} session=${sessionId}`);
          const viewerPipeline = appRegistry.resolveByGesture(cmd.gesture);
          if (viewerPipeline) {
            orchestrator.activateApp(sessionId, viewerPipeline.appId).catch(() => {});
            const cachedFrame = registry.getLastFrame(sessionId);
            if (cachedFrame) sendCachedFrameToAI(sessionId, cachedFrame);
          }
        } else if (cmd.type === "set_vision_fps" && typeof cmd.fps === "number") {
          const fps = Math.max(0.1, Math.min(cmd.fps, 5));
          orchestrator.setVisionFps(sessionId, fps);
          console.log(`[relay] Vision FPS set to ${fps} session=${sessionId}`);
          ws.send(JSON.stringify({ type: "vision_fps", fps }));
        } else if (cmd.type === "send_text" && typeof cmd.text === "string") {
          const text = cmd.text.slice(0, 1000);
          if (text.length > 0) {
            orchestrator.sendTrigger(sessionId, text);
            console.log(`[relay] Text to AI: "${text.slice(0, 80)}${text.length > 80 ? "..." : ""}" session=${sessionId}`);
          }
        } else if (cmd.type === "ai_telemetry") {
          ws.send(JSON.stringify({
            type: "ai_telemetry",
            telemetry: orchestrator.getTelemetry(sessionId),
          }));
        } else if (cmd.type === "workflow_control") {
          const action = cmd.action as string;
          const workflowId = cmd.workflowId as string;
          const nodeId = cmd.nodeId as string | undefined;
          if (action && workflowId) {
            await orchestrator.handleWorkflowControl(sessionId, action as any, workflowId, nodeId, "viewer");
            if (action === "stop_workflow") {
              session.activeAppId = null;
              session.activeWorkflowId = null;
              session.appPipeline = null;
              dbWriter.enqueue(q.deactivateActivation(sessionId, "viewer"));
              dbWriter.flushNow();
              sendAllStageDisables(session);
              if (session.publisher?.ws?.readyState === 1) {
                session.publisher.ws.send(JSON.stringify({ type: "app_status", appId: null, status: "inactive" }));
              }
              broadcast(session, { type: "app_status", appId: null, status: "inactive" });
            }
          }
        } else if (isBackpressureMessage(cmd)) {
          const clampedFps = Math.max(1, Math.min(60, cmd.targetFps));
          console.log(`[relay] Backpressure from viewer: targetFps=${clampedFps} session=${sessionId}`);
          const publisherWs = session.publisher?.ws;
          if (publisherWs && publisherWs.readyState === 1 /* OPEN */) {
            publisherWs.send(JSON.stringify({ type: "backpressure", targetFps: clampedFps }));
          }
        } else if (cmd.type === "set_audio_mode") {
          const mode = cmd.mode as string;
          if (["phone", "glasses", "all"].includes(mode)) {
            console.log(`[relay] Audio mode change from viewer: mode=${mode} session=${sessionId}`);
            const publisherWs = session.publisher?.ws;
            if (publisherWs && publisherWs.readyState === 1 /* OPEN */) {
              publisherWs.send(JSON.stringify({ type: "set_audio_mode", mode }));
            }
          }
        } else if (cmd.type === "set_audio_gain") {
          const publisherWs = session.publisher?.ws;
          if (publisherWs && publisherWs.readyState === 1 /* OPEN */) {
            publisherWs.send(JSON.stringify({ type: "set_audio_gain", codecType: cmd.codecType, gainDb: cmd.gainDb }));
          }
        } else if (cmd.type === "set_noise_gate") {
          const publisherWs = session.publisher?.ws;
          if (publisherWs && publisherWs.readyState === 1 /* OPEN */) {
            publisherWs.send(JSON.stringify({ type: "set_noise_gate", codecType: cmd.codecType, threshold: cmd.threshold }));
          }
        } else if (cmd.type === "set_noise_suppression") {
          const publisherWs = session.publisher?.ws;
          if (publisherWs && publisherWs.readyState === 1 /* OPEN */) {
            publisherWs.send(JSON.stringify({ type: "set_noise_suppression", codecType: cmd.codecType, enabled: cmd.enabled }));
          }
        } else if (cmd.type === "set_audio_mix") {
          const publisherWs = session.publisher?.ws;
          if (publisherWs && publisherWs.readyState === 1 /* OPEN */) {
            publisherWs.send(JSON.stringify({ type: "set_audio_mix", enabled: cmd.enabled, weightPhone: cmd.weightPhone, weightGlasses: cmd.weightGlasses }));
          }
        } else if (cmd.type === "get_audio_config") {
          const publisherWs = session.publisher?.ws;
          if (publisherWs && publisherWs.readyState === 1 /* OPEN */) {
            publisherWs.send(JSON.stringify({ type: "get_audio_config" }));
          }
        } else if (cmd.type === "capture_photo") {
          const publisherWs = session.publisher?.ws;
          if (publisherWs && publisherWs.readyState === 1 /* OPEN */) {
            publisherWs.send(JSON.stringify({ type: "capture_photo" }));
          }
        } else if (cmd.type === "start_recording") {
          const publisherWs = session.publisher?.ws;
          if (publisherWs && publisherWs.readyState === 1 /* OPEN */) {
            publisherWs.send(JSON.stringify({ type: "start_recording" }));
          }
        } else if (cmd.type === "stop_recording") {
          const publisherWs = session.publisher?.ws;
          if (publisherWs && publisherWs.readyState === 1 /* OPEN */) {
            publisherWs.send(JSON.stringify({ type: "stop_recording" }));
          }
        } else if (cmd.type === "start_stream") {
          const publisherWs = session.publisher?.ws;
          if (publisherWs && publisherWs.readyState === 1 /* OPEN */) {
            publisherWs.send(JSON.stringify({ type: "start_stream" }));
          }
        } else if (cmd.type === "stop_stream") {
          const publisherWs = session.publisher?.ws;
          if (publisherWs && publisherWs.readyState === 1 /* OPEN */) {
            publisherWs.send(JSON.stringify({ type: "stop_stream" }));
          }
        } else if (cmd.type === "speak_text" && typeof cmd.text === "string") {
          const publisherWs = session.publisher?.ws;
          if (publisherWs && publisherWs.readyState === 1 /* OPEN */) {
            publisherWs.send(JSON.stringify({ type: "speak_text", text: cmd.text.slice(0, 500) }));
          }
        } else if (cmd.type === "set_codec" && typeof cmd.codec === "string") {
          const codec = (cmd.codec as string).toLowerCase();
          if (["jpeg", "h264"].includes(codec)) {
            console.log(`[relay] Codec change from viewer: codec=${codec} session=${sessionId}`);
            if (codec === "h264" && session.activeAppId) {
              getH264Decoder(sessionId).start();
            } else {
              stopH264Decoder(sessionId);
            }
            const publisherWs = session.publisher?.ws;
            if (publisherWs && publisherWs.readyState === 1 /* OPEN */) {
              publisherWs.send(JSON.stringify({ type: "set_codec", codec }));
            }
          }
        }
      } catch (err) { console.warn("[relay] Viewer message parse error:", err); }
    } else {
      // Binary frame from viewer — forward FRAU audio to publisher
      const buf = message as Uint8Array;
      if (isAudioFrame(buf)) {
        const sent = registry.sendToPublisher(sessionId, buf);
        if (!sent) {
          console.warn(`[relay] Viewer audio frame dropped: publisher not connected for session=${sessionId}`);
        }
        if (sent && !ws.data._audioFrameCount) {
          ws.data._audioFrameCount = 1;
          console.log(`[relay] Viewer audio forwarding to publisher: session=${sessionId} frameSize=${buf.length}`);
        } else if (sent) {
          ws.data._audioFrameCount = (ws.data._audioFrameCount ?? 0) + 1;
          if (ws.data._audioFrameCount % 100 === 0) {
            console.log(`[relay] Viewer audio: ${ws.data._audioFrameCount} frames forwarded session=${sessionId}`);
          }
        }
      }
    }
  }
}
