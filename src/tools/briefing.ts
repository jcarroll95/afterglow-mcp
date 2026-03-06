import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolve, relative } from "path";
import {
  getStructuredDiff,
  getUntrackedFiles,
  isGitRepo,
} from "../modules/git.js";
import { filterFiles, filterFilePaths } from "../modules/filter.js";
import { isParseableFile } from "../modules/parser.js";
import {
  buildGraph,
  extractSubgraph,
  getImportsOf,
  getImportersOf,
} from "../modules/graph.js";
import { generateMermaid, generateSimpleMermaid } from "../modules/mermaid.js";

/**
 * Categorize a file by extension. Duplicated from analyze_changes for now —
 * will be extracted to a shared util when we refactor.
 */
function categorizeFile(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  const categories: Record<string, string> = {
    ts: "TypeScript source",
    tsx: "React component (TSX)",
    js: "JavaScript source",
    jsx: "React component (JSX)",
    json: "Configuration/data",
    md: "Documentation",
    css: "Stylesheet",
    scss: "Stylesheet (SCSS)",
    html: "HTML template",
    yml: "YAML config",
    yaml: "YAML config",
  };
  const fileName = filePath.split("/").pop()?.toLowerCase() ?? "";
  if (fileName === "package.json") return "npm package config";
  if (fileName === "tsconfig.json") return "TypeScript config";
  return categories[ext] ?? "Other";
}

/**
 * Registers the afterglow_briefing tool.
 *
 * This is the flagship tool. It combines change analysis, connection
 * tracing, and diagram generation into a single educational briefing
 * about what just happened to the project.
 */
