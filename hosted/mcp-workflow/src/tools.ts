/**
 * Tool registrations for the MWDAT workflow MCP server.
 * 14 tools covering workflow CRUD, node/edge operations, activation, and node definitions.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as api from "./client.js";
import type { WorkflowDetail, NodeDefinition } from "./types.js";

// --- Helpers ---

function fmtWorkflow(w: WorkflowDetail): string {
  const lines = [
    `# ${w.name} (${w.id})`,
    `Status: ${w.status} | Created: ${w.createdAt} | Updated: ${w.updatedAt}`,
  ];
  if (w.description) lines.push(`Description: ${w.description}`);
  lines.push(`Nodes: ${w.nodes.length} | Edges: ${w.edges.length}`);
  if (w.flowConfig) lines.push(`Flow: ${w.flowConfig.mode} (${w.flowConfig.flowOrder.length} flows)`);
  lines.push("", "## Nodes");
  for (const n of w.nodes) {
    const cfgKeys = Object.keys(n.config);
    lines.push(`- [${n.id}] ${n.type} "${n.label}" at (${n.positionX}, ${n.positionY})${cfgKeys.length ? ` config: {${cfgKeys.join(", ")}}` : ""}`);
  }
  if (w.edges.length) {
    lines.push("", "## Edges");
    for (const e of w.edges) {
      lines.push(`- [${e.id}] ${e.sourceNodeId} -> ${e.targetNodeId}`);
    }
  }
  return lines.join("\n");
}

function fmtNodeDef(d: NodeDefinition): string {
  const lines = [
    `## ${d.label} (${d.type})`,
    `Role: ${d.role} | Activation: ${d.activationMode ?? "none"} | Runtime: ${d.runtime.join(", ")}`,
    `Subtitle: "${d.subtitle}"`,
    `Allowed targets: ${d.allowedTargets.join(", ")}`,
  ];
  if (d.allowedSources?.length) lines.push(`Allowed sources: ${d.allowedSources.join(", ")}`);
  if (d.defaultModel) lines.push(`Default model: ${d.defaultModel}`);
  if (d.configSchema.length) {
    lines.push("Config fields:");
    for (const f of d.configSchema) {
      if ("key" in f) lines.push(`  - ${f.kind}: ${f.key} "${"label" in f ? f.label : ""}"`);
      else if (f.kind === "section") lines.push(`  - section: ${f.label}`);
    }
  }
  return lines.join("\n");
}

function handleErr(err: unknown): { content: Array<{ type: "text"; text: string }>; isError: true } {
  const msg = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
}

// Nanoid-style ID generator (no dep)
function nanoid(size = 10): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < size; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

// --- Tool Registration ---

export function registerTools(server: McpServer): void {
  // 1. List workflows
  server.registerTool(
    "wf_list_workflows",
    {
      title: "List Workflows",
      description: `List all workflows with summary info (id, name, status, node count, last updated).

Returns markdown table of all workflows. Use wf_get_workflow for full details on a specific one.`,
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async () => {
      try {
        const workflows = await api.listWorkflows();
        if (!workflows.length) return { content: [{ type: "text", text: "No workflows found." }] };

        const lines = ["# Workflows", "", "| ID | Name | Status | Nodes | Updated |", "|---|---|---|---|---|"];
        for (const w of workflows) {
          lines.push(`| ${w.id} | ${w.name} | ${w.status} | ${w.nodeCount} | ${w.updatedAt} |`);
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) { return handleErr(err); }
    },
  );

  // 2. Get workflow
  server.registerTool(
    "wf_get_workflow",
    {
      title: "Get Workflow",
      description: `Get full workflow detail: name, description, status, all nodes (type, label, config, position), all edges, flow config, and settings.

Returns structured markdown with node and edge listings.`,
      inputSchema: { workflow_id: z.string().describe("Workflow ID") },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ workflow_id }) => {
      try {
        const w = await api.getWorkflow(workflow_id);
        return { content: [{ type: "text", text: fmtWorkflow(w) }] };
      } catch (err) { return handleErr(err); }
    },
  );

  // 3. Create workflow
  server.registerTool(
    "wf_create_workflow",
    {
      title: "Create Workflow",
      description: `Create a new workflow. Optionally provide initial nodes and edges.

Pass name (required) and optionally description, nodes array, edges array.
Each node needs: { id, type, label?, config?, positionX?, positionY? }
Each edge needs: { id, sourceNodeId, targetNodeId }

Use wf_get_node_definitions to find valid node types. Returns the created workflow.`,
      inputSchema: {
        name: z.string().min(1).describe("Workflow name"),
        description: z.string().optional().describe("Workflow description"),
        nodes: z.array(z.object({
          id: z.string(),
          type: z.string(),
          label: z.string().optional(),
          config: z.string().optional().describe("JSON string of node config"),
          positionX: z.number().optional().default(0),
          positionY: z.number().optional().default(0),
        })).optional().describe("Initial nodes"),
        edges: z.array(z.object({
          id: z.string(),
          sourceNodeId: z.string(),
          targetNodeId: z.string(),
        })).optional().describe("Initial edges"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (params) => {
      try {
        const w = await api.createWorkflow(params);
        return { content: [{ type: "text", text: `Created workflow:\n${fmtWorkflow(w)}` }] };
      } catch (err) { return handleErr(err); }
    },
  );

  // 4. Update workflow
  server.registerTool(
    "wf_update_workflow",
    {
      title: "Update Workflow",
      description: `Update workflow metadata: name, description, status, settings, or flow config.

Does NOT update nodes/edges directly — use wf_add_node, wf_remove_node, wf_add_edge, wf_remove_edge for graph mutations.`,
      inputSchema: {
        workflow_id: z.string().describe("Workflow ID"),
        name: z.string().optional(),
        description: z.string().optional(),
        status: z.enum(["draft", "published", "archived"]).optional(),
        canvas_viewport: z.string().optional().describe("JSON string: {x, y, zoom}"),
        flow_config: z.string().optional().describe("JSON string: FlowExecutionConfig"),
        settings: z.string().optional().describe("JSON string: WorkflowSettings"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ workflow_id, ...params }) => {
      try {
        const body: Record<string, unknown> = {};
        if (params.name !== undefined) body.name = params.name;
        if (params.description !== undefined) body.description = params.description;
        if (params.status !== undefined) body.status = params.status;
        if (params.canvas_viewport !== undefined) body.canvasViewport = params.canvas_viewport;
        if (params.flow_config !== undefined) body.flowConfig = JSON.parse(params.flow_config);
        if (params.settings !== undefined) body.settings = JSON.parse(params.settings);

        const w = await api.updateWorkflow(workflow_id, body);
        return { content: [{ type: "text", text: `Updated workflow:\n${fmtWorkflow(w)}` }] };
      } catch (err) { return handleErr(err); }
    },
  );

  // 5. Delete workflow
  server.registerTool(
    "wf_delete_workflow",
    {
      title: "Delete Workflow",
      description: `Delete a workflow and all its nodes and edges (cascade delete). This is irreversible.`,
      inputSchema: {
        workflow_id: z.string().describe("Workflow ID to delete"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ workflow_id }) => {
      try {
        await api.deleteWorkflow(workflow_id);
        return { content: [{ type: "text", text: `Deleted workflow ${workflow_id}` }] };
      } catch (err) { return handleErr(err); }
    },
  );

  // 6. Add node
  server.registerTool(
    "wf_add_node",
    {
      title: "Add Node to Workflow",
      description: `Add a new node to an existing workflow. Fetches current workflow, appends node, saves.

Use wf_get_node_definitions to find valid node types and their default configs.
Returns updated workflow.`,
      inputSchema: {
        workflow_id: z.string().describe("Workflow ID"),
        node_type: z.string().describe("Node type from node definitions (e.g. 'camera-source', 's2s-live', 'vision-ocr')"),
        label: z.string().optional().describe("Node label (defaults to node type label)"),
        config: z.string().optional().describe("JSON string of node config"),
        position_x: z.number().optional().describe("X position on canvas (default 200)"),
        position_y: z.number().optional().describe("Y position on canvas (default 200)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ workflow_id, node_type, label, config, position_x, position_y }) => {
      try {
        const w = await api.getWorkflow(workflow_id);
        const nodeId = `node_${nanoid()}`;
        const nodeConfig = config ? JSON.parse(config) : {};

        w.nodes.push({
          id: nodeId,
          type: node_type,
          label: label ?? node_type,
          config: nodeConfig,
          positionX: position_x ?? 200,
          positionY: position_y ?? 200,
        });

        const updated = await api.updateWorkflow(workflow_id, {
          nodes: w.nodes.map((n) => ({
            id: n.id,
            type: n.type,
            label: n.label,
            config: JSON.stringify(n.config),
            positionX: n.positionX,
            positionY: n.positionY,
          })),
          edges: w.edges.map((e) => ({
            id: e.id,
            sourceNodeId: e.sourceNodeId,
            targetNodeId: e.targetNodeId,
          })),
        });
        return { content: [{ type: "text", text: `Added node ${nodeId} (${node_type}):\n${fmtWorkflow(updated)}` }] };
      } catch (err) { return handleErr(err); }
    },
  );

  // 7. Remove node
  server.registerTool(
    "wf_remove_node",
    {
      title: "Remove Node from Workflow",
      description: `Remove a node and all its connected edges from a workflow. Read-modify-write pattern.`,
      inputSchema: {
        workflow_id: z.string().describe("Workflow ID"),
        node_id: z.string().describe("Node ID to remove"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ workflow_id, node_id }) => {
      try {
        const w = await api.getWorkflow(workflow_id);
        const node = w.nodes.find((n) => n.id === node_id);
        if (!node) return { content: [{ type: "text", text: `Node ${node_id} not found in workflow` }] };

        const remainingNodes = w.nodes.filter((n) => n.id !== node_id);
        const remainingEdges = w.edges.filter((e) => e.sourceNodeId !== node_id && e.targetNodeId !== node_id);

        const updated = await api.updateWorkflow(workflow_id, {
          nodes: remainingNodes.map((n) => ({
            id: n.id, type: n.type, label: n.label,
            config: JSON.stringify(n.config), positionX: n.positionX, positionY: n.positionY,
          })),
          edges: remainingEdges.map((e) => ({
            id: e.id, sourceNodeId: e.sourceNodeId, targetNodeId: e.targetNodeId,
          })),
        });
        return { content: [{ type: "text", text: `Removed node ${node_id} (${node.type}):\n${fmtWorkflow(updated)}` }] };
      } catch (err) { return handleErr(err); }
    },
  );

  // 8. Update node
  server.registerTool(
    "wf_update_node",
    {
      title: "Update Node in Workflow",
      description: `Update a node's label, config, or position. Read-modify-write pattern.
Pass config as a JSON string to replace the full config object.`,
      inputSchema: {
        workflow_id: z.string().describe("Workflow ID"),
        node_id: z.string().describe("Node ID to update"),
        label: z.string().optional().describe("New label"),
        config: z.string().optional().describe("JSON string of full node config (replaces existing)"),
        position_x: z.number().optional().describe("New X position"),
        position_y: z.number().optional().describe("New Y position"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ workflow_id, node_id, label, config, position_x, position_y }) => {
      try {
        const w = await api.getWorkflow(workflow_id);
        const node = w.nodes.find((n) => n.id === node_id);
        if (!node) return { content: [{ type: "text", text: `Node ${node_id} not found` }] };

        if (label !== undefined) node.label = label;
        if (config !== undefined) node.config = JSON.parse(config);
        if (position_x !== undefined) node.positionX = position_x;
        if (position_y !== undefined) node.positionY = position_y;

        const updated = await api.updateWorkflow(workflow_id, {
          nodes: w.nodes.map((n) => ({
            id: n.id, type: n.type, label: n.label,
            config: JSON.stringify(n.config), positionX: n.positionX, positionY: n.positionY,
          })),
          edges: w.edges.map((e) => ({
            id: e.id, sourceNodeId: e.sourceNodeId, targetNodeId: e.targetNodeId,
          })),
        });
        return { content: [{ type: "text", text: `Updated node ${node_id}:\n${fmtWorkflow(updated)}` }] };
      } catch (err) { return handleErr(err); }
    },
  );

  // 9. Add edge
  server.registerTool(
    "wf_add_edge",
    {
      title: "Add Edge to Workflow",
      description: `Add a connection between two nodes. Validates that both nodes exist.
For allowedTargets validation, check node definitions with wf_get_node_definition first.`,
      inputSchema: {
        workflow_id: z.string().describe("Workflow ID"),
        source_node_id: z.string().describe("Source node ID (output port)"),
        target_node_id: z.string().describe("Target node ID (input port)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ workflow_id, source_node_id, target_node_id }) => {
      try {
        const w = await api.getWorkflow(workflow_id);
        const source = w.nodes.find((n) => n.id === source_node_id);
        const target = w.nodes.find((n) => n.id === target_node_id);
        if (!source) return { content: [{ type: "text", text: `Source node ${source_node_id} not found` }] };
        if (!target) return { content: [{ type: "text", text: `Target node ${target_node_id} not found` }] };

        const existing = w.edges.find(
          (e) => e.sourceNodeId === source_node_id && e.targetNodeId === target_node_id,
        );
        if (existing) return { content: [{ type: "text", text: `Edge already exists: ${existing.id}` }] };

        const edgeId = `edge_${nanoid()}`;
        w.edges.push({ id: edgeId, sourceNodeId: source_node_id, targetNodeId: target_node_id });

        const updated = await api.updateWorkflow(workflow_id, {
          nodes: w.nodes.map((n) => ({
            id: n.id, type: n.type, label: n.label,
            config: JSON.stringify(n.config), positionX: n.positionX, positionY: n.positionY,
          })),
          edges: w.edges.map((e) => ({
            id: e.id, sourceNodeId: e.sourceNodeId, targetNodeId: e.targetNodeId,
          })),
        });
        return { content: [{ type: "text", text: `Added edge ${edgeId} (${source.type} -> ${target.type}):\n${fmtWorkflow(updated)}` }] };
      } catch (err) { return handleErr(err); }
    },
  );

  // 10. Remove edge
  server.registerTool(
    "wf_remove_edge",
    {
      title: "Remove Edge from Workflow",
      description: `Remove a connection between two nodes by edge ID.`,
      inputSchema: {
        workflow_id: z.string().describe("Workflow ID"),
        edge_id: z.string().describe("Edge ID to remove"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ workflow_id, edge_id }) => {
      try {
        const w = await api.getWorkflow(workflow_id);
        const edge = w.edges.find((e) => e.id === edge_id);
        if (!edge) return { content: [{ type: "text", text: `Edge ${edge_id} not found` }] };

        const remainingEdges = w.edges.filter((e) => e.id !== edge_id);

        const updated = await api.updateWorkflow(workflow_id, {
          nodes: w.nodes.map((n) => ({
            id: n.id, type: n.type, label: n.label,
            config: JSON.stringify(n.config), positionX: n.positionX, positionY: n.positionY,
          })),
          edges: remainingEdges.map((e) => ({
            id: e.id, sourceNodeId: e.sourceNodeId, targetNodeId: e.targetNodeId,
          })),
        });
        return { content: [{ type: "text", text: `Removed edge ${edge_id}:\n${fmtWorkflow(updated)}` }] };
      } catch (err) { return handleErr(err); }
    },
  );

  // 11. Validate workflow
  server.registerTool(
    "wf_validate_workflow",
    {
      title: "Validate Workflow",
      description: `Validate a workflow's structure: check node types exist, edges reference valid nodes, no orphaned edges, and optional allowedTargets checks.`,
      inputSchema: {
        workflow_id: z.string().describe("Workflow ID to validate"),
        check_edges: z.boolean().optional().default(true).describe("Check allowedTargets for each edge"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ workflow_id, check_edges }) => {
      try {
        const [w, defs] = await Promise.all([api.getWorkflow(workflow_id), api.getNodeDefinitions()]);
        const defMap = new Map(defs.map((d) => [d.type, d]));
        const nodeIds = new Set(w.nodes.map((n) => n.id));
        const issues: string[] = [];

        // Check node types
        for (const n of w.nodes) {
          if (!defMap.has(n.type)) issues.push(`Unknown node type: ${n.type} (node ${n.id})`);
        }

        // Check edge references
        for (const e of w.edges) {
          if (!nodeIds.has(e.sourceNodeId)) issues.push(`Edge ${e.id}: source ${e.sourceNodeId} not found`);
          if (!nodeIds.has(e.targetNodeId)) issues.push(`Edge ${e.id}: target ${e.targetNodeId} not found`);
        }

        // Check orphans
        const connectedNodes = new Set<string>();
        for (const e of w.edges) {
          connectedNodes.add(e.sourceNodeId);
          connectedNodes.add(e.targetNodeId);
        }
        for (const n of w.nodes) {
          if (!connectedNodes.has(n.id) && w.nodes.length > 1) {
            issues.push(`Orphaned node: ${n.id} (${n.type}) — not connected to any edge`);
          }
        }

        // Check allowedTargets
        if (check_edges) {
          for (const e of w.edges) {
            const sourceNode = w.nodes.find((n) => n.id === e.sourceNodeId);
            const targetNode = w.nodes.find((n) => n.id === e.targetNodeId);
            if (!sourceNode || !targetNode) continue;

            const sourceDef = defMap.get(sourceNode.type);
            if (sourceDef && !sourceDef.allowedTargets.includes(targetNode.type)) {
              // Check sentinels
              const targetDef = defMap.get(targetNode.type);
              const sentinelOk =
                (sourceDef.allowedTargets.includes("<sink>") && targetDef?.role === "sink") ||
                (sourceDef.allowedTargets.includes("<trigger>") && targetDef?.role === "trigger") ||
                (sourceDef.allowedTargets.includes("<source>") && targetDef?.role === "source");
              if (!sentinelOk) {
                issues.push(`Edge ${e.id}: ${sourceNode.type} -> ${targetNode.type} not in allowedTargets`);
              }
            }
          }
        }

        if (!issues.length) {
          return { content: [{ type: "text", text: `Workflow "${w.name}" is valid. ${w.nodes.length} nodes, ${w.edges.length} edges, no issues found.` }] };
        }
        return { content: [{ type: "text", text: `Validation issues (${issues.length}):\n${issues.map((i) => `- ${i}`).join("\n")}` }] };
      } catch (err) { return handleErr(err); }
    },
  );

  // 12. Activate workflow
  server.registerTool(
    "wf_activate_workflow",
    {
      title: "Activate Workflow",
      description: `Activate a workflow on an active session. Optionally specify a session ID, device ID for wake, or override an active workflow.

If no session ID is provided, the server will select the active session. Returns activation status and any conflict info.`,
      inputSchema: {
        workflow_id: z.string().describe("Workflow ID to activate"),
        session_id: z.string().optional().describe("Target session ID (optional, uses active session if omitted)"),
        device_id: z.string().optional().describe("Device ID to wake before activation"),
        override: z.boolean().optional().default(false).describe("Override any currently active workflow"),
        reason: z.string().optional().describe("Reason for override (logged)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ workflow_id, session_id, device_id, override, reason }) => {
      try {
        const result = await api.activateWorkflow(workflow_id, session_id, { override, reason, deviceId: device_id });
        if (result.status === "conflict") {
          return {
            content: [{
              type: "text",
              text: `Conflict: another workflow is active (appId: ${result.conflict?.activeAppId ?? "unknown"}, status: ${result.conflict?.status}). Set override=true to force activation.`,
            }],
          };
        }
        return { content: [{ type: "text", text: `Activated workflow ${workflow_id}: appId=${result.appId}, status=${result.status}` }] };
      } catch (err) { return handleErr(err); }
    },
  );

  // 13. List node definitions
  server.registerTool(
    "wf_get_node_definitions",
    {
      title: "List Node Definitions",
      description: `List all available node types for building workflows. Returns type, label, role, activation mode, allowed targets, runtime, and config schema summary.

Use wf_get_node_definition for full details on a specific type. Results are cached for 1 minute.`,
      inputSchema: {
        role: z.string().optional().describe("Filter by role: source, processor, trigger, transform, sink, gating, reference"),
        activation_mode: z.string().optional().describe("Filter by activation mode: ai, vision, enhance, tracking, sensor, speech, measure, yolo, jepa, palantir, stt, passthrough"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ role, activation_mode }) => {
      try {
        let defs = await api.getNodeDefinitions();
        if (role) defs = defs.filter((d) => d.role === role);
        if (activation_mode) defs = defs.filter((d) => d.activationMode === activation_mode);

        if (!defs.length) return { content: [{ type: "text", text: "No node definitions match filters." }] };

        const lines = [`# Node Definitions (${defs.length})`, "", "| Type | Label | Role | Activation | Runtime | Targets |", "|---|---|---|---|---|---|"];
        for (const d of defs) {
          const targets = d.allowedTargets.length > 4 ? `${d.allowedTargets.slice(0, 3).join(", ")} +${d.allowedTargets.length - 3}` : d.allowedTargets.join(", ");
          lines.push(`| ${d.type} | ${d.label} | ${d.role} | ${d.activationMode ?? "-"} | ${d.runtime.join(",")} | ${targets} |`);
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) { return handleErr(err); }
    },
  );

  // 14. Get single node definition
  server.registerTool(
    "wf_get_node_definition",
    {
      title: "Get Node Definition",
      description: `Get full details for a specific node type: label, subtitle, color, role, activation mode, allowed targets/sources, config schema with all fields, default config, and subnodes.`,
      inputSchema: {
        node_type: z.string().describe("Node type string (e.g. 'camera-source', 's2s-live', 'vision-ocr', 'tracking-ocsort')"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ node_type }) => {
      try {
        const defs = await api.getNodeDefinitions();
        const def = defs.find((d) => d.type === node_type);
        if (!def) {
          const similar = defs.filter((d) => d.type.includes(node_type) || node_type.includes(d.type)).map((d) => d.type);
          const hint = similar.length ? ` Similar types: ${similar.join(", ")}` : "";
          return { content: [{ type: "text", text: `Node type "${node_type}" not found.${hint}` }] };
        }
        return { content: [{ type: "text", text: fmtNodeDef(def) }] };
      } catch (err) { return handleErr(err); }
    },
  );
}
