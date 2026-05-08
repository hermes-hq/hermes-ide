/**
 * Tool family routing. See playbook §5.
 *
 * Each tool name maps to one of five visual-language families. New tools that
 * aren't in the table fall through to "generic" — the bare-bones treatment
 * that motivates adding a proper family-specific renderer when a tool starts
 * being important.
 */
export type ToolFamily = "file" | "exec" | "search" | "web" | "generic";

/** Lowercase, separator-stripped tool name → family. */
const FAMILY: Record<string, ToolFamily> = {
  read: "file",
  write: "file",
  edit: "file",
  notebookedit: "file",
  bash: "exec",
  run: "exec",
  grep: "search",
  glob: "search",
  webfetch: "web",
  websearch: "web",
};

/**
 * Pure routing function. Case-insensitive; ignores whitespace, hyphens, and
 * underscores in the tool name (`Notebook Edit`, `notebook-edit`,
 * `notebook_edit`, `NotebookEdit` all map to "file").
 */
export function getToolFamily(toolName: string): ToolFamily {
  const key = toolName.toLowerCase().replace(/[\s_-]/g, "");
  return FAMILY[key] ?? "generic";
}
