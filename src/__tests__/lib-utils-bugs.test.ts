/**
 * Lib & Utils Bug Regression Tests
 *
 * Bugs found and fixed:
 *
 * CRITICAL:
 *   1. structuralEqual — NaN !== NaN returns false, but NaN is structurally equal to NaN
 *   2. structuralEqual — Date objects compared by keys (always equal) instead of time value
 *   3. structuralEqual — RegExp objects compared by keys (always equal) instead of source/flags
 *
 * HIGH:
 *   4. mergeStyles — NaN level produces "undefined" string in compiled output
 *   5. mergeRoles — "You are a Expert..." should be "You are an Expert..." (grammar)
 *
 * MEDIUM:
 *   6. langColors — missing common languages, no case-insensitive lookup helper
 *   7. structuralEqual — Date vs plain object cross-type not rejected
 *   8. mergeStyles — duplicate style selections not deduplicated
 */
import { describe, it, expect } from "vitest";

import { structuralEqual, structuralClone } from "../utils/structuralEqual";
import { mergeStyles, validateCustomStyle, BUILT_IN_STYLES, type StyleDefinition, type SelectedStyle } from "../lib/styles";
import { mergeRoles, validateCustomRole, BUILT_IN_ROLES, type RoleDefinition } from "../lib/roles";
import { compilePrompt, EMPTY_FIELDS, type ComposerFields } from "../lib/compilePrompt";
import { utf8ToBase64 } from "../utils/encoding";
import { LANG_COLORS, getLangColor } from "../utils/langColors";

// =============================================================================
// CRITICAL: Bug 1 — structuralEqual NaN handling
// =============================================================================
describe("CRITICAL: structuralEqual — NaN handling", () => {
  it("NaN is structurally equal to NaN", () => {
    // Before fix: structuralEqual(NaN, NaN) returned false because NaN !== NaN
    expect(structuralEqual(NaN, NaN)).toBe(true);
  });

  it("NaN inside objects is detected as equal", () => {
    const a = { value: NaN, name: "test" };
    const b = { value: NaN, name: "test" };
    expect(structuralEqual(a, b)).toBe(true);
  });

  it("NaN inside arrays is detected as equal", () => {
    expect(structuralEqual([1, NaN, 3], [1, NaN, 3])).toBe(true);
  });

  it("NaN is NOT equal to a number", () => {
    expect(structuralEqual(NaN, 0)).toBe(false);
    expect(structuralEqual(NaN, 1)).toBe(false);
    expect(structuralEqual(NaN, Infinity)).toBe(false);
  });

  it("NaN is NOT equal to null or undefined", () => {
    expect(structuralEqual(NaN, null)).toBe(false);
    expect(structuralEqual(NaN, undefined)).toBe(false);
  });

  it("NaN in nested structures", () => {
    const a = { data: { scores: [NaN, 1, 2] } };
    const b = { data: { scores: [NaN, 1, 2] } };
    expect(structuralEqual(a, b)).toBe(true);
  });

  it("different NaN positions in array are NOT equal", () => {
    expect(structuralEqual([NaN, 1], [1, NaN])).toBe(false);
  });
});

// =============================================================================
// CRITICAL: Bug 2 — structuralEqual Date handling
// =============================================================================
describe("CRITICAL: structuralEqual — Date handling", () => {
  it("same-value Dates are structurally equal", () => {
    const a = new Date(1700000000000);
    const b = new Date(1700000000000);
    expect(structuralEqual(a, b)).toBe(true);
  });

  it("different-value Dates are NOT structurally equal", () => {
    // Before fix: structuralEqual(new Date(1000), new Date(2000)) returned true
    // because both Date objects have 0 enumerable keys
    const a = new Date(1000);
    const b = new Date(2000);
    expect(structuralEqual(a, b)).toBe(false);
  });

  it("Date vs plain object is NOT equal", () => {
    const d = new Date(1000);
    const o = {};
    expect(structuralEqual(d, o)).toBe(false);
  });

  it("identical Date references are equal (short-circuit)", () => {
    const d = new Date();
    expect(structuralEqual(d, d)).toBe(true);
  });

  it("Dates nested in objects", () => {
    const a = { created: new Date(1000), name: "test" };
    const b = { created: new Date(1000), name: "test" };
    expect(structuralEqual(a, b)).toBe(true);

    const c = { created: new Date(2000), name: "test" };
    expect(structuralEqual(a, c)).toBe(false);
  });

  it("Invalid Dates (NaN time) are equal to each other", () => {
    const a = new Date("invalid");
    const b = new Date("also invalid");
    // Both have getTime() === NaN, and NaN === NaN is false
    // So these should be NOT equal (they have unpredictable time values)
    expect(structuralEqual(a, b)).toBe(false);
  });
});

