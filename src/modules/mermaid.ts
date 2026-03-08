import { DependencyGraph, getEdgeLabel, NodeImpact, DIAGRAM_LIMITS } from "../types.js";
import {
  classifyFileHierarchical,
  detectHierarchy,
  HierarchicalLayer,
  LayerViolation,
} from "./boundaries.js";

/**
 * Convert a DependencyGraph into Mermaid diagram syntax.
 *
 * v0.6 UPGRADES:
 *   - Impact-based truncation: large graphs collapse low-scoring context nodes
 *   - Edge prioritization: solid arrows for primary edges (involving changed files),
 *     dotted arrows for context edges (between unchanged files)
 *   - Violation styling: edges flagged as layer violations get red linkStyle
 *   - Auto TB direction: when 3+ hierarchical layers detected, switches to
 *     top-to-bottom layout for natural flow visualization
 *   - Rank-ordered subgraphs: layers render in architectural order (routes at top,
 *     models at bottom) instead of arbitrary insertion order
 */

// ─── Options ─────────────────────────────────────────────────────────

export interface MermaidOptions {
  /** Center the diagram on this file (gets 🔍 highlight) */
  focusFile?: string;

  /** Graph direction: "LR" = left-to-right, "TB" = top-to-bottom. Auto-detected if omitted. */
  direction?: "LR" | "TB";

  /** Files modified in the current diff → :::modified (red) */
  modifiedFiles?: Set<string>;

  /** Files newly added or untracked → :::new (green) */
  newFiles?: Set<string>;

  /** Group nodes into architectural subgraphs. Default: true when change sets provided. */
  useSubgraphs?: boolean;

  /**
   * Impact scores for nodes (v0.6). When provided, nodes below
   * DIAGRAM_LIMITS.MIN_SCORE get excluded from the diagram.
   * Generate these via computeImpactScores().
   */
  impactScores?: Map<string, NodeImpact>;

  /**
   * Layer violations to highlight (v0.6). Violation edges get
   * red styling and ⚠️ labels.
   */
  violations?: LayerViolation[];

  /**
   * Internal flag: force simple (label-free) edge rendering.
   * Used by generateSimpleMermaid(). Not part of the public API.
   */
  _forceSimple?: boolean;
}

// ─── Node ID / Display Helpers ───────────────────────────────────────

/**
 * Convert a file path into a valid Mermaid node ID.
 * Uses the stripped path (after common prefix removal) for shorter IDs.
 */
function toNodeId(filePath: string, commonPrefix: string = ""): string {
  const stripped = commonPrefix && filePath.startsWith(commonPrefix)
    ? filePath.slice(commonPrefix.length)
    : filePath;
  return stripped.replace(/[^a-zA-Z0-9]/g, "_");
}

/**
 * Produce a short display name for a node label.
 *
 * When inside a subgraph (inSubgraph=true), use just the filename
 * since the subgraph header provides the layer context.
 * Example: "auth.js" instead of "controllers/auth.js"
 *
 * When not in a subgraph, use the last 2 path segments.
 * Example: "controllers/auth.js"
 *
 * The commonPrefix is stripped first so deeply nested monorepo paths
 * like "apps/api/controllers/auth.js" don't waste horizontal space.
 */
function toDisplayName(
  filePath: string,
  commonPrefix: string = "",
  inSubgraph: boolean = false
): string {
  const stripped = commonPrefix && filePath.startsWith(commonPrefix)
    ? filePath.slice(commonPrefix.length)
    : filePath;

  const parts = stripped.split("/");

  if (inSubgraph) {
    // Inside a subgraph: filename only (or last 2 if filename alone is ambiguous)
    // We use last 2 segments to disambiguate files like "auth.js" that could
    // appear in both routes/ and controllers/
    if (parts.length <= 2) return stripped;
    return parts.slice(-2).join("/");
  }

  // Not in subgraph: last 2 segments for context
  if (parts.length <= 2) return stripped;
  return parts.slice(-2).join("/");
}

