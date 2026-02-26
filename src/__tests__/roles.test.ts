import { describe, it, expect } from "vitest";
import { BUILT_IN_ROLES, mergeRoles, validateCustomRole, type RoleDefinition } from "../lib/roles";

describe("mergeRoles", () => {
  it("returns empty string for empty array", () => {
    expect(mergeRoles([], BUILT_IN_ROLES)).toBe("");
  });

  it("returns systemInstruction verbatim for single role", () => {
    const result = mergeRoles(["debugger"], BUILT_IN_ROLES);
    const role = BUILT_IN_ROLES.find((r) => r.id === "debugger")!;
    expect(result).toBe(role.systemInstruction);
  });

  it("uses 'and' for 2 roles", () => {
    const result = mergeRoles(["debugger", "backend-eng"], BUILT_IN_ROLES);
    expect(result).toContain("You are an Expert Debugger and Senior Backend Engineer.");
  });

  it("uses Oxford comma for 3+ roles", () => {
    const result = mergeRoles(["debugger", "backend-eng", "architect"], BUILT_IN_ROLES);
    expect(result).toContain("You are an Expert Debugger, Senior Backend Engineer, and Software Architect.");
  });

  it("is deterministic — same input produces same output", () => {
    const ids = ["frontend-eng", "typescript-specialist", "architect"];
    const a = mergeRoles(ids, BUILT_IN_ROLES);
    const b = mergeRoles(ids, BUILT_IN_ROLES);
    expect(a).toBe(b);
  });

  it("skips unknown IDs silently", () => {
    const result = mergeRoles(["debugger", "nonexistent-role"], BUILT_IN_ROLES);
    const role = BUILT_IN_ROLES.find((r) => r.id === "debugger")!;
    expect(result).toBe(role.systemInstruction);
  });

  it("deduplicates capability sentences", () => {
    // Create roles with overlapping capabilities
    const roles: RoleDefinition[] = [
      { id: "a", label: "Role A", systemInstruction: "You are a Role A with expertise in testing.", builtIn: false },
      { id: "b", label: "Role B", systemInstruction: "You are a Role B with expertise in testing.", builtIn: false },
    ];
    const result = mergeRoles(["a", "b"], roles);
    // Should only have one "expertise in testing" mention after the opening
    const matches = result.match(/expertise in testing/gi) || [];
    expect(matches.length).toBe(1);
  });
});

describe("validateCustomRole", () => {
  it("rejects empty label", () => {
    const result = validateCustomRole(
      { label: "", systemInstruction: "Some instruction" },
      BUILT_IN_ROLES,
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Label");
  });

  it("rejects empty systemInstruction", () => {
    const result = validateCustomRole(
      { label: "My Role", systemInstruction: "  " },
      BUILT_IN_ROLES,
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain("instruction");
  });

  it("rejects duplicate label (case-insensitive)", () => {
    const result = validateCustomRole(
      { label: "expert debugger", systemInstruction: "Some instruction" },
      BUILT_IN_ROLES,
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain("already exists");
  });

  it("accepts a valid custom role", () => {
    const result = validateCustomRole(
      { label: "Unique Custom Role", systemInstruction: "You are a unique custom role." },
      BUILT_IN_ROLES,
    );
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });
});
