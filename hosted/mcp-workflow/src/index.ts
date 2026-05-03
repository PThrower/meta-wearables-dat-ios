#!/usr/bin/env node
/**
 * MCP server for the MWDAT workflow editor.
 *
 * Provides 14 tools for workflow CRUD, node/edge operations,
 * activation, and node definitions — all via the relay server REST API.
 *
 * Environment variables:
 *   MWDAT_RELAY_URL  — relay server URL (default: https://relay.simulationapi.com)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools.js";

const server = new McpServer({
  name: "mwdat-workflow-mcp",
  version: "1.0.0",
});

registerTools(server);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MCP workflow server running via stdio");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
