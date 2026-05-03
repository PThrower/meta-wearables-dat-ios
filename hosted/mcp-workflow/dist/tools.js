/**
 * Tool registrations for the MWDAT workflow MCP server.
 * 26 tools: workflow CRUD (5), graph mutations (5), validation/activation (4),
 * runtime observability (6), flow config & settings (4), config awareness (2).
 */
import { z } from "zod";
import * as api from "./client.js";
// --- Helpers ---
function fmtWorkflow(w) {
    const lines = [
        `# ${w.name} (${w.id})`,
        `Status: ${w.status} | Created: ${w.createdAt} | Updated: ${w.updatedAt}`,
    ];
    if (w.description)
        lines.push(`Description: ${w.description}`);
    lines.push(`Nodes: ${w.nodes.length} | Edges: ${w.edges.length}`);
    if (w.flowConfig)
        lines.push(`Flow: ${w.flowConfig.mode} (${w.flowConfig.flowOrder.length} flows)`);
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
function fmtConfigField(f, indent = "  ") {
    const lines = [];
    switch (f.kind) {
        case "text":
            lines.push(`${indent}- text: ${f.key} "${f.label}"${f.placeholder ? ` (placeholder: "${f.placeholder}")` : ""}`);
            break;
        case "textarea":
            lines.push(`${indent}- textarea: ${f.key} "${f.label}"${f.rows ? ` (${f.rows} rows)` : ""}${f.placeholder ? ` placeholder: "${f.placeholder}"` : ""}`);
            break;
        case "select":
            lines.push(`${indent}- select: ${f.key} "${f.label}"`);
            for (const o of f.options)
                lines.push(`${indent}    ${o.value} = ${o.label}`);
            break;
        case "range":
            lines.push(`${indent}- range: ${f.key} "${f.label}" [${f.min}..${f.max}] step ${f.step}${f.unit ?? ""}`);
            break;
        case "checkbox":
            lines.push(`${indent}- checkbox: ${f.key} "${f.label}"`);
            break;
        case "number":
            lines.push(`${indent}- number: ${f.key} "${f.label}"${f.min !== undefined ? ` min=${f.min}` : ""}${f.max !== undefined ? ` max=${f.max}` : ""}${f.step !== undefined ? ` step=${f.step}` : ""}${f.placeholder ? ` placeholder="${f.placeholder}"` : ""}`);
            break;
        case "checkbox-group":
            lines.push(`${indent}- checkbox-group: ${f.key} "${f.label}"`);
            for (const sub of f.fields)
                lines.push(`${indent}    ${sub.key} = ${sub.label}`);
            break;
        case "geofence-map":
            lines.push(`${indent}- geofence-map: ${f.key} "${f.label}"`);
            break;
        case "zones":
            lines.push(`${indent}- zones: ${f.key} "${f.label}"`);
            break;
        case "section":
            lines.push(`${indent}--- ${f.label} ---`);
            for (const sub of f.fields)
                lines.push(...fmtConfigField(sub, indent + "  "));
            break;
        case "conditional":
            lines.push(`${indent}--- conditional (${JSON.stringify(f.condition)}) ---`);
            for (const sub of f.fields)
                lines.push(...fmtConfigField(sub, indent + "  "));
            break;
    }
    return lines;
}
function fmtNodeDef(d) {
    const lines = [
        `## ${d.label} (${d.type})`,
        `Role: ${d.role} | Activation: ${d.activationMode ?? "none"} | Runtime: ${d.runtime.join(", ")}`,
        `Subtitle: "${d.subtitle}"`,
        `Allowed targets: ${d.allowedTargets.join(", ")}`,
    ];
    if (d.allowedSources?.length)
        lines.push(`Allowed sources: ${d.allowedSources.join(", ")}`);
    if (d.defaultModel)
        lines.push(`Default model: ${d.defaultModel}`);
    if (d.configSchema.length) {
        lines.push("Config fields:");
        for (const f of d.configSchema) {
            lines.push(...fmtConfigField(f));
        }
    }
    if (Object.keys(d.defaultConfig).length) {
        lines.push(`Defaults: ${JSON.stringify(d.defaultConfig)}`);
    }
    return lines.join("\n");
}
function handleErr(err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
}
// Nanoid-style ID generator (no dep)
function nanoid(size = 10) {
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    let id = "";
    for (let i = 0; i < size; i++)
        id += chars[Math.floor(Math.random() * chars.length)];
    return id;
}
// --- Tool Registration ---
export function registerTools(server) {
    // 1. List workflows
    server.registerTool("wf_list_workflows", {
        title: "List Workflows",
        description: `List all workflows with summary info (id, name, status, node count, last updated).

Returns markdown table of all workflows. Use wf_get_workflow for full details on a specific one.`,
        inputSchema: {},
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }, async () => {
        try {
            const workflows = await api.listWorkflows();
            if (!workflows.length)
                return { content: [{ type: "text", text: "No workflows found." }] };
            const lines = ["# Workflows", "", "| ID | Name | Status | Nodes | Updated |", "|---|---|---|---|---|"];
            for (const w of workflows) {
                lines.push(`| ${w.id} | ${w.name} | ${w.status} | ${w.nodeCount} | ${w.updatedAt} |`);
            }
            return { content: [{ type: "text", text: lines.join("\n") }] };
        }
        catch (err) {
            return handleErr(err);
        }
    });
    // 2. Get workflow
    server.registerTool("wf_get_workflow", {
        title: "Get Workflow",
        description: `Get full workflow detail: name, description, status, all nodes (type, label, config, position), all edges, flow config, and settings.

Returns structured markdown with node and edge listings.`,
        inputSchema: { workflow_id: z.string().describe("Workflow ID") },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }, async ({ workflow_id }) => {
        try {
            const w = await api.getWorkflow(workflow_id);
            return { content: [{ type: "text", text: fmtWorkflow(w) }] };
        }
        catch (err) {
            return handleErr(err);
        }
    });
    // 3. Create workflow
    server.registerTool("wf_create_workflow", {
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
    }, async (params) => {
        try {
            const w = await api.createWorkflow(params);
            return { content: [{ type: "text", text: `Created workflow:\n${fmtWorkflow(w)}` }] };
        }
        catch (err) {
            return handleErr(err);
        }
    });
    // 4. Update workflow
    server.registerTool("wf_update_workflow", {
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
    }, async ({ workflow_id, ...params }) => {
        try {
            const body = {};
            if (params.name !== undefined)
                body.name = params.name;
            if (params.description !== undefined)
                body.description = params.description;
            if (params.status !== undefined)
                body.status = params.status;
            if (params.canvas_viewport !== undefined)
                body.canvasViewport = params.canvas_viewport;
            if (params.flow_config !== undefined)
                body.flowConfig = JSON.parse(params.flow_config);
            if (params.settings !== undefined)
                body.settings = JSON.parse(params.settings);
            const w = await api.updateWorkflow(workflow_id, body);
            return { content: [{ type: "text", text: `Updated workflow:\n${fmtWorkflow(w)}` }] };
        }
        catch (err) {
            return handleErr(err);
        }
    });
    // 5. Delete workflow
    server.registerTool("wf_delete_workflow", {
        title: "Delete Workflow",
        description: `Delete a workflow and all its nodes and edges (cascade delete). This is irreversible.`,
        inputSchema: {
            workflow_id: z.string().describe("Workflow ID to delete"),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    }, async ({ workflow_id }) => {
        try {
            await api.deleteWorkflow(workflow_id);
            return { content: [{ type: "text", text: `Deleted workflow ${workflow_id}` }] };
        }
        catch (err) {
            return handleErr(err);
        }
    });
    // 6. Add node
    server.registerTool("wf_add_node", {
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
    }, async ({ workflow_id, node_type, label, config, position_x, position_y }) => {
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
        }
        catch (err) {
            return handleErr(err);
        }
    });
    // 7. Remove node
    server.registerTool("wf_remove_node", {
        title: "Remove Node from Workflow",
        description: `Remove a node and all its connected edges from a workflow. Read-modify-write pattern.`,
        inputSchema: {
            workflow_id: z.string().describe("Workflow ID"),
            node_id: z.string().describe("Node ID to remove"),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    }, async ({ workflow_id, node_id }) => {
        try {
            const w = await api.getWorkflow(workflow_id);
            const node = w.nodes.find((n) => n.id === node_id);
            if (!node)
                return { content: [{ type: "text", text: `Node ${node_id} not found in workflow` }] };
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
        }
        catch (err) {
            return handleErr(err);
        }
    });
    // 8. Update node
    server.registerTool("wf_update_node", {
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
    }, async ({ workflow_id, node_id, label, config, position_x, position_y }) => {
        try {
            const w = await api.getWorkflow(workflow_id);
            const node = w.nodes.find((n) => n.id === node_id);
            if (!node)
                return { content: [{ type: "text", text: `Node ${node_id} not found` }] };
            if (label !== undefined)
                node.label = label;
            if (config !== undefined)
                node.config = JSON.parse(config);
            if (position_x !== undefined)
                node.positionX = position_x;
            if (position_y !== undefined)
                node.positionY = position_y;
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
        }
        catch (err) {
            return handleErr(err);
        }
    });
    // 9. Add edge
    server.registerTool("wf_add_edge", {
        title: "Add Edge to Workflow",
        description: `Add a connection between two nodes. Validates that both nodes exist AND that the edge is allowed by allowedTargets/allowedSources rules (including sentinel expansion: <sink>, <trigger>, <source>).`,
        inputSchema: {
            workflow_id: z.string().describe("Workflow ID"),
            source_node_id: z.string().describe("Source node ID (output port)"),
            target_node_id: z.string().describe("Target node ID (input port)"),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    }, async ({ workflow_id, source_node_id, target_node_id }) => {
        try {
            const [w, defs] = await Promise.all([api.getWorkflow(workflow_id), api.getNodeDefinitions()]);
            const defMap = new Map(defs.map((d) => [d.type, d]));
            const source = w.nodes.find((n) => n.id === source_node_id);
            const target = w.nodes.find((n) => n.id === target_node_id);
            if (!source)
                return { content: [{ type: "text", text: `Source node ${source_node_id} not found` }] };
            if (!target)
                return { content: [{ type: "text", text: `Target node ${target_node_id} not found` }] };
            const existing = w.edges.find((e) => e.sourceNodeId === source_node_id && e.targetNodeId === target_node_id);
            if (existing)
                return { content: [{ type: "text", text: `Edge already exists: ${existing.id}` }] };
            // Validate allowedTargets (forward direction)
            const sourceDef = defMap.get(source.type);
            const targetDef = defMap.get(target.type);
            if (sourceDef) {
                const allowedDirect = sourceDef.allowedTargets.includes(target.type);
                const sentinelOk = (sourceDef.allowedTargets.includes("<sink>") && targetDef?.role === "sink") ||
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
        }
        catch (err) {
            return handleErr(err);
        }
    });
    // 10. Remove edge
    server.registerTool("wf_remove_edge", {
        title: "Remove Edge from Workflow",
        description: `Remove a connection between two nodes by edge ID.`,
        inputSchema: {
            workflow_id: z.string().describe("Workflow ID"),
            edge_id: z.string().describe("Edge ID to remove"),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    }, async ({ workflow_id, edge_id }) => {
        try {
            const w = await api.getWorkflow(workflow_id);
            const edge = w.edges.find((e) => e.id === edge_id);
            if (!edge)
                return { content: [{ type: "text", text: `Edge ${edge_id} not found` }] };
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
        }
        catch (err) {
            return handleErr(err);
        }
    });
    // 11. Validate workflow
    server.registerTool("wf_validate_workflow", {
        title: "Validate Workflow",
        description: `Validate a workflow's structure: check node types exist, edges reference valid nodes, no orphaned edges, and optional allowedTargets checks.`,
        inputSchema: {
            workflow_id: z.string().describe("Workflow ID to validate"),
            check_edges: z.boolean().optional().default(true).describe("Check allowedTargets for each edge"),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }, async ({ workflow_id, check_edges }) => {
        try {
            const [w, defs] = await Promise.all([api.getWorkflow(workflow_id), api.getNodeDefinitions()]);
            const defMap = new Map(defs.map((d) => [d.type, d]));
            const nodeIds = new Set(w.nodes.map((n) => n.id));
            const issues = [];
            // Check node types
            for (const n of w.nodes) {
                if (!defMap.has(n.type))
                    issues.push(`Unknown node type: ${n.type} (node ${n.id})`);
            }
            // Check edge references
            for (const e of w.edges) {
                if (!nodeIds.has(e.sourceNodeId))
                    issues.push(`Edge ${e.id}: source ${e.sourceNodeId} not found`);
                if (!nodeIds.has(e.targetNodeId))
                    issues.push(`Edge ${e.id}: target ${e.targetNodeId} not found`);
            }
            // Check orphans
            const connectedNodes = new Set();
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
                    if (!sourceNode || !targetNode)
                        continue;
                    const sourceDef = defMap.get(sourceNode.type);
                    if (sourceDef && !sourceDef.allowedTargets.includes(targetNode.type)) {
                        // Check sentinels
                        const targetDef = defMap.get(targetNode.type);
                        const sentinelOk = (sourceDef.allowedTargets.includes("<sink>") && targetDef?.role === "sink") ||
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
        }
        catch (err) {
            return handleErr(err);
        }
    });
    // 12. Activate workflow
    server.registerTool("wf_activate_workflow", {
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
    }, async ({ workflow_id, session_id, device_id, override, reason }) => {
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
        }
        catch (err) {
            return handleErr(err);
        }
    });
    // 13. List node definitions
    server.registerTool("wf_get_node_definitions", {
        title: "List Node Definitions",
        description: `List all available node types for building workflows. Returns type, label, role, activation mode, allowed targets, runtime, and config schema summary.

Use wf_get_node_definition for full details on a specific type. Results are cached for 1 minute.`,
        inputSchema: {
            role: z.string().optional().describe("Filter by role: source, processor, trigger, transform, sink, gating, reference"),
            activation_mode: z.string().optional().describe("Filter by activation mode: ai, vision, enhance, tracking, sensor, speech, measure, yolo, jepa, palantir, stt, passthrough"),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }, async ({ role, activation_mode }) => {
        try {
            let defs = await api.getNodeDefinitions();
            if (role)
                defs = defs.filter((d) => d.role === role);
            if (activation_mode)
                defs = defs.filter((d) => d.activationMode === activation_mode);
            if (!defs.length)
                return { content: [{ type: "text", text: "No node definitions match filters." }] };
            const lines = [`# Node Definitions (${defs.length})`, "", "| Type | Label | Role | Activation | Runtime | Targets |", "|---|---|---|---|---|---|"];
            for (const d of defs) {
                const targets = d.allowedTargets.length > 4 ? `${d.allowedTargets.slice(0, 3).join(", ")} +${d.allowedTargets.length - 3}` : d.allowedTargets.join(", ");
                lines.push(`| ${d.type} | ${d.label} | ${d.role} | ${d.activationMode ?? "-"} | ${d.runtime.join(",")} | ${targets} |`);
            }
            return { content: [{ type: "text", text: lines.join("\n") }] };
        }
        catch (err) {
            return handleErr(err);
        }
    });
    // 14. Get single node definition
    server.registerTool("wf_get_node_definition", {
        title: "Get Node Definition",
        description: `Get full details for a specific node type: label, subtitle, color, role, activation mode, allowed targets/sources, config schema with all fields, default config, and subnodes.`,
        inputSchema: {
            node_type: z.string().describe("Node type string (e.g. 'camera-source', 's2s-live', 'vision-ocr', 'tracking-ocsort')"),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }, async ({ node_type }) => {
        try {
            const defs = await api.getNodeDefinitions();
            const def = defs.find((d) => d.type === node_type);
            if (!def) {
                const similar = defs.filter((d) => d.type.includes(node_type) || node_type.includes(d.type)).map((d) => d.type);
                const hint = similar.length ? ` Similar types: ${similar.join(", ")}` : "";
                return { content: [{ type: "text", text: `Node type "${node_type}" not found.${hint}` }] };
            }
            return { content: [{ type: "text", text: fmtNodeDef(def) }] };
        }
        catch (err) {
            return handleErr(err);
        }
    });
    // =====================
    // Runtime Observability
    // =====================
    // 15. Get active sessions
    server.registerTool("wf_get_active_session", {
        title: "Get Active Session",
        description: `Get active sessions with device info, publisher state, battery, frame counts, and running workflow.

Returns full runtime context: which device is connected, whether it's streaming, what workflow is active, battery level, and frame/audio stats. Use this before activating to know which session to target.`,
        inputSchema: {},
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }, async () => {
        try {
            const sessions = await api.getActiveSessions();
            if (!sessions.length)
                return { content: [{ type: "text", text: "No active sessions. Start the iOS app and connect a device." }] };
            const lines = [`# Active Sessions (${sessions.length})`, ""];
            for (const s of sessions) {
                lines.push(`## Session ${s.id}`);
                lines.push(`State: ${s.state} | Link: ${s.linkState} | Uptime: ${Math.round((s.uptimeMs ?? 0) / 1000)}s`);
                lines.push(`Publisher: ${s.publisherConnected ? "connected" : "disconnected"}${s.publisherStandby ? " (standby)" : ""} | Viewers: ${s.viewerCount}`);
                if (s.activeWorkflowId)
                    lines.push(`Active workflow: ${s.activeWorkflowId}`);
                if (s.device) {
                    lines.push(`Device: ${s.device.deviceName ?? s.device.deviceModel ?? "unknown"} (${s.device.deviceModel ?? "?"})`);
                    if (s.device.appVersion)
                        lines.push(`App: v${s.device.appVersion} (${s.device.buildNumber ?? "?"})`);
                }
                if (s.battery)
                    lines.push(`Battery: ${s.battery.level ?? "?"}% ${s.battery.state ?? ""}${s.battery.lowPowerMode ? " [low power]" : ""}`);
                if (s.frames)
                    lines.push(`Frames: ${s.frames.frameCount} (${Math.round((s.frames.totalBytes ?? 0) / 1024)}KB) | Audio: ${s.frames.audioCount}`);
                lines.push("");
            }
            return { content: [{ type: "text", text: lines.join("\n") }] };
        }
        catch (err) {
            return handleErr(err);
        }
    });
    // 16. Get node states
    server.registerTool("wf_get_node_states", {
        title: "Get Node Execution States",
        description: `Get current execution state of every node in the active workflow for a session.

Returns live node states (running/errored/pending/completed) from the orchestrator, plus recent execution log entries from the database. Use this after activation to verify nodes started correctly, or to diagnose which node failed.`,
        inputSchema: {
            session_id: z.string().describe("Session ID (get from wf_get_active_session)"),
            limit: z.number().int().min(1).max(500).optional().default(50).describe("Max execution log entries to return"),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }, async ({ session_id, limit }) => {
        try {
            const data = await api.getNodeStates(session_id, limit);
            const lines = [`# Node States — Session ${session_id}`];
            if (data.workflowId) {
                lines.push(`Workflow: ${data.workflowName ?? data.workflowId} | Activated: ${data.activatedAt ? new Date(data.activatedAt).toISOString() : "unknown"}`);
            }
            else {
                lines.push("No active workflow.");
                return { content: [{ type: "text", text: lines.join("\n") }] };
            }
            // Current live states
            lines.push("", `## Live States (${data.nodes.length} nodes)`);
            for (const n of data.nodes) {
                const stateIcon = n.state === "running" ? "[running]" : n.state === "errored" ? "[ERROR]" : n.state === "completed" ? "[done]" : `[${n.state}]`;
                lines.push(`- ${stateIcon} ${n.label} (${n.nodeType}) — node ${n.nodeId}`);
                if (n.error)
                    lines.push(`  Error: ${n.error}`);
                if (n.startedAt)
                    lines.push(`  Started: ${new Date(n.startedAt).toISOString()}`);
                if (n.completedAt)
                    lines.push(`  Completed: ${new Date(n.completedAt).toISOString()}`);
            }
            // Recent execution log
            if (data.log.length) {
                lines.push("", `## Recent Execution Log (${data.log.length} entries)`);
                for (const e of data.log.slice(0, 20)) {
                    const ts = new Date(e.timestampMs).toISOString().slice(11, 23);
                    lines.push(`- ${ts} ${e.nodeType}/${e.nodeId} ${e.action} → ${e.state}${e.error ? ` ERR: ${e.error}` : ""}`);
                }
                if (data.log.length > 20)
                    lines.push(`  ... and ${data.log.length - 20} more`);
            }
            return { content: [{ type: "text", text: lines.join("\n") }] };
        }
        catch (err) {
            return handleErr(err);
        }
    });
    // 17. Get telemetry
    server.registerTool("wf_get_telemetry", {
        title: "Get Session Telemetry",
        description: `Get performance telemetry for a session: publisher frame timing, battery, audio stats, and AI service status (latency, trigger count, queue depth).

Use this to check if the device is keeping up, if AI responses are timely, or if there are bottlenecks.`,
        inputSchema: {
            session_id: z.string().describe("Session ID (get from wf_get_active_session)"),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }, async ({ session_id }) => {
        try {
            const data = await api.getSessionTelemetry(session_id);
            const lines = [`# Telemetry — Session ${session_id}`];
            if (data.publisher.connected) {
                lines.push("", "## Publisher");
                lines.push(`Standby: ${data.publisher.standby ?? "unknown"}`);
                lines.push(`Frames: ${data.publisher.frameCount ?? 0} | Bytes: ${Math.round((data.publisher.totalBytes ?? 0) / 1024)}KB`);
                lines.push(`Audio: ${data.publisher.audioCount ?? 0} chunks | ${Math.round((data.publisher.audioBytes ?? 0) / 1024)}KB`);
                if (data.publisher.lastHeader)
                    lines.push(`Resolution: ${data.publisher.lastHeader.width}x${data.publisher.lastHeader.height} q=${data.publisher.lastHeader.quality}`);
                if (data.publisher.timing) {
                    const t = data.publisher.timing;
                    lines.push(`Timing: FPS=${t.fps ?? "?"} dropped=${t.dropped ?? "?"} avgLatencyMs=${t.avgLatencyMs ?? "?"}`);
                }
                if (data.publisher.battery) {
                    lines.push(`Battery: ${data.publisher.battery.level ?? "?"}% ${data.publisher.battery.state ?? ""}${data.publisher.battery.lowPowerMode ? " [low power]" : ""}`);
                }
            }
            else {
                lines.push("", "Publisher: not connected");
            }
            lines.push("", "## AI Service");
            const aiStatus = data.ai.status;
            const aiTelem = data.ai.telemetry;
            lines.push(`Status: ${aiStatus.status ?? "idle"} | App: ${aiStatus.appId ?? "none"}`);
            lines.push(`Triggers: ${aiTelem.triggers ?? 0} | Events: ${aiTelem.guidanceEvents ?? 0}`);
            lines.push(`Avg latency: ${aiTelem.avgLatencyMs ?? 0}ms | Last: ${aiTelem.lastLatencyMs ?? "n/a"}ms`);
            lines.push(`Queue depth: ${aiTelem.queueDepth ?? 0}`);
            return { content: [{ type: "text", text: lines.join("\n") }] };
        }
        catch (err) {
            return handleErr(err);
        }
    });
    // 18. Activate and observe
    server.registerTool("wf_activate_and_observe", {
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
    }, async ({ workflow_id, session_id, device_id, override, wait_ms }) => {
        try {
            // Step 1: Find session if not provided
            let sid = session_id;
            if (!sid) {
                const active = await api.getActiveSessions();
                const withPublisher = active.filter((s) => s.publisherConnected);
                if (!withPublisher.length)
                    return { content: [{ type: "text", text: "No active session with connected publisher. Start the iOS app first." }] };
                sid = withPublisher[0].id;
            }
            // Step 2: Activate
            const lines = [`# Activate & Observe — ${workflow_id}`, "", `Session: ${sid}`];
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
                api.getNodeStates(sid, 20),
                api.getSessionTelemetry(sid),
            ]);
            lines.push("", `## Node States (${states.nodes.length})`);
            const errored = [];
            const running = [];
            for (const n of states.nodes) {
                if (n.state === "running")
                    running.push(n.label);
                else if (n.state === "errored")
                    errored.push(`${n.label}: ${n.error ?? "unknown"}`);
            }
            if (running.length)
                lines.push(`Running: ${running.join(", ")}`);
            if (errored.length)
                lines.push(`Errors:\n${errored.map((e) => `  - ${e}`).join("\n")}`);
            const pending = states.nodes.filter((n) => n.state === "pending");
            if (pending.length)
                lines.push(`Pending: ${pending.map((n) => n.label).join(", ")}`);
            // Step 5: Quick telemetry
            lines.push("", "## Quick Telemetry");
            const pub = telemetry.publisher;
            if (pub.connected) {
                lines.push(`Publisher: streaming, ${pub.frameCount ?? 0} frames`);
                if (pub.battery)
                    lines.push(`Battery: ${pub.battery.level ?? "?"}%`);
            }
            const aiTelem = telemetry.ai.telemetry;
            lines.push(`AI triggers: ${aiTelem.triggers ?? 0} | latency: ${aiTelem.avgLatencyMs ?? 0}ms`);
            return { content: [{ type: "text", text: lines.join("\n") }] };
        }
        catch (err) {
            return handleErr(err);
        }
    });
    // 19. Deactivate workflow
    server.registerTool("wf_deactivate", {
        title: "Deactivate Workflow",
        description: `Deactivate the currently running workflow on a session. Stops all AI services, sends deactivate command to iOS device, and clears workflow state.`,
        inputSchema: {
            session_id: z.string().describe("Session ID (get from wf_get_active_session)"),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    }, async ({ session_id }) => {
        try {
            const result = await api.deactivateWorkflow(session_id);
            return { content: [{ type: "text", text: `Deactivated workflow ${result.deactivatedWorkflowId} on session ${result.sessionId}` }] };
        }
        catch (err) {
            return handleErr(err);
        }
    });
    // 20. Get results (guidance history)
    server.registerTool("wf_get_results", {
        title: "Get Workflow Results",
        description: `Get recent AI guidance results and events from an active session. Returns the AI event history (text guidance, responses, triggers) and current AI status.

For detection/tracking/sensor results, use wf_get_node_states which shows node execution state and errors. This tool focuses on AI conversation output.`,
        inputSchema: {
            session_id: z.string().describe("Session ID"),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }, async ({ session_id }) => {
        try {
            const data = await api.request("GET", `/session/${session_id}/guidance`);
            const lines = [`# Results — Session ${session_id}`];
            const status = data.status;
            lines.push(`AI Status: ${status.status ?? "idle"} | App: ${status.appId ?? "none"} | Triggers: ${status.triggerCount ?? 0}`);
            const events = data.history ?? [];
            if (!events.length) {
                lines.push("", "No guidance events yet.");
            }
            else {
                lines.push("", `## Recent Events (${events.length})`);
                for (const e of events.slice(-15)) {
                    const ts = e.timestampMs ? new Date(e.timestampMs).toISOString().slice(11, 23) : "?";
                    const type = e.type ?? "event";
                    const text = (e.text ?? e.content ?? e.summary ?? "");
                    lines.push(`- ${ts} [${type}] ${String(text).slice(0, 200)}`);
                }
            }
            return { content: [{ type: "text", text: lines.join("\n") }] };
        }
        catch (err) {
            return handleErr(err);
        }
    });
    // ==========================
    // Flow Config & Settings
    // ==========================
    // 21. Get workflow settings
    server.registerTool("wf_get_settings", {
        title: "Get Workflow Settings",
        description: `Get the runtime settings for a workflow: disconnect/reconnect behavior, auto-deactivate, recording, viewer access, wake-on-activate, target device, etc.

Returns the full WorkflowSettings object with field descriptions.`,
        inputSchema: {
            workflow_id: z.string().describe("Workflow ID"),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }, async ({ workflow_id }) => {
        try {
            const w = await api.getWorkflow(workflow_id);
            if (!w.settings)
                return { content: [{ type: "text", text: `Workflow "${w.name}" has no settings configured (using defaults).` }] };
            const s = w.settings;
            const lines = [
                `# Settings — ${w.name}`,
                "",
                `| Field | Value | Description |`,
                `|---|---|---|`,
                `| onDisconnect | ${s.onDisconnect} | What happens when publisher disconnects (stop/pause/continue) |`,
                `| onReconnect | ${s.onReconnect} | What happens when publisher reconnects (restart/resume/noop) |`,
                `| autoDeactivateMin | ${s.autoDeactivateMin ?? "never"} | Auto-deactivate after N minutes (null = never) |`,
                `| maxSessionDuration | ${s.maxSessionDuration ?? "unlimited"} | Max session duration in minutes (null = unlimited) |`,
                `| recordingEnabled | ${s.recordingEnabled} | Whether frames are recorded to MP4 |`,
                `| viewerAccess | ${s.viewerAccess} | Who can view the stream (owner/team/public) |`,
                `| telemetryIntervalSec | ${s.telemetryIntervalSec} | How often telemetry is sampled (seconds) |`,
                `| wakeOnActivate | ${s.wakeOnActivate} | Wake the target device when workflow activates |`,
                `| autoStartStream | ${s.autoStartStream} | Auto-start camera stream on activation |`,
                `| targetDeviceId | ${s.targetDeviceId ?? "any"} | Specific device to target (null = any) |`,
            ];
            return { content: [{ type: "text", text: lines.join("\n") }] };
        }
        catch (err) {
            return handleErr(err);
        }
    });
    // 22. Update workflow settings
    server.registerTool("wf_update_settings", {
        title: "Update Workflow Settings",
        description: `Update runtime settings for a workflow. Only provided fields are changed.

Settings control lifecycle behavior:
- onDisconnect: stop/pause/continue — what happens when the iOS publisher disconnects
- onReconnect: restart/resume/noop — what happens when it reconnects
- autoDeactivateMin: auto-deactivate after N minutes (null = never)
- maxSessionDuration: max session duration in minutes (null = unlimited)
- recordingEnabled: whether to record frames to MP4
- viewerAccess: owner/team/public — who can view the stream
- telemetryIntervalSec: telemetry sampling interval
- wakeOnActivate: wake the target device before activation
- autoStartStream: auto-start camera stream
- targetDeviceId: specific device UUID to target (null = any device)`,
        inputSchema: {
            workflow_id: z.string().describe("Workflow ID"),
            on_disconnect: z.enum(["stop", "pause", "continue"]).optional(),
            on_reconnect: z.enum(["restart", "resume", "noop"]).optional(),
            auto_deactivate_min: z.number().nullable().optional(),
            max_session_duration: z.number().nullable().optional(),
            recording_enabled: z.boolean().optional(),
            viewer_access: z.enum(["owner", "team", "public"]).optional(),
            telemetry_interval_sec: z.number().optional(),
            wake_on_activate: z.boolean().optional(),
            auto_start_stream: z.boolean().optional(),
            target_device_id: z.string().nullable().optional(),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }, async ({ workflow_id, ...params }) => {
        try {
            const w = await api.getWorkflow(workflow_id);
            const current = w.settings ?? {
                onDisconnect: "stop", onReconnect: "restart", autoDeactivateMin: null,
                maxSessionDuration: null, recordingEnabled: false, viewerAccess: "owner",
                telemetryIntervalSec: 10, wakeOnActivate: false, autoStartStream: false, targetDeviceId: null,
            };
            if (params.on_disconnect !== undefined)
                current.onDisconnect = params.on_disconnect;
            if (params.on_reconnect !== undefined)
                current.onReconnect = params.on_reconnect;
            if (params.auto_deactivate_min !== undefined)
                current.autoDeactivateMin = params.auto_deactivate_min;
            if (params.max_session_duration !== undefined)
                current.maxSessionDuration = params.max_session_duration;
            if (params.recording_enabled !== undefined)
                current.recordingEnabled = params.recording_enabled;
            if (params.viewer_access !== undefined)
                current.viewerAccess = params.viewer_access;
            if (params.telemetry_interval_sec !== undefined)
                current.telemetryIntervalSec = params.telemetry_interval_sec;
            if (params.wake_on_activate !== undefined)
                current.wakeOnActivate = params.wake_on_activate;
            if (params.auto_start_stream !== undefined)
                current.autoStartStream = params.auto_start_stream;
            if (params.target_device_id !== undefined)
                current.targetDeviceId = params.target_device_id;
            const updated = await api.updateWorkflow(workflow_id, {
                settings: JSON.stringify(current),
            });
            return { content: [{ type: "text", text: `Updated settings for "${updated.name}":\n${JSON.stringify(current, null, 2)}` }] };
        }
        catch (err) {
            return handleErr(err);
        }
    });
    // 23. Get flow config
    server.registerTool("wf_get_flow_config", {
        title: "Get Flow Execution Config",
        description: `Get the flow execution configuration for a workflow: execution mode (parallel/sequential/event-driven), flow ordering, and flow triggers.

Flow config controls how multiple disconnected sub-flows within a workflow execute:
- parallel: all flows start simultaneously
- sequential: flows run one after another in specified order
- event-driven: flows are triggered by conditions (on_flow_complete, on_condition, on_timer, on_jepa_event)

Returns the full FlowExecutionConfig with human-readable trigger details.`,
        inputSchema: {
            workflow_id: z.string().describe("Workflow ID"),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }, async ({ workflow_id }) => {
        try {
            const w = await api.getWorkflow(workflow_id);
            if (!w.flowConfig)
                return { content: [{ type: "text", text: `Workflow "${w.name}" has no flow config (default: parallel).` }] };
            const fc = w.flowConfig;
            const lines = [
                `# Flow Config — ${w.name}`,
                "",
                `Mode: ${fc.mode}`,
                `Flow order: ${fc.flowOrder.length ? fc.flowOrder.join(" -> ") : "(none)"}`,
            ];
            if (fc.flowTriggers && Object.keys(fc.flowTriggers).length) {
                lines.push("", "## Triggers");
                for (const [flowId, trigger] of Object.entries(fc.flowTriggers)) {
                    lines.push(`### Flow: ${flowId}`);
                    lines.push(`Type: ${trigger.type}`);
                    if (trigger.sourceFlowId)
                        lines.push(`Source flow: ${trigger.sourceFlowId}`);
                    if (trigger.condition) {
                        const c = trigger.condition;
                        lines.push(`Condition: ${c.field} ${c.operator} ${c.value} (from flow ${c.sourceFlowId})`);
                    }
                    if (trigger.intervalSec)
                        lines.push(`Interval: ${trigger.intervalSec}s`);
                    if (trigger.jepaEvent)
                        lines.push(`JEPA event: ${trigger.jepaEvent} (threshold: ${trigger.jepaConfidenceThreshold ?? "default"})`);
                }
            }
            return { content: [{ type: "text", text: lines.join("\n") }] };
        }
        catch (err) {
            return handleErr(err);
        }
    });
    // 24. Update flow config
    server.registerTool("wf_update_flow_config", {
        title: "Update Flow Execution Config",
        description: `Update the flow execution config for a workflow. Controls how multiple disconnected sub-flows execute.

Modes:
- "parallel": all flows start simultaneously (default)
- "sequential": flows run one after another in flowOrder
- "event-driven": flows are triggered by conditions

Trigger types (for event-driven mode):
- on_flow_complete: activate when another flow finishes (requires sourceFlowId)
- on_condition: activate when a field from another flow meets a condition (requires condition object with sourceFlowId, field, operator, value)
- on_timer: activate on a recurring interval (requires intervalSec)
- on_jepa_event: activate on JEPA anomaly/action events (optional jepaEvent filter, jepaConfidenceThreshold)

Pass the full flow_config as a JSON string.`,
        inputSchema: {
            workflow_id: z.string().describe("Workflow ID"),
            mode: z.enum(["parallel", "sequential", "event-driven"]).describe("Execution mode"),
            flow_order: z.string().optional().describe("JSON array of flow IDs in execution order (for sequential mode)"),
            flow_triggers: z.string().optional().describe("JSON object mapping flow IDs to FlowTrigger configs"),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }, async ({ workflow_id, mode, flow_order, flow_triggers }) => {
        try {
            const flowConfig = { mode, flowOrder: flow_order ? JSON.parse(flow_order) : [] };
            if (flow_triggers)
                flowConfig.flowTriggers = JSON.parse(flow_triggers);
            const updated = await api.updateWorkflow(workflow_id, {
                flowConfig: JSON.stringify(flowConfig),
            });
            return { content: [{ type: "text", text: `Updated flow config for "${updated.name}": mode=${mode}, ${flowConfig.flowOrder ? `${flowConfig.flowOrder.length} flows in order` : "no order"}, ${flow_triggers ? `${Object.keys(JSON.parse(flow_triggers)).length} triggers` : "no triggers"}` }] };
        }
        catch (err) {
            return handleErr(err);
        }
    });
    // 25. Validate node config
    server.registerTool("wf_validate_config", {
        title: "Validate Node Config",
        description: `Validate a node's config against its configSchema. Checks that:
- All required config keys are present
- Range values are within min/max bounds
- Select values match one of the defined options
- Number values respect min/max/step constraints
- Config keys not in the schema are flagged as unknown

Pass the node config as a JSON string. Returns a list of issues (or "valid" if none).`,
        inputSchema: {
            node_type: z.string().describe("Node type (e.g. 'tracking-ocsort', 's2s-live')"),
            config: z.string().describe("JSON string of the node config to validate"),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }, async ({ node_type, config }) => {
        try {
            const [defs, parsed] = await Promise.all([api.getNodeDefinitions(), Promise.resolve(JSON.parse(config))]);
            const def = defs.find((d) => d.type === node_type);
            if (!def)
                return { content: [{ type: "text", text: `Unknown node type: ${node_type}` }] };
            const issues = [];
            const configKeys = new Set(Object.keys(parsed));
            const schemaKeys = new Set();
            // Flatten configSchema to get all field keys (recursing into sections/conditionals)
            function collectFields(fields) {
                for (const f of fields) {
                    if (f.kind === "section" || f.kind === "conditional") {
                        collectFields((f.fields ?? []));
                    }
                    else if (f.key) {
                        schemaKeys.add(f.key);
                        const val = parsed[f.key];
                        if (val === undefined)
                            return; // missing keys handled below
                        switch (f.kind) {
                            case "range":
                                if (typeof val === "number") {
                                    if (val < f.min)
                                        issues.push(`${f.key}: ${val} below minimum ${f.min}`);
                                    if (val > f.max)
                                        issues.push(`${f.key}: ${val} above maximum ${f.max}`);
                                }
                                else {
                                    issues.push(`${f.key}: expected number, got ${typeof val}`);
                                }
                                break;
                            case "select":
                                if (typeof val === "string") {
                                    const validValues = (f.options ?? []).map((o) => o.value);
                                    if (!validValues.includes(val))
                                        issues.push(`${f.key}: "${val}" not in options [${validValues.join(", ")}]`);
                                }
                                else {
                                    issues.push(`${f.key}: expected string, got ${typeof val}`);
                                }
                                break;
                            case "number":
                                if (typeof val === "number") {
                                    if (f.min !== undefined && val < f.min)
                                        issues.push(`${f.key}: ${val} below minimum ${f.min}`);
                                    if (f.max !== undefined && val > f.max)
                                        issues.push(`${f.key}: ${val} above maximum ${f.max}`);
                                }
                                else {
                                    issues.push(`${f.key}: expected number, got ${typeof val}`);
                                }
                                break;
                        }
                    }
                }
            }
            collectFields(def.configSchema);
            // Check for missing schema keys (warn, not error — defaults may apply)
            for (const sk of schemaKeys) {
                if (!configKeys.has(sk) && parsed[sk] === undefined) {
                    issues.push(`${sk}: not set (default: ${JSON.stringify(def.defaultConfig[sk] ?? "none")})`);
                }
            }
            // Check for unknown config keys
            for (const ck of configKeys) {
                if (!schemaKeys.has(ck)) {
                    issues.push(`${ck}: unknown key (not in ${node_type} configSchema)`);
                }
            }
            if (!issues.length) {
                return { content: [{ type: "text", text: `Config for ${node_type} is valid. All ${configKeys.size} keys pass schema checks.` }] };
            }
            return { content: [{ type: "text", text: `Config validation (${issues.length} issues):\n${issues.map((i) => `- ${i}`).join("\n")}` }] };
        }
        catch (err) {
            return handleErr(err);
        }
    });
    // 26. Suggest config for use case
    server.registerTool("wf_suggest_config", {
        title: "Suggest Node Config",
        description: `Get sensible config values for a node type given a use case description. Returns the default config merged with adjusted values for the described scenario.

Example use cases:
- "low-light surveillance" — suggests night mode enhance, lower confidence thresholds
- "fast moving objects" — suggests higher FPS, lower smoothing, higher IoU threshold
- "quiet office OCR" — suggests lower FPS, higher confidence, English OCR
- "outdoor tracking with zones" — suggests GPS continuous, tracking with zones defined

Returns the suggested config as a JSON string you can pass to wf_add_node or wf_update_node.`,
        inputSchema: {
            node_type: z.string().describe("Node type to configure"),
            use_case: z.string().describe("Use case description (e.g. 'low-light surveillance', 'fast moving objects')"),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }, async ({ node_type, use_case }) => {
        try {
            const defs = await api.getNodeDefinitions();
            const def = defs.find((d) => d.type === node_type);
            if (!def)
                return { content: [{ type: "text", text: `Unknown node type: ${node_type}` }] };
            const config = { ...def.defaultConfig };
            const adjustments = [];
            const uc = use_case.toLowerCase();
            // Vision nodes
            if (node_type.startsWith("vision-")) {
                if (uc.includes("fast") || uc.includes("sport") || uc.includes("motion")) {
                    config.targetFPS = 10;
                    config.smoothingAlpha = 0.5;
                    adjustments.push("targetFPS=10 (fast), smoothingAlpha=0.5 (less smoothing)");
                }
                if (uc.includes("accurate") || uc.includes("precise") || uc.includes("careful")) {
                    config.confidence = 0.7;
                    config.smoothingAlpha = 0.2;
                    config.targetFPS = 3;
                    adjustments.push("confidence=0.7 (strict), smoothingAlpha=0.2 (heavy smoothing), targetFPS=3");
                }
                if (uc.includes("low-light") || uc.includes("dark") || uc.includes("night")) {
                    config.confidence = 0.3;
                    adjustments.push("confidence=0.3 (lenient for low-light)");
                }
            }
            // Tracking nodes
            if (node_type === "tracking-ocsort") {
                if (uc.includes("crowd") || uc.includes("busy") || uc.includes("many")) {
                    config.maxTracks = 50;
                    config.maxAge = 60;
                    config.minHits = 5;
                    adjustments.push("maxTracks=50, maxAge=60, minHits=5 (crowd scenario)");
                }
                if (uc.includes("fast") || uc.includes("sport")) {
                    config.targetFPS = 15;
                    config.iouThreshold = 0.2;
                    config.deltaT = 5;
                    config.inertia = 0.4;
                    adjustments.push("targetFPS=15, iouThreshold=0.2 (loose for fast motion), deltaT=5, inertia=0.4");
                }
                if (uc.includes("long") || uc.includes("persistent") || uc.includes("occlusion")) {
                    config.reconciliationEnabled = true;
                    config.reconciliationMaxGap = 120;
                    config.maxAge = 60;
                    adjustments.push("reconciliationEnabled=true, maxGap=120, maxAge=60 (long occlusions)");
                }
            }
            // AI processor nodes
            if (node_type.startsWith("s2s-")) {
                if (uc.includes("fast") || uc.includes("realtime") || uc.includes("responsive")) {
                    config.visionFps = 2;
                    config.analysisIntervalSec = 1;
                    config.temperature = 0.3;
                    adjustments.push("visionFps=2, analysisInterval=1s, temperature=0.3 (fast+focused)");
                }
                if (uc.includes("creative") || uc.includes("conversation") || uc.includes("chat")) {
                    config.temperature = 1.2;
                    adjustments.push("temperature=1.2 (creative)");
                }
            }
            // Enhance nodes
            if (node_type === "enhance-night-mode") {
                if (uc.includes("extreme") || uc.includes("very dark")) {
                    config.brightness = 0.3;
                    config.gamma = 0.6;
                    config.highlightAmount = 2.5;
                    adjustments.push("brightness=0.3, gamma=0.6, highlightAmount=2.5 (extreme night)");
                }
            }
            if (node_type === "enhance-brightness") {
                if (uc.includes("low-light") || uc.includes("dark")) {
                    config.brightness = 0.3;
                    config.contrast = 1.3;
                    adjustments.push("brightness=0.3, contrast=1.3 (low-light boost)");
                }
            }
            // Sensor nodes
            if (node_type === "sensor-location") {
                if (uc.includes("precise") || uc.includes("navigation")) {
                    config.accuracy = "best";
                    config.minDistance = 1;
                    config.updateIntervalSec = 1;
                    adjustments.push("accuracy=best, minDistance=1m, updateInterval=1s (precise tracking)");
                }
                if (uc.includes("battery") || uc.includes("efficient")) {
                    config.accuracy = "hundredMeters";
                    config.minDistance = 100;
                    config.updateIntervalSec = 60;
                    adjustments.push("accuracy=100m, minDistance=100m, updateInterval=60s (battery efficient)");
                }
            }
            if (!adjustments.length) {
                return { content: [{ type: "text", text: `No specific adjustments for "${use_case}". Using defaults for ${node_type}:\n${JSON.stringify(config, null, 2)}` }] };
            }
            return { content: [{ type: "text", text: `Suggested config for ${node_type} (${use_case}):\n${JSON.stringify(config, null, 2)}\n\nAdjustments from defaults:\n${adjustments.map((a) => `- ${a}`).join("\n")}` }] };
        }
        catch (err) {
            return handleErr(err);
        }
    });
}
//# sourceMappingURL=tools.js.map