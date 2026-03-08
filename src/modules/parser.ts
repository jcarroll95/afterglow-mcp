import { readFileSync } from "fs";
import { ImportInfo, FileAnalysis, ExportSignature } from "../types.js";

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
 *   const foo = require("./module")           (CommonJS)
 *   const { a, b } = require("./module")      (CommonJS destructured)
 *   require("./side-effects")                  (CommonJS bare)
 *   export function foo() {}
 *   export const bar = ...
 *   export class Baz {}
 *   export default ...
 *   export { a, b } from "./module"  (re-exports)
 *   module.exports = { foo, bar }    (CommonJS)
 *   module.exports = router          (CommonJS default)
 *   exports.foo = ...                (CommonJS named)
 *
 * What this won't catch (acceptable for MVP):
 *   Dynamic imports: import("./module")
 *   Dynamic requires: require(variable)
 *   Complex multi-line destructured imports split across many lines
 *
 * v0.5 UPGRADE: parseExports now returns ExportSignature[] with kind,
 * params, and returnType — enabling the API Surface section in briefings.
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

  // ── CommonJS require() calls ──────────────────────────────────
  // v0.5.1: Handle require() so the graph works on CJS codebases.
  //
  // Patterns handled:
  //   const foo = require("./module")                → default import
  //   const { a, b } = require("./module")           → named (destructured) import
  //   const { a: aliased } = require("./module")     → named with alias
  //   const foo = require("./module").bar             → property access (treated as default)
  //   require("./side-effects")                       → bare require
  //
  // NOT handled (acceptable for now):
  //   Dynamic requires: require(variable)
  //   Conditional requires inside if/function blocks
  //   require.resolve()

  const REQUIRE_DESTRUCTURED = /(?:const|let|var)\s+\{([^}]+)\}\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  const REQUIRE_DEFAULT = /(?:const|let|var)\s+(\w+)\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  const REQUIRE_BARE = /(?:^|;|\n)\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/gm;

  // Destructured requires: const { a, b } = require("./module")
  REQUIRE_DESTRUCTURED.lastIndex = 0;
  while ((match = REQUIRE_DESTRUCTURED.exec(content)) !== null) {
    const specifierClause = match[1];
    const source = match[2];
    if (!source) continue;

    const isRelative = source.startsWith(".") || source.startsWith("/");

    // Parse destructured names: "a, b, c: aliased" → ["a", "b", "aliased"]
    const specifiers = specifierClause
      .split(",")
      .map((s) => {
        const parts = s.trim().split(/\s*:\s*/);
        return (parts[parts.length - 1] ?? "").trim();
      })
      .filter(Boolean);

    imports.push({
      source,
      specifiers,
      isDefault: false,
      isNamespace: false,
      isRelative,
    });
  }

  // Default requires: const foo = require("./module")
  // Track what we've already captured via destructured to avoid duplicates
  const seenRequireSources = new Set(
    imports.filter((i) => !i.isDefault).map((i) => i.source)
  );

  REQUIRE_DEFAULT.lastIndex = 0;
  while ((match = REQUIRE_DEFAULT.exec(content)) !== null) {
    const name = match[1];
    const source = match[2];
    if (!source || !name) continue;

    // Skip if already captured as destructured require
    if (seenRequireSources.has(source)) continue;

    const isRelative = source.startsWith(".") || source.startsWith("/");

    imports.push({
      source,
      specifiers: [name],
      isDefault: true,
      isNamespace: false,
      isRelative,
    });
  }

  // Bare requires: require("./side-effects")
  REQUIRE_BARE.lastIndex = 0;
  while ((match = REQUIRE_BARE.exec(content)) !== null) {
    const source = match[1];
    if (!source) continue;

    const isRelative = source.startsWith(".") || source.startsWith("/");

    // Skip if already captured by either pattern above
    const alreadyCaptured = imports.some((i) => i.source === source);
    if (alreadyCaptured) continue;

    imports.push({
      source,
      specifiers: [],
      isDefault: false,
      isNamespace: false,
      isRelative,
    });
  }

  return imports;
}

