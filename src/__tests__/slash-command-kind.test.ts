/**
 * `classifySlashCommand` — pins which CLI commands need an embedded
 * PTY vs which run as a normal stream-json prompt.  This is the
 * routing decision the composer makes when the user accepts a
 * slash-command popover entry.
 */
import { describe, it, expect } from "vitest";
import { classifySlashCommand, stripSlash } from "../utils/slashCommandKind";

describe("classifySlashCommand — known CLI built-ins", () => {
  it("/mcp, /agents, /help, /cost, /init etc. are CLI-only", () => {
    for (const cmd of [
      "/mcp",
      "/agents",
      "/help",
      "/cost",
      "/init",
      "/login",
      "/logout",
      "/permissions",
      "/output-style",
      "/clear",
      "/compact",
      "/config",
      "/doctor",
      "/memory",
      "/model",
      "/pr-comments",
      "/release-notes",
      "/review",
      "/settings",
      "/status",
      "/terminal-setup",
      "/vim",
      "/mcp-status",
    ]) {
      expect(classifySlashCommand({ command: cmd })).toBe("cli");
    }
  });

  it("classifies regardless of leading slash + case", () => {
    expect(classifySlashCommand({ command: "MCP" })).toBe("cli");
    expect(classifySlashCommand({ command: "/Help" })).toBe("cli");
    expect(classifySlashCommand({ command: "/AGENTS" })).toBe("cli");
  });
});

describe("classifySlashCommand — namespaced (skill / plugin)", () => {
  it("/<plugin>:<skill> is always native — runs through stream-json", () => {
    expect(classifySlashCommand({ command: "/frontend-design:frontend-design" })).toBe("native");
    expect(classifySlashCommand({ command: "/telegram:configure" })).toBe("native");
    expect(classifySlashCommand({ command: "/hermes-test:ping" })).toBe("native");
  });

  it("plugin-namespaced names that look like CLI commands are STILL native", () => {
    // /someplugin:mcp is a skill that happens to be named `mcp` —
    // not the actual built-in.  Must NOT be misclassified.
    expect(classifySlashCommand({ command: "/myplugin:mcp" })).toBe("native");
    expect(classifySlashCommand({ command: "/myplugin:help" })).toBe("native");
  });
});

describe("classifySlashCommand — user / project commands", () => {
  it("custom commands from .claude/commands/*.md default to native", () => {
    expect(classifySlashCommand({ command: "/recap" })).toBe("native");
    expect(classifySlashCommand({ command: "/ship" })).toBe("native");
    expect(classifySlashCommand({ command: "/hermes-ping" })).toBe("native");
  });

  it("custom command whose description hints at terminal → cli", () => {
    expect(
      classifySlashCommand({
        command: "/my-tui",
        description: "Drop into an interactive picker (opens terminal)",
      }),
    ).toBe("cli");

    expect(
      classifySlashCommand({
        command: "/my-tool",
        description: "Run an interactive CLI for setup",
      }),
    ).toBe("cli");
  });

  it("description mentioning the word 'terminal' in passing does NOT flip classification", () => {
    expect(
      classifySlashCommand({
        command: "/explain-terminal",
        description: "Explain what a terminal command does without running it",
      }),
    ).toBe("native");
  });
});

describe("stripSlash", () => {
  it("removes a leading slash", () => {
    expect(stripSlash("/mcp")).toBe("mcp");
    expect(stripSlash("/foo:bar")).toBe("foo:bar");
  });
  it("leaves bare names alone", () => {
    expect(stripSlash("mcp")).toBe("mcp");
  });
  it("only strips ONE leading slash (defensive)", () => {
    expect(stripSlash("//mcp")).toBe("/mcp");
  });
});