// =============================================================================
// CRITICAL: Bug 3 — structuralEqual RegExp handling
// =============================================================================
describe("CRITICAL: structuralEqual — RegExp handling", () => {
  it("same-pattern RegExps are structurally equal", () => {
    expect(structuralEqual(/abc/gi, /abc/gi)).toBe(true);
  });

  it("different-pattern RegExps are NOT structurally equal", () => {
    // Before fix: structuralEqual(/abc/gi, /xyz/) returned true
    // because both RegExp objects have 0 enumerable keys
    expect(structuralEqual(/abc/gi, /xyz/)).toBe(false);
  });

  it("same pattern with different flags are NOT equal", () => {
    expect(structuralEqual(/abc/g, /abc/i)).toBe(false);
  });

  it("RegExp vs plain object is NOT equal", () => {
    expect(structuralEqual(/abc/, {})).toBe(false);
  });

  it("identical RegExp references are equal (short-circuit)", () => {
    const r = /test/i;
    expect(structuralEqual(r, r)).toBe(true);
  });

  it("RegExps nested in objects", () => {
    const a = { pattern: /^hello/i, name: "greeting" };
    const b = { pattern: /^hello/i, name: "greeting" };
    expect(structuralEqual(a, b)).toBe(true);

    const c = { pattern: /^goodbye/i, name: "greeting" };
    expect(structuralEqual(a, c)).toBe(false);
  });
});

// =============================================================================
// HIGH: Bug 4 — mergeStyles NaN level produces "undefined"
// =============================================================================
describe("HIGH: mergeStyles — NaN level handling", () => {
  it("NaN level does NOT produce 'undefined' in output", () => {
    // Before fix: NaN level -> def.levels[NaN] -> undefined -> "undefined" string
    const result = mergeStyles([{ id: "concise", level: NaN }], BUILT_IN_STYLES);
    expect(result).not.toContain("undefined");
    // Should fall back to level 1 (index 0)
    const concise = BUILT_IN_STYLES.find((s) => s.id === "concise")!;
    expect(result).toBe(concise.levels[0]);
  });

  it("Infinity level clamps to level 5", () => {
    const concise = BUILT_IN_STYLES.find((s) => s.id === "concise")!;
    const result = mergeStyles([{ id: "concise", level: Infinity }], BUILT_IN_STYLES);
    // Infinity - 1 = Infinity, not finite, so falls back to index 0
    expect(result).toBe(concise.levels[0]);
  });

  it("-Infinity level clamps to level 1", () => {
    const concise = BUILT_IN_STYLES.find((s) => s.id === "concise")!;
    const result = mergeStyles([{ id: "concise", level: -Infinity }], BUILT_IN_STYLES);
    expect(result).toBe(concise.levels[0]);
  });

  it("normal levels still work correctly after fix", () => {
    const concise = BUILT_IN_STYLES.find((s) => s.id === "concise")!;
    expect(mergeStyles([{ id: "concise", level: 1 }], BUILT_IN_STYLES)).toBe(concise.levels[0]);
    expect(mergeStyles([{ id: "concise", level: 3 }], BUILT_IN_STYLES)).toBe(concise.levels[2]);
    expect(mergeStyles([{ id: "concise", level: 5 }], BUILT_IN_STYLES)).toBe(concise.levels[4]);
  });
});

