/**
 * flow-detection.ts — Detect independent flows (weakly connected components)
 * in a workflow DAG using Union-Find.
 *
 * A "flow" is a set of nodes connected by edges (treating edges as undirected).
 * Two disconnected subgraphs = two independent flows.
 */

import type { DetectedFlow } from "./app-types.js";

/** Color palette for flow visualization (cycled when >8 flows) */
export const FLOW_COLORS = [
  "#38bdf8", "#c084fc", "#4ade80", "#fb923c",
  "#f472b6", "#facc15", "#60a5fa", "#f87171",
];

/** Default edge color for single-flow or uncolored workflows */
export const DEFAULT_EDGE_COLOR = "#64748b";

interface UFNode {
  parent: string;
  rank: number;
}

/** Union-Find with path compression and union by rank */
function makeUF(entries: string[]): Map<string, UFNode> {
  const uf = new Map<string, UFNode>();
  for (const id of entries) uf.set(id, { parent: id, rank: 0 });
  return uf;
}

function find(uf: Map<string, UFNode>, x: string): string {
  const node = uf.get(x);
  if (!node) return x;
  if (node.parent !== x) node.parent = find(uf, node.parent);
  return node.parent;
}

function union(uf: Map<string, UFNode>, a: string, b: string): void {
  const ra = find(uf, a);
  const rb = find(uf, b);
  if (ra === rb) return;
  const na = uf.get(ra)!;
  const nb = uf.get(rb)!;
  if (na.rank < nb.rank) {
    na.parent = rb;
  } else if (na.rank > nb.rank) {
    nb.parent = ra;
  } else {
    nb.parent = ra;
    na.rank++;
  }
}

/**
 * Detect independent flows in a workflow DAG.
 *
 * @param nodes - All workflow nodes (only `.id` needed)
 * @param edges - All workflow edges (sourceNodeId/targetNodeId treated as undirected)
 * @returns Array of DetectedFlow, one per connected component
 */
export function detectFlows(
  nodes: Array<{ id: string; type?: string; label?: string }>,
  edges: Array<{ id: string; sourceNodeId: string; targetNodeId: string }>,
): DetectedFlow[] {
  if (nodes.length === 0) return [];

  const uf = makeUF(nodes.map(n => n.id));

  // Union all edges (undirected)
  for (const e of edges) {
    if (uf.has(e.sourceNodeId) && uf.has(e.targetNodeId)) {
      union(uf, e.sourceNodeId, e.targetNodeId);
    }
  }

  // Group nodes by root
  const groups = new Map<string, string[]>();
  for (const n of nodes) {
    const root = find(uf, n.id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(n.id);
  }

  const nodeMap = new Map(nodes.map(n => [n.id, n]));

  const flows: DetectedFlow[] = [];
  let colorIdx = 0;
  for (const [root, nodeIds] of groups) {
    // Stable flow ID based on lexicographically smallest node ID
    const sorted = [...nodeIds].sort();
    const flowId = `flow_${sorted[0]}`;

    // Collect edges belonging to this flow
    const nodeIdSet = new Set(nodeIds);
    const edgeIds = edges
      .filter(e => nodeIdSet.has(e.sourceNodeId) && nodeIdSet.has(e.targetNodeId))
      .map(e => e.id);

    // Build label from first→last node types (using topological sort within the flow)
    const flowEdges = edges.filter(e => nodeIdSet.has(e.sourceNodeId) && nodeIdSet.has(e.targetNodeId));
    const inDeg = new Map<string, number>();
    for (const id of nodeIds) inDeg.set(id, 0);
    for (const e of flowEdges) inDeg.set(e.targetNodeId, (inDeg.get(e.targetNodeId) ?? 0) + 1);
    const topoSorted = [...nodeIds].sort((a, b) => (inDeg.get(a) ?? 0) - (inDeg.get(b) ?? 0));

    const first = nodeMap.get(topoSorted[0]);
    const last = nodeMap.get(topoSorted[topoSorted.length - 1]);
    const firstLabel = first?.type?.replace(/-/g, " ") ?? first?.id ?? "?";
    const lastLabel = last?.type?.replace(/-/g, " ") ?? last?.id ?? "?";
    const label = nodeIds.length === 1 ? firstLabel : `${firstLabel} → ${lastLabel}`;

    flows.push({
      flowId,
      nodeIds,
      edgeIds,
      color: FLOW_COLORS[colorIdx % FLOW_COLORS.length],
      label,
    });
    colorIdx++;
  }

  // Sort flows by their stable flowId for deterministic ordering
  flows.sort((a, b) => a.flowId.localeCompare(b.flowId));
  return flows;
}
