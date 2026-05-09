/**
 * `classifySlashCommand` — pins which CLI commands need an embedded
 * PTY vs which run as a normal stream-json prompt.
 *
 * Priority (in order):
 *   1. `<plugin>:<skill>` namespace → always native.
 *   2. Description with terminal hint ("opens terminal", etc) → cli.
 *   3. Description present + no CLI hint → native (trust the SDK).
 *   4. No description + name in KNOWN_CLI_COMMANDS → cli.
 *   5. Otherwise → native.
 *
 * The priority matters: an SDK-reported skill that happens to share
 * a name with a CLI built-in (e.g. `/init` is both a CLI command and
 * a Conductor skill) MUST classify as native when the SDK provides a
 * description — we trust the SDK's word.
 */
import { describe, it, expect } from "vitest";
import {
  classifySlashCommand,
  missingCliBuiltins,
  stripSlash,
} from "../utils/slashCommandKind";

describe("classifySlashCommand — known CLI built-ins (no description)", () => {
  it("interactive-only verbs without an SDK description fall through to cli", () => {
    for (const cmd of [
      "/mcp",
      "/mcp-status",
      "/agents",
      "/help",
      "/cost",
      "/login",
      "/logout",
      "/permissions",
      "/clear",
      "/compact",
      "/config",
      "/doctor",
      "/memory",
      "/model",
      "/recap",
      "/release-notes",
      "/status",
      "/terminal-setup",
      "/vim",
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

describe("classifySlashCommand — description trumps the KNOWN list", () => {
  it("a same-named SDK skill (with description, no CLI hint) → native", () => {
    // `/init` is BOTH a CLI built-in and an SDK-reported skill in
    // Conductor's catalog.  When the SDK reports it (i.e. provides
    // a description), we treat it as the skill — running it through
    // stream-json — not the interactive terminal.  This protects
    // user intent: they picked the skill from the popover.
    expect(
      classifySlashCommand({
        command: "/init",
        description: "Initialize a new CLAUDE.md file with codebase docs",
      }),
    ).toBe("native");

    expect(
      classifySlashCommand({
        command: "/recap",
        description: "Summarize the conversation in five bullets",
      }),
    ).toBe("native");
  });

  it("description with CLI hint still wins → cli", () => {
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

  it("description mentioning the word 'terminal' in passing does NOT flip", () => {
    expect(
      classifySlashCommand({
        command: "/explain-terminal",
        description: "Explain what a terminal command does without running it",
      }),
    ).toBe("native");
  });
});

describe("classifySlashCommand — namespaced (skill / plugin)", () => {
  it("/<plugin>:<skill> is always native", () => {
    expect(classifySlashCommand({ command: "/frontend-design:frontend-design" })).toBe("native");
    expect(classifySlashCommand({ command: "/telegram:configure" })).toBe("native");
    expect(classifySlashCommand({ command: "/hermes-test:ping" })).toBe("native");
  });

  it("plugin-namespaced names that look like CLI commands are STILL native", () => {
    expect(classifySlashCommand({ command: "/myplugin:mcp" })).toBe("native");
    expect(classifySlashCommand({ command: "/myplugin:help" })).toBe("native");
  });
});

describe("classifySlashCommand — user / custom commands", () => {
  it("custom commands NOT on the curated list default to native", () => {
    expect(classifySlashCommand({ command: "/ship" })).toBe("native");
    expect(classifySlashCommand({ command: "/hermes-ping" })).toBe("native");
    expect(classifySlashCommand({ command: "/team-standup" })).toBe("native");
  });
});

describe("missingCliBuiltins — curated-mirror merge", () => {
  it("returns the well-known Claude Code CLI built-ins when none are in the existing list", () => {
    const got = missingCliBuiltins([]);
    const names = got.map((b) => b.command);
    // Spot-check several names across the catalog.
    expect(names).toContain("/mcp");
    expect(names).toContain("/mcp-status");
    expect(names).toContain("/agents");
    expect(names).toContain("/help");
    expect(names).toContain("/cost");
    expect(names).toContain("/login");
    expect(names).toContain("/logout");
    expect(names).toContain("/permissions");
    expect(names).toContain("/plan");
    expect(names).toContain("/plugin");
    expect(names).toContain("/clear");
    expect(names).toContain("/compact");
    expect(names).toContain("/diff");
    expect(names).toContain("/doctor");
    expect(names).toContain("/memory");
    expect(names).toContain("/model");
    expect(names).toContain("/theme");
  });

  it("catalog has at least 60 entries", () => {
    expect(missingCliBuiltins([]).length).toBeGreaterThanOrEqual(60);
  });

  it("dedupes against the SDK-reported list (case-insensitive)", () => {
    const got = missingCliBuiltins([
      { command: "/mcp" },
      { command: "/Help" },
      { command: "/AGENTS" },
    ]);
    const names = got.map((b) => b.command);
    expect(names).not.toContain("/mcp");
    expect(names).not.toContain("/help");
    expect(names).not.toContain("/agents");
    // But still includes the rest.
    expect(names).toContain("/login");
    expect(names).toContain("/cost");
  });

  it("every catalog entry classifies as `cli` when used without a description", () => {
    for (const b of missingCliBuiltins([])) {
      expect(classifySlashCommand({ command: b.command })).toBe("cli");
    }
  });

  it("descriptions are short enough for the dropdown row (≤60 chars)", () => {
    for (const b of missingCliBuiltins([])) {
      expect(b.description.length).toBeLessThanOrEqual(60);
    }
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
