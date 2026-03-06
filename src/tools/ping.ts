import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/**
 * Registers the ping tool on the server.
 * This is a "proof of life" tool — it verifies the server is working
 * and that tools can be called.
 */
export function registerPingTool(server: McpServer): void {
  server.registerTool(
    "afterglow_ping",
    {
      title: "Ping Afterglow",
      description:
        "Test tool to verify the afterglow-mcp server is running and responding. " +
        "Returns a confirmation message. Use this to check connectivity.",
      inputSchema: {
        message: z
          .string()
          .optional()
          .describe("Optional message to echo back"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ message }) => {
      const response = message
        ? `afterglow-mcp is running. You said: "${message}"`
        : "afterglow-mcp is running and ready.";

      return {
        content: [{ type: "text" as const, text: response }],
      };
    }
  );
}
