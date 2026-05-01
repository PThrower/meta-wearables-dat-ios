import { NODE_DEF_MAP } from "./node-definitions.js";
import { resolveSourceInput } from "./app-registry.js";

type WsLike = { send: (data: string) => void; readyState: number };

/**
 * Dispatch workflow config messages (speech, vision, enhance, sensor, tracking, measure)
 * to the publisher WebSocket. Called both on activation and on publisher reconnect.
 */
export function dispatchWorkflowConfig(
  ws: WsLike,
  nodes: Array<{ id: string; type: string; config: Record<string, unknown> }>,
  sid: string,
  edges?: Array<{ sourceNodeId: string; targetNodeId: string }>,
): void {
  if (ws.readyState !== 1 /* WebSocket.OPEN */) return;

  const speechIdx: number[] = [];
  const visionIdx: number[] = [];
  const enhanceIdx: number[] = [];
  const sensorIdx: number[] = [];
  const trackingIdx: number[] = [];
  const measureIdx: number[] = [];

  for (let i = 0; i < nodes.length; i++) {
    const def = NODE_DEF_MAP.get(nodes[i].type);
    if (def?.activationMode === "speech")    { speechIdx.push(i);   continue; }
    if (def?.activationMode === "vision")    { visionIdx.push(i);   continue; }
    if (def?.activationMode === "enhance")   { enhanceIdx.push(i);  continue; }
    if (def?.activationMode === "sensor")    { sensorIdx.push(i);   continue; }
    if (def?.activationMode === "tracking")  { trackingIdx.push(i); continue; }
    if (def?.activationMode === "measure")   { measureIdx.push(i);  continue; }
  }

  // Speech config (mobile-stt, vad)
  if (speechIdx.length > 0) {
    const speechConfigs = speechIdx.map(i => ({
      speechType: nodes[i].type,
      config: { ...(nodes[i].config ?? {}) },
    }));
    ws.send(JSON.stringify({ type: "speech_stage_config", stages: speechConfigs, enabled: true }));
    console.log(`[relay] Replayed speech config (${speechConfigs.length} stages) session=${sid}`);
  }

  // Vision config — send ONE combined config with ALL detection types
  // (same fix as activation dispatch — per-node messages cause unregister race)
  const thumbnailNodeIdx = nodes.findIndex(n => n.type === "vision-thumbnails");
  const thumbnailCfg = thumbnailNodeIdx >= 0
    ? (nodes[thumbnailNodeIdx].config as any)
    : null;

  // Determine which detection types get thumbnails — only types that feed into the thumbnail node via edges.
  // If no edges info, fall back to all detection types (backward compat).
  const thumbnailDetTypes: string[] = [];
  if (thumbnailNodeIdx >= 0 && edges && edges.length > 0) {
    const thumbNodeId = nodes[thumbnailNodeIdx].id;
    // Find upstream vision nodes connected TO the thumbnail node
    for (const edge of edges) {
      if (edge.targetNodeId === thumbNodeId) {
        const srcIdx = nodes.findIndex(n => n.id === edge.sourceNodeId);
        if (srcIdx >= 0) {
          const srcDef = NODE_DEF_MAP.get(nodes[srcIdx].type);
          if (srcDef?.activationMode === "vision") {
            thumbnailDetTypes.push(nodes[srcIdx].type);
          }
        }
      }
    }
  }

  if (visionIdx.length > 0) {
    const allDetTypes: string[] = [];
    let bestConf = 0.5, bestSmooth = 0.3, bestFps = 5, bestMax = 0, bestLabels = 5;
    let bestLang = "en-US";
    const allSym: Record<string, boolean> = {};

    for (const i of visionIdx) {
      allDetTypes.push(nodes[i].type);
      const cfg = nodes[i].config as any;
      if (cfg?.confidence != null) bestConf = Math.min(bestConf, cfg.confidence);
      if (cfg?.smoothingAlpha != null) bestSmooth = Math.min(bestSmooth, cfg.smoothingAlpha);
      if (cfg?.targetFPS != null) bestFps = Math.max(bestFps, cfg.targetFPS);
      const mr = cfg?.maxFaces ?? cfg?.maxPersons ?? cfg?.maxPoses ?? 0;
      if (mr > 0) bestMax = Math.max(bestMax, mr);
      if (cfg?.language) bestLang = cfg.language;
      if (cfg?.maxLabels) bestLabels = Math.max(bestLabels, cfg.maxLabels);
      if (cfg?.symbologies) Object.assign(allSym, cfg.symbologies);
    }
    if (Object.keys(allSym).length === 0 && allDetTypes.includes("vision-barcode-scan")) {
      Object.assign(allSym, { qr: true });
    }

    ws.send(JSON.stringify({
      type: "vision_stage_config",
      nodeType: allDetTypes[0],
      detectionTypes: allDetTypes,
      confidence: bestConf,
      smoothingAlpha: bestSmooth,
      targetFPS: bestFps,
      maxResults: bestMax,
      language: bestLang,
      symbologies: Object.entries(allSym).filter(([, v]) => v).map(([k]) => k),
      maxLabels: bestLabels,
      thumbnailsEnabled: !!thumbnailCfg,
      thumbnailDetectionTypes: thumbnailDetTypes.length > 0 ? thumbnailDetTypes : (thumbnailCfg ? allDetTypes : []),
      thumbnailSize: thumbnailCfg?.thumbnailSize ?? 64,
      thumbnailMaxCount: thumbnailCfg?.maxCount ?? 4,
      thumbnailQuality: thumbnailCfg?.quality ?? 0.6,
    }));
    console.log(`[relay] Replayed vision config: types=${allDetTypes.join(",")} session=${sid}`);
  }

  // Enhance config
  if (enhanceIdx.length > 0) {
    const filters = enhanceIdx.map(i => ({
      type: nodes[i].type,
      params: (nodes[i].config ?? {}) as Record<string, number>,
    }));
    ws.send(JSON.stringify({ type: "enhance_stage_config", filters, enabled: true }));
    console.log(`[relay] Replayed enhance config (${filters.length} filters) session=${sid}`);
  }

  // Sensor config
  if (sensorIdx.length > 0) {
    const sensors = sensorIdx.map(i => {
      const rawConfig = { ...(nodes[i].config ?? {}) as Record<string, unknown> };
      if (nodes[i].type === "sensor-sound" && typeof rawConfig.targetLabels === "string") {
        rawConfig.targetLabels = (rawConfig.targetLabels as string).split(",").map((s: string) => s.trim()).filter((s: string) => s.length > 0);
      }
      // Resolve upstream audio source for sensor-sound on reconnect
      if (nodes[i].type === "sensor-sound" && edges) {
        const inputCfg = resolveSourceInput(nodes[i].id, nodes as any, edges as any);
        if (inputCfg.glassesMic && !inputCfg.phoneMic) {
          rawConfig.audioSource = "glasses";
        } else {
          rawConfig.audioSource = "phone";
        }
      }
      // Normalize location variants to "sensor-location" + inject mode from type
      const effectiveType = nodes[i].type.startsWith("sensor-location")
        ? "sensor-location"
        : nodes[i].type;
      const modeOverride = nodes[i].type.startsWith("sensor-location-")
        ? nodes[i].type.replace("sensor-location-", "")
        : nodes[i].type === "sensor-location" ? "continuous" : undefined;
      if (modeOverride) rawConfig.mode = modeOverride;

      return { sensorType: effectiveType, config: rawConfig };
    });
    ws.send(JSON.stringify({ type: "sensor_stage_config", sensors, enabled: true }));
    console.log(`[relay] Replayed sensor config (${sensors.length} sensors) session=${sid}`);
  }

  // Tracking config (OC-SORT)
  if (trackingIdx.length > 0) {
    // Collect gate/cost nodes from workflow nodes
    const gateNodes = nodes.filter(n => n.type && typeof n.type === "string" && (n.type.startsWith("gate-") || n.type.startsWith("cost-")));
    const gateNodeMap = new Map(gateNodes.map(n => [n.id, n]));

    for (const i of trackingIdx) {
      const cfg = (nodes[i].config ?? {}) as Record<string, unknown>;
      const targetClasses = typeof cfg.targetClasses === "string" && (cfg.targetClasses as string).length > 0
        ? (cfg.targetClasses as string).split(",").map(s => s.trim()).filter(s => s.length > 0)
        : [];

      // Build ordered gate chain via BFS on edges
      const trackerNodeId = nodes[i].id;
      const gates: Array<{ gateType: string; params: Record<string, number> }> = [];
      if (edges && edges.length > 0) {
        const visited = new Set<string>();
        const queue: string[] = [trackerNodeId];
        while (queue.length > 0) {
          const targetId = queue.shift()!;
          if (visited.has(targetId)) continue;
          visited.add(targetId);
          for (const edge of edges) {
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

      ws.send(JSON.stringify({
        type: "tracking_stage_config",
        enabled: true,
        targetClasses,
        confidence: (cfg.confidence as number) ?? 0.5,
        // Ref: arXiv:2203.14360 Sec 4.2 — OCM parameters
        iouThreshold: (cfg.iouThreshold as number) ?? 0.3,
        maxTracks: (cfg.maxTracks as number) ?? 0,
        maxAge: (cfg.maxAge as number) ?? 30,
        minHits: (cfg.minHits as number) ?? 3,
        targetFPS: (cfg.targetFPS as number) ?? 10,
        smoothingAlpha: (cfg.smoothingAlpha as number) ?? 0.3,
        zones: (cfg.zones as Array<Record<string, unknown>>) ?? [],
        deltaT: (cfg.deltaT as number) ?? 3,
        inertia: (cfg.inertia as number) ?? 0.2,
        detThresh: (cfg.detThresh as number) ?? 0.5,
        useByte: (cfg.useByte as boolean) ?? false,
        gates: pureGates,
        costFunction,
      }));
    }
    console.log(`[relay] Replayed tracking config (${trackingIdx.length} nodes) session=${sid}`);
  }

  // Tool measurement config (homography + reference object)
  if (measureIdx.length > 0) {
    for (const i of measureIdx) {
      const cfg = (nodes[i].config ?? {}) as Record<string, unknown>;
      ws.send(JSON.stringify({
        type: "measure_stage_config",
        enabled: true,
        referenceObject: (cfg.referenceObject as string) ?? "auto",
        maxMeasurementError: (cfg.maxMeasurementError as number) ?? 2.0,
        targetFPS: (cfg.targetFPS as number) ?? 1,
        smoothingAlpha: (cfg.smoothingAlpha as number) ?? 0.5,
        confidence: (cfg.confidence as number) ?? 0.6,
      }));
    }
    console.log(`[relay] Replayed measure config (${measureIdx.length} nodes) session=${sid}`);
  }
}
