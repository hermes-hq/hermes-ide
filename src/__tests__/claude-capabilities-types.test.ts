/**
 * Type-contract tests for `ClaudeCapabilities`.
 *
 * These tests don't exercise behavior — they lock in the TypeScript shape so
 * that if the Rust side ever changes the wire format (e.g. renames a field
 * or alters a sub-type), the build breaks here loudly instead of silently
 * misrendering the composer.
 */
import { describe, it, expect } from "vitest";
import type {
  BuiltinCommand,
  ClaudeCapabilities,
  ModelInfo,
} from "../api/sessions";

describe("ClaudeCapabilities type contract", () => {
  it("accepts the expected fully-populated shape", () => {
    const example: ClaudeCapabilities = {
      effort_levels: ["low", "medium", "high"],
      effort_current: "high",
      models: [{ id: "opus", label: "Opus", description: "..." }],
      slash_commands_builtin: [{ command: "/help", description: "..." }],
    };
    expect(example.effort_levels.length).toBe(3);
    expect(example.models[0].id).toBe("opus");
    expect(example.slash_commands_builtin[0].command).toBe("/help");
    expect(example.effort_current).toBe("high");
  });

  it("accepts empty arrays and a null effort_current for graceful degradation", () => {
    const example: ClaudeCapabilities = {
      effort_levels: [],
      effort_current: null,
      models: [],
      slash_commands_builtin: [],
    };
    expect(example.effort_levels).toEqual([]);
    expect(example.models).toEqual([]);
    expect(example.slash_commands_builtin).toEqual([]);
    expect(example.effort_current).toBeNull();
  });

  it("ModelInfo carries id/label/description as strings", () => {
    const m: ModelInfo = { id: "sonnet", label: "Sonnet", description: "fast" };
    expect(typeof m.id).toBe("string");
    expect(typeof m.label).toBe("string");
    expect(typeof m.description).toBe("string");
  });

  it("BuiltinCommand carries command/description as strings", () => {
    const c: BuiltinCommand = { command: "/clear", description: "clear context" };
    expect(c.command.startsWith("/")).toBe(true);
    expect(typeof c.description).toBe("string");
  });
});
