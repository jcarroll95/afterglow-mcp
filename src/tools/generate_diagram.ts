import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolve, relative } from "path";
import { existsSync } from "fs";
import { isGitRepo } from "../modules/git.js";
import { buildGraph, extractSubgraph } from "../modules/graph.js";
import { generateMermaid, generateSimpleMermaid } from "../modules/mermaid.js";

/**
 * Registers the afterglow_generate_diagram tool.
 *
 * Produces a Mermaid architecture diagram showing how files in the
 * project connect to each other. Can focus on a specific file's
 * neighborhood or show the full project structure.
 */
export function registerGenerateDiagramTool(server: McpServer): void {
  server.registerTool(
    "afterglow_generate_diagram",
    {
      title: "Generate Architecture Diagram",
      description:
        "Generates a Mermaid diagram showing how files and modules in a project " +
        "connect to each other through imports. Can focus on a specific file's " +
        "neighborhood or show broader project structure.\n\n" +
        "The diagram is returned as Mermaid source code which most AI tools " +
        "and markdown renderers will display as a visual diagram.\n\n" +
        "Args:\n" +
        "  - project_path (string): Absolute path to the project root\n" +
        "  - focus_file (string, optional): Center the diagram on this file's connections\n" +
        "  - depth (number): How many levels of connections to include (default: 1)\n" +
        "  - direction ('LR' | 'TB'): Layout direction. LR = left-to-right, TB = top-to-bottom\n" +
        "  - simple (boolean): If true, omit import details for a cleaner diagram\n\n" +
        "Returns:\n" +
        "  Mermaid diagram source code inside a code fence, plus a summary.",
      inputSchema: {
        project_path: z
          .string()
          .describe("Absolute path to the project root directory"),
        focus_file: z
          .string()
          .optional()
          .describe(
            "Optional: center the diagram on this file's connections. " +
            "Path can be absolute or relative to the project root."
          ),
        depth: z
          .number()
          .int()
          .min(1)
          .max(4)
          .default(1)
          .describe(
            "How many levels of connections to include outward from the focus file. " +
            "Default: 1. Higher values show more of the architecture but produce larger diagrams."
          ),
        direction: z
          .enum(["LR", "TB"])
          .default("LR")
          .describe(
            "Diagram layout direction. 'LR' = left-to-right (wider), " +
            "'TB' = top-to-bottom (taller). Default: LR."
          ),
        simple: z
          .boolean()
          .default(false)
          .describe(
            "If true, produce a simplified diagram without import details on edges. " +
            "Useful for larger graphs where labels would create clutter."
          ),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ project_path, focus_file, depth, direction, simple }) => {
      if (!isGitRepo(project_path)) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Error: "${project_path}" is not a git repository. ` +
                `afterglow-mcp requires a project with git initialized.`,
            },
          ],
        };
      }

      try {
        const absoluteRoot = resolve(project_path);
        const fullGraph = buildGraph(project_path);

        let graphToRender = fullGraph;
        let focusRelative: string | undefined;

        // If a focus file is specified, extract a subgraph around it
        if (focus_file) {
          const absoluteFile = focus_file.startsWith("/")
            ? focus_file
            : resolve(absoluteRoot, focus_file);
          focusRelative = relative(absoluteRoot, absoluteFile);

          if (!existsSync(absoluteFile)) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Error: File not found: "${focusRelative}".`,
                },
              ],
            };
          }

          const nodeExists = fullGraph.nodes.some(
            (n) => n.filePath === focusRelative
          );
          if (!nodeExists) {
            return {
              content: [
                {
                  type: "text" as const,
                  text:
                    `"${focusRelative}" was not found in the dependency graph. ` +
                    `It may not be a JS/TS source file, or it's in a filtered directory.`,
                },
              ],
            };
          }

          graphToRender = extractSubgraph(fullGraph, [focusRelative], depth);
        } else if (fullGraph.nodes.length > 50) {
          // For large projects without a focus file, suggest focusing
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `This project has ${fullGraph.nodes.length} source files and ` +
                  `${fullGraph.edges.length} connections. A full diagram would be ` +
                  `difficult to read.\n\n` +
                  `Try specifying a \`focus_file\` to center the diagram on a ` +
                  `specific file's neighborhood, or increase \`depth\` gradually.\n\n` +
                  `Some files that might be interesting to focus on:\n` +
                  getMostConnectedFiles(fullGraph, 5),
              },
            ],
          };
        }

        // Generate the diagram
        const mermaidSource = simple
          ? generateSimpleMermaid(graphToRender, {
              focusFile: focusRelative,
              direction,
            })
          : generateMermaid(graphToRender, {
              focusFile: focusRelative,
              direction,
            });

        // Build the response
        const lines: string[] = [];

        if (focusRelative) {
          lines.push(`# Afterglow: Architecture around \`${focusRelative}\``);
        } else {
          lines.push("# Afterglow: Project Architecture");
        }
        lines.push("");
        lines.push(
          `*${graphToRender.nodes.length} files, ${graphToRender.edges.length} connections` +
          (focusRelative ? `, depth ${depth} from focus` : "") +
          "*"
        );
        lines.push("");
        lines.push("~~~mermaid");
        lines.push(mermaidSource);
        lines.push("~~~");

        // Legend
        lines.push("");
        lines.push("**Reading the diagram**: Arrows show import direction — " +
          "an arrow from A to B means A imports from B. " +
          (focusRelative ? "The highlighted node (🔍) is the focus file." : ""));

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
        };
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text" as const,
              text: `Error generating diagram: ${message}`,
            },
          ],
        };
      }
    }
  );
}

/**
 * Helper: find the most-connected files in a graph for suggesting focus targets.
 */
function getMostConnectedFiles(
  graph: { nodes: Array<{ filePath: string }>; edges: Array<{ from: string; to: string }> },
  count: number
): string {
  // Count connections per file (both directions)
  const connectionCount = new Map<string, number>();
  for (const node of graph.nodes) {
    connectionCount.set(node.filePath, 0);
  }
  for (const edge of graph.edges) {
    connectionCount.set(edge.from, (connectionCount.get(edge.from) ?? 0) + 1);
    connectionCount.set(edge.to, (connectionCount.get(edge.to) ?? 0) + 1);
  }

  // Sort by connection count and return top N
  const sorted = [...connectionCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, count);

  return sorted
    .map(([file, connections]) => `- \`${file}\` (${connections} connections)`)
    .join("\n");
}