/**
 * Find the longest common directory prefix across a set of file paths.
 * Returns the prefix WITH trailing slash so it can be cleanly stripped.
 *
 * Example:
 *   ["apps/api/controllers/auth.js", "apps/api/models/User.js", "apps/api/utils/error.js"]
 *   → "apps/api/"
 *
 *   ["src/index.ts", "src/tools/ping.ts"]
 *   → "src/"
 *
 *   ["index.ts", "package.json"]
 *   → "" (no common prefix)
 */
function findCommonPrefix(filePaths: string[]): string {
  if (filePaths.length === 0) return "";
  if (filePaths.length === 1) {
    const parts = filePaths[0].split("/");
    if (parts.length <= 1) return "";
    return parts.slice(0, -1).join("/") + "/";
  }

  // Split all paths into directory segments
  const splitPaths = filePaths.map((fp) => fp.split("/"));
  const minLength = Math.min(...splitPaths.map((p) => p.length));

  const commonParts: string[] = [];
  for (let i = 0; i < minLength - 1; i++) {
    // -1 because we never include the filename segment
    const segment = splitPaths[0][i];
    if (splitPaths.every((p) => p[i] === segment)) {
      commonParts.push(segment);
    } else {
      break;
    }
  }

  if (commonParts.length === 0) return "";
  return commonParts.join("/") + "/";
}

function toSubgraphId(layerName: string): string {
  return layerName.replace(/[^a-zA-Z0-9]/g, "");
}

// ─── Change Status ───────────────────────────────────────────────────

type ChangeStatus = "focus" | "new" | "modified" | "existing";

function getChangeStatus(
  filePath: string,
  options: MermaidOptions
): ChangeStatus {
  if (options.focusFile === filePath) return "focus";
  if (options.newFiles?.has(filePath)) return "new";
  if (options.modifiedFiles?.has(filePath)) return "modified";
  return "existing";
}

function isChangeAware(options: MermaidOptions): boolean {
  return (
    (options.modifiedFiles !== undefined && options.modifiedFiles.size > 0) ||
    (options.newFiles !== undefined && options.newFiles.size > 0)
  );
}

/**
 * Check if an edge involves at least one changed/new file.
 * Primary edges get solid arrows; context edges get dotted.
 */
function isPrimaryEdge(
  edge: { from: string; to: string },
  options: MermaidOptions
): boolean {
  if (!isChangeAware(options)) return true; // No change info → all edges are primary
  const changedOrNew = new Set([
    ...(options.modifiedFiles ?? []),
    ...(options.newFiles ?? []),
  ]);
  return changedOrNew.has(edge.from) || changedOrNew.has(edge.to);
}

// ─── Impact Scoring ──────────────────────────────────────────────────

/**
 * Compute impact scores for all nodes in a subgraph.
 *
 * Scoring rules (additive):
 *   +10  File was modified or newly added in this diff
 *   +3   File is a direct dependency of a changed file
 *   +3   File is a direct dependent of a changed file
 *   +2   File has 5+ total connections in the full graph
 *   +5   File is involved in a layer violation
 *
 * @param subgraph - The subgraph to score
 * @param modifiedFiles - Files modified in the diff
 * @param newFiles - Files newly added / untracked
 * @param fullGraph - The full project graph (for hub detection)
 * @param violations - Detected layer violations
 */
