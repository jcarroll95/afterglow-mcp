import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  getStructuredDiff,
  getUntrackedFiles,
  isGitRepo,
} from "../modules/git.js";

/**
 * Categorizes a file by its extension into a human-readable type.
 */
function categorizeFile(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";

  // This is a Record<string, string> — a TypeScript way of typing an object
  // where all keys and values are strings. It's like saying "this is a
  // dictionary of string → string."
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
    env: "Environment config",
    sql: "Database query",
    sh: "Shell script",
    dockerfile: "Docker config",
  };

  // Check for special filenames
  const fileName = filePath.split("/").pop()?.toLowerCase() ?? "";
  if (fileName === "package.json") return "npm package config";
  if (fileName === "tsconfig.json") return "TypeScript config";
  if (fileName === ".gitignore") return "Git ignore rules";
  if (fileName === "dockerfile" || fileName.startsWith("dockerfile"))
    return "Docker config";

  return categories[ext] ?? "Other";
}

/**
 * Registers the afterglow_analyze_changes tool on the server.
 *
 * This tool reads git diffs and produces a structured, human-readable summary
 * of what changed — designed to be educational, not just informational.
 */
export function registerAnalyzeChangesTool(server: McpServer): void {
  server.registerTool(
    "afterglow_analyze_changes",
    {
      title: "Analyze Recent Code Changes",
      description:
        "Analyzes recent git changes in a project and produces a structured, " +
        "educational summary. Shows what files were modified, how many lines " +
        "changed, and categorizes changes by type (source code, config, docs, etc.). " +
        "Designed for developers who want to understand what AI-generated code " +
        "did to their project.\n\n" +
        "Args:\n" +
        "  - project_path (string): Absolute path to the project root (must be a git repo)\n" +
        "  - scope ('staged' | 'unstaged' | 'last_commit'): Which changes to analyze. " +
        "Defaults to 'unstaged' (current working directory changes).\n\n" +
        "Returns:\n" +
        "  A markdown-formatted summary with sections for changed files, " +
        "statistics, and categorized changes.",
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
      // Validate the project path is a git repo
      if (!isGitRepo(project_path)) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Error: "${project_path}" is not a git repository. ` +
                `afterglow-mcp requires a project with git initialized. ` +
                `Run \`git init\` in your project directory if needed.`,
            },
          ],
        };
      }

      try {
        const diff = getStructuredDiff(project_path, scope);
        const untrackedFiles = scope === "unstaged" ? getUntrackedFiles(project_path) : [];

        // If nothing changed, say so clearly
        if (diff.files.length === 0 && untrackedFiles.length === 0) {
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
                text: `No changes detected ${scopeLabel}. Your project is clean.`,
              },
            ],
          };
        }

        // Build the summary
        const lines: string[] = [];

        // Header
        const scopeLabel =
          scope === "staged"
            ? "Staged Changes"
            : scope === "last_commit"
              ? "Last Commit Changes"
              : "Working Directory Changes";

        lines.push(`# Afterglow: ${scopeLabel}`);
        lines.push("");

        // Quick stats
        const totalFiles = diff.files.length + untrackedFiles.length;
        lines.push(`**${totalFiles} files** changed: **+${diff.totalAdditions}** additions, **-${diff.totalDeletions}** deletions`);
        lines.push("");

        // Group files by category
        const byCategory = new Map<string, typeof diff.files>();
        for (const file of diff.files) {
          const category = categorizeFile(file.filePath);
          const existing = byCategory.get(category) ?? [];
          existing.push(file);
          byCategory.set(category, existing);
        }

        // Changed files by category
        lines.push("## Changes by Category");
        lines.push("");

        for (const [category, files] of byCategory) {
          lines.push(`### ${category}`);
          for (const file of files) {
            const statusEmoji =
              file.status === "added"
                ? "🆕"
                : file.status === "deleted"
                  ? "🗑️"
                  : file.status === "renamed"
                    ? "📝"
                    : "✏️";
            lines.push(
              `- ${statusEmoji} \`${file.filePath}\` — +${file.additions}/-${file.deletions}`
            );
          }
          lines.push("");
        }

        // Untracked files (new files not yet added to git)
        if (untrackedFiles.length > 0) {
          lines.push("### New Untracked Files");
          for (const file of untrackedFiles) {
            const category = categorizeFile(file);
            lines.push(`- 🆕 \`${file}\` (${category}) — not yet tracked by git`);
          }
          lines.push("");
        }

        // File-level detail with the actual diff content for each file
        lines.push("## File Details");
        lines.push("");
        for (const file of diff.files) {
          lines.push(`### \`${file.filePath}\``);
          lines.push(`- **Status**: ${file.status}`);
          lines.push(`- **Type**: ${categorizeFile(file.filePath)}`);
          lines.push(`- **Changes**: +${file.additions} additions, -${file.deletions} deletions`);
          lines.push("");
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
              text: `Error analyzing changes: ${message}`,
            },
          ],
        };
      }
    }
  );
}
