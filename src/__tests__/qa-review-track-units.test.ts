/**
 * The pure rules behind the Review Desk / Feature Track fixes:
 *   - the Track writer is an agent, never a plain shell (PLN-07);
 *   - skipped phases are read from feature.md (PLN-14);
 *   - review comments find their line again after the next turn (PLN-19);
 *   - the diff parser adds no phantom last line (PLN-26);
 *   - risk flags for the checks and the agent's own config (PLN-22);
 *   - count-bearing strings pick the plural form (PLN-18).
 */
import { describe, expect, it } from "vitest";
import { attachedSessions, isAgentSession, skippedPhases } from "../track/rules";
import { anchorContext, relocateComment, type AnchorLine } from "../review/reviewModel";
import { parsePatch } from "../review/patch";
import { riskFlagsFor } from "../review/riskFlags";
import { translatePlural } from "../i18n/plural";

describe("the Track writer is an agent", () => {
  const at = (id: string, created: string, extra: Record<string, unknown> = {}) => ({ id, working_directory: "/repo", created_at: created, ...extra });

  it("puts an agent session before an older plain shell, with or without turn history", () => {
    const shell = at("shell", "2026-01-01T10:00:00Z", { ai_provider: null });
    const agent = at("agent", "2026-01-01T10:05:00Z", { ai_provider: "claude" });
    expect(attachedSessions([shell, agent], "/repo").map((s) => s.id)).toEqual(["agent", "shell"]);
    const detected = at("detected", "2026-01-01T10:06:00Z", { detected_agent: { name: "Codex" } });
    expect(attachedSessions([shell, detected], "/repo").map((s) => s.id)).toEqual(["detected", "shell"]);
    // A turn history still wins over a launch-time agent.
    const has = (id: string) => id === "detected";
    expect(attachedSessions([agent, detected], "/repo", has).map((s) => s.id)).toEqual(["detected", "agent"]);
  });

  it("knows a plain shell is no agent", () => {
    expect(isAgentSession(at("s", "x"))).toBe(false);
    expect(isAgentSession(at("s", "x", { ai_provider: "codex" }))).toBe(true);
    expect(isAgentSession(at("s", "x"), () => true)).toBe(true);
  });
});

describe("skippedPhases", () => {
  it("reads the inline list hermes-track writes, with when", () => {
    const text = "---\nslug: a\ntrack: Full\nphase: design\ngate: none\nskipped: [questions (2026-10-01 14:05 UTC), research (2026-10-01 14:06 UTC)]\n---\nbody\n";
    expect(skippedPhases(text)).toEqual([
      { phase: "questions", when: "2026-10-01 14:05 UTC" },
      { phase: "research", when: "2026-10-01 14:06 UTC" },
    ]);
  });

  it("reads a block list, ignores unknown phases and text outside the front matter", () => {
    expect(skippedPhases("---\nslug: a\nskipped:\n  - plan\n  - later\n---\nskipped: [design]\n")).toEqual([{ phase: "plan", when: null }]);
    expect(skippedPhases("---\nslug: a\n---\n")).toEqual([]);
    expect(skippedPhases("no front matter")).toEqual([]);
  });
});

describe("review comments are anchored by text and context", () => {
  const lines = (texts: string[], side: "new" | "old" = "new"): AnchorLine[] => texts.map((text, i) => ({ side, no: i + 1, text }));

  it("follows its line when the next turn inserts lines above it", () => {
    const turn1 = lines(["export function add(a, b) {", "  return a + b;", "}"]);
    const ctx = anchorContext(turn1, 1);
    expect(ctx).toEqual({ before: ["export function add(a, b) {"], after: ["}"] });
    const comment = { side: "new" as const, line: 2, excerpt: "  return a + b;", ...ctx };
    const turn2 = lines(["/** Adds. */", "export function add(a, b) {", "  return a + b;", "}"]);
    expect(relocateComment(comment, turn2)).toBe(3);
  });

  it("picks the occurrence whose surroundings match, and is outdated when the line is gone", () => {
    const file = lines(["a {", "  return x;", "}", "b {", "  return x;", "}"]);
    const comment = { side: "new" as const, line: 2, excerpt: "  return x;", before: ["b {"], after: ["}"] };
    expect(relocateComment(comment, file)).toBe(5);
    expect(relocateComment({ ...comment, excerpt: "  return y;" }, file)).toBeNull();
    // Same text, no context: the nearest to where it was.
    expect(relocateComment({ side: "new", line: 4, excerpt: "  return x;" }, file)).toBe(5);
    // A deleted line is found on its own side only.
    expect(relocateComment({ side: "old", line: 1, excerpt: "a {" }, file)).toBeNull();
  });
});