export function computeImpactScores(
  subgraph: DependencyGraph,
  modifiedFiles: Set<string>,
  newFiles: Set<string>,
  fullGraph: DependencyGraph,
  violations: LayerViolation[]
): Map<string, NodeImpact> {
  const scores = new Map<string, NodeImpact>();
  const changedFiles = new Set([...modifiedFiles, ...newFiles]);

  // Build full-graph connection counts for hub detection
  const connectionCount = new Map<string, number>();
  for (const edge of fullGraph.edges) {
    connectionCount.set(edge.from, (connectionCount.get(edge.from) ?? 0) + 1);
    connectionCount.set(edge.to, (connectionCount.get(edge.to) ?? 0) + 1);
  }

  // Build violation file set
  const violationFiles = new Set<string>();
  for (const v of violations) {
    violationFiles.add(v.from);
    violationFiles.add(v.to);
  }

  // Build direct neighbor sets
  const directDeps = new Set<string>(); // files that changed files import FROM
  const directDependents = new Set<string>(); // files that import FROM changed files
  for (const edge of subgraph.edges) {
    if (changedFiles.has(edge.from)) directDeps.add(edge.to);
    if (changedFiles.has(edge.to)) directDependents.add(edge.from);
  }

  for (const node of subgraph.nodes) {
    let score = 0;
    const reasons: string[] = [];

    if (changedFiles.has(node.filePath)) {
      score += 10;
      reasons.push(newFiles.has(node.filePath) ? "new file" : "modified file");
    }

    if (directDeps.has(node.filePath) && !changedFiles.has(node.filePath)) {
      score += 3;
      reasons.push("dependency of changed file");
    }

    if (directDependents.has(node.filePath) && !changedFiles.has(node.filePath)) {
      score += 3;
      reasons.push("dependent of changed file");
    }

    const connections = connectionCount.get(node.filePath) ?? 0;
    if (connections >= 5) {
      score += 2;
      reasons.push(`hub (${connections} connections)`);
    }

    if (violationFiles.has(node.filePath)) {
      score += 5;
      reasons.push("layer violation");
    }

    scores.set(node.filePath, {
      filePath: node.filePath,
      score,
      reason: reasons.join(", ") || "context file",
    });
  }

  return scores;
}

// ─── Class Definitions ───────────────────────────────────────────────

function changeAwareClassDefs(): string[] {
  return [
    "  %% Change status styles",
    "  classDef modified fill:#fecaca,stroke:#ef4444,stroke-width:2px,color:#991b1b",
    "  classDef new fill:#dcfce7,stroke:#22c55e,stroke-width:2px,color:#166534",
    "  classDef existing fill:#f3f4f6,stroke:#9ca3af,color:#374151",
    "  classDef focus fill:#fef3c7,stroke:#f59e0b,stroke-width:3px,color:#92400e",
  ];
}

function legacyClassDefs(): string[] {
  return [
    "  %% Style classes",
    "  classDef source fill:#e2e8f0,stroke:#475569,color:#1e293b",
    "  classDef component fill:#dbeafe,stroke:#3b82f6,color:#1e40af",
    "  classDef config fill:#fef3c7,stroke:#f59e0b,color:#92400e",
    "  classDef docs fill:#d1fae5,stroke:#10b981,color:#065f46",
    "  classDef other fill:#f3f4f6,stroke:#9ca3af,color:#374151",
    "  classDef focus fill:#fecaca,stroke:#ef4444,stroke-width:3px,color:#991b1b",
  ];
}

function legacyStyleClass(category: string): string {
  if (category.includes("TypeScript") || category.includes("JavaScript")) return "source";
  if (category.includes("React")) return "component";
  if (category.includes("config") || category.includes("Config")) return "config";
  if (category.includes("Documentation")) return "docs";
  return "other";
}

// ─── Subgraph Builder (v0.6: rank-ordered) ───────────────────────────

/**
 * Group graph nodes by architectural layer, sorted by hierarchical rank.
 * Lower rank layers appear first (top of diagram in TB layout).
 */
