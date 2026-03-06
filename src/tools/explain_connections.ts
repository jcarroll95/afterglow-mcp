import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolve, relative } from "path";
import { existsSync } from "fs";
import { isGitRepo } from "../modules/git.js";
import {
  buildGraph,
  extractSubgraph,
  getImportsOf,
  getImportersOf,
} from "../modules/graph.js";

/**
 * Registers the afterglow_explain_connections tool.
 *
 * Given a file and project path, this tool:
 * 1. Builds the project's dependency graph
 * 2. Finds what the file imports and what imports it
 * 3. Extracts a neighborhood subgraph around the file
 * 4. Produces a plain-English explanation of how the file fits
 *    into the project architecture
 */
export function registerExplainConnectionsTool(server: McpServer): void {
  server.registerTool(
    "afterglow_explain_connections",
    {
      title: "Explain File Connections",
      description:
        "Analyzes how a specific file connects to the rest of the project. " +
        "Traces its imports (what it depends on) and its importers (what depends " +
        "on it), and explains the relationships in plain English with a focus on " +
        "helping developers understand the architecture.\n\n" +
        "Args:\n" +
        "  - project_path (string): Absolute path to the project root\n" +
        "  - file_path (string): Path to the file to analyze (absolute or relative to project root)\n" +
        "  - depth (number): How many levels of connections to trace (default: 1)\n\n" +
        "Returns:\n" +
        "  A markdown-formatted explanation of the file's role in the project, " +
        "what it depends on, and what depends on it.",
      inputSchema: {
        project_path: z
          .string()
          .describe("Absolute path to the project root directory"),
        file_path: z
          .string()
          .describe(
            "Path to the file to analyze. Can be absolute or relative to the project root."
          ),
        depth: z
          .number()
          .int()
          .min(1)
          .max(3)
          .default(1)
          .describe(
            "How many levels of connections to trace outward. " +
            "1 = direct imports/importers only. 2 = includes their connections too. " +
            "Default: 1. Max: 3 (to keep output manageable)."
          ),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ project_path, file_path, depth }) => {
      // Validate project is a git repo
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

      // Resolve the file path
      const absoluteRoot = resolve(project_path);
      const absoluteFile = file_path.startsWith("/")
        ? file_path
        : resolve(absoluteRoot, file_path);
      const relativeFile = relative(absoluteRoot, absoluteFile);

      // Check the file exists
      if (!existsSync(absoluteFile)) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Error: File not found: "${relativeFile}". ` +
                `Make sure the path is correct relative to the project root.`,
            },
          ],
        };
      }

      try {
        // Build the full project graph
        const fullGraph = buildGraph(project_path);

        // Check that our file is in the graph
        const nodeExists = fullGraph.nodes.some(
          (n) => n.filePath === relativeFile
        );
        if (!nodeExists) {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `"${relativeFile}" was not found in the project's dependency graph. ` +
                  `This usually means it's not a JavaScript/TypeScript source file, ` +
                  `or it's in a directory that afterglow filters out (like node_modules or build/).`,
              },
            ],
          };
        }

        // Get direct connections
        const importsEdges = getImportsOf(fullGraph, relativeFile);
        const importerEdges = getImportersOf(fullGraph, relativeFile);

        // Get the node info for the focus file
        const focusNode = fullGraph.nodes.find(
          (n) => n.filePath === relativeFile
        );

        // Extract neighborhood subgraph
        const subgraph = extractSubgraph(fullGraph, [relativeFile], depth);

        // Build the explanation
        const lines: string[] = [];

        // Header
        lines.push(`# Afterglow: Connections for \`${relativeFile}\``);
        lines.push("");

        // File identity
        if (focusNode) {
          lines.push(`**Type**: ${focusNode.category}`);
          if (focusNode.exports.length > 0) {
            lines.push(
              `**Exports**: ${focusNode.exports.map((e) => `\`${e}\``).join(", ")}`
            );
          }
          lines.push("");
        }

        // Quick summary
        const inCount = importerEdges.length;
        const outCount = importsEdges.length;
        if (inCount === 0 && outCount === 0) {
          lines.push(
            "This file is **isolated** — it doesn't import from or get imported by " +
            "any other project files. It may be an entry point, a standalone script, " +
            "or a newly created file that hasn't been wired in yet."
          );
          lines.push("");
        } else {
          lines.push(
            `This file has **${outCount} dependency${outCount !== 1 ? "ies" : ""}** ` +
            `(files it imports from) and **${inCount} dependent${inCount !== 1 ? "s" : ""}** ` +
            `(files that import from it).`
          );
          lines.push("");
        }

        // What this file depends on
        if (importsEdges.length > 0) {
          lines.push("## Dependencies (what this file imports)");
          lines.push("");
          for (const edge of importsEdges) {
            const targetNode = fullGraph.nodes.find(
              (n) => n.filePath === edge.to
            );
            const targetType = targetNode?.category ?? "Unknown";

            if (edge.symbols.length > 0) {
              lines.push(
                `- **\`${edge.to}\`** (${targetType}) — imports ${edge.symbols.map((s) => `\`${s}\``).join(", ")}`
              );
            } else {
              lines.push(
                `- **\`${edge.to}\`** (${targetType}) — side-effect import`
              );
            }
          }
          lines.push("");
        }

        // What depends on this file
        if (importerEdges.length > 0) {
          lines.push("## Dependents (what imports this file)");
          lines.push("");
          for (const edge of importerEdges) {
            const sourceNode = fullGraph.nodes.find(
              (n) => n.filePath === edge.from
            );
            const sourceType = sourceNode?.category ?? "Unknown";

            if (edge.symbols.length > 0) {
              lines.push(
                `- **\`${edge.from}\`** (${sourceType}) — uses ${edge.symbols.map((s) => `\`${s}\``).join(", ")}`
              );
            } else {
              lines.push(
                `- **\`${edge.from}\`** (${sourceType}) — side-effect import`
              );
            }
          }
          lines.push("");
        }

        // Neighborhood summary (for depth > 1)
        if (depth > 1 && subgraph.nodes.length > importsEdges.length + importerEdges.length + 1) {
          lines.push("## Extended Neighborhood");
          lines.push("");
          lines.push(
            `With depth=${depth}, the connection graph includes ` +
            `**${subgraph.nodes.length} files** and **${subgraph.edges.length} connections**. ` +
            `This shows the broader context of how this file fits into the architecture.`
          );
          lines.push("");

          // List files in the extended neighborhood that aren't direct connections
          const directFiles = new Set([
            relativeFile,
            ...importsEdges.map((e) => e.to),
            ...importerEdges.map((e) => e.from),
          ]);
          const extendedFiles = subgraph.nodes.filter(
            (n) => !directFiles.has(n.filePath)
          );
          if (extendedFiles.length > 0) {
            lines.push("Files connected through intermediaries:");
            for (const node of extendedFiles) {
              lines.push(`- \`${node.filePath}\` (${node.category})`);
            }
            lines.push("");
          }
        }

        // Architecture insight
        lines.push("## Architectural Role");
        lines.push("");
        if (inCount === 0 && outCount > 0) {
          lines.push(
            "This file is a **leaf consumer** — it uses other modules but nothing depends on it. " +
            "This is typical of entry points, scripts, and top-level orchestration files."
          );
        } else if (inCount > 0 && outCount === 0) {
          lines.push(
            "This file is a **pure provider** — other files depend on it, but it has no " +
            "dependencies of its own within the project. This is typical of utility libraries, " +
            "type definitions, and constants files."
          );
        } else if (inCount > 0 && outCount > 0) {
          const ratio = inCount / (inCount + outCount);
          if (ratio > 0.7) {
            lines.push(
              "This file is a **core module** — many files depend on it. Changes here " +
              "will have a wide impact across the project. Treat modifications carefully."
            );
          } else if (ratio < 0.3) {
            lines.push(
              "This file is a **consumer with limited exposure** — it imports from several " +
              "modules but few other files depend on it directly."
            );
          } else {
            lines.push(
              "This file sits in the **middle layer** of the architecture — it both consumes " +
              "and provides functionality. It acts as a bridge between different parts of the project."
            );
          }
        }
        lines.push("");

        // Graph stats footer
        lines.push("---");
        lines.push(
          `*Graph: ${fullGraph.nodes.length} files, ${fullGraph.edges.length} connections total in project*`
        );

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
              text: `Error analyzing connections: ${message}`,
            },
          ],
        };
      }
    }
  );
}
