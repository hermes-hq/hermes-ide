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
import type { ModelInfo } from "../api/sessions";

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
});
