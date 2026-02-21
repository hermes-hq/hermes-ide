import { mergeRoles, type RoleDefinition } from "./roles";
import { mergeStyles, type StyleDefinition, type SelectedStyle } from "./styles";

// ── v2 interfaces ──

export interface ComposerFields {
  roleIds: string[];
  task: string;
  scope: string;
  constraints: string;
  styleSelections: SelectedStyle[];
  style: string; // free-text override (Additional Style Notes)
}

export const EMPTY_FIELDS: ComposerFields = {
  roleIds: [],
  task: "",
  scope: "",
  constraints: "",
  styleSelections: [],
  style: "",
};

// ── Legacy types (backward compat with saved user templates and v1 tests) ──

export interface LegacyComposerFields {
  role: string;
  task: string;
  scope: string;
  constraints: string;
  style: string;
}

export const LEGACY_EMPTY_FIELDS: LegacyComposerFields = {
  role: "",
  task: "",
  scope: "",
  constraints: "",
  style: "",
};

// ── Compiler v2 ──

export function compilePrompt(
  fields: ComposerFields,
  allRoles: RoleDefinition[],
  allStyles: StyleDefinition[] = [],
): string {
  const sections: string[] = [];
  const roleText = mergeRoles(fields.roleIds, allRoles);
  if (roleText.trim()) sections.push(`**Role:** ${roleText.trim()}`);
  if (fields.task.trim()) sections.push(`**Task:** ${fields.task.trim()}`);
  if (fields.scope.trim()) sections.push(`**Scope:** ${fields.scope.trim()}`);
  if (fields.constraints.trim()) sections.push(`**Constraints:** ${fields.constraints.trim()}`);

  // Style: merge selections + free-text
  const selectionsText = mergeStyles(fields.styleSelections, allStyles);
  const freeText = fields.style.trim();
  const combined = [selectionsText, freeText].filter(Boolean).join(" ");
  if (combined) sections.push(`**Style:** ${combined}`);

  return sections.join("\n\n");
}

// ── Legacy compiler (v1 — used by existing tests) ──

export function compilePromptLegacy(fields: LegacyComposerFields): string {
  const sections: string[] = [];
  if (fields.role.trim()) sections.push(`**Role:** ${fields.role.trim()}`);
  if (fields.task.trim()) sections.push(`**Task:** ${fields.task.trim()}`);
  if (fields.scope.trim()) sections.push(`**Scope:** ${fields.scope.trim()}`);
  if (fields.constraints.trim()) sections.push(`**Constraints:** ${fields.constraints.trim()}`);
  if (fields.style.trim()) sections.push(`**Style:** ${fields.style.trim()}`);
  return sections.join("\n\n");
}

// ── Re-exports for convenience ──

export { BUILT_IN_TEMPLATES, TEMPLATE_CATEGORIES } from "./templates";
export type { PromptTemplate, TemplateCategory } from "./templates";
export { BUILT_IN_ROLES, mergeRoles, validateCustomRole } from "./roles";
export type { RoleDefinition } from "./roles";
export { BUILT_IN_STYLES, mergeStyles, validateCustomStyle } from "./styles";
export type { StyleDefinition, SelectedStyle } from "./styles";
