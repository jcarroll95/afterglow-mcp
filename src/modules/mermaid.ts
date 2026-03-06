import { DependencyGraph } from "../types.js";

/**
 * Convert a DependencyGraph into Mermaid diagram syntax.
 *
 * Mermaid is a text-based diagramming language that most AI tools
 * and markdown renderers can display as an actual visual diagram.
 * By returning Mermaid source, we let the host decide how to render it.
 *
 * Example output:
 *   graph LR
 *     src_index_ts["src/index.ts"]
 *     src_tools_ping_ts["src/tools/ping.ts"]
 *     src_index_ts -->|"registerPingTool"| src_tools_ping_ts
 */

/**
 * Convert a file path into a valid Mermaid node ID.
 * Mermaid IDs can't contain slashes, dots, or hyphens in all contexts,
 * so we replace them with underscores.
 */
function toNodeId(filePath: string): string {
  return filePath.replace(/[^a-zA-Z0-9]/g, "_");
}

/**
 * Shorten a file path for display in diagram nodes.
 * Keeps just the filename for short paths, or last two segments for deeper ones.
 */
function toDisplayName(filePath: string): string {
  const parts = filePath.split("/");
  if (parts.length <= 2) return filePath;
  return parts.slice(-2).join("/");
}

/**
 * Assign a visual style class based on file category.
 * Returns a Mermaid class name we'll define in the diagram.
 */
function styleClass(category: string): string {
  if (category.includes("TypeScript") || category.includes("JavaScript")) return "source";
  if (category.includes("React")) return "component";
  if (category.includes("config") || category.includes("Config")) return "config";
  if (category.includes("Documentation")) return "docs";
  return "other";
}

/**
 * Generate a Mermaid graph from a DependencyGraph.
 *
 * Options:
 * - focusFile: if provided, this node gets highlighted
 * - direction: graph direction ("LR" = left-to-right, "TB" = top-to-bottom)
 */
export function generateMermaid(
  graph: DependencyGraph,
  options: {
    focusFile?: string;
    direction?: "LR" | "TB";
  } = {}
): string {
  const { focusFile, direction = "LR" } = options;

  if (graph.nodes.length === 0) {
    return "graph LR\n  empty[\"No files in graph\"]";
  }

  const lines: string[] = [];
  lines.push(`graph ${direction}`);

  // Style definitions
  lines.push("");
  lines.push("  %% Style classes");
  lines.push("  classDef source fill:#e2e8f0,stroke:#475569,color:#1e293b");
  lines.push("  classDef component fill:#dbeafe,stroke:#3b82f6,color:#1e40af");
  lines.push("  classDef config fill:#fef3c7,stroke:#f59e0b,color:#92400e");
  lines.push("  classDef docs fill:#d1fae5,stroke:#10b981,color:#065f46");
  lines.push("  classDef other fill:#f3f4f6,stroke:#9ca3af,color:#374151");
  lines.push("  classDef focus fill:#fecaca,stroke:#ef4444,stroke-width:3px,color:#991b1b");
  lines.push("");

  // Nodes
  lines.push("  %% Nodes");
  for (const node of graph.nodes) {
    const id = toNodeId(node.filePath);
    const display = toDisplayName(node.filePath);

    // Use different shapes for different roles
    const isFocus = focusFile === node.filePath;
    if (isFocus) {
      lines.push(`  ${id}["🔍 ${display}"]:::focus`);
    } else {
      const cls = styleClass(node.category);
      lines.push(`  ${id}["${display}"]:::${cls}`);
    }
  }

  lines.push("");

  // Edges
  lines.push("  %% Connections");
  for (const edge of graph.edges) {
    const fromId = toNodeId(edge.from);
    const toId = toNodeId(edge.to);

    // Show imported symbols on the edge label (truncate if too many)
    let label: string;
    if (edge.symbols.length === 0) {
      label = "imports";
    } else if (edge.symbols.length <= 3) {
      label = edge.symbols.join(", ");
    } else {
      label = `${edge.symbols.slice(0, 2).join(", ")} +${edge.symbols.length - 2} more`;
    }

    lines.push(`  ${fromId} -->|"${label}"| ${toId}`);
  }

  return lines.join("\n");
}

/**
 * Generate a simplified Mermaid diagram that only shows file relationships
 * without import details. Useful for larger graphs where edge labels
 * would create visual clutter.
 */
export function generateSimpleMermaid(
  graph: DependencyGraph,
  options: {
    focusFile?: string;
    direction?: "LR" | "TB";
  } = {}
): string {
  const { focusFile, direction = "LR" } = options;

  if (graph.nodes.length === 0) {
    return "graph LR\n  empty[\"No files in graph\"]";
  }

  const lines: string[] = [];
  lines.push(`graph ${direction}`);
  lines.push("");

  // Nodes with simpler display
  for (const node of graph.nodes) {
    const id = toNodeId(node.filePath);
    const display = toDisplayName(node.filePath);
    const isFocus = focusFile === node.filePath;

    if (isFocus) {
      lines.push(`  ${id}["🔍 ${display}"]`);
      lines.push(`  style ${id} fill:#fecaca,stroke:#ef4444,stroke-width:3px`);
    } else {
      lines.push(`  ${id}["${display}"]`);
    }
  }

  lines.push("");

  // Simple arrows without labels
  const seen = new Set<string>();
  for (const edge of graph.edges) {
    const key = `${edge.from}->${edge.to}`;
    if (seen.has(key)) continue;
    seen.add(key);

    lines.push(`  ${toNodeId(edge.from)} --> ${toNodeId(edge.to)}`);
  }

  return lines.join("\n");
}
