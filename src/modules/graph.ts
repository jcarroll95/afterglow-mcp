import { resolve, dirname, relative, join } from "path";
import { existsSync, readdirSync, statSync } from "fs";
import { DependencyGraph, GraphNode, GraphEdge } from "../types.js";
import { analyzeFile, isParseableFile } from "./parser.js";
import { shouldIgnoreFile } from "./filter.js";
import { inferEdgeRelationships } from "./semantics.js";
import { getLayerName } from "./boundaries.js";

// ─── Import Path Resolution ──────────────────────────────────────────

/**
 * TypeScript/JavaScript file extensions to try when resolving imports.
 * When someone writes `import { foo } from "./utils"`, the actual file
 * could be utils.ts, utils.tsx, utils.js, utils/index.ts, etc.
 */
const RESOLVE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mts",
  ".mjs",
  "",
];

const INDEX_FILES = [
  "/index.ts",
  "/index.tsx",
  "/index.js",
  "/index.jsx",
];

/**
 * Resolve a relative import path to an actual file on disk.
 *
 * Given:
 *   importSource = "./utils"
 *   fromFile = "/project/src/tools/ping.ts"
 *
 * Tries:
 *   /project/src/tools/utils.ts
 *   /project/src/tools/utils.tsx
 *   /project/src/tools/utils.js
 *   /project/src/tools/utils/index.ts
 *   etc.
 *
 * Returns the resolved absolute path, or null if not found.
 */
export function resolveImportPath(
  importSource: string,
  fromFile: string
): string | null {
  // Strip any .js/.ts extension the developer may have written
  // (TypeScript convention is to import as .js even though source is .ts)
  const stripped = importSource.replace(/\.(js|jsx|ts|tsx|mjs|mts|cjs|cts)$/, "");
  const baseDir = dirname(fromFile);
  const basePath = resolve(baseDir, stripped);

  // Try direct file with each extension
  for (const ext of RESOLVE_EXTENSIONS) {
    const candidate = basePath + ext;
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate;
    }
  }

  // Try as directory with index file
  for (const indexFile of INDEX_FILES) {
    const candidate = basePath + indexFile;
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

// ─── Project Scanning ────────────────────────────────────────────────

/**
 * Recursively collect all parseable source files in a directory.
 * Respects the ignore filter (skips node_modules, build, etc.)
 */
export function collectSourceFiles(
  dir: string,
  projectRoot: string
): string[] {
  const results: string[] = [];

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return results;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const relativePath = relative(projectRoot, fullPath);

    // Skip ignored directories/files
    if (shouldIgnoreFile(relativePath)) continue;

    let stat;
    try {
      stat = statSync(fullPath);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      results.push(...collectSourceFiles(fullPath, projectRoot));
    } else if (stat.isFile() && isParseableFile(entry)) {
      results.push(fullPath);
    }
  }

  return results;
}

// ─── Graph Building ──────────────────────────────────────────────────

/**
 * Categorize a file by extension (same logic as analyze_changes,
 * extracted here so the graph can use it too).
 */
function categorizeFile(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  const categories: Record<string, string> = {
    ts: "TypeScript source",
    tsx: "React component (TSX)",
    js: "JavaScript source",
    jsx: "React component (JSX)",
    mts: "TypeScript source (ESM)",
    mjs: "JavaScript source (ESM)",
    json: "Configuration/data",
    md: "Documentation",
    css: "Stylesheet",
  };
  return categories[ext] ?? "Other";
}

/**
 * Build a full dependency graph for a project.
 *
 * This scans all source files, parses their imports/exports,
 * resolves relative imports to actual files, and returns a
 * DependencyGraph with nodes and edges.
 *
 * v0.5 UPGRADES:
 *   - Nodes now include architecturalLayer (from boundaries.ts)
 *   - Nodes now include ExportSignature[] (from parser.ts upgrade)
 *   - Edges now include semantic relationships (from semantics.ts)
 *
 * The graph is JSON-serializable by design — ready for future
 * persistence to .afterglow/state.json.
 */
