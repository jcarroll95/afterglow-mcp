import { execSync } from "child_process";

/**
 * Result of parsing a single file from a git diff.
 */
export interface DiffFileEntry {
  filePath: string;
  status: "added" | "modified" | "deleted" | "renamed";
  additions: number;
  deletions: number;
}

/**
 * Structured result from a git diff operation.
 */
export interface DiffResult {
  files: DiffFileEntry[];
  totalAdditions: number;
  totalDeletions: number;
  rawDiff: string;
}

/**
 * Runs a git command in the given directory and returns stdout as a string.
 * Throws a descriptive error if the command fails or the directory isn't a git repo.
 */
function runGit(args: string, cwd: string): string {
  try {
    return execSync(`git ${args}`, {
      cwd,
      encoding: "utf-8",
      // Silence git's stderr for cleaner output; we handle errors ourselves
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch (error: unknown) {
    // `error: unknown` is a TypeScript pattern. In JS you'd just write `catch (error)`.
    // TS doesn't know what type a thrown error is, so it's `unknown` by default
    // when strict mode is on. We narrow it with `instanceof`.
    if (error instanceof Error) {
      if (error.message.includes("not a git repository")) {
        throw new Error(
          `"${cwd}" is not a git repository. afterglow-mcp needs to run inside a git project.`
        );
      }
      throw new Error(`Git command failed: git ${args}\n${error.message}`);
    }
    throw error;
  }
}

/**
 * Checks whether the given path is inside a git repository.
 */
export function isGitRepo(cwd: string): boolean {
  try {
    runGit("rev-parse --is-inside-work-tree", cwd);
    return true;
  } catch {
    return false;
  }
}

/**
 * Gets the raw unified diff for the given scope.
 *
 * - "unstaged": changes in working directory not yet staged (git diff)
 * - "staged": changes staged for commit (git diff --staged)
 * - "last_commit": changes in the most recent commit (git diff HEAD~1 HEAD)
 */
export function getRawDiff(
  cwd: string,
  scope: "staged" | "unstaged" | "last_commit"
): string {
  switch (scope) {
    case "staged":
      return runGit("diff --staged", cwd);
    case "unstaged":
      return runGit("diff", cwd);
    case "last_commit":
      return runGit("diff HEAD~1 HEAD", cwd);
  }
}

/**
 * Gets the --numstat summary (additions/deletions per file) for the given scope.
 * Returns parsed file entries with status inferred from the stat numbers.
 */
export function getDiffStats(
  cwd: string,
  scope: "staged" | "unstaged" | "last_commit"
): DiffFileEntry[] {
  let numstatArgs: string;
  switch (scope) {
    case "staged":
      numstatArgs = "diff --staged --numstat";
      break;
    case "unstaged":
      numstatArgs = "diff --numstat";
      break;
    case "last_commit":
      numstatArgs = "diff HEAD~1 HEAD --numstat";
      break;
  }

  const output = runGit(numstatArgs, cwd);
  if (!output) return [];

  // Also get the name-status to know added/modified/deleted/renamed
  let nameStatusArgs: string;
  switch (scope) {
    case "staged":
      nameStatusArgs = "diff --staged --name-status";
      break;
    case "unstaged":
      nameStatusArgs = "diff --name-status";
      break;
    case "last_commit":
      nameStatusArgs = "diff HEAD~1 HEAD --name-status";
      break;
  }

  const nameStatusOutput = runGit(nameStatusArgs, cwd);

  // Build a map of file path -> status letter from name-status output
  // Format: "M\tsrc/index.ts" or "A\tsrc/new-file.ts" or "R100\told.ts\tnew.ts"
  const statusMap = new Map<string, "added" | "modified" | "deleted" | "renamed">();
  for (const line of nameStatusOutput.split("\n")) {
    if (!line) continue;
    const parts = line.split("\t");
    const statusLetter = parts[0]?.[0]; // First character: A, M, D, R
    // For renames, the new file path is the last element
    const filePath = parts[parts.length - 1];
    if (!filePath) continue;

    switch (statusLetter) {
      case "A":
        statusMap.set(filePath, "added");
        break;
      case "D":
        statusMap.set(filePath, "deleted");
        break;
      case "R":
        statusMap.set(filePath, "renamed");
        break;
      default:
        statusMap.set(filePath, "modified");
    }
  }

  // Parse numstat output
  // Format: "10\t5\tsrc/index.ts" (additions \t deletions \t filepath)
  const entries: DiffFileEntry[] = [];
  for (const line of output.split("\n")) {
    if (!line) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;

    // Binary files show "-" for additions/deletions
    const additions = parts[0] === "-" ? 0 : parseInt(parts[0], 10);
    const deletions = parts[1] === "-" ? 0 : parseInt(parts[1], 10);
    const filePath = parts[2];

    entries.push({
      filePath,
      status: statusMap.get(filePath) ?? "modified",
      additions,
      deletions,
    });
  }

  return entries;
}

/**
 * Gets a complete structured diff result for the given scope.
 */
export function getStructuredDiff(
  cwd: string,
  scope: "staged" | "unstaged" | "last_commit"
): DiffResult {
  const files = getDiffStats(cwd, scope);
  const rawDiff = getRawDiff(cwd, scope);

  let totalAdditions = 0;
  let totalDeletions = 0;
  for (const file of files) {
    totalAdditions += file.additions;
    totalDeletions += file.deletions;
  }

  return {
    files,
    totalAdditions,
    totalDeletions,
    rawDiff,
  };
}

/**
 * Gets the list of currently untracked (brand new) files.
 * These won't appear in git diff but are part of "what changed."
 */
export function getUntrackedFiles(cwd: string): string[] {
  const output = runGit("ls-files --others --exclude-standard", cwd);
  if (!output) return [];
  return output.split("\n").filter(Boolean);
}

/**
 * Gets the short summary of the last N commits.
 */
export function getRecentCommits(cwd: string, count: number = 5): string {
  return runGit(
    `log --oneline --no-decorate -n ${count}`,
    cwd
  );
}
