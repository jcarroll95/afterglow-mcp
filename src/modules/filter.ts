/**
 * Filters out files that are noise in a code change analysis.
 * This includes dependency directories, build artifacts, lock files,
 * binary assets, and other files that don't represent meaningful
 * developer-authored changes.
 */

/**
 * Directory prefixes that should always be excluded.
 * A file is excluded if its path starts with any of these.
 */
const IGNORED_DIRECTORIES: string[] = [
  "node_modules/",
  ".git/",
  "dist/",
  "build/",
  ".next/",
  ".nuxt/",
  ".output/",
  ".svelte-kit/",
  ".vercel/",
  ".netlify/",
  ".cache/",
  ".turbo/",
  ".parcel-cache/",
  "coverage/",
  ".nyc_output/",
  "__pycache__/",
  ".pytest_cache/",
  "venv/",
  ".venv/",
  "env/",
  ".env/",
  ".tox/",
  "vendor/",
  "bower_components/",
  ".idea/",
  ".vscode/",
  ".DS_Store/",
  "tmp/",
  "temp/",
  ".terraform/",
  ".angular/",
];

/**
 * Exact filenames that should always be excluded.
 */
const IGNORED_FILES: string[] = [
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "composer.lock",
  "Gemfile.lock",
  "Cargo.lock",
  "poetry.lock",
  "Pipfile.lock",
  ".DS_Store",
  "Thumbs.db",
  ".eslintcache",
  ".stylelintcache",
  ".prettiercache",
];

/**
 * File extensions for binary/non-readable files that add noise.
 */
const IGNORED_EXTENSIONS: string[] = [
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".svg",
  ".bmp",
  ".tiff",
  ".mp4",
  ".mp3",
  ".wav",
  ".ogg",
  ".webm",
  ".mov",
  ".avi",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".otf",
  ".zip",
  ".tar",
  ".gz",
  ".rar",
  ".7z",
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".map",
  ".min.js",
  ".min.css",
];

/**
 * Returns true if the file should be EXCLUDED from analysis.
 */
export function shouldIgnoreFile(filePath: string): boolean {
  // Normalize to forward slashes for cross-platform consistency
  const normalized = filePath.replace(/\\/g, "/");

  // Check directory prefixes
  for (const dir of IGNORED_DIRECTORIES) {
    if (normalized.startsWith(dir) || normalized.includes(`/${dir}`)) {
      return true;
    }
  }

  // Check exact filenames
  const fileName = normalized.split("/").pop() ?? "";
  if (IGNORED_FILES.includes(fileName)) {
    return true;
  }

  // Check extensions
  const lowerPath = normalized.toLowerCase();
  for (const ext of IGNORED_EXTENSIONS) {
    if (lowerPath.endsWith(ext)) {
      return true;
    }
  }

  return false;
}

/**
 * Filters an array of file paths, returning only the ones worth analyzing.
 */
export function filterFiles<T extends { filePath: string }>(files: T[]): T[] {
  return files.filter((f) => !shouldIgnoreFile(f.filePath));
}

/**
 * Filters an array of plain file path strings.
 */
export function filterFilePaths(paths: string[]): string[] {
  return paths.filter((p) => !shouldIgnoreFile(p));
}