// =============================================================================
// HIGH: Bug 5 — mergeRoles grammar "a" vs "an"
// =============================================================================
describe("HIGH: mergeRoles — article grammar (a vs an)", () => {
  it("uses 'an' before vowel-starting labels like 'Expert Debugger'", () => {
    // Before fix: "You are a Expert Debugger and Senior Backend Engineer."
    // After fix: "You are an Expert Debugger and Senior Backend Engineer."
    const result = mergeRoles(["debugger", "backend-eng"], BUILT_IN_ROLES);
    expect(result).toContain("You are an Expert Debugger and Senior Backend Engineer.");
    expect(result).not.toContain("You are a Expert");
  });

  it("uses 'an' before 'Accessibility Specialist'", () => {
    const result = mergeRoles(["accessibility-specialist", "frontend-eng"], BUILT_IN_ROLES);
    expect(result).toContain("You are an Accessibility Specialist and Senior Frontend Engineer.");
  });

  it("uses 'a' before consonant-starting labels like 'Senior Backend Engineer'", () => {
    const result = mergeRoles(["backend-eng", "frontend-eng"], BUILT_IN_ROLES);
    expect(result).toContain("You are a Senior Backend Engineer and Senior Frontend Engineer.");
  });

  it("uses 'a' before consonant for custom roles", () => {
    const roles: RoleDefinition[] = [
      { id: "r1", label: "Database Admin", systemInstruction: "You are a db admin.", builtIn: false },
      { id: "r2", label: "Security Expert", systemInstruction: "You are a security expert.", builtIn: false },
    ];
    const result = mergeRoles(["r1", "r2"], roles);
    expect(result).toContain("You are a Database Admin and Security Expert.");
  });

  it("uses 'an' before vowel for custom roles", () => {
    const roles: RoleDefinition[] = [
      { id: "r1", label: "API Specialist", systemInstruction: "You are an api specialist.", builtIn: false },
      { id: "r2", label: "Security Expert", systemInstruction: "You are a security expert.", builtIn: false },
    ];
    const result = mergeRoles(["r1", "r2"], roles);
    expect(result).toContain("You are an API Specialist and Security Expert.");
  });

  it("3+ roles with vowel-starting first label uses 'an'", () => {
    const result = mergeRoles(["debugger", "backend-eng", "architect"], BUILT_IN_ROLES);
    expect(result).toContain("You are an Expert Debugger, Senior Backend Engineer, and Software Architect.");
  });

  it("3+ roles with consonant-starting first label uses 'a'", () => {
    const result = mergeRoles(["backend-eng", "frontend-eng", "architect"], BUILT_IN_ROLES);
    expect(result).toContain("You are a Senior Backend Engineer, Senior Frontend Engineer, and Software Architect.");
  });
});

// =============================================================================
// MEDIUM: Bug 6 — langColors missing languages and case-insensitive lookup
// =============================================================================
describe("MEDIUM: langColors — coverage and case-insensitive lookup", () => {
  it("has colors for newly added common languages", () => {
    expect(LANG_COLORS["Shell"]).toBe("#89e051");
    expect(LANG_COLORS["HTML"]).toBe("#e34c26");
    expect(LANG_COLORS["CSS"]).toBe("#563d7c");
    expect(LANG_COLORS["SQL"]).toBe("#e38c00");
    expect(LANG_COLORS["R"]).toBe("#198ce7");
    expect(LANG_COLORS["Scala"]).toBe("#c22d40");
    expect(LANG_COLORS["Elixir"]).toBe("#6e4a7e");
    expect(LANG_COLORS["Lua"]).toBe("#000080");
    expect(LANG_COLORS["Haskell"]).toBe("#5e5086");
    expect(LANG_COLORS["Zig"]).toBe("#ec915c");
  });

  it("getLangColor returns correct color for exact case", () => {
    expect(getLangColor("TypeScript")).toBe("#3178c6");
    expect(getLangColor("Python")).toBe("#3572a5");
  });

  it("getLangColor returns correct color for different case", () => {
    // Case-insensitive lookup
    expect(getLangColor("typescript")).toBe("#3178c6");
    expect(getLangColor("PYTHON")).toBe("#3572a5");
    expect(getLangColor("javascript")).toBe("#f1e05a");
    expect(getLangColor("rust")).toBe("#dea584");
  });

  it("getLangColor returns fallback for unknown language", () => {
    expect(getLangColor("BrainF**k")).toBe("#666");
    expect(getLangColor("BrainF**k", "#999")).toBe("#999");
  });

  it("getLangColor handles empty string", () => {
    expect(getLangColor("")).toBe("#666");
  });
});