export function registerBriefingTool(server: McpServer): void {
  server.registerTool(
    "afterglow_briefing",
    {
      title: "Code Change Briefing",
      description:
        "Produces a comprehensive, educational briefing about recent code changes. " +
        "Combines change analysis, dependency tracing, and architecture diagrams " +
        "into a single report designed to help developers understand what " +
        "AI-generated code did to their project.\n\n" +
        "This is the primary tool — use it when the developer asks to understand " +
        "recent changes, says 'brief me', or wants to know what just happened.\n\n" +
        "The briefing includes:\n" +
        "  - What files changed and how (additions, modifications, deletions)\n" +
        "  - How changed files connect to the rest of the project\n" +
        "  - A Mermaid architecture diagram of the affected area\n" +
        "  - Key observations about the architectural impact\n\n" +
        "Args:\n" +
        "  - project_path (string): Absolute path to the project root\n" +
        "  - scope ('staged' | 'unstaged' | 'last_commit'): Which changes to analyze\n\n" +
        "Returns:\n" +
        "  A comprehensive markdown briefing with diagram.",
      inputSchema: {
        project_path: z
          .string()
          .describe("Absolute path to the project root directory (must be a git repo)"),
        scope: z
          .enum(["staged", "unstaged", "last_commit"])
          .default("unstaged")
          .describe(
            "Which changes to analyze: 'unstaged' for working directory changes, " +
            "'staged' for changes ready to commit, 'last_commit' for the most recent commit"
          ),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ project_path, scope }) => {
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

        // ── Phase 1: Detect Changes ──────────────────────────────

        const rawDiff = getStructuredDiff(project_path, scope);
        const rawUntracked =
          scope === "unstaged" ? getUntrackedFiles(project_path) : [];

        const filteredFiles = filterFiles(rawDiff.files);
        const untrackedFiles = filterFilePaths(rawUntracked);

        let totalAdditions = 0;
        let totalDeletions = 0;
        for (const file of filteredFiles) {
          totalAdditions += file.additions;
          totalDeletions += file.deletions;
        }

        const allChangedPaths = [
          ...filteredFiles.map((f) => f.filePath),
          ...untrackedFiles,
        ];

        if (allChangedPaths.length === 0) {
          const scopeLabel =
            scope === "staged"
              ? "staged for commit"
              : scope === "last_commit"
                ? "in the last commit"
                : "in the working directory";
          return {
            content: [
              {
                type: "text" as const,
                text: `No changes detected ${scopeLabel}. Nothing to brief on.`,
              },
            ],
          };
        }

        // ── Phase 2: Build Dependency Graph ──────────────────────

        const fullGraph = buildGraph(project_path);

        // Extract subgraph around changed files (depth 1 = immediate neighbors)
        const parseableChanged = allChangedPaths.filter(isParseableFile);
        const subgraph =
          parseableChanged.length > 0
            ? extractSubgraph(fullGraph, parseableChanged, 1)
            : { nodes: [], edges: [], builtAt: fullGraph.builtAt, projectRoot: fullGraph.projectRoot };

        // ── Phase 3: Assemble Briefing ───────────────────────────

        const lines: string[] = [];
        const scopeLabel =
          scope === "staged"
            ? "Staged Changes"
            : scope === "last_commit"
              ? "Last Commit"
              : "Working Directory";

        lines.push(`# Afterglow Briefing: ${scopeLabel}`);
        lines.push("");

        // Overview stats
        const fileCount = allChangedPaths.length;
        lines.push(
          `**${fileCount} file${fileCount !== 1 ? "s" : ""} changed** · ` +
          `+${totalAdditions} additions · -${totalDeletions} deletions`
        );
        lines.push("");

        // ── Section: What Changed ────────────────────────────────

        lines.push("## What Changed");
        lines.push("");

        // Group by category
        const byCategory = new Map<string, typeof filteredFiles>();
        for (const file of filteredFiles) {
          const cat = categorizeFile(file.filePath);
          const group = byCategory.get(cat) ?? [];
          group.push(file);
          byCategory.set(cat, group);
        }

        for (const [category, files] of byCategory) {
          lines.push(`**${category}**`);
          for (const file of files) {
            const emoji =
              file.status === "added"
                ? "🆕"
                : file.status === "deleted"
                  ? "🗑️"
                  : file.status === "renamed"
                    ? "📝"
                    : "✏️";
            lines.push(
              `- ${emoji} \`${file.filePath}\` (+${file.additions}/-${file.deletions})`
            );
          }
          lines.push("");
        }

        if (untrackedFiles.length > 0) {
          lines.push("**New Untracked Files**");
          for (const file of untrackedFiles) {
            lines.push(`- 🆕 \`${file}\` (${categorizeFile(file)})`);
          }
          lines.push("");
        }

        // ── Section: How It Connects ─────────────────────────────

        if (parseableChanged.length > 0 && subgraph.edges.length > 0) {
          lines.push("## How These Changes Connect");
          lines.push("");

          for (const changedFile of parseableChanged) {
            const imports = getImportsOf(fullGraph, changedFile);
            const importers = getImportersOf(fullGraph, changedFile);

            // Only include files that have connections
            if (imports.length === 0 && importers.length === 0) continue;

            lines.push(`**\`${changedFile}\`**`);

            if (imports.length > 0) {
              const importList = imports
                .map((e) => {
                  const symbols =
                    e.symbols.length > 0
                      ? ` (${e.symbols.join(", ")})`
                      : "";
                  return `\`${e.to}\`${symbols}`;
                })
                .join(", ");
              lines.push(`- Depends on: ${importList}`);
            }

            if (importers.length > 0) {
              const importerList = importers
                .map((e) => `\`${e.from}\``)
                .join(", ");
              lines.push(`- Used by: ${importerList}`);
            }

            lines.push("");
          }
        }

        // ── Section: Architecture Diagram ────────────────────────

        if (subgraph.nodes.length > 1) {
          lines.push("## Architecture");
          lines.push("");

          const useSimple = subgraph.edges.length > 15;
          const mermaidSource = useSimple
            ? generateSimpleMermaid(subgraph, { direction: "LR" })
            : generateMermaid(subgraph, { direction: "LR" });

          lines.push("```mermaid");
          lines.push(mermaidSource);
          lines.push("```");
          lines.push("");
          lines.push(
            `*Showing ${subgraph.nodes.length} files and ` +
            `${subgraph.edges.length} connections in the affected area.*`
          );
          lines.push("");
        }

        // ── Section: Key Observations ────────────────────────────

        const observations = generateObservations(
          filteredFiles,
          untrackedFiles,
          parseableChanged,
          fullGraph,
          subgraph
        );

        if (observations.length > 0) {
          lines.push("## Key Observations");
          lines.push("");
          for (const obs of observations) {
            lines.push(`- ${obs}`);
          }
          lines.push("");
        }

        // Footer
        const skippedCount =
          rawDiff.files.length -
          filteredFiles.length +
          (rawUntracked.length - untrackedFiles.length);
        if (skippedCount > 0) {
          lines.push("---");
          lines.push(
            `*${skippedCount} file(s) excluded (node_modules, lock files, build artifacts, etc.)*`
          );
        }

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
              text: `Error generating briefing: ${message}`,
            },
          ],
        };
      }
    }
  );
}

