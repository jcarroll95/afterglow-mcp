#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerPingTool } from "./tools/ping.js";
import { registerAnalyzeChangesTool } from "./tools/analyze_changes.js";
import { registerExplainConnectionsTool } from "./tools/explain_connections.js";
import { registerGenerateDiagramTool } from "./tools/generate_diagram.js";
import { registerBriefingTool } from "./tools/briefing.js";

/**
 * Create and configure the MCP server.
 */
function createServer(): McpServer {
  const server = new McpServer({
    name: "afterglow-mcp",
    version: "0.2.0",
  });

  // Register all tools
  registerPingTool(server);
  registerAnalyzeChangesTool(server);
  registerExplainConnectionsTool(server);
  registerGenerateDiagramTool(server);
  registerBriefingTool(server);

  return server;
}

/**
 * Start the server with STDIO transport.
 */
async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Log to stderr — stdout is reserved for MCP protocol messages
  console.error("afterglow-mcp server started");
}

main().catch((error: unknown) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
