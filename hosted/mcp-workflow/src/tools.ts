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
      description: `Add a connection between two nodes. Validates that both nodes exist AND that the edge is allowed by allowedTargets/allowedSources rules (including sentinel expansion: <sink>, <trigger>, <source>).`,
      inputSchema: {
        workflow_id: z.string().describe("Workflow ID"),
        source_node_id: z.string().describe("Source node ID (output port)"),
        target_node_id: z.string().describe("Target node ID (input port)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ workflow_id, source_node_id, target_node_id }) => {
      try {
        const [w, defs] = await Promise.all([api.getWorkflow(workflow_id), api.getNodeDefinitions()]);
        const defMap = new Map(defs.map((d) => [d.type, d]));
        const source = w.nodes.find((n) => n.id === source_node_id);
        const target = w.nodes.find((n) => n.id === target_node_id);
        if (!source) return { content: [{ type: "text", text: `Source node ${source_node_id} not found` }] };
        if (!target) return { content: [{ type: "text", text: `Target node ${target_node_id} not found` }] };

        const existing = w.edges.find(
          (e) => e.sourceNodeId === source_node_id && e.targetNodeId === target_node_id,
        );
        if (existing) return { content: [{ type: "text", text: `Edge already exists: ${existing.id}` }] };

        // Validate allowedTargets (forward direction)
        const sourceDef = defMap.get(source.type);
        const targetDef = defMap.get(target.type);
        if (sourceDef) {
          const allowedDirect = sourceDef.allowedTargets.includes(target.type);
          const sentinelOk =
            (sourceDef.allowedTargets.includes("<sink>") && targetDef?.role === "sink") ||
            (sourceDef.allowedTargets.includes("<trigger>") && targetDef?.role === "trigger") ||
            (sourceDef.allowedTargets.includes("<source>") && targetDef?.role === "source");
          if (!allowedDirect && !sentinelOk) {
            const validTargets = sourceDef.allowedTargets.join(", ");
            return { content: [{ type: "text", text: `Invalid edge: ${source.type} -> ${target.type} not allowed. Source allowedTargets: ${validTargets}` }] };
          }
        }

        // Validate allowedSources (reverse direction — subnode restriction)
        if (targetDef?.allowedSources?.length) {
          if (!targetDef.allowedSources.includes(source.type)) {
            return { content: [{ type: "text", text: `Invalid edge: ${target.type} does not accept connections from ${source.type}. Target allowedSources: ${targetDef.allowedSources.join(", ")}` }] };
          }
        }

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

  // =====================
  // Runtime Observability
  // =====================

  // 15. Get active sessions
  server.registerTool(
    "wf_get_active_session",
    {
      title: "Get Active Session",
      description: `Get active sessions with device info, publisher state, battery, frame counts, and running workflow.

Returns full runtime context: which device is connected, whether it's streaming, what workflow is active, battery level, and frame/audio stats. Use this before activating to know which session to target.`,
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async () => {
      try {
        const sessions = await api.getActiveSessions();
        if (!sessions.length) return { content: [{ type: "text", text: "No active sessions. Start the iOS app and connect a device." }] };

        const lines = [`# Active Sessions (${sessions.length})`, ""];
        for (const s of sessions) {
          lines.push(`## Session ${s.id}`);
          lines.push(`State: ${s.state} | Link: ${s.linkState} | Uptime: ${Math.round((s.uptimeMs ?? 0) / 1000)}s`);
          lines.push(`Publisher: ${s.publisherConnected ? "connected" : "disconnected"}${s.publisherStandby ? " (standby)" : ""} | Viewers: ${s.viewerCount}`);
          if (s.activeWorkflowId) lines.push(`Active workflow: ${s.activeWorkflowId}`);
          if (s.device) {
            lines.push(`Device: ${s.device.deviceName ?? s.device.deviceModel ?? "unknown"} (${s.device.deviceModel ?? "?"})`);
            if (s.device.appVersion) lines.push(`App: v${s.device.appVersion} (${s.device.buildNumber ?? "?"})`);
          }
          if (s.battery) lines.push(`Battery: ${s.battery.level ?? "?"}% ${s.battery.state ?? ""}${s.battery.lowPowerMode ? " [low power]" : ""}`);
          if (s.frames) lines.push(`Frames: ${s.frames.frameCount} (${Math.round((s.frames.totalBytes ?? 0) / 1024)}KB) | Audio: ${s.frames.audioCount}`);
          lines.push("");
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) { return handleErr(err); }
    },
  );

  // 16. Get node states
  server.registerTool(
    "wf_get_node_states",
    {
      title: "Get Node Execution States",
      description: `Get current execution state of every node in the active workflow for a session.

Returns live node states (running/errored/pending/completed) from the orchestrator, plus recent execution log entries from the database. Use this after activation to verify nodes started correctly, or to diagnose which node failed.`,
      inputSchema: {
        session_id: z.string().describe("Session ID (get from wf_get_active_session)"),
        limit: z.number().int().min(1).max(500).optional().default(50).describe("Max execution log entries to return"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ session_id, limit }) => {
      try {
        const data = await api.getNodeStates(session_id, limit);

        const lines = [`# Node States — Session ${session_id}`];
        if (data.workflowId) {
          lines.push(`Workflow: ${data.workflowName ?? data.workflowId} | Activated: ${data.activatedAt ? new Date(data.activatedAt).toISOString() : "unknown"}`);
        } else {
          lines.push("No active workflow.");
          return { content: [{ type: "text", text: lines.join("\n") }] };
        }

        // Current live states
        lines.push("", `## Live States (${data.nodes.length} nodes)`);
        for (const n of data.nodes) {
          const stateIcon = n.state === "running" ? "[running]" : n.state === "errored" ? "[ERROR]" : n.state === "completed" ? "[done]" : `[${n.state}]`;
          lines.push(`- ${stateIcon} ${n.label} (${n.nodeType}) — node ${n.nodeId}`);
          if (n.error) lines.push(`  Error: ${n.error}`);
          if (n.startedAt) lines.push(`  Started: ${new Date(n.startedAt).toISOString()}`);
          if (n.completedAt) lines.push(`  Completed: ${new Date(n.completedAt).toISOString()}`);
        }

        // Recent execution log
        if (data.log.length) {
          lines.push("", `## Recent Execution Log (${data.log.length} entries)`);
          for (const e of data.log.slice(0, 20)) {
            const ts = new Date(e.timestampMs).toISOString().slice(11, 23);
            lines.push(`- ${ts} ${e.nodeType}/${e.nodeId} ${e.action} → ${e.state}${e.error ? ` ERR: ${e.error}` : ""}`);
          }
          if (data.log.length > 20) lines.push(`  ... and ${data.log.length - 20} more`);
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) { return handleErr(err); }
    },
  );

  // 17. Get telemetry
  server.registerTool(
    "wf_get_telemetry",
    {
      title: "Get Session Telemetry",
      description: `Get performance telemetry for a session: publisher frame timing, battery, audio stats, and AI service status (latency, trigger count, queue depth).

Use this to check if the device is keeping up, if AI responses are timely, or if there are bottlenecks.`,
      inputSchema: {
        session_id: z.string().describe("Session ID (get from wf_get_active_session)"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ session_id }) => {
      try {
        const data = await api.getSessionTelemetry(session_id);
        const lines = [`# Telemetry — Session ${session_id}`];

        if (data.publisher.connected) {
          lines.push("", "## Publisher");
          lines.push(`Standby: ${data.publisher.standby ?? "unknown"}`);
          lines.push(`Frames: ${data.publisher.frameCount ?? 0} | Bytes: ${Math.round((data.publisher.totalBytes ?? 0) / 1024)}KB`);
          lines.push(`Audio: ${data.publisher.audioCount ?? 0} chunks | ${Math.round((data.publisher.audioBytes ?? 0) / 1024)}KB`);
          if (data.publisher.lastHeader) lines.push(`Resolution: ${data.publisher.lastHeader.width}x${data.publisher.lastHeader.height} q=${data.publisher.lastHeader.quality}`);
          if (data.publisher.timing) {
            const t = data.publisher.timing as Record<string, unknown>;
            lines.push(`Timing: FPS=${t.fps ?? "?"} dropped=${t.dropped ?? "?"} avgLatencyMs=${t.avgLatencyMs ?? "?"}`);
          }
          if (data.publisher.battery) {
            lines.push(`Battery: ${data.publisher.battery.level ?? "?"}% ${data.publisher.battery.state ?? ""}${data.publisher.battery.lowPowerMode ? " [low power]" : ""}`);
          }
        } else {
          lines.push("", "Publisher: not connected");
        }

        lines.push("", "## AI Service");
        const aiStatus = data.ai.status as Record<string, unknown>;
        const aiTelem = data.ai.telemetry as Record<string, unknown>;
        lines.push(`Status: ${aiStatus.status ?? "idle"} | App: ${aiStatus.appId ?? "none"}`);
        lines.push(`Triggers: ${aiTelem.triggers ?? 0} | Events: ${aiTelem.guidanceEvents ?? 0}`);
        lines.push(`Avg latency: ${aiTelem.avgLatencyMs ?? 0}ms | Last: ${aiTelem.lastLatencyMs ?? "n/a"}ms`);
        lines.push(`Queue depth: ${aiTelem.queueDepth ?? 0}`);

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) { return handleErr(err); }
    },
  );

  // 18. Activate and observe
  server.registerTool(
    "wf_activate_and_observe",
    {
      title: "Activate Workflow and Observe",
      description: `Activate a workflow, wait briefly, then report initial node states and telemetry. Combines wf_activate_workflow + wf_get_node_states + wf_get_telemetry into one call for rapid iteration.

Returns: activation result, node states (did they start?), and telemetry (is the device keeping up?). If activation fails or nodes error, reports what went wrong.`,
      inputSchema: {
        workflow_id: z.string().describe("Workflow ID to activate"),
        session_id: z.string().optional().describe("Target session ID (auto-detected if omitted)"),
        device_id: z.string().optional().describe("Device ID to wake before activation"),
        override: z.boolean().optional().default(false).describe("Override any currently active workflow"),
        wait_ms: z.number().int().min(500).max(10000).optional().default(3000).describe("Milliseconds to wait before polling states (default 3000)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ workflow_id, session_id, device_id, override, wait_ms }) => {
      try {
        // Step 1: Find session if not provided
        let sid = session_id;
        if (!sid) {
          const active = await api.getActiveSessions();
          const withPublisher = active.filter((s) => s.publisherConnected);
          if (!withPublisher.length) return { content: [{ type: "text", text: "No active session with connected publisher. Start the iOS app first." }] };
          sid = withPublisher[0].id;
        }

        // Step 2: Activate
        const lines: string[] = [`# Activate & Observe — ${workflow_id}`, "", `Session: ${sid}`];
        const result = await api.activateWorkflow(workflow_id, sid, { override, deviceId: device_id });
        if (result.status === "conflict") {
          lines.push(`Activation CONFLICT: appId=${result.conflict?.activeAppId ?? "?"}, status=${result.conflict?.status}. Set override=true.`);
          return { content: [{ type: "text", text: lines.join("\n") }] };
        }
        lines.push(`Activation: appId=${result.appId}, status=${result.status}`);

        // Step 3: Wait for nodes to initialize
        lines.push(`Waiting ${wait_ms}ms for initialization...`);
        await new Promise((r) => setTimeout(r, wait_ms));

        // Step 4: Poll states
        const [states, telemetry] = await Promise.all([
          api.getNodeStates(sid!, 20),
          api.getSessionTelemetry(sid!),
        ]);

        lines.push("", `## Node States (${states.nodes.length})`);
        const errored: string[] = [];
        const running: string[] = [];
        for (const n of states.nodes) {
          if (n.state === "running") running.push(n.label);
          else if (n.state === "errored") errored.push(`${n.label}: ${n.error ?? "unknown"}`);
        }
        if (running.length) lines.push(`Running: ${running.join(", ")}`);
        if (errored.length) lines.push(`Errors:\n${errored.map((e) => `  - ${e}`).join("\n")}`);
        const pending = states.nodes.filter((n) => n.state === "pending");
        if (pending.length) lines.push(`Pending: ${pending.map((n) => n.label).join(", ")}`);

        // Step 5: Quick telemetry
        lines.push("", "## Quick Telemetry");
        const pub = telemetry.publisher;
        if (pub.connected) {
          lines.push(`Publisher: streaming, ${pub.frameCount ?? 0} frames`);
          if (pub.battery) lines.push(`Battery: ${pub.battery.level ?? "?"}%`);
        }
        const aiTelem = (telemetry.ai.telemetry as Record<string, unknown>);
        lines.push(`AI triggers: ${aiTelem.triggers ?? 0} | latency: ${aiTelem.avgLatencyMs ?? 0}ms`);

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) { return handleErr(err); }
    },
  );

  // 19. Deactivate workflow
  server.registerTool(
    "wf_deactivate",
    {
      title: "Deactivate Workflow",
      description: `Deactivate the currently running workflow on a session. Stops all AI services, sends deactivate command to iOS device, and clears workflow state.`,
      inputSchema: {
        session_id: z.string().describe("Session ID (get from wf_get_active_session)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ session_id }) => {
      try {
        const result = await api.deactivateWorkflow(session_id);
        return { content: [{ type: "text", text: `Deactivated workflow ${result.deactivatedWorkflowId} on session ${result.sessionId}` }] };
      } catch (err) { return handleErr(err); }
    },
  );

  // 20. Get results (guidance history)
  server.registerTool(
    "wf_get_results",
    {
      title: "Get Workflow Results",
      description: `Get recent AI guidance results and events from an active session. Returns the AI event history (text guidance, responses, triggers) and current AI status.

For detection/tracking/sensor results, use wf_get_node_states which shows node execution state and errors. This tool focuses on AI conversation output.`,
      inputSchema: {
        session_id: z.string().describe("Session ID"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ session_id }) => {
      try {
        const data = await api.request<{
          history: Array<Record<string, unknown>>;
          status: Record<string, unknown>;
          telemetry: Record<string, unknown>;
        }>("GET", `/session/${session_id}/guidance`);

        const lines = [`# Results — Session ${session_id}`];

        const status = data.status as Record<string, unknown>;
        lines.push(`AI Status: ${status.status ?? "idle"} | App: ${status.appId ?? "none"} | Triggers: ${(status as Record<string, unknown>).triggerCount ?? 0}`);

        const events = data.history ?? [];
        if (!events.length) {
          lines.push("", "No guidance events yet.");
        } else {
          lines.push("", `## Recent Events (${events.length})`);
          for (const e of events.slice(-15)) {
            const ts = e.timestampMs ? new Date(e.timestampMs as number).toISOString().slice(11, 23) : "?";
            const type = e.type ?? "event";
            const text = (e.text ?? e.content ?? e.summary ?? "") as string;
            lines.push(`- ${ts} [${type}] ${String(text).slice(0, 200)}`);
          }
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) { return handleErr(err); }
    },
  );
}
