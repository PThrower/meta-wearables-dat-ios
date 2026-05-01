import { NODE_DEF_MAP, resolveNodeType } from "./node-definitions.js";
import type { FlowExecutionConfig } from "./app-types.js";

/** BFS from a node to find the nearest speaker sink type — returns true if glasses-speaker reachable */
export function resolveSinkTarget(
  startNodeId: string,
  nodes: Array<{ id: string; type: string }>,
  edges: Array<{ sourceNodeId: string; targetNodeId: string }>,
): boolean {
  const visited = new Set<string>();
  const queue = [startNodeId];
  visited.add(startNodeId);
  while (queue.length > 0) {
    const currentId = queue.shift()!;
    for (const edge of edges) {
      if (edge.sourceNodeId !== currentId) continue;
      if (visited.has(edge.targetNodeId)) continue;
      visited.add(edge.targetNodeId);
      const targetNode = nodes.find(n => n.id === edge.targetNodeId);
      if (!targetNode) continue;
      const resolved = resolveNodeType(targetNode.type);
      if (resolved === "glasses-speaker") return true;
      // Keep walking through transforms
      const def = NODE_DEF_MAP.get(resolved);
      if (def?.role === "transform" || def?.role === "sink") {
        queue.push(edge.targetNodeId);
      }
    }
  }
  return false;
}

/** Estimate speech duration for a group of TTS chains (ms).
 *  ~150 wpm average, ~5 chars/word → ~12.5 chars/sec → 80ms/char.
 *  Adds 500ms buffer per chain for synthesis startup overhead. */
export function estimateGroupDuration(chains: Array<{ textContent: string }>): number {
  let totalMs = 0;
  for (const chain of chains) {
    totalMs += Math.max(chain.textContent.length * 80, 1500); // floor of 1.5s per chain
    totalMs += 500; // synthesis buffer
  }
  return totalMs;
}

/** Push text→local-tts→speaker chains for passive workflows to the publisher */
export function pushPassiveTTSChains(
  nodes: Array<{ id: string; type: string; config: Record<string, unknown> }>,
  edges: Array<{ sourceNodeId: string; targetNodeId: string }>,
  publisherWs: { send: (data: string) => void; readyState: number },
  sessionId: string,
  flowConfig?: FlowExecutionConfig | null,
): void {
  if (publisherWs.readyState !== 1) return; // WebSocket.OPEN

  // Build all text→tts chains, keyed by the text node's flow
  const chains: Array<{ textNodeId: string; textContent: string; ttsNodeId: string; preferGlasses: boolean; flowId: string }> = [];
  for (const node of nodes) {
    if (node.type !== "text") continue;
    const textContent = node.config?.text as string | undefined;
    if (!textContent) continue;
    for (const edge of edges) {
      if (edge.sourceNodeId !== node.id) continue;
      const ttsNode = nodes.find(n => n.id === edge.targetNodeId);
      if (!ttsNode) continue;
      const ttsDef = NODE_DEF_MAP.get(resolveNodeType(ttsNode.type));
      if (ttsDef?.type !== "local-tts") continue;
      const preferGlasses = resolveSinkTarget(ttsNode.id, nodes, edges);
      // Determine flowId from the text node (lexicographically smallest node in its component)
      const flowId = getFlowIdForNode(node.id, nodes, edges);
      chains.push({ textNodeId: node.id, textContent, ttsNodeId: ttsNode.id, preferGlasses, flowId });
    }
  }

  // Determine push order
  const flowOrder = flowConfig?.flowOrder;
  if (flowOrder && flowOrder.length > 1) {
    // Sort chains by their flow's position in flowOrder
    const orderMap = new Map(flowOrder.map((fid, idx) => [fid, idx]));
    chains.sort((a, b) => (orderMap.get(a.flowId) ?? 999) - (orderMap.get(b.flowId) ?? 999));
  }

  // For sequential mode: push all chains but with inter-flow delays
  const mode = flowConfig?.mode ?? "parallel";
  if (mode === "sequential" && chains.length > 1) {
    // Group chains by flowId, preserving configured flow order
    const flowGroups = new Map<string, typeof chains>();
    for (const chain of chains) {
      if (!flowGroups.has(chain.flowId)) flowGroups.set(chain.flowId, []);
      flowGroups.get(chain.flowId)!.push(chain);
    }
    const groups = [...flowGroups.values()];

    // Push first flow's chains immediately
    for (const chain of groups[0]) {
      publisherWs.send(JSON.stringify({ type: "audio_route", preferGlasses: chain.preferGlasses }));
      publisherWs.send(JSON.stringify({ type: "guidance_text", text: chain.textContent, preferGlasses: chain.preferGlasses }));
      console.log(`[relay] Passive TTS (sequential flow 0): pushed text (${chain.textContent.length} chars) preferGlasses=${chain.preferGlasses} session=${sessionId}`);
    }

    // Subsequent flows delayed by estimated speech duration of prior flows
    // ~150 wpm average TTS speed, ~5 chars/word → ~12.5 chars/sec → 80ms/char
    // Add 500ms buffer per chain for synthesis overhead
    let delayMs = estimateGroupDuration(groups[0]);
    for (let gi = 1; gi < groups.length; gi++) {
      const group = groups[gi];
      const capturedDelay = delayMs;
      const giLabel = gi;
      setTimeout(() => {
        for (const chain of group) {
          publisherWs.send(JSON.stringify({ type: "audio_route", preferGlasses: chain.preferGlasses }));
          publisherWs.send(JSON.stringify({ type: "guidance_text", text: chain.textContent, preferGlasses: chain.preferGlasses }));
          console.log(`[relay] Passive TTS (sequential flow ${giLabel}, delayed ${capturedDelay}ms): pushed text (${chain.textContent.length} chars) preferGlasses=${chain.preferGlasses} session=${sessionId}`);
        }
      }, delayMs);
      delayMs += estimateGroupDuration(group);
    }
    return;
  }

  // Parallel or default: push all immediately in order
  for (const chain of chains) {
    publisherWs.send(JSON.stringify({ type: "audio_route", preferGlasses: chain.preferGlasses }));
    publisherWs.send(JSON.stringify({ type: "guidance_text", text: chain.textContent, preferGlasses: chain.preferGlasses }));
    console.log(`[relay] Passive TTS: pushed text (${chain.textContent.length} chars) preferGlasses=${chain.preferGlasses} session=${sessionId}`);
  }
}

