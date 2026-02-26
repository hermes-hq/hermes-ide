export const LANG_COLORS: Record<string, string> = {
  "JavaScript": "#f1e05a",
  "TypeScript": "#3178c6",
  "JavaScript/TypeScript": "#3178c6",
  "Python": "#3572a5",
  "Rust": "#dea584",
  "Go": "#00add8",
  "Ruby": "#701516",
  "Java": "#b07219",
  "Java/Kotlin": "#b07219",
  "Kotlin": "#a97bff",
  "Swift": "#f05138",
  "C#": "#178600",
  "C++": "#f34b7d",
  "C": "#555555",
  "PHP": "#4f5d95",
  "Dart": "#00b4ab",
  "Shell": "#89e051",
  "Bash": "#89e051",
  "HTML": "#e34c26",
  "CSS": "#563d7c",
  "SCSS": "#c6538c",
  "SQL": "#e38c00",
  "R": "#198ce7",
  "Scala": "#c22d40",
  "Elixir": "#6e4a7e",
  "Lua": "#000080",
  "Haskell": "#5e5086",
  "Zig": "#ec915c",
  "Objective-C": "#438eff",
  "Vue": "#41b883",
  "Svelte": "#ff3e00",
};

// Build a case-insensitive lookup index (lazily built once)
let _lowerIndex: Record<string, string> | null = null;
function getLowerIndex(): Record<string, string> {
  if (!_lowerIndex) {
    _lowerIndex = {};
    for (const [key, val] of Object.entries(LANG_COLORS)) {
      _lowerIndex[key.toLowerCase()] = val;
    }
  }
  return _lowerIndex;
}

/**
 * Look up a language color with case-insensitive matching.
 * Returns the hex color or the provided fallback (defaults to "#666").
 */
export function getLangColor(lang: string, fallback = "#666"): string {
  return LANG_COLORS[lang] ?? getLowerIndex()[lang.toLowerCase()] ?? fallback;
}
