/**
 * Typographic glyphs used in agent UI chrome. See playbook §4.
 *
 * All glyphs render as text in JetBrains Mono (verified-rendering set).
 * If any of these renders as a fallback box on a target platform,
 * replace **only that one** via inline SVG (instructions in playbook §4).
 *
 * Rule: never use emoji glyphs in chrome (`📄` `🔍` `✨` `⚡`). The redesign
 * is typographic; if a concept needs a glyph, use this table.
 */
export const GLYPHS = {
  /** U+25C7 white diamond — file operation (Read, Write, Edit, NotebookEdit). */
  file: "◇",
  /** U+25B8 black right-pointing small triangle — execution prompt (Bash, Run). */
  exec: "▸",
  /** U+2315 telephone recorder — search query (Grep, Glob). Visually a magnifier. */
  search: "⌕",
  /** U+2503 box drawings heavy vertical — diff margin / +/- column. */
  margin: "┃",
  /** U+25BE black down-pointing small triangle — disclosure toggle. */
  disclosure: "▾",
  /** U+00B9 superscript one — web citation. Also `²` U+00B2, `³` U+00B3. */
  citation: "¹",
} as const;

export type GlyphKey = keyof typeof GLYPHS;