/** Determine the flowId for a node using the same algorithm as detectFlows (lexicographically smallest node in the connected component) */
export function getFlowIdForNode(
  targetNodeId: string,
  nodes: Array<{ id: string }>,
  edges: Array<{ sourceNodeId: string; targetNodeId: string }>,
): string {
  // BFS from targetNodeId to find all nodes in its connected component
  const adjacency = new Map<string, string[]>();
  for (const n of nodes) adjacency.set(n.id, []);
  for (const e of edges) {
    if (adjacency.has(e.sourceNodeId) && adjacency.has(e.targetNodeId)) {
      adjacency.get(e.sourceNodeId)!.push(e.targetNodeId);
      adjacency.get(e.targetNodeId)!.push(e.sourceNodeId);
    }
  }
  const visited = new Set<string>();
  const queue = [targetNodeId];
  visited.add(targetNodeId);
  let smallest = targetNodeId;
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current < smallest) smallest = current;
    for (const neighbor of (adjacency.get(current) ?? [])) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }
  }
  return `flow_${smallest}`;
}

/** Build mobile-side config for passive workflows (no AI, just sinks/transforms) */
export function buildMobileWorkflowConfig(
  nodes: Array<{ id: string; type: string; config: Record<string, unknown> }>,
  edges: Array<{ sourceNodeId: string; targetNodeId: string }>,
): Record<string, unknown> | null {
  const sinkNodes = nodes.filter(n => {
    const def = NODE_DEF_MAP.get(resolveNodeType(n.type));
    return def && (def.role === "sink" || def.role === "transform");
  });
  if (sinkNodes.length === 0) return null;

  const sourceNodes = nodes.filter(n => {
    const def = NODE_DEF_MAP.get(resolveNodeType(n.type));
    return def?.role === "source";
  });
  // Resolve input config from source nodes via OR-merge (same as resolveSourceInput)
  const hasCamera = sourceNodes.some(n => resolveNodeType(n.type) === "camera-source");
  const hasPhoneMic = sourceNodes.some(n => resolveNodeType(n.type) === "phone-mic-source");
  const hasGlassesMic = sourceNodes.some(n => resolveNodeType(n.type) === "glasses-mic-source");
  const hasGestures = sourceNodes.some(n => resolveNodeType(n.type) === "gesture-source");
  return {
    sinks: sinkNodes.map(n => ({ type: n.type, config: n.config })),
    input: sourceNodes.length > 0 ? {
      video: hasCamera,
      phoneMic: hasPhoneMic,
      glassesMic: hasGlassesMic,
      gestures: hasGestures,
    } : undefined,
    edges: edges.map(e => ({ source: e.sourceNodeId, target: e.targetNodeId })),
  };
}
