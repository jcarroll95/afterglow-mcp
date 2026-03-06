import { readFileSync } from "fs";
import { ImportInfo, FileAnalysis } from "../types.js";

/**
 * Parse a JS/TS file and extract its imports and exports.
 *
 * DESIGN DECISION: This uses regex, not an AST parser like tree-sitter.
 * Why? Because regex handles 95% of real-world JS/TS import patterns,
 * has zero dependencies, and keeps the install lightweight. The interface
 * (FileAnalysis) is the contract — we can swap the implementation to
 * tree-sitter later without changing any calling code.
 *
 * What this handles:
 *   import { a, b } from "./module"
 *   import Foo from "./module"
 *   import * as Bar from "./module"
 *   import { a as b } from "./module"
 *   import "./side-effects"
 *   export function foo() {}
 *   export const bar = ...
 *   export class Baz {}
 *   export default ...
 *   export { a, b } from "./module"  (re-exports)
 *
 * What this won't catch (acceptable for MVP):
 *   Dynamic imports: import("./module")
 *   require() calls (CommonJS)
 *   Complex multi-line destructured imports split across many lines
 */

// ─── Import Parsing ──────────────────────────────────────────────────

/**
 * Regex that matches ES module import statements.
 *
 * Breakdown:
 *   import\s+          — the import keyword followed by whitespace
 *   (?:                — non-capturing group for the import clause (optional)
 *     ([\s\S]*?)       — capture group 1: everything before "from" (specifiers)
 *     \s+from\s+       — the "from" keyword
 *   )?                 — the whole clause is optional (for bare imports like `import "./polyfill"`)
 *   ['"]([^'"]+)['"]   — capture group 2: the module path inside quotes
 *
 * The 'g' flag finds all matches, 'm' handles multiline.
 */
const IMPORT_REGEX = /import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]|import\s+['"]([^'"]+)['"]/gm;

/**
 * Parse the specifier clause of an import statement.
 * Examples:
 *   "{ useState, useEffect }"  → named imports
 *   "React"                     → default import
 *   "* as path"                 → namespace import
 *   "React, { useState }"      → default + named (combo)
 */
function parseSpecifiers(
  clause: string
): { specifiers: string[]; isDefault: boolean; isNamespace: boolean } {
  const trimmed = clause.trim();

  // Namespace import: import * as Foo from "..."
  if (trimmed.startsWith("*")) {
    const alias = trimmed.replace(/^\*\s*as\s+/, "").trim();
    return { specifiers: [alias], isDefault: false, isNamespace: true };
  }

  const specifiers: string[] = [];
  let isDefault = false;

  // Check for named imports in braces: { a, b, c as d }
  const braceMatch = trimmed.match(/\{([^}]+)\}/);
  if (braceMatch) {
    const named = braceMatch[1].split(",").map((s) => {
      // Handle "a as b" → use the local name "b"
      const parts = s.trim().split(/\s+as\s+/);
      return (parts[parts.length - 1] ?? "").trim();
    });
    specifiers.push(...named.filter(Boolean));
  }

  // Check for default import: everything before the brace or comma
  // "React, { useState }" → default is "React"
  // "React" → default is "React"
  const beforeBrace = trimmed.replace(/\{[^}]*\}/, "").replace(/,\s*$/, "").trim();
  if (beforeBrace && !beforeBrace.startsWith("*")) {
    isDefault = true;
    specifiers.unshift(beforeBrace);
  }

  return { specifiers, isDefault, isNamespace: false };
}

/**
 * Extract all import statements from file content.
 */
export function parseImports(content: string): ImportInfo[] {
  const imports: ImportInfo[] = [];

  // Reset regex state (important because we reuse the regex with 'g' flag)
  IMPORT_REGEX.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = IMPORT_REGEX.exec(content)) !== null) {
    // match[1] = specifier clause (if present)
    // match[2] = module path (from "from" style imports)
    // match[3] = module path (from bare imports like import "./polyfill")
    const clause = match[1] ?? "";
    const source = match[2] ?? match[3] ?? "";

    if (!source) continue;

    const isRelative = source.startsWith(".") || source.startsWith("/");

    if (clause) {
      const parsed = parseSpecifiers(clause);
      imports.push({
        source,
        specifiers: parsed.specifiers,
        isDefault: parsed.isDefault,
        isNamespace: parsed.isNamespace,
        isRelative,
      });
    } else {
      // Bare import: import "./side-effects"
      imports.push({
        source,
        specifiers: [],
        isDefault: false,
        isNamespace: false,
        isRelative,
      });
    }
  }

  return imports;
}

// ─── Export Parsing ──────────────────────────────────────────────────

/**
 * Regex patterns for various export forms.
 */
const EXPORT_PATTERNS: RegExp[] = [
  // export function foo(
  /export\s+(?:async\s+)?function\s+(\w+)/g,
  // export const foo = / export let foo = / export var foo =
  /export\s+(?:const|let|var)\s+(\w+)/g,
  // export class Foo
  /export\s+class\s+(\w+)/g,
  // export interface Foo (TypeScript)
  /export\s+interface\s+(\w+)/g,
  // export type Foo (TypeScript)
  /export\s+type\s+(\w+)/g,
  // export enum Foo (TypeScript)
  /export\s+enum\s+(\w+)/g,
];

/**
 * Extract all named exports from file content.
 * Does not capture `export default` (tracked separately)
 * or re-exports (`export { x } from "./y"` — those are tracked as imports).
 */
export function parseExports(content: string): string[] {
  const exports: string[] = [];
  const seen = new Set<string>();

  for (const pattern of EXPORT_PATTERNS) {
    // Reset regex state
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const name = match[1];
      if (name && !seen.has(name)) {
        seen.add(name);
        exports.push(name);
      }
    }
  }

  // Check for default export
  if (/export\s+default\b/.test(content) && !seen.has("default")) {
    exports.push("default");
  }

  return exports;
}

// ─── File Analysis ───────────────────────────────────────────────────

/**
 * Read a file and produce a complete analysis of its imports and exports.
 *
 * Returns null if the file can't be read (deleted, binary, permissions, etc.)
 * rather than throwing — this is intentional because during a diff analysis,
 * some files in the changeset may have been deleted and that shouldn't
 * crash the whole analysis.
 */
export function analyzeFile(filePath: string): FileAnalysis | null {
  try {
    const content = readFileSync(filePath, "utf-8");
    return {
      filePath,
      imports: parseImports(content),
      exports: parseExports(content),
    };
  } catch {
    // File can't be read — deleted, binary, permissions, etc.
    return null;
  }
}

/**
 * Checks if a file is a JS/TS source file that we should parse.
 */
export function isParseableFile(filePath: string): boolean {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  return ["ts", "tsx", "js", "jsx", "mts", "mjs", "cts", "cjs"].includes(ext);
}
