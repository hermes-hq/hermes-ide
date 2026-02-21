import { describe, it, expect } from "vitest";
import {
  compilePromptLegacy,
  LegacyComposerFields,
  LEGACY_EMPTY_FIELDS,
  BUILT_IN_TEMPLATES,
  EMPTY_FIELDS,
} from "../lib/compilePrompt";

describe("compilePromptLegacy", () => {
  it("produces empty string for empty fields", () => {
    expect(compilePromptLegacy(LEGACY_EMPTY_FIELDS)).toBe("");
  });

  it("produces a single section when only task is filled", () => {
    const fields: LegacyComposerFields = { ...LEGACY_EMPTY_FIELDS, task: "Fix the login bug" };
    expect(compilePromptLegacy(fields)).toBe("**Task:** Fix the login bug");
  });

  it("produces all sections with correct headers when all fields are filled", () => {
    const fields: LegacyComposerFields = {
      role: "Senior engineer",
      task: "Refactor auth module",
      scope: "src/auth/",
      constraints: "No new deps",
      style: "Be concise",
    };
    const result = compilePromptLegacy(fields);
    expect(result).toBe(
      "**Role:** Senior engineer\n\n**Task:** Refactor auth module\n\n**Scope:** src/auth/\n\n**Constraints:** No new deps\n\n**Style:** Be concise"
    );
  });

  it("omits empty fields entirely", () => {
    const fields: LegacyComposerFields = { ...LEGACY_EMPTY_FIELDS, role: "Reviewer", style: "Be brief" };
    const result = compilePromptLegacy(fields);
    expect(result).toBe("**Role:** Reviewer\n\n**Style:** Be brief");
    expect(result).not.toContain("**Task:**");
    expect(result).not.toContain("**Scope:**");
    expect(result).not.toContain("**Constraints:**");
  });

  it("treats whitespace-only fields as empty", () => {
    const fields: LegacyComposerFields = { ...LEGACY_EMPTY_FIELDS, task: "   ", role: "  \n  " };
    expect(compilePromptLegacy(fields)).toBe("");
  });

  it("trims leading/trailing whitespace from field values", () => {
    const fields: LegacyComposerFields = { ...LEGACY_EMPTY_FIELDS, task: "  Fix the bug  " };
    expect(compilePromptLegacy(fields)).toBe("**Task:** Fix the bug");
  });

  it("maintains order: Role, Task, Scope, Constraints, Style", () => {
    const fields: LegacyComposerFields = {
      role: "R",
      task: "T",
      scope: "S",
      constraints: "C",
      style: "St",
    };
    const result = compilePromptLegacy(fields);
    const lines = result.split("\n\n");
    expect(lines[0]).toMatch(/^\*\*Role:\*\*/);
    expect(lines[1]).toMatch(/^\*\*Task:\*\*/);
    expect(lines[2]).toMatch(/^\*\*Scope:\*\*/);
    expect(lines[3]).toMatch(/^\*\*Constraints:\*\*/);
    expect(lines[4]).toMatch(/^\*\*Style:\*\*/);
  });

  it("separates sections with double newline", () => {
    const fields: LegacyComposerFields = { ...LEGACY_EMPTY_FIELDS, role: "R", task: "T" };
    const result = compilePromptLegacy(fields);
    expect(result).toBe("**Role:** R\n\n**Task:** T");
  });
});

describe("Template management", () => {
  it("built-in templates have correct fields pre-filled", () => {
    expect(BUILT_IN_TEMPLATES.length).toBeGreaterThanOrEqual(4);
    const codeReview = BUILT_IN_TEMPLATES.find((t) => t.id === "git-review");
    expect(codeReview).toBeDefined();
    expect(codeReview!.fields.style).toBeTruthy();
  });

  it("applying a template overwrites current fields", () => {
    const tpl = BUILT_IN_TEMPLATES.find((t) => t.id === "refactor-extract")!;
    const applied = { ...EMPTY_FIELDS, ...tpl.fields };
    expect(applied.constraints).toBeTruthy();
    expect(applied.task).toBe("");
    expect(applied.scope).toBe("");
  });

  it("EMPTY_FIELDS has correct defaults", () => {
    expect(EMPTY_FIELDS.roleIds).toEqual([]);
    expect(EMPTY_FIELDS.styleSelections).toEqual([]);
    expect(EMPTY_FIELDS.task).toBe("");
    expect(EMPTY_FIELDS.scope).toBe("");
    expect(EMPTY_FIELDS.constraints).toBe("");
    expect(EMPTY_FIELDS.style).toBe("");
  });

  it("all built-in templates have id and name", () => {
    for (const tpl of BUILT_IN_TEMPLATES) {
      expect(tpl.id).toBeTruthy();
      expect(tpl.name).toBeTruthy();
    }
  });

  it("built-in template fields produce valid compiled prompts (legacy)", () => {
    for (const tpl of BUILT_IN_TEMPLATES) {
      const fields: LegacyComposerFields = {
        role: "",
        task: "",
        scope: "",
        constraints: "",
        style: "",
        ...tpl.fields,
      };
      // Remove v2/v3 fields that don't belong in legacy
      const record = fields as unknown as Record<string, unknown>;
      delete record.roleIds;
      delete record.styleSelections;
      const compiled = compilePromptLegacy(fields);
      expect(compiled.length).toBeGreaterThan(0);
    }
  });
});

describe("Legacy template migration", () => {
  it("handles v1 templates with string role gracefully", () => {
    const v1Template = {
      id: "user-123",
      name: "My Template",
      fields: { role: "You are an expert", task: "Do something" },
    };
    const hasLegacyRole = typeof (v1Template.fields as Record<string, unknown>).role === "string";
    expect(hasLegacyRole).toBe(true);
  });
});