function groupNodesByLayer(
  nodes: DependencyGraph["nodes"]
): Array<[string, string[], number]> {
  // Classify and group
  const layerMap = new Map<string, { files: string[]; rank: number }>();

  for (const node of nodes) {
    const layer = classifyFileHierarchical(node.filePath);
    const layerName = node.architecturalLayer ?? layer.name;
    const existing = layerMap.get(layerName);
    if (existing) {
      existing.files.push(node.filePath);
    } else {
      layerMap.set(layerName, { files: [node.filePath], rank: layer.rank });
    }
  }

  // Sort by rank (lowest first = highest in architecture)
  return [...layerMap.entries()]
    .map(([name, data]) => [name, data.files, data.rank] as [string, string[], number])
    .sort((a, b) => a[2] - b[2]);
}

// ─── Direction Heuristic ─────────────────────────────────────────────

/**
 * Determine the best diagram direction based on the subgraph content.
 *
 * If the nodes span 3+ distinct hierarchical layer ranks → use TB
 * (top-to-bottom), because layered architectures read vertically.
 * Otherwise → use LR (left-to-right).
 */
function autoDirection(nodes: DependencyGraph["nodes"]): "LR" | "TB" {
  const ranks = new Set<number>();
  for (const node of nodes) {
    const layer = classifyFileHierarchical(node.filePath);
    if (!layer.exempt) {
      ranks.add(layer.rank);
    }
  }
  return ranks.size >= 3 ? "TB" : "LR";
}

// ─── Node Line Builder ───────────────────────────────────────────────

function buildNodeLine(
  filePath: string,
  nodeMap: Map<string, DependencyGraph["nodes"][0]>,
  options: MermaidOptions,
  changeAware: boolean,
  indent: string,
  commonPrefix: string = "",
  inSubgraph: boolean = false
): string {
  const id = toNodeId(filePath, commonPrefix);
  const display = toDisplayName(filePath, commonPrefix, inSubgraph);

  if (changeAware) {
    const status = getChangeStatus(filePath, options);
    if (status === "focus") {
      return `${indent}${id}["🔍 ${display}"]:::focus`;
    }
    const emoji =
      status === "new" ? "🆕 " :
      status === "modified" ? "✏️ " :
      "";
    return `${indent}${id}["${emoji}${display}"]:::${status}`;
  }

  if (options.focusFile === filePath) {
    return `${indent}${id}["🔍 ${display}"]:::focus`;
  }

  const node = nodeMap.get(filePath);
  const cls = legacyStyleClass(node?.category ?? "Other");
  return `${indent}${id}["${display}"]:::${cls}`;
}

// ─── Main Generator ──────────────────────────────────────────────────

/**
 * Generate a Mermaid graph from a DependencyGraph.
 *
 * v0.6: Impact scoring, edge prioritization, violation styling,
 * auto-direction, rank-ordered subgraphs.
 */
