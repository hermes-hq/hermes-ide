import { describe, it, expect } from "vitest";
import { compilePrompt, ComposerFields, EMPTY_FIELDS } from "../lib/compilePrompt";
import { BUILT_IN_ROLES } from "../lib/roles";
import { BUILT_IN_STYLES } from "../lib/styles";

describe("compilePrompt v2", () => {
  it("returns empty string for empty fields and no roles", () => {
    expect(compilePrompt(EMPTY_FIELDS, BUILT_IN_ROLES, BUILT_IN_STYLES)).toBe("");
  });

  it("resolves roleIds to Role section", () => {
    const fields: ComposerFields = {
      ...EMPTY_FIELDS,
      roleIds: ["debugger", "backend-eng"],
      task: "Fix the bug",
    };
    const result = compilePrompt(fields, BUILT_IN_ROLES, BUILT_IN_STYLES);
    expect(result).toContain("**Role:**");
    expect(result).toContain("Expert Debugger");
    expect(result).toContain("Senior Backend Engineer");
    expect(result).toContain("**Task:** Fix the bug");
  });

  it("single roleId produces clean output without 'and'", () => {
    const fields: ComposerFields = {
      ...EMPTY_FIELDS,
      roleIds: ["debugger"],
    };
    const result = compilePrompt(fields, BUILT_IN_ROLES, BUILT_IN_STYLES);
    const debugger_ = BUILT_IN_ROLES.find((r) => r.id === "debugger")!;
    expect(result).toBe(`**Role:** ${debugger_.systemInstruction}`);
  });

  it("maintains section order: Role, Task, Scope, Constraints, Style", () => {
    const fields: ComposerFields = {
      roleIds: ["debugger"],
      task: "T",
      scope: "S",
      constraints: "C",
      styleSelections: [],
      style: "St",
    };
    const result = compilePrompt(fields, BUILT_IN_ROLES, BUILT_IN_STYLES);
    const lines = result.split("\n\n");
    expect(lines[0]).toMatch(/^\*\*Role:\*\*/);
    expect(lines[1]).toMatch(/^\*\*Task:\*\*/);
    expect(lines[2]).toMatch(/^\*\*Scope:\*\*/);
    expect(lines[3]).toMatch(/^\*\*Constraints:\*\*/);
    expect(lines[4]).toMatch(/^\*\*Style:\*\*/);
  });

  it("omits empty sections", () => {
    const fields: ComposerFields = {
      ...EMPTY_FIELDS,
      task: "Do something",
      style: "Be concise",
    };
    const result = compilePrompt(fields, BUILT_IN_ROLES, BUILT_IN_STYLES);
    expect(result).toBe("**Task:** Do something\n\n**Style:** Be concise");
    expect(result).not.toContain("**Role:**");
    expect(result).not.toContain("**Scope:**");
    expect(result).not.toContain("**Constraints:**");
  });

  it("treats whitespace-only fields as empty", () => {
    const fields: ComposerFields = { ...EMPTY_FIELDS, task: "   ", scope: "  \n  " };
    expect(compilePrompt(fields, BUILT_IN_ROLES, BUILT_IN_STYLES)).toBe("");
  });

  it("trims field values", () => {
    const fields: ComposerFields = { ...EMPTY_FIELDS, task: "  Fix the bug  " };
    expect(compilePrompt(fields, BUILT_IN_ROLES, BUILT_IN_STYLES)).toBe("**Task:** Fix the bug");
  });

  it("compiles styleSelections into Style section", () => {
    const fields: ComposerFields = {
      ...EMPTY_FIELDS,
      styleSelections: [{ id: "concise", level: 3 }],
    };
    const result = compilePrompt(fields, BUILT_IN_ROLES, BUILT_IN_STYLES);
    expect(result).toContain("**Style:**");
    expect(result).toContain("concise");
  });

  it("combines styleSelections with free-text style", () => {
    const fields: ComposerFields = {
      ...EMPTY_FIELDS,
      styleSelections: [{ id: "concise", level: 3 }],
      style: "Show line references.",
    };
    const result = compilePrompt(fields, BUILT_IN_ROLES, BUILT_IN_STYLES);
    expect(result).toContain("**Style:**");
    expect(result).toContain("concise");
    expect(result).toContain("Show line references.");
  });

  it("multiple styleSelections produce combined instructions", () => {
    const fields: ComposerFields = {
      ...EMPTY_FIELDS,
      styleSelections: [
        { id: "concise", level: 4 },
        { id: "code-heavy", level: 3 },
      ],
    };
    const result = compilePrompt(fields, BUILT_IN_ROLES, BUILT_IN_STYLES);
    expect(result).toContain("**Style:**");
    // Level 4 concise and level 3 code-heavy
    expect(result).toContain("very concise");
    expect(result).toContain("code");
  });
});
