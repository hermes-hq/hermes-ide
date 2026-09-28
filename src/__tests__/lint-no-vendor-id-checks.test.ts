import { describe, expect, it } from "vitest";
import { ESLint } from "eslint";
import { fileURLToPath } from "node:url";
import allowlist from "../../eslint-rules/vendor-id-checks.allowlist.json";
import catalog from "../catalog/agents.json";

// F19: only src/agent/providers may branch on an agent's id. Runs the
// repository's real ESLint config against snippets, so this proves what
// `npx eslint .` does in CI.

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const RULE = "hermes-vendor/no-vendor-id-checks";

// The allowlist may only shrink. Lower this when you remove entries; never raise it.
const ALLOWLIST_CEILING = 4;

async function lint(code: string, filePath: string, eslint = new ESLint({ cwd: REPO_ROOT })) {
  const [result] = await eslint.lintText(code, { filePath });
  return result.messages.filter((m) => m.ruleId === RULE);
}

describe("no-vendor-id-checks lint rule", () => {
  it.each([
    ['export const f = (p: string) => p === "claude";', "=== with a vendor id"],
    ['export const f = (p: string) => "codex" !== p;', "!== with the id on the left"],
    ['export function f(p: string) { switch (p) { case "gemini": return 1; default: return 0; } }', "switch case"],
    ['export const f = (ids: string[]) => ids.includes("aider");', "includes"],
    ['export const f = (s: Set<string>) => s.has("goose");', "Set.has"],
    ['export const f = (m: string) => m.startsWith("copilot");', "startsWith"],
    ["export const f = (p: string) => p === `opencode`;", "template literal"],
  ])("flags %#: %s", async (code, _label) => {
    const messages = await lint(code, "src/components/InboxBadge.tsx");
    expect(messages).toHaveLength(1);
    expect(messages[0].severity).toBe(2);
    expect(messages[0].message).toContain("outside src/agent/providers");
  });

  it("covers every agent in the catalog except the Custom entry", async () => {
    for (const { id } of catalog.agents) {
      const messages = await lint(`export const f = (p: string) => p === ${JSON.stringify(id)};`, "src/components/StatusStrip.tsx");
      expect(messages.length, id).toBe(id === "custom" ? 0 : 1);
    }
  });

  it("allows the same code inside src/agent/providers", async () => {
    expect(await lint('export const f = (p: string) => p === "claude";', "src/agent/providers/claude.ts")).toEqual([]);
  });

  it("allows tests, and strings that are not comparisons", async () => {
    expect(await lint('export const f = (p: string) => p === "claude";', "src/__tests__/x.test.ts")).toEqual([]);
    expect(await lint('export const label = "claude"; export const other = (p: string) => p === "shell";', "src/components/A.tsx")).toEqual([]);
  });

  it("the status, inbox and event contract code is vendor-free", async () => {
    const eslint = new ESLint({ cwd: REPO_ROOT });
    const results = await eslint.lintFiles([
      "src/agent/status/",
      "src/agent/contract/",
      "src/components/AgentStatusTag.tsx",
      "src/components/StatusBar.tsx",
      "src/components/SessionList.tsx",
    ]);
    const hits = results.flatMap((r) => r.messages.filter((m) => m.ruleId === RULE).map((m) => `${r.filePath}:${m.line}`));
    expect(hits).toEqual([]);
  }, 60_000);
});

describe("vendor-id allowlist", () => {
  it("only shrinks", () => {
    expect(allowlist.files.length).toBeLessThanOrEqual(ALLOWLIST_CEILING);
    expect(new Set(allowlist.files).size).toBe(allowlist.files.length);
  });

  it("has no stale entries: every listed file still exists and still checks an agent id", async () => {
    const vendorIds = catalog.agents.map((a) => a.id).filter((id) => id !== "custom");
    const strict = new ESLint({
      cwd: REPO_ROOT,
      overrideConfig: { rules: { [RULE]: ["error", { vendorIds, allowlist: [] }] } },
    });
    const results = await strict.lintFiles(allowlist.files);
    const stale = results.filter((r) => !r.messages.some((m) => m.ruleId === RULE)).map((r) => r.filePath);
    expect(results).toHaveLength(allowlist.files.length);
    expect(stale, "these files no longer check an agent id — remove them from the allowlist").toEqual([]);
  }, 60_000);
});