export function generateMermaid(
  graph: DependencyGraph,
  options: MermaidOptions = {}
): string {
  if (graph.nodes.length === 0) {
    return "graph LR\n  empty[\"No files in graph\"]";
  }

  const changeAware = isChangeAware(options);

  // v0.6: Auto-detect direction if not specified
  const direction = options.direction ?? (changeAware ? autoDirection(graph.nodes) : "LR");

  const useSubgraphs =
    options.useSubgraphs !== undefined
      ? options.useSubgraphs
      : changeAware;

  // v0.6: Filter nodes by impact score if provided
  let visibleNodes = graph.nodes;
  let truncatedCount = 0;
  if (options.impactScores && graph.nodes.length > DIAGRAM_LIMITS.MAX_NODES) {
    visibleNodes = graph.nodes.filter((n) => {
      const impact = options.impactScores!.get(n.filePath);
      return (impact?.score ?? 0) >= DIAGRAM_LIMITS.MIN_SCORE;
    });
    truncatedCount = graph.nodes.length - visibleNodes.length;
  }

  // Build a set of visible file paths for edge filtering
  const visiblePaths = new Set(visibleNodes.map((n) => n.filePath));

  // Filter edges to only those between visible nodes
  const visibleEdges = graph.edges.filter(
    (e) => visiblePaths.has(e.from) && visiblePaths.has(e.to)
  );

  // v0.6: Auto-switch to simple mode if too many edges, or if explicitly requested
  const useSimple = options._forceSimple || visibleEdges.length > DIAGRAM_LIMITS.MAX_EDGES;

  // Build violation lookup for edge styling
  const violationEdges = new Set<string>();
  if (options.violations) {
    for (const v of options.violations) {
      violationEdges.add(`${v.from}->${v.to}`);
    }
  }

  const nodeMap = new Map(visibleNodes.map((n) => [n.filePath, n]));

  // v0.6: Compute common path prefix for compact node IDs and labels
  const commonPrefix = findCommonPrefix(visibleNodes.map((n) => n.filePath));

  const lines: string[] = [];
  lines.push(`graph ${direction}`);
  lines.push("");

  // Style definitions
  if (changeAware) {
    lines.push(...changeAwareClassDefs());
  } else {
    lines.push(...legacyClassDefs());
  }
  lines.push("");

  // ── Nodes ────────────────────────────────────────────────────

  if (useSubgraphs) {
    const layers = groupNodesByLayer(visibleNodes);

    for (const [layerName, filePaths] of layers) {
      const subId = toSubgraphId(layerName);
      lines.push(`  subgraph ${subId}["${layerName}"]`);

      for (const fp of filePaths) {
        lines.push(buildNodeLine(fp, nodeMap, options, changeAware, "    ", commonPrefix, true));
      }

      lines.push("  end");
      lines.push("");
    }
  } else {
    lines.push("  %% Nodes");
    for (const node of visibleNodes) {
      lines.push(buildNodeLine(node.filePath, nodeMap, options, changeAware, "  ", commonPrefix, false));
    }
    lines.push("");
  }

  // ── Edges ────────────────────────────────────────────────────

  lines.push("  %% Connections");
  const violationEdgeIndices: number[] = [];
  let edgeIndex = 0;

  for (const edge of visibleEdges) {
    const fromId = toNodeId(edge.from, commonPrefix);
    const toId = toNodeId(edge.to, commonPrefix);
    const isViolation = violationEdges.has(`${edge.from}->${edge.to}`);
    const primary = isPrimaryEdge(edge, options);

    if (useSimple) {
      // Simple mode: no labels
      if (primary) {
        lines.push(`  ${fromId} --> ${toId}`);
      } else {
        lines.push(`  ${fromId} -.-> ${toId}`);
      }
    } else {
      // Detailed mode: labels on edges
      const label = isViolation
        ? `⚠️ ${getEdgeLabel(edge)}`
        : getEdgeLabel(edge);

      if (primary) {
        lines.push(`  ${fromId} -->|"${label}"| ${toId}`);
      } else {
        lines.push(`  ${fromId} -.->|"${label}"| ${toId}`);
      }
    }

    // Track violation edges for linkStyle
    if (isViolation) {
      violationEdgeIndices.push(edgeIndex);
    }
    edgeIndex++;
  }

  // v0.6: Style violation edges red
  if (violationEdgeIndices.length > 0) {
    lines.push("");
    lines.push("  %% Violation edge styling");
    for (const idx of violationEdgeIndices) {
      lines.push(`  linkStyle ${idx} stroke:#ef4444,stroke-width:2px`);
    }
  }

  // Truncation notice (added as a comment — the briefing tool will add
  // a prose notice outside the code fence)
  if (truncatedCount > 0) {
    lines.push("");
    lines.push(`  %% ${truncatedCount} low-impact context files omitted for readability`);
  }

  return lines.join("\n");
}

// ─── Simple Generator ────────────────────────────────────────────────

/**
 * Generate a simplified Mermaid diagram without edge labels.
 * v0.6: Supports same options as full generator (impact scoring,
 * dotted edges, violations, auto-direction, subgraphs).
 */
export function generateSimpleMermaid(
  graph: DependencyGraph,
  options: MermaidOptions = {}
): string {
  return generateMermaid(graph, { ...options, _forceSimple: true });
}
