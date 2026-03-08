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

// ─── Export Parsing ──────────────────────────────────────────────────

/**
 * A richer representation of a single export from a source file.
 *
 * UPGRADE from v0.4: Previously exports were just string[] of names.
 * This captures the full public contract — the kind, parameters, and
 * return type — so the briefing can show API surface area.
 *
 * The `kind` field tells you what syntactic form the export takes.
 * The `params` and `returnType` fields are best-effort regex extractions —
 * they'll be present for most functions and arrow-const exports, absent
 * for types/interfaces/enums (where they don't apply).
 */
export interface ExportSignature {
  /** The exported name (e.g., "buildGraph", "DependencyGraph", "default") */
  name: string;

  /**
   * What kind of export this is.
   *
   * "function"  — export function foo() / export async function foo()
   * "class"     — export class Foo
   * "const"     — export const foo = ... (includes arrow functions)
   * "let"       — export let foo = ...
   * "var"       — export var foo = ...
   * "type"      — export type Foo = ...
   * "interface" — export interface Foo
   * "enum"      — export enum Foo
   * "default"   — export default ... (when we can't determine the specific kind)
   */
  kind:
    | "function"
    | "class"
    | "const"
    | "let"
    | "var"
    | "type"
    | "interface"
    | "enum"
    | "default";

  /**
   * Parameter signature for functions/methods, e.g. "(server: McpServer)"
   * or "(projectRoot: string, depth?: number)".
   *
   * This is the raw text between the parens — we don't parse individual
   * params because the regex approach has diminishing returns there.
   * Consumers can display it as-is for a useful at-a-glance API view.
   *
   * Absent for non-function exports (types, interfaces, enums, plain consts).
   */
  params?: string;

  /**
   * Return type annotation if the developer wrote one, e.g. "void",
   * "DependencyGraph", "Promise<string[]>".
   *
   * Absent when no explicit return type annotation exists (TypeScript
   * infers it, but we don't — that would require type-checking, not regex).
   */
  returnType?: string;

  /** Whether this export is the default export of the module */
  isDefault: boolean;
}

/**
 * The parsed result for a single file: its imports and exports.
 */
export interface FileAnalysis {
  /** Absolute or project-relative path to the file */
  filePath: string;

  /** All imports found in this file */
  imports: ImportInfo[];

  /**
   * Named exports found in this file.
   *
   * BACKWARD COMPAT: This was string[] in v0.4. It's now ExportSignature[].
   * If you need just the names (which most existing code does), use:
   *   analysis.exports.map(e => e.name)
   *
   * Or use the convenience getter `exportNames` if we add one later.
   */
  exports: ExportSignature[];
}

// ─── Semantic Analysis ───────────────────────────────────────────────

/**
 * Confidence level for a semantic relationship inference.
 *
 * "inferred"  — We matched a naming pattern (e.g., "buildGraph" → "builds")
 *               or detected a usage pattern in the importing file.
 * "structural" — We couldn't determine the verb, so we fell back to
 *                the generic "uses". Still correct, just not specific.
 */
export type SemanticConfidence = "inferred" | "structural";

/**
 * A semantic label describing HOW an imported symbol is used,
 * not just THAT it's imported.
 *
 * This is the key upgrade from v0.4 → v0.5. Instead of edge labels
 * like "registerPingTool, buildGraph", we get labels like
 * "registers tool", "builds dependency graph".
 */
export interface SymbolRelationship {
  /** The imported symbol name (e.g., "buildGraph") */
  symbol: string;

  /**
   * Human-readable verb describing what the import does.
   * Examples: "registers", "builds", "checks", "filters", "generates",
   *           "parses", "reads", "validates", "types from", "uses"
   */
  verb: string;

  /**
   * Optional human-readable object/complement for the verb.
   * Derived from the symbol name minus the verb prefix.
   * Examples: "graph" (from buildGraph), "tool" (from registerPingTool),
   *           "files" (from filterFiles)
   *
   * When present, the full label reads as: verb + " " + object
   *   → "builds graph", "registers tool", "filters files"
   *
   * When absent, just the verb is used: "uses", "types from"
   */
  object?: string;

  /** How confident we are in this inference */
  confidence: SemanticConfidence;
}

// ─── Dependency Graph ────────────────────────────────────────────────

/**
 * A node in the dependency graph representing one file.
 */