describe("parsePatch adds no phantom line", () => {
  it("ends a new file and an edited file at their last real line", () => {
    const patch = [
      "diff --git a/notes.md b/notes.md",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/notes.md",
      "@@ -0,0 +1,3 @@",
      "+one",
      "+two",
      "+three",
      "diff --git a/math.js b/math.js",
      "--- a/math.js",
      "+++ b/math.js",
      "@@ -1 +1,2 @@",
      "+export const add = (a, b) => a + b;",
      " export const sub = (a, b) => a - b;",
      "",
    ].join("\n");
    const [notes, math] = parsePatch(patch);
    const last = (f: typeof notes) => f.hunks[f.hunks.length - 1].lines.at(-1);
    expect(notes.hunks[0].lines.map((l) => l.newNo)).toEqual([1, 2, 3]);
    expect(last(math)).toEqual({ kind: "context", oldNo: 1, newNo: 2, text: "export const sub = (a, b) => a - b;" });
  });

  it("still reads an empty context line whose space was stripped", () => {
    const [f] = parsePatch(["diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -1,3 +1,3 @@", " a", "", "-b", "+c", ""].join("\n"));
    expect(f.hunks[0].lines.map((l) => [l.kind, l.oldNo, l.newNo])).toEqual([
      ["context", 1, 1],
      ["context", 2, 2],
      ["del", 3, null],
      ["add", null, 3],
    ]);
  });
});

describe("risk flags for the checks and the agent's own config", () => {
  const diff = (path: string, body: string[]) => parsePatch([`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, ...body, ""].join("\n"))[0];

  it("flags emptied done_when in worktree.toml with how many commands went", () => {
    const f = diff(".hermes/worktree.toml", ["@@ -1 +1 @@", '-done_when = ["npm test"]', "+done_when = []"]);
    expect(riskFlagsFor(f)).toEqual([{ kind: "checks_changed", label: "checks changed", detail: "done_when went from 1 command to 0 commands in .hermes/worktree.toml" }]);
    const setup = diff(".hermes/worktree.toml", ["@@ -1 +1 @@", '-setup = ["npm ci"]', '+setup = ["npm i"]']);
    expect(riskFlagsFor(setup).map((x) => x.kind)).toEqual(["agent_config"]);
  });

  it("flags done_when edits in a feature.md, not other edits of it", () => {
    const dropped = diff(".hermes/features/a/feature.md", ["@@ -3,4 +3,2 @@", " gate: none", "-done_when:", "-  - npm test", "+done_when: []", " ---"]);
    expect(riskFlagsFor(dropped)[0]).toMatchObject({ kind: "checks_changed", detail: "done_when went from 1 command to 0 commands in .hermes/features/a/feature.md" });
    const body = diff(".hermes/features/a/feature.md", ["@@ -8,1 +8,1 @@", "-old text", "+new text"]);
    expect(riskFlagsFor(body)).toEqual([]);
    // A new feature.md only adds checks.
    const created = parsePatch(["diff --git a/.hermes/features/a/feature.md b/.hermes/features/a/feature.md", "new file mode 100644", "--- /dev/null", "+++ b/.hermes/features/a/feature.md", "@@ -0,0 +1,3 @@", "+---", "+done_when: []", "+---", ""].join("\n"))[0];
    expect(riskFlagsFor(created)).toEqual([]);
  });

  it("flags the files that steer an agent", () => {
    for (const p of [".claude/settings.json", ".mcp.json", ".codex/config.toml", "AGENTS.md", "CLAUDE.md", "docs/CLAUDE.md", ".agents/hooks.json"]) {
      const f = diff(p, ["@@ -0,0 +1 @@", "+x"]);
      expect(riskFlagsFor(f).map((x) => x.kind), p).toContain("agent_config");
    }
    expect(riskFlagsFor(diff("src/claude.ts", ["@@ -0,0 +1 @@", "+x"])).map((x) => x.kind)).not.toContain("agent_config");
  });
});

describe("translatePlural", () => {
  it("says 1 file and 2 files", () => {
    expect(translatePlural("review.fileCount", 1, {}, "en")).toBe("1 file");
    expect(translatePlural("review.fileCount", 2, {}, "en")).toBe("2 files");
    expect(translatePlural("review.commentsToSend", 1, { agent: "Claude Code" }, "en")).toBe("1 comment to send to Claude Code");
  });
});
