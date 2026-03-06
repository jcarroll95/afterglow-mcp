/**
 * Shared type definitions for afterglow-mcp.
 *
 * DESIGN DECISION: Every interface here is intentionally JSON-serializable.
 * No Maps, Sets, functions, or class instances — only plain objects, arrays,
 * strings, numbers, and booleans. This is because in v0.4+ we'll persist
 * the dependency graph to .afterglow/state.json between runs. If the types
 * are serializable from day one, that future work is just
 * JSON.stringify/JSON.parse with no refactoring.
 */

// ─── Import Parsing ──────────────────────────────────────────────────

/**
 * A single import found in a source file.
 */
export interface ImportInfo {
  /** The raw import path as written (e.g., "./utils", "express", "../models/user") */
  source: string;

  /** Named imports (e.g., ["useState", "useEffect"]). Empty array for default/namespace imports. */
  specifiers: string[];

  /** Whether this is a default import (import Foo from "...") */
  isDefault: boolean;

  /** Whether this is a namespace import (import * as Foo from "...") */
  isNamespace: boolean;

  /** Whether this is a relative import (starts with . or ..) vs a package import */
  isRelative: boolean;
}

/**
 * The parsed result for a single file: its imports and exports.
 */
export interface FileAnalysis {
  /** Absolute or project-relative path to the file */
  filePath: string;

  /** All imports found in this file */
  imports: ImportInfo[];

  /** Named exports found in this file */
  exports: string[];
}

// ─── Dependency Graph ────────────────────────────────────────────────

/**
 * A node in the dependency graph representing one file.
 */
export interface GraphNode {
  /** Project-relative file path (e.g., "src/tools/ping.ts") */
  filePath: string;

  /** What this file exports (function names, class names, constants) */
  exports: string[];

  /** Human-readable category (e.g., "TypeScript source", "React component") */
  category: string;
}

/**
 * An edge in the dependency graph: file A imports something from file B.
 */
export interface GraphEdge {
  /** The file that contains the import statement */
  from: string;

  /** The file being imported from */
  to: string;

  /** What symbols are being imported (e.g., ["useState", "useEffect"]) */
  symbols: string[];

  /** Whether this is a default import */
  isDefault: boolean;
}

/**
 * The full dependency graph for a project or a subgraph focused on specific files.
 *
 * This is the core data structure that gets:
 * - Built by the graph module
 * - Rendered into Mermaid diagrams by the diagram module
 * - Diffed against previous state in future versions
 * - Serialized to .afterglow/state.json for persistence
 */
export interface DependencyGraph {
  /** All files in the graph */
  nodes: GraphNode[];

  /** All import relationships between files */
  edges: GraphEdge[];

  /** When this graph was built (ISO string) */
  builtAt: string;

  /** The project root this graph was built from */
  projectRoot: string;
}

// ─── Briefing Output ─────────────────────────────────────────────────

/**
 * A single file's entry in a briefing.
 */
export interface BriefingFileEntry {
  filePath: string;
  status: "added" | "modified" | "deleted" | "renamed";
  category: string;
  additions: number;
  deletions: number;
  /** Files this file imports from (project files only, not packages) */
  importsFrom: string[];
  /** Files that import from this file */
  importedBy: string[];
}

/**
 * The complete output of a briefing. Designed to be both
 * human-readable (via the formatted text) and machine-diffable
 * (via the structured data).
 */
export interface Briefing {
  /** When this briefing was generated */
  generatedAt: string;

  /** What scope was analyzed */
  scope: "staged" | "unstaged" | "last_commit";

  /** Per-file analysis */
  files: BriefingFileEntry[];

  /** The dependency subgraph covering changed files and their neighbors */
  graph: DependencyGraph;

  /** Mermaid diagram source */
  diagram: string;
}
