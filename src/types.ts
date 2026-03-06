/**
 * Represents a single file change detected from git.
 */
export interface FileChange {
    filePath: string;
    status: "added" | "modified" | "deleted" | "renamed";
    additions: number;
    deletions: number;
}

/**
 * Represents an import found in a source file.
 */
export interface ImportInfo {
    /** The raw import path as written in the source (e.g., "./utils" or "express") */
    source: string;
    /** The named imports (e.g., ["useState", "useEffect"]) */
    specifiers: string[];
    /** Whether this is a relative import (starts with . or ..) */
    isRelative: boolean;
}

/**
 * An edge in the dependency graph connecting two files.
 */
export interface DependencyEdge {
    from: string;
    to: string;
    imports: string[];
}

/**
 * The full dependency graph for a project or subgraph.
 */
export interface DependencyGraph {
    files: string[];
    edges: DependencyEdge[];
}

/**
 * The output of the briefing tool.
 */
export interface Briefing {
    summary: string;
    changedFiles: FileChange[];
    connections: string;
    diagram: string;
    concepts: string[];
}