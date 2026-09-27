import type { LanguageSupport } from "@codemirror/language";

/**
 * Map from language identifier to a loader for its CM6 LanguageSupport.
 * Each grammar is its own chunk, fetched the first time a file in that
 * language is opened — none of them are part of the startup bundle.
 */
const languageLoaders: Record<string, () => Promise<LanguageSupport>> = {
  javascript: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ jsx: true, typescript: false })),
  typescript: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ jsx: true, typescript: true })),
  rust: () => import("@codemirror/lang-rust").then((m) => m.rust()),
  python: () => import("@codemirror/lang-python").then((m) => m.python()),
  go: () => import("@codemirror/lang-go").then((m) => m.go()),
  java: () => import("@codemirror/lang-java").then((m) => m.java()),
  cpp: () => import("@codemirror/lang-cpp").then((m) => m.cpp()),
  php: () => import("@codemirror/lang-php").then((m) => m.php()),
  sql: () => import("@codemirror/lang-sql").then((m) => m.sql()),
  yaml: () => import("@codemirror/lang-yaml").then((m) => m.yaml()),
  html: () => import("@codemirror/lang-html").then((m) => m.html()),
  css: () => import("@codemirror/lang-css").then((m) => m.css()),
  json: () => import("@codemirror/lang-json").then((m) => m.json()),
  markdown: () => import("@codemirror/lang-markdown").then((m) => m.markdown()),
};

/** One load per language: concurrent callers share the same promise. */
const pending = new Map<string, Promise<LanguageSupport>>();
/** Languages that finished loading, for synchronous lookups. */
const loaded = new Map<string, LanguageSupport>();

/** Whether a grammar exists for this language identifier. */
export function hasLanguageSupport(language: string): boolean {
  return Object.prototype.hasOwnProperty.call(languageLoaders, language.toLowerCase());
}

/**
 * Loads (once) and returns the CodeMirror 6 LanguageSupport for a language
 * identifier, or `null` for unsupported / plaintext languages.
 */
export function loadLanguageSupport(language: string): Promise<LanguageSupport | null> {
  const id = language.toLowerCase();
  if (!hasLanguageSupport(id)) return Promise.resolve(null);
  let promise = pending.get(id);
  if (!promise) {
    promise = languageLoaders[id]().then((support) => {
      loaded.set(id, support);
      return support;
    });
    // A failed chunk load must not poison the cache: allow a retry.
    promise.catch(() => pending.delete(id));
    pending.set(id, promise);
  }
  return promise;
}

/**
 * The LanguageSupport for a language if it has already been loaded,
 * otherwise `null` (use {@link loadLanguageSupport} to fetch it).
 */
export function peekLanguageSupport(language: string): LanguageSupport | null {
  return loaded.get(language.toLowerCase()) ?? null;
}

/**
 * Extension-to-language-id mapping.
 * Matches the Rust backend's file-type detection exactly.
 */
const extensionMap: Record<string, string> = {
  // Rust
  rs: "rust",

  // TypeScript
  ts: "typescript",
  tsx: "typescript",

  // JavaScript
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",

  // Python
  py: "python",

  // Go
  go: "go",

  // Java
  java: "java",

  // C / C++ (C uses cpp grammar)
  c: "cpp",
  h: "cpp",
  cpp: "cpp",
  hpp: "cpp",
  cc: "cpp",
  cxx: "cpp",

  // PHP
  php: "php",

  // SQL
  sql: "sql",

  // YAML
  yaml: "yaml",
  yml: "yaml",

  // HTML
  html: "html",
  htm: "html",

  // CSS variants
  css: "css",
  scss: "css",
  sass: "css",
  less: "css",

  // JSON
  json: "json",

  // Markdown
  md: "markdown",
  markdown: "markdown",

  // Kotlin — falls back to Java grammar
  kt: "java",
  kts: "java",

  // Shell — no CM package bundled, maps to plaintext
  sh: "shell",
  bash: "shell",
  zsh: "shell",

  // Dockerfile — no CM package bundled
  dockerfile: "dockerfile",

  // Other languages without bundled CM packages
  rb: "ruby",
  swift: "swift",
  dart: "dart",
  lua: "lua",
  r: "r",
  ex: "elixir",
  exs: "elixir",
  cs: "csharp",
  toml: "toml",
  xml: "xml",
  svg: "xml",
};

/**
 * Maps a file extension (without the leading dot) to a language identifier.
 * Returns `"plaintext"` for unrecognised extensions.
 */
export function getLanguageForExtension(ext: string): string {
  const normalized = ext.toLowerCase().replace(/^\./, "");
  return extensionMap[normalized] ?? "plaintext";
}
