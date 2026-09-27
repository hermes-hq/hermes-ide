/**
 * Tests for `isCurrentModel`, the helper that decides which row of the
 * dynamic ModelPicker should be flagged as the active model.
 *
 * The "default" option is special-cased: it is current when there's no
 * detected model at all (fresh session, before Claude's banner has been
 * parsed). All other options match by case-insensitive substring against
 * Claude's reported model string (e.g. `claude-sonnet-4-6`).
 */
import { describe, it, expect } from "vitest";
import { isCurrentModel } from "../utils/modelPicker";
import { CLAUDE_MODEL_OPTIONS, type ModelInfo } from "../agent/modelOptions";

const make = (id: string): ModelInfo => ({ id, label: id, description: "" });

describe("isCurrentModel", () => {
  it("matches sonnet against a hyphenated wire format", () => {
    expect(isCurrentModel(make("sonnet"), "claude-sonnet-4-6")).toBe(true);
  });

  it("does not match opus against a sonnet model string", () => {
    expect(isCurrentModel(make("opus"), "claude-sonnet-4-6")).toBe(false);
  });

  it("treats the `default` option as current when no model is detected (null)", () => {
    expect(isCurrentModel(make("default"), null)).toBe(true);
  });

  it("treats the `default` option as current when the model string is empty", () => {
    expect(isCurrentModel(make("default"), "")).toBe(true);
  });

  it("does not flag a non-default option when no model is detected", () => {
    expect(isCurrentModel(make("haiku"), null)).toBe(false);
  });

  it("matches case-insensitively in both directions", () => {
    // Uppercase id, lowercase model
    expect(isCurrentModel(make("OPUS"), "claude-opus-4-7")).toBe(true);
    // Lowercase id, mixed-case model
    expect(isCurrentModel(make("opus"), "Claude-Opus-4-7")).toBe(true);
  });

  it("matches haiku against a haiku model string", () => {
    expect(isCurrentModel(make("haiku"), "claude-haiku-4-5")).toBe(true);
  });

  it("does not match `default` when a real model is reported", () => {
    expect(isCurrentModel(make("default"), "claude-sonnet-4-6")).toBe(false);
  });

  it("matches the Fable 5.1 row only against Fable 5.1", () => {
    expect(isCurrentModel(make("claude-fable-5-1"), "claude-fable-5-1")).toBe(true);
    expect(isCurrentModel(make("claude-fable-5-1"), "claude-fable-5")).toBe(false);
    expect(isCurrentModel(make("opus"), "claude-fable-5-1")).toBe(false);
  });
});

describe("CLAUDE_MODEL_OPTIONS", () => {
  it("offers the family aliases plus Fable 5.1", () => {
    expect(CLAUDE_MODEL_OPTIONS.map((o) => o.id)).toEqual([
      "default",
      "sonnet",
      "opus",
      "claude-fable-5-1",
      "haiku",
    ]);
  });
});