// ─── Observation Generator ─────────────────────────────────────────

/**
 * Generate key observations about the changes based on the data.
 * These are the "so what?" insights that make the briefing educational.
 */
function generateObservations(
  changedFiles: Array<{
    filePath: string;
    status: string;
    additions: number;
    deletions: number;
  }>,
  untrackedFiles: string[],
  parseableChanged: string[],
  fullGraph: { nodes: Array<{ filePath: string }>; edges: Array<{ from: string; to: string }> },
  subgraph: { nodes: Array<{ filePath: string }>; edges: Array<{ from: string; to: string }> }
): string[] {
  const observations: string[] = [];

  // New files added
  const newFiles = changedFiles.filter((f) => f.status === "added");
  if (newFiles.length > 0) {
    observations.push(
      `**${newFiles.length} new file(s)** were added to the project. ` +
      `Review their imports to understand how they integrate with existing code.`
    );
  }

  // Deleted files
  const deletedFiles = changedFiles.filter((f) => f.status === "deleted");
  if (deletedFiles.length > 0) {
    observations.push(
      `**${deletedFiles.length} file(s) were deleted.** ` +
      `Check that nothing still imports from them — dangling imports cause build errors.`
    );
  }

  // High-impact changes (files with many dependents)
  for (const filePath of parseableChanged) {
    const importers = fullGraph.edges.filter((e) => e.to === filePath);
    if (importers.length >= 3) {
      observations.push(
        `\`${filePath}\` is imported by **${importers.length} other files**. ` +
        `Changes here have a wide blast radius — test thoroughly.`
      );
    }
  }

  // Large changes
  const largestChange = changedFiles.reduce(
    (max, f) =>
      f.additions + f.deletions > max.additions + max.deletions ? f : max,
    changedFiles[0]
  );
  if (
    largestChange &&
    largestChange.additions + largestChange.deletions > 100
  ) {
    observations.push(
      `\`${largestChange.filePath}\` had the largest change ` +
      `(+${largestChange.additions}/-${largestChange.deletions} lines). ` +
      `Large changes in a single file may warrant splitting into smaller modules.`
    );
  }

  // Isolated files (new files with no connections)
  for (const filePath of untrackedFiles) {
    if (isParseableFile(filePath)) {
      const hasConnections = subgraph.edges.some(
        (e) => e.from === filePath || e.to === filePath
      );
      if (!hasConnections) {
        observations.push(
          `\`${filePath}\` is new and not yet connected to the project graph. ` +
          `It may need to be imported somewhere to be used.`
        );
      }
    }
  }

  // Ratio of config to source changes
  const configChanges = changedFiles.filter((f) => {
    const cat = categorizeFile(f.filePath);
    return cat.includes("config") || cat.includes("Config");
  });
  if (configChanges.length > 0 && configChanges.length >= changedFiles.length / 2) {
    observations.push(
      `A significant portion of changes are configuration files. ` +
      `This may indicate project setup, dependency changes, or build configuration updates.`
    );
  }

  return observations;
}
