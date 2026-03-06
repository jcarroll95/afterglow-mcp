import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerPingTool } from "./tools/ping.js";

/**
 * Create and configure the MCP server.
 */
function createServer(): McpServer {
    const server = new McpServer({
        name: "afterglow-mcp",
        version: "0.1.0",
    });

    // Register all tools
    registerPingTool(server);

    // Tools that are added later go here:
    // registerAnalyzeChangesTool(server);
    // registerExplainConnectionsTool(server);
    // registerGenerateDiagramTool(server);
    // registerBriefingTool(server);

    return server;
}

/**
 * Start the server with STDIO transport.
 */
async function main(): Promise<void> {
    const server = createServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);

    // Log to stderr because stdout is used for MCP protocol messages. Always use console.error() for
    // debug logging in MCP servers.
    console.error("afterglow-mcp server started");
}

main().catch((error: unknown) => {
    console.error("Fatal error:", error);
    process.exit(1);
});