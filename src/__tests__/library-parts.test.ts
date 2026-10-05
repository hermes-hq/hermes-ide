/**
 * The 2.0 built-ins are library entries now: a saved built-in role or style
 * id resolves through the catalog's aliases to its library persona or style;
 * only an id the catalog has no entry for keeps its 2.0 text, logged once.
 * A 2.0 pin on a built-in template becomes a pin on its library entry, once,
 * without rewriting the saved pins.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  settings: {} as Record<string, string>,
  aliases: {} as Record<string, string>,
  pinned: [] as string[],
  bodies: {} as Record<string, { kind: string; title: string; desc: string; body: string; levels?: { label: string; instruction: string }[] }>,
  pages: [] as { hits: { id: string; title: string; description: string }[]; nextCursor: string | null }[],
}));

vi.mock("../api/settings", () => ({
  getSetting: vi.fn(async (k: string) => h.settings[k] ?? ""),
  setSetting: vi.fn(async (k: string, v: string) => {
    h.settings[k] = v;
  }),
}));

vi.mock("../library/api", () => ({
  libraryResolve: vi.fn(async (ids: string[]) => Object.fromEntries(ids.filter((id) => h.aliases[id]).map((id) => [id, h.aliases[id]]))),
  librarySetItem: vi.fn(async (id: string) => {
    h.pinned.push(id);
  }),
  librarySearch: vi.fn(async (req: { cursor?: string | null }) => h.pages[Number(req.cursor ?? 0)]),
  libraryGet: vi.fn(async (id: string) => {
    const b = h.bodies[id];
    return {
      id,
      resolvedFrom: null,
      row: { id, v: "1.0.0", kind: b.kind, title: b.title, desc: b.desc },
      body: { schema: 1, fm: { id, kind: b.kind, title: b.title, version: "1.0.0", levels: b.levels }, body: b.body, steps: [] },
    };
  }),
}));

vi.mock("../library/render", () => ({ render: vi.fn(async (body: { body: string }) => body.body) }));

const { carryLegacyPins, definitionsFor, listParts, resolvePartIds } = await import("../library/parts");
const { loadMine, resetMissingAliasLog } = await import("../library/legacy");

const LEVELS = ["one", "two", "three", "four", "five"].map((w) => ({ label: w, instruction: `Be ${w}.` }));

beforeEach(() => {
  for (const k of Object.keys(h.settings)) delete h.settings[k];
  h.aliases = {
    "backend-eng": "backend-engineer",
    detailed: "thorough",
    "debug-root-cause": "find-root-cause",
    "backend-engineer": "backend-engineer",
  };
  h.pinned = [];
  h.bodies = {
    "backend-engineer": { kind: "persona", title: "Backend engineer", desc: "Builds servers.", body: "You are a backend engineer." },
    thorough: { kind: "style", title: "Thorough", desc: "More depth.", body: "", levels: LEVELS },
  };
  resetMissingAliasLog();
});
afterEach(() => {
  warnSpy?.mockRestore();
  warnSpy = null;
});

let warnSpy: ReturnType<typeof vi.spyOn> | null = null;
const quiet = () => (warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {}));

describe("saved built-in ids", () => {
  it("never asks the library about the person's own ids", async () => {
    const r = await resolvePartIds(["user-1", "custom-role-2", "custom-style-3", "backend-eng"]);
    expect(r).toEqual({ "backend-eng": "backend-engineer" });
  });

  it("resolve to the library entry, keyed by the id as saved", async () => {
    const { roles, styles } = await definitionsFor(["backend-eng"], ["detailed"]);
    expect(roles).toEqual([{ id: "backend-eng", label: "Backend engineer", description: "Builds servers.", systemInstruction: "You are a backend engineer.", builtIn: true }]);
    expect(styles[0].id).toBe("detailed");
    expect(styles[0].label).toBe("Thorough");
    expect(styles[0].levels).toEqual(["Be one.", "Be two.", "Be three.", "Be four.", "Be five."]);
  });

  it("fall back to the 2.0 text only when the catalog has no entry, logged once per id", async () => {
    delete h.aliases["backend-eng"];
    const warn = quiet();
    const first = await definitionsFor(["backend-eng"], []);
    await definitionsFor(["backend-eng"], []);
    expect(first.roles[0].label).toBe("Senior Backend Engineer");
    expect(first.roles[0].systemInstruction).toMatch(/senior backend engineer/i);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('"backend-eng"'))).toHaveLength(1);
  });

  it("compile a saved template's built-in role through its library persona in My templates", async () => {
    h.settings.prompt_templates = JSON.stringify([
      { id: "user-1", name: "Ship it", category: "planning", fields: { task: "Release v2" }, recommendedRoles: ["backend-eng"], recommendedStyles: [{ id: "detailed", level: 3 }], builtIn: false },
    ]);
    const [mine] = await loadMine();
    expect(mine.text).toContain("Release v2");
    expect(mine.text).toContain("You are a backend engineer.");
    expect(mine.text).toContain("Be three.");
  });
});

describe("the library's personas and styles", () => {
  it("are every page of the kind, sorted by title", async () => {
    h.pages = [
      { hits: [{ id: "z", title: "Zed", description: "" }], nextCursor: "1" },
      { hits: [{ id: "a", title: "Alpha", description: "" }], nextCursor: null },
    ];
    expect((await listParts("persona")).map((p) => p.id)).toEqual(["a", "z"]);
  });
});

describe("2.0 pins on built-in templates", () => {
  it("become library pins once, and the saved pins are not rewritten", async () => {
    const saved = JSON.stringify(["debug-root-cause", "user-ship", "explain"]);
    h.settings.pinned_templates = saved;
    quiet();
    const missing = await carryLegacyPins();
    expect(h.pinned).toEqual(["find-root-cause"]);
    expect(missing).toEqual(["explain"]);
    expect(h.settings.pinned_templates).toBe(saved);
    expect(JSON.parse(h.settings.pinned_templates_library)).toEqual(["debug-root-cause"]);
    await carryLegacyPins();
    expect(h.pinned).toEqual(["find-root-cause"]);
  });
});