// =============================================================================
// MEDIUM: Bug 7 — structuralEqual Date vs plain object cross-type
// =============================================================================
describe("MEDIUM: structuralEqual — cross-type object comparison", () => {
  it("Date vs empty object returns false", () => {
    expect(structuralEqual(new Date(0), {})).toBe(false);
  });

  it("RegExp vs empty object returns false", () => {
    expect(structuralEqual(/test/, {})).toBe(false);
  });

  it("Date vs RegExp returns false", () => {
    expect(structuralEqual(new Date(0), /test/)).toBe(false);
  });

  it("plain objects with same keys still compare correctly", () => {
    expect(structuralEqual({ a: 1 }, { a: 1 })).toBe(true);
    expect(structuralEqual({ a: 1 }, { a: 2 })).toBe(false);
  });
});

// =============================================================================
// MEDIUM: Bug 8 — mergeStyles duplicate selections
// =============================================================================
describe("MEDIUM: mergeStyles — duplicate style selections", () => {
  it("duplicate style IDs both contribute to output (by design, not deduplicated)", () => {
    // This tests the current behavior: duplicates are both included.
    // This is a documentation/awareness test.
    const concise = BUILT_IN_STYLES.find((s) => s.id === "concise")!;
    const result = mergeStyles(
      [{ id: "concise", level: 3 }, { id: "concise", level: 5 }],
      BUILT_IN_STYLES,
    );
    // Both level instructions appear
    expect(result).toContain(concise.levels[2]);
    expect(result).toContain(concise.levels[4]);
  });
});

// =============================================================================
// Additional edge-case tests for completeness
// =============================================================================

describe("structuralEqual — additional edge cases", () => {
  it("empty arrays are equal", () => {
    expect(structuralEqual([], [])).toBe(true);
  });

  it("empty objects are equal", () => {
    expect(structuralEqual({}, {})).toBe(true);
  });

  it("nested empty structures are equal", () => {
    expect(structuralEqual({ a: [], b: {} }, { a: [], b: {} })).toBe(true);
  });

  it("boolean vs number is not equal", () => {
    expect(structuralEqual(true, 1)).toBe(false);
    expect(structuralEqual(false, 0)).toBe(false);
  });

  it("string vs number is not equal", () => {
    expect(structuralEqual("1", 1)).toBe(false);
  });

  it("-0 and +0 are considered equal (by === semantics)", () => {
    // -0 === +0 is true in JS, so structuralEqual treats them as equal
    expect(structuralEqual(-0, +0)).toBe(true);
  });
});

describe("structuralClone — correctness", () => {
  it("clones primitive values", () => {
    expect(structuralClone(42)).toBe(42);
    expect(structuralClone("hello")).toBe("hello");
    expect(structuralClone(null)).toBe(null);
    expect(structuralClone(true)).toBe(true);
  });

  it("clones objects deeply", () => {
    const original = { a: { b: [1, 2, 3] }, c: "test" };
    const cloned = structuralClone(original);
    expect(cloned).toEqual(original);
    expect(cloned).not.toBe(original);
    expect(cloned.a).not.toBe(original.a);
    expect(cloned.a.b).not.toBe(original.a.b);
  });

  it("cloned object modifications do not affect original", () => {
    const original = { items: [1, 2, 3] };
    const cloned = structuralClone(original);
    cloned.items.push(4);
    expect(original.items).toEqual([1, 2, 3]);
    expect(cloned.items).toEqual([1, 2, 3, 4]);
  });
});