export function buildGraph(projectRoot: string): DependencyGraph {
  const absoluteRoot = resolve(projectRoot);
  const sourceFiles = collectSourceFiles(absoluteRoot, absoluteRoot);

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  // Map of absolute path → relative path for lookups
  const absToRelative = new Map<string, string>();

  // First pass: analyze all files, build nodes
  const fileAnalyses = new Map<string, ReturnType<typeof analyzeFile>>();
  for (const absPath of sourceFiles) {
    const relPath = relative(absoluteRoot, absPath);
    absToRelative.set(absPath, relPath);

    const analysis = analyzeFile(absPath);
    fileAnalyses.set(absPath, analysis);

    nodes.push({
      filePath: relPath,
      exports: analysis?.exports ?? [],
      category: categorizeFile(relPath),
      // v0.5: classify by architectural role, not just file extension
      architecturalLayer: getLayerName(relPath),
    });
  }

  // Second pass: resolve imports to build edges
  for (const absPath of sourceFiles) {
    const analysis = fileAnalyses.get(absPath);
    if (!analysis) continue;

    const fromRelative = absToRelative.get(absPath) ?? absPath;

    for (const imp of analysis.imports) {
      // Only trace relative imports (project files, not npm packages)
      if (!imp.isRelative) continue;

      const resolved = resolveImportPath(imp.source, absPath);
      if (!resolved) continue;

      const toRelative = absToRelative.get(resolved);
      if (!toRelative) continue; // Resolved to a file outside our source scan

      // v0.5: infer semantic relationships for imported symbols
      const relationships =
        imp.specifiers.length > 0
          ? inferEdgeRelationships(imp.specifiers, absPath)
          : undefined;

      edges.push({
        from: fromRelative,
        to: toRelative,
        symbols: imp.specifiers,
        isDefault: imp.isDefault,
        relationships,
      });
    }
  }

  return {
    nodes,
    edges,
    builtAt: new Date().toISOString(),
    projectRoot: absoluteRoot,
  };
}

// ─── Subgraph Extraction ─────────────────────────────────────────────

/**
 * Extract a subgraph centered on specific files, including their
 * direct neighbors up to `depth` levels away.
 *
 * This is what the explain_connections tool uses: given the files
 * that changed, show their immediate neighborhood in the graph.
 *
 * Uses breadth-first traversal in both directions (imports AND imported-by).
 */
export function extractSubgraph(
  graph: DependencyGraph,
  focusFiles: string[],
  depth: number = 1
): DependencyGraph {
  // Build adjacency lists for bidirectional traversal
  const outgoing = new Map<string, GraphEdge[]>(); // file → files it imports
  const incoming = new Map<string, GraphEdge[]>(); // file → files that import it

  for (const edge of graph.edges) {
    const out = outgoing.get(edge.from) ?? [];
    out.push(edge);
    outgoing.set(edge.from, out);

    const inc = incoming.get(edge.to) ?? [];
    inc.push(edge);
    incoming.set(edge.to, inc);
  }

  // BFS from focus files
  const visited = new Set<string>();
  let frontier = new Set<string>(focusFiles);

  for (let d = 0; d <= depth; d++) {
    const nextFrontier = new Set<string>();
    for (const file of frontier) {
      if (visited.has(file)) continue;
      visited.add(file);

      // Traverse outgoing edges (files this file imports)
      for (const edge of outgoing.get(file) ?? []) {
        if (!visited.has(edge.to)) nextFrontier.add(edge.to);
      }

      // Traverse incoming edges (files that import this file)
      for (const edge of incoming.get(file) ?? []) {
        if (!visited.has(edge.from)) nextFrontier.add(edge.from);
      }
    }
    frontier = nextFrontier;
  }

  // Filter graph to only visited nodes and their interconnecting edges
  const subNodes = graph.nodes.filter((n) => visited.has(n.filePath));
  const subEdges = graph.edges.filter(
    (e) => visited.has(e.from) && visited.has(e.to)
  );

  return {
    nodes: subNodes,
    edges: subEdges,
    builtAt: graph.builtAt,
    projectRoot: graph.projectRoot,
  };
}

// ─── Query Helpers ───────────────────────────────────────────────────

/**
 * Get all files that a given file imports from (outgoing edges).
 */
export function getImportsOf(
  graph: DependencyGraph,
  filePath: string
): GraphEdge[] {
  return graph.edges.filter((e) => e.from === filePath);
}

/**
 * Get all files that import a given file (incoming edges).
 */
export function getImportersOf(
  graph: DependencyGraph,
  filePath: string
): GraphEdge[] {
  return graph.edges.filter((e) => e.to === filePath);
}
