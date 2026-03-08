import { describe, it, expect } from "vitest";
import { BUILT_IN_TEMPLATES, TEMPLATE_CATEGORIES, type TemplateCategory } from "../lib/templates";
import { BUILT_IN_ROLES } from "../lib/roles";
import { BUILT_IN_STYLES } from "../lib/styles";
import { compilePrompt, EMPTY_FIELDS } from "../lib/compilePrompt";

describe("Template registry", () => {
  it("has 108 built-in templates with required fields", () => {
    expect(BUILT_IN_TEMPLATES.length).toBe(108);
    for (const tpl of BUILT_IN_TEMPLATES) {
      expect(tpl.id).toBeTruthy();
      expect(tpl.name).toBeTruthy();
      expect(tpl.category).toBeTruthy();
      expect(tpl.builtIn).toBe(true);
    }
  });

  it("all categories are valid TemplateCategory values", () => {
    const validCategories = Object.keys(TEMPLATE_CATEGORIES) as TemplateCategory[];
    for (const tpl of BUILT_IN_TEMPLATES) {
      expect(validCategories).toContain(tpl.category);
    }
  });

  it("all recommendedRoles reference existing BUILT_IN_ROLES IDs", () => {
    const roleIds = new Set(BUILT_IN_ROLES.map((r) => r.id));
    for (const tpl of BUILT_IN_TEMPLATES) {
      for (const rid of tpl.recommendedRoles) {
        expect(roleIds.has(rid)).toBe(true);
      }
    }
  });

  it("all recommendedStyles reference existing BUILT_IN_STYLES IDs", () => {
    const styleIds = new Set(BUILT_IN_STYLES.map((s) => s.id));
    for (const tpl of BUILT_IN_TEMPLATES) {
      for (const sel of tpl.recommendedStyles) {
        expect(styleIds.has(sel.id)).toBe(true);
        expect(sel.level).toBeGreaterThanOrEqual(1);
        expect(sel.level).toBeLessThanOrEqual(5);
      }
    }
  });

  it("has no duplicate template IDs", () => {
    const ids = BUILT_IN_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("template fields compile successfully with recommended roles and styles", () => {
    for (const tpl of BUILT_IN_TEMPLATES) {
      const fields = {
        ...EMPTY_FIELDS,
        roleIds: tpl.recommendedRoles,
        styleSelections: tpl.recommendedStyles,
        ...tpl.fields,
      };
      // Remove legacy fields
      delete (fields as Record<string, unknown>).role;
      const compiled = compilePrompt(fields, BUILT_IN_ROLES, BUILT_IN_STYLES);
      expect(compiled.length).toBeGreaterThan(0);
    }
  });

  it("applying a template sets roleIds and styleSelections from recommendations", () => {
    const tpl = BUILT_IN_TEMPLATES.find((t) => t.id === "debug-root-cause")!;
    const fields = {
      ...EMPTY_FIELDS,
      ...tpl.fields,
      roleIds: tpl.recommendedRoles,
      styleSelections: tpl.recommendedStyles,
    };
    expect(fields.roleIds).toEqual(["debugger", "backend-eng"]);
    expect(fields.styleSelections).toEqual([
      { id: "step-by-step", level: 3 },
      { id: "diff-format", level: 3 },
    ]);
  });

  it("TEMPLATE_CATEGORIES covers all categories used by templates", () => {
    const usedCategories = new Set(BUILT_IN_TEMPLATES.map((t) => t.category));
    for (const cat of usedCategories) {
      expect(TEMPLATE_CATEGORIES[cat]).toBeDefined();
    }
  });
});