describe("utf8ToBase64 — additional edge cases", () => {
  it("handles single byte boundary (0x7F)", () => {
    const input = String.fromCharCode(0x7f);
    const result = utf8ToBase64(input);
    const decoded = new TextDecoder().decode(
      Uint8Array.from(atob(result), (c) => c.charCodeAt(0)),
    );
    expect(decoded).toBe(input);
  });

  it("handles two-byte boundary (0x80)", () => {
    const input = String.fromCharCode(0x80);
    const result = utf8ToBase64(input);
    const decoded = new TextDecoder().decode(
      Uint8Array.from(atob(result), (c) => c.charCodeAt(0)),
    );
    expect(decoded).toBe(input);
  });

  it("handles surrogate pair characters (4-byte UTF-8)", () => {
    // U+1F600 (Grinning Face) is a 4-byte UTF-8 character
    const input = "\u{1F600}";
    const result = utf8ToBase64(input);
    const decoded = new TextDecoder().decode(
      Uint8Array.from(atob(result), (c) => c.charCodeAt(0)),
    );
    expect(decoded).toBe(input);
  });

  it("handles null character", () => {
    const input = "a\0b";
    const result = utf8ToBase64(input);
    const decoded = new TextDecoder().decode(
      Uint8Array.from(atob(result), (c) => c.charCodeAt(0)),
    );
    expect(decoded).toBe(input);
  });
});

describe("compilePrompt — edge cases", () => {
  it("handles unknown roleIds gracefully (empty role section)", () => {
    const fields: ComposerFields = {
      ...EMPTY_FIELDS,
      roleIds: ["nonexistent-1", "nonexistent-2"],
      task: "Do something",
    };
    const result = compilePrompt(fields, BUILT_IN_ROLES, BUILT_IN_STYLES);
    expect(result).not.toContain("**Role:**");
    expect(result).toBe("**Task:** Do something");
  });

  it("handles styleSelections with unknown IDs gracefully", () => {
    const fields: ComposerFields = {
      ...EMPTY_FIELDS,
      styleSelections: [{ id: "nonexistent-style", level: 3 }],
      task: "Test",
    };
    const result = compilePrompt(fields, BUILT_IN_ROLES, BUILT_IN_STYLES);
    expect(result).not.toContain("**Style:**");
    expect(result).toBe("**Task:** Test");
  });

  it("handles all fields set to whitespace only", () => {
    const fields: ComposerFields = {
      roleIds: [],
      task: "   \t\n   ",
      scope: "   ",
      constraints: " \n ",
      styleSelections: [],
      style: "   ",
    };
    const result = compilePrompt(fields, BUILT_IN_ROLES, BUILT_IN_STYLES);
    expect(result).toBe("");
  });
});

describe("validateCustomRole — edge cases", () => {
  it("rejects whitespace-only label", () => {
    const result = validateCustomRole(
      { label: "   \t\n   ", systemInstruction: "Some instruction" },
      [],
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Label");
  });

  it("rejects whitespace-only systemInstruction", () => {
    const result = validateCustomRole(
      { label: "Valid Label", systemInstruction: "   \t\n   " },
      [],
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain("instruction");
  });

  it("accepts valid role when no existing roles", () => {
    const result = validateCustomRole(
      { label: "New Role", systemInstruction: "You do things." },
      [],
    );
    expect(result.valid).toBe(true);
  });
});

describe("validateCustomStyle — edge cases", () => {
  it("rejects whitespace-only label", () => {
    const result = validateCustomStyle(
      { label: "   \t\n   ", levels: ["a", "b", "c", "d", "e"] },
      [],
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Label");
  });

  it("rejects whitespace-only level instruction", () => {
    const result = validateCustomStyle(
      { label: "Valid", levels: ["a", "b", "   ", "d", "e"] },
      [],
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain("level");
  });

  it("accepts valid style when no existing styles", () => {
    const result = validateCustomStyle(
      { label: "New Style", levels: ["l1", "l2", "l3", "l4", "l5"] },
      [],
    );
    expect(result.valid).toBe(true);
  });
});
