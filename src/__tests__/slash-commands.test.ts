import { describe, it, expect } from "vitest";
import { getActiveSlashCommand, replaceSlashCommand } from "../utils/slashCommands";

describe("getActiveSlashCommand", () => {
  it("returns null for empty text", () => {
    expect(getActiveSlashCommand("", 0)).toBeNull();
  });

  it("returns null when caret is before any /", () => {
    expect(getActiveSlashCommand("hello", 5)).toBeNull();
  });

  it("matches a bare / at the start", () => {
    expect(getActiveSlashCommand("/", 1)).toEqual({ start: 0, end: 1, query: "" });
  });

  it("matches /help at the start", () => {
    expect(getActiveSlashCommand("/help", 5)).toEqual({ start: 0, end: 5, query: "help" });
  });

  it("matches partial query while typing", () => {
    expect(getActiveSlashCommand("/com", 4)).toEqual({ start: 0, end: 4, query: "com" });
  });

  it("matches /clear when leading whitespace is present", () => {
    expect(getActiveSlashCommand("  /clear", 8)).toEqual({ start: 2, end: 8, query: "clear" });
  });

  it("rejects when non-whitespace precedes the /", () => {
    expect(getActiveSlashCommand("hi /clear", 9)).toBeNull();
  });

  it("rejects shell paths like /usr/bin", () => {
    expect(getActiveSlashCommand("/usr/bin", 8)).toBeNull();
  });

  it("rejects when whitespace is between / and caret", () => {
    expect(getActiveSlashCommand("/help me", 8)).toBeNull();
  });

  it("works on a fresh line in multi-line input", () => {
    const text = "first line\n/compact";
    expect(getActiveSlashCommand(text, text.length)).toEqual({
      start: 11,
      end: 19,
      query: "compact",
    });
  });

  it("rejects when previous-line content is on the current line via lack of newline", () => {
    expect(getActiveSlashCommand("first /clear", 12)).toBeNull();
  });

  it("only extends to caret, not past it", () => {
    // Caret in the middle of /helpme — should match /help
    expect(getActiveSlashCommand("/helpme", 5)).toEqual({ start: 0, end: 5, query: "help" });
  });

  it("matches /allowed-tools (commands with dashes)", () => {
    expect(getActiveSlashCommand("/allowed-tools", 14)).toEqual({
      start: 0,
      end: 14,
      query: "allowed-tools",
    });
  });
});

describe("replaceSlashCommand", () => {
  it("replaces the slash range with a command", () => {
    const text = "/com";
    const cmd = { start: 0, end: 4, query: "com" };
    expect(replaceSlashCommand(text, cmd, "/compact")).toEqual({
      text: "/compact",
      caret: 8,
    });
  });

  it("preserves text after the slash range", () => {
    const text = "/com extra";
    const cmd = { start: 0, end: 4, query: "com" };
    expect(replaceSlashCommand(text, cmd, "/compact")).toEqual({
      text: "/compact extra",
      caret: 8,
    });
  });

  it("works mid-line in multi-line input", () => {
    const text = "first\n/cl";
    const cmd = { start: 6, end: 9, query: "cl" };
    expect(replaceSlashCommand(text, cmd, "/clear")).toEqual({
      text: "first\n/clear",
      caret: 12,
    });
  });
});