// ─── Export Parsing ──────────────────────────────────────────────────

/**
 * Clean up a captured parameter string for display.
 *
 * Regex captures can include trailing whitespace, newlines, or
 * other noise. This normalizes it to a clean single-line string.
 *
 * Examples:
 *   "  server: McpServer,\n  options: Options  " → "server: McpServer, options: Options"
 *   "projectRoot: string" → "projectRoot: string"
 */
function cleanParams(raw: string): string {
  return raw
    .replace(/\s*\n\s*/g, " ") // collapse newlines to spaces
    .replace(/\s+/g, " ")       // collapse multiple spaces
    .replace(/,\s*$/, "")       // trailing comma
    .trim();
}

/**
 * Clean up a captured return type string.
 *
 * Trims whitespace, removes trailing opening braces or arrow tokens
 * that sometimes get captured by greedy regex.
 */
function cleanReturnType(raw: string): string {
  return raw
    .replace(/\s*\n\s*/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s*[{=].*$/, "") // trailing { or = from function body
    .trim();
}

/**
 * Extract all exports from file content as ExportSignature[].
 *
 * v0.5 UPGRADE: Previously returned string[] of just names.
 * Now returns full signatures with kind, params, and returnType.
 *
 * This enables the API Surface section in briefings, which shows
 * the public contract of each changed file.
 *
 * APPROACH: Each export form gets its own regex with specific capture
 * groups for params and return type. We process them in order and
 * deduplicate by name (since a symbol can't be exported twice).
 */
export function parseExports(content: string): ExportSignature[] {
  const exports: ExportSignature[] = [];
  const seen = new Set<string>();

  /**
   * Helper: add an export if we haven't seen this name yet.
   */
  function addExport(sig: ExportSignature): void {
    if (sig.name && !seen.has(sig.name)) {
      seen.add(sig.name);
      exports.push(sig);
    }
  }

  // ── Exported functions ───────────────────────────────────────
  // export function foo(params): ReturnType {
  // export async function foo(params): Promise<ReturnType> {
  const funcRegex = /export\s+(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)(?:\s*:\s*([^{]+))?\s*\{/g;
  let match: RegExpExecArray | null;

  funcRegex.lastIndex = 0;
  while ((match = funcRegex.exec(content)) !== null) {
    const name = match[1];
    const rawParams = match[2] ?? "";
    const rawReturn = match[3] ?? "";

    addExport({
      name,
      kind: "function",
      params: rawParams.trim() ? cleanParams(rawParams) : undefined,
      returnType: rawReturn.trim() ? cleanReturnType(rawReturn) : undefined,
      isDefault: false,
    });
  }

  // ── Exported arrow function consts ───────────────────────────
  // export const foo = (params): ReturnType => {
  // export const foo = async (params): ReturnType => {
  // export const foo = (params) => {
  const arrowRegex = /export\s+const\s+(\w+)\s*=\s*(?:async\s+)?\(([^)]*)\)(?:\s*:\s*([^=>{]+))?\s*=>/g;

  arrowRegex.lastIndex = 0;
  while ((match = arrowRegex.exec(content)) !== null) {
    const name = match[1];
    const rawParams = match[2] ?? "";
    const rawReturn = match[3] ?? "";

    addExport({
      name,
      kind: "function", // Arrow const is functionally a function export
      params: rawParams.trim() ? cleanParams(rawParams) : undefined,
      returnType: rawReturn.trim() ? cleanReturnType(rawReturn) : undefined,
      isDefault: false,
    });
  }

  // ── Exported non-function consts/lets/vars ───────────────────
  // export const FOO = "bar"
  // export let count = 0
  // export var legacy = true
  // (Excluding arrow functions which are caught above)
  const varRegex = /export\s+(const|let|var)\s+(\w+)\s*(?::\s*([^=]+))?\s*=/g;

  varRegex.lastIndex = 0;
  while ((match = varRegex.exec(content)) !== null) {
    const varKind = match[1] as "const" | "let" | "var";
    const name = match[2];
    const rawType = match[3] ?? "";

    // Skip if already captured as arrow function
    if (seen.has(name)) continue;

    addExport({
      name,
      kind: varKind,
      // For non-function consts, the type annotation IS the return type conceptually
      returnType: rawType.trim() ? cleanReturnType(rawType) : undefined,
      isDefault: false,
    });
  }

  // ── Exported classes ─────────────────────────────────────────
  // export class Foo { ... }
  // export class Foo extends Bar { ... }
  const classRegex = /export\s+class\s+(\w+)/g;

  classRegex.lastIndex = 0;
  while ((match = classRegex.exec(content)) !== null) {
    addExport({
      name: match[1],
      kind: "class",
      isDefault: false,
    });
  }

  // ── Exported interfaces ──────────────────────────────────────
  // export interface Foo { ... }
  // export interface Foo extends Bar { ... }
  const ifaceRegex = /export\s+interface\s+(\w+)/g;

  ifaceRegex.lastIndex = 0;
  while ((match = ifaceRegex.exec(content)) !== null) {
    addExport({
      name: match[1],
      kind: "interface",
      isDefault: false,
    });
  }

  // ── Exported types ───────────────────────────────────────────
  // export type Foo = string | number
  // export type Foo = { ... }
  const typeRegex = /export\s+type\s+(\w+)/g;

  typeRegex.lastIndex = 0;
  while ((match = typeRegex.exec(content)) !== null) {
    addExport({
      name: match[1],
      kind: "type",
      isDefault: false,
    });
  }

  // ── Exported enums ───────────────────────────────────────────
  // export enum Foo { ... }
  const enumRegex = /export\s+enum\s+(\w+)/g;

  enumRegex.lastIndex = 0;
  while ((match = enumRegex.exec(content)) !== null) {
    addExport({
      name: match[1],
      kind: "enum",
      isDefault: false,
    });
  }

  // ── Default export ───────────────────────────────────────────
  // export default function foo() {}  → already caught above as named
  // export default class Foo {}       → already caught above as named
  // export default ...                → caught here as generic default
  if (/export\s+default\b/.test(content) && !seen.has("default")) {
    addExport({
      name: "default",
      kind: "default",
      isDefault: true,
    });
  }

  // ── CommonJS module.exports ────────────────────────────────
  // v0.5.1: Handle CJS exports so the API Surface section works
  // on CommonJS codebases.
  //
  // Patterns:
  //   module.exports = { foo, bar, baz }   → named exports
  //   module.exports = router              → default export
  //   module.exports.foo = ...             → named export
  //   exports.foo = ...                    → named export

  // module.exports = { foo, bar }
  const moduleExportsObj = content.match(
    /module\.exports\s*=\s*\{([^}]+)\}/
  );
  if (moduleExportsObj) {
    const names = moduleExportsObj[1]
      .split(",")
      .map((s) => {
        // Handle "foo: bar" → use "foo" (the exported name)
        const parts = s.trim().split(/\s*:\s*/);
        return (parts[0] ?? "").trim();
      })
      .filter((name) => name && /^\w+$/.test(name));

    for (const name of names) {
      addExport({
        name,
        kind: "const",
        isDefault: false,
      });
    }
  }

  // module.exports = singleValue (not an object literal)
  const moduleExportsDefault = content.match(
    /module\.exports\s*=\s*(\w+)\s*;/
  );
  if (moduleExportsDefault && !moduleExportsObj) {
    const name = moduleExportsDefault[1];
    if (name && !seen.has(name)) {
      addExport({
        name,
        kind: "default",
        isDefault: true,
      });
    }
  }

  // module.exports.foo = ... or exports.foo = ...
  const namedCjsExport =
    /(?:module\.exports|exports)\.(\w+)\s*=/g;

  namedCjsExport.lastIndex = 0;
  while ((match = namedCjsExport.exec(content)) !== null) {
    const name = match[1];
    if (name && name !== "exports") {
      addExport({
        name,
        kind: "const",
        isDefault: false,
      });
    }
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
 *
 * v0.5: exports is now ExportSignature[] instead of string[].
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
