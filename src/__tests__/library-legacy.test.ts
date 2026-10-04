/**
 * Migration of Hermes 2.0 prompts: every built-in id (108 templates, 23
 * roles, 14 styles) resolves to something — a library entry when the
 * catalog carries it, else its read-only classic copy — the person's own
 * items always win, an unknown id is kept as missing (never dropped), and a
 * saved custom prompt shows up in My templates with its compiled text.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const settings: Record<string, string> = {};
vi.mock("../api/settings", () => ({
  getSetting: vi.fn(async (k: string) => settings[k] ?? ""),
  setSetting: vi.fn(async (k: string, v: string) => {
    settings[k] = v;
  }),
}));

const { filterLegacy, isUserId, loadClassics, loadMine, resolveIds, visibleClassics } = await import("../library/legacy");
const { BUILT_IN_ROLES, BUILT_IN_STYLES, BUILT_IN_TEMPLATES } = await import("../lib/compilePrompt");
const { resetMyPromptsCache } = await import("../library/myPrompts");

beforeEach(() => {
  for (const k of Object.keys(settings)) delete settings[k];
  resetMyPromptsCache();
});

describe("Hermes classics", () => {
  it("lists every 2.0 built-in, each with text to use", async () => {
    const classics = await loadClassics();
    expect(classics.filter((c) => c.source === "template")).toHaveLength(BUILT_IN_TEMPLATES.length);
    expect(classics.filter((c) => c.source === "role")).toHaveLength(BUILT_IN_ROLES.length);
    expect(classics.filter((c) => c.source === "style")).toHaveLength(BUILT_IN_STYLES.length);
    expect(classics.every((c) => c.text.trim().length > 0)).toBe(true);
    expect(new Set(classics.map((c) => c.key)).size).toBe(classics.length);
  });

  it("resolves every built-in id, preferring a library entry that carries it", async () => {
    const classics = await loadClassics();
    const ids = [...BUILT_IN_TEMPLATES.map((t) => t.id), ...BUILT_IN_ROLES.map((r) => r.id), ...BUILT_IN_STYLES.map((s) => s.id)];
    expect(ids.length).toBe(145);
    const library = { "security-auditor": "security-auditor", concise: "concise" };
    const r = resolveIds(ids, library, classics, []);
    expect(Object.values(r).every((x) => x.kind === "library" || x.kind === "classic")).toBe(true);
    expect(r["security-auditor"]).toEqual({ kind: "library", id: "security-auditor" });
    expect(r["debug-root-cause"].kind).toBe("classic");
    // A classic the library replaces is listed once, as the library entry.
    const shown = visibleClassics(classics, library);
    expect(shown.some((c) => c.id === "concise")).toBe(false);
    expect(shown.length).toBe(classics.length - classics.filter((c) => c.id in library).length);
  });

  it("keeps the person's items first and unknown ids as missing", async () => {
    const classics = await loadClassics();
    const r = resolveIds(["user-123", "custom-role-9", "nope-not-a-thing"], { "user-123": "something-else" }, classics, []);
    expect(r["user-123"]).toEqual({ kind: "user", id: "user-123" });
    expect(r["custom-role-9"].kind).toBe("user");
    expect(r["nope-not-a-thing"]).toEqual({ kind: "missing", id: "nope-not-a-thing" });
    expect(isUserId("user-x") && !isUserId("debug-root-cause")).toBe(true);
  });
});

describe("Mine (migrated from 2.0)", () => {
  it("shows a saved 2.0 prompt with its own role and style, compiled, and the role itself", async () => {
    settings.prompt_templates = JSON.stringify([
      {
        id: "user-1",
        name: "Ship checklist",
        category: "planning",
        fields: { task: "Check the release", constraints: "No new deps", roleIds: ["custom-role-1"] },
        recommendedRoles: [],
        recommendedStyles: [],
        builtIn: false,
      },
      { id: "user-old", name: "1.x template", category: "debugging", fields: { role: "Old role", task: "Old task" }, builtIn: false },
    ]);
    settings.custom_roles = JSON.stringify([{ id: "custom-role-1", label: "Release captain", systemInstruction: "You run releases.", builtIn: false }]);
    const mine = await loadMine();
    expect(mine.map((m) => m.title)).toEqual(["Ship checklist", "1.x template", "Release captain"]);
    expect(mine[2].source).toBe("role");
    expect(mine[0].text).toContain("Check the release");
    expect(mine[0].text).toContain("You run releases.");
    expect(mine[0].text).toContain("No new deps");
    expect(mine[1].text).toContain("Old role");
    expect(filterLegacy(mine, "ship")).toHaveLength(1);
    expect(filterLegacy(mine, "cat:planning")).toHaveLength(3);
  });

  it("survives a broken saved list without touching it", async () => {
    settings.prompt_templates = "{not json";
    expect(await loadMine()).toEqual([]);
    expect(settings.prompt_templates).toBe("{not json");
  });
});