export interface GraphNode {
  /** Project-relative file path (e.g., "src/tools/ping.ts") */
  filePath: string;

  /**
   * What this file exports.
   *
   * v0.5+: This is ExportSignature[] for full API surface info.
   * For backward compat, existing code that only needs names can use:
   *   node.exports.map(e => typeof e === 'string' ? e : e.name)
   *
   * During the transition period, this may contain either string[]
   * (from old graph builds) or ExportSignature[] (from new builds).
   * The `exportNames` helper below handles both.
   */
  exports: ExportSignature[] | string[];

  /** Human-readable category (e.g., "TypeScript source", "React component") */
  category: string;

  /**
   * Architectural layer this file belongs to (v0.5+).
   *
   * Unlike `category` which is based on file extension ("TypeScript source"),
   * this reflects the file's ROLE in the architecture ("Tools / Handlers",
   * "Core Modules", "Types / Contracts").
   *
   * Optional for backward compat — absent on graphs built before v0.5.
   */
  architecturalLayer?: string;
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

  /**
   * Semantic relationships for each imported symbol (v0.5+).
   *
   * This is the amplified version of `symbols`. Instead of just names,
   * each entry describes HOW the symbol is used with a verb + object.
   *
   * When present, diagram renderers should prefer this over raw `symbols`
   * for edge labels. When absent, fall back to `symbols` (backward compat).
   *
   * Example:
   *   symbols: ["buildGraph", "extractSubgraph"]
   *   relationships: [
   *     { symbol: "buildGraph", verb: "builds", object: "graph", confidence: "inferred" },
   *     { symbol: "extractSubgraph", verb: "extracts", object: "subgraph", confidence: "inferred" }
   *   ]
   */
  relationships?: SymbolRelationship[];
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

// ─── Graph Readability (v0.6) ────────────────────────────────────────

/**
 * Impact score for a node in the subgraph, used to determine
 * whether it appears in the diagram or gets collapsed.
 *
 * Nodes with higher scores are more important to show.
 * The scoring is computed by the briefing tool based on change status,
 * connection proximity, hub-ness, and violation involvement.
 */
export interface NodeImpact {
  filePath: string;
  score: number;
  /** Human-readable reason for the score (e.g., "modified file", "hub with 5 connections") */
  reason: string;
}

/**
 * Readability constants for diagram generation.
 * These control when truncation and simplification kick in.
 */
export const DIAGRAM_LIMITS = {
  /** Max nodes before low-scoring nodes get collapsed */
  MAX_NODES: 15,
  /** Max edges before switching to simple (label-free) diagram */
  MAX_EDGES: 25,
  /** Minimum impact score to survive truncation */
  MIN_SCORE: 3,
} as const;

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

// ─── Utility Helpers ─────────────────────────────────────────────────

/**
 * Extract just the export names from a GraphNode's exports array.
 *
 * Handles both old-format (string[]) and new-format (ExportSignature[])
 * for backward compatibility during the v0.4 → v0.5 transition.
 */
export function getExportNames(
  exports: ExportSignature[] | string[]
): string[] {
  if (exports.length === 0) return [];
  // Check if first element is a string (old format) or object (new format)
  if (typeof exports[0] === "string") {
    return exports as string[];
  }
  return (exports as ExportSignature[]).map((e) => e.name);
}

/**
 * Get the best human-readable label for a graph edge.
 *
 * Prefers semantic relationships when available, falls back to raw symbol
 * names. This is the single function that diagram renderers and briefing
 * generators should use for edge labels.
 *
 * Examples:
 *   With relationships: "builds graph, extracts subgraph"
 *   Without (fallback):  "buildGraph, extractSubgraph"
 */
export function getEdgeLabel(edge: GraphEdge): string {
  // Prefer semantic relationships if present
  if (edge.relationships && edge.relationships.length > 0) {
    const labels = edge.relationships.map((r) =>
      r.object ? `${r.verb} ${r.object}` : r.verb
    );

    if (labels.length <= 3) {
      return labels.join(", ");
    }
    return `${labels.slice(0, 2).join(", ")} +${labels.length - 2} more`;
  }

  // Fallback to raw symbol names (v0.4 behavior)
  if (edge.symbols.length === 0) {
    return "imports";
  }
  if (edge.symbols.length <= 3) {
    return edge.symbols.join(", ");
  }
  return `${edge.symbols.slice(0, 2).join(", ")} +${edge.symbols.length - 2} more`;
}
