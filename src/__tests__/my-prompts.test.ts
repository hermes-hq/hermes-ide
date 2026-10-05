/**
 * Mine (src/library/myPrompts.ts): the person's 2.0 templates, roles and
 * styles move into one list on the first read and nothing is lost; the old
 * settings keys are never written; a template an older build saves later
 * still arrives; one the person deleted from Mine stays deleted; files keep
 * the 2.0 bundle format both ways.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const settings: Record<string, string> = {};
const writes: string[] = [];
vi.mock("../api/settings", () => ({
  getSetting: vi.fn(async (k: string) => settings[k] ?? ""),
  setSetting: vi.fn(async (k: string, v: string) => {
    writes.push(k);
    settings[k] = v;
  }),
}));
// The library cannot be read here: built-in ids fall back to their 2.0 text.
vi.mock("../library/api", () => ({
  libraryResolve: vi.fn(async () => {
    throw new Error("library offline");
  }),
  libraryGet: vi.fn(async () => {
    throw new Error("library offline");
  }),
  librarySearch: vi.fn(),
  librarySetItem: vi.fn(),
}));

const m = await import("../library/myPrompts");

const TEMPLATES = [
  {
    id: "user-1",
    name: "Ship checklist",
    category: "planning",
    group: "Release",
    fields: { task: "Check the release {{version}}", scope: "", constraints: "No new deps", roleIds: ["custom-role-1"], styleSelections: [{ id: "concise", level: 3 }], style: "" },
    recommendedRoles: [],
    recommendedStyles: [],
    builtIn: false,
  },
  { id: "user-2", name: "Old one", category: "debugging", fields: { role: "Old role", task: "Old task" }, builtIn: false },
];

beforeEach(() => {
  for (const k of Object.keys(settings)) delete settings[k];
  writes.length = 0;
  m.resetMyPromptsCache();
});

describe("migration from 2.0", () => {
  it("moves templates, roles and styles into Mine with the text 2.0 sent, folders and pins kept", async () => {
    settings.prompt_templates = JSON.stringify(TEMPLATES);
    settings.custom_roles = JSON.stringify([{ id: "custom-role-1", label: "Release captain", systemInstruction: "You run releases.", builtIn: false }]);
    settings.custom_styles = JSON.stringify([{ id: "custom-style-1", label: "Pirate", levels: ["a", "b", "c", "d", "e"], builtIn: false }]);
    settings.pinned_templates = JSON.stringify(["user-1"]);
    const list = await m.loadMyPrompts();
    expect(list.map((x) => [x.id, x.kind, x.title])).toEqual([
      ["user-1", "prompt", "Ship checklist"],
      ["user-2", "prompt", "Old one"],
      ["custom-role-1", "persona", "Release captain"],
      ["custom-style-1", "style", "Pirate"],
    ]);
    const ship = list[0];
    expect(ship.text).toContain("You run releases.");
    expect(ship.text).toContain("Check the release");
    expect(ship.text).toContain("No new deps");
    // The built-in "concise" style is not readable from the library here: its 2.0 text stands in.
    expect(ship.text).toMatch(/\*\*Style:\*\* \S/);
    expect(ship.folder).toBe("Release");
    expect(ship.args).toEqual([{ name: "version", description: "", type: "text", required: true }]);
    expect(list[1].args).toBeUndefined();
    expect(ship.pinned).toBe(true);
    expect(list[1].text).toContain("Old role");
    expect(list[3].levels).toEqual(["a", "b", "c", "d", "e"]);
    expect(m.takeMigrationNotice()).toEqual({ prompts: 2, personas: 1, styles: 1 });
    expect(m.takeMigrationNotice()).toBeNull();
  });

  it("never writes the 2.0 keys", async () => {
    settings.prompt_templates = JSON.stringify(TEMPLATES);
    const before = settings.prompt_templates;
    await m.loadMyPrompts();
    await m.saveMyPrompt({ kind: "prompt", title: "New", description: "", text: "x" });
    expect(settings.prompt_templates).toBe(before);
    expect(writes.filter((k) => !k.startsWith("my_prompts"))).toEqual([]);
  });

  it("merges a template an older build saved later, and keeps a deleted one deleted", async () => {
    settings.prompt_templates = JSON.stringify([TEMPLATES[0]]);
    await m.loadMyPrompts();
    await m.deleteMyPrompt("user-1");
    // An older Hermes adds a template to the 2.0 list.
    settings.prompt_templates = JSON.stringify([TEMPLATES[0], TEMPLATES[1]]);
    m.resetMyPromptsCache();
    const list = await m.loadMyPrompts();
    expect(list.map((x) => x.id)).toEqual(["user-2"]);
  });

  it("does nothing for someone with no 2.0 data", async () => {
    expect(await m.loadMyPrompts()).toEqual([]);
    expect(writes).toEqual([]);
  });

  it("survives a broken 2.0 list without touching it", async () => {
    settings.prompt_templates = "{not json";
    expect(await m.loadMyPrompts()).toEqual([]);
    expect(settings.prompt_templates).toBe("{not json");
  });

  it("keeps only well-formed items from a hand-edited list", () => {
    expect(m.cleanList([null, { id: 1 }, { id: "a", title: "A", text: "t", kind: "weird", args: [{ name: "x" }, { nope: 1 }] }])).toEqual([
      { id: "a", kind: "prompt", title: "A", description: "", text: "t", args: [{ name: "x", description: "" }], createdAt: 0, updatedAt: 0, lastUsedAt: null, useCount: 0 },
    ]);
  });
});

describe("changes", () => {
  it("saves, updates, pins, records use and tells listeners", async () => {
    const seen: number[] = [];
    m.onMyPromptsChange((list) => seen.push(list.length));
    const a = await m.saveMyPrompt({ kind: "prompt", title: "A", description: "", text: "Fix {{bug}}", args: [{ name: "bug", description: "", required: true }] });
    expect(a.id).toMatch(/^mine-/);
    await m.saveMyPrompt({ ...a, title: "A2" });
    await m.setMyPinned(a.id, true);
    await m.recordMyUse(a.id, 42);
    const [only] = await m.loadMyPrompts();
    expect(only).toMatchObject({ id: a.id, title: "A2", pinned: true, lastUsedAt: 42, useCount: 1, args: [{ name: "bug" }] });
    expect(seen).toEqual([1, 1, 1, 1]);
    expect(JSON.parse(settings.my_prompts)).toHaveLength(1);
  });
});

describe("files", () => {
  it("exports Mine as a 2.0 bundle and reads it back without duplicates", async () => {
    const list: import("../library/myPrompts").MyPrompt[] = [
      { id: "mine-1", kind: "prompt", title: "Release notes", description: "Ours", text: "Write notes for {{version}}", folder: "Writing", createdAt: 1, updatedAt: 1 },
      { id: "mine-2", kind: "persona", title: "Staff engineer", description: "", text: "You are the staff engineer.", createdAt: 1, updatedAt: 1 },
      { id: "mine-3", kind: "style", title: "Pirate", description: "", text: "c", levels: ["a", "b", "c"], createdAt: 1, updatedAt: 1 },
    ];
    const bundle = m.toBundle(list, "2.1.0");
    expect(bundle._hermes_bundle_version).toBe(1);
    expect(bundle.templates[0]).toMatchObject({ name: "Release notes", group: "Writing", fields: { task: "Write notes for {{version}}" } });
    expect(bundle.roles[0]).toMatchObject({ label: "Staff engineer", systemInstruction: "You are the staff engineer." });
    expect(bundle.styles[0].levels).toEqual(["a", "b", "c", "c", "c"]);

    const back = m.fromBundle(bundle, [list[1]], (tpl) => tpl.fields.task, "Imported", 7);
    expect(back.skipped).toBe(1);
    expect(back.added.map((x) => [x.kind, x.title, x.folder ?? null])).toEqual([
      ["prompt", "Release notes", "Writing"],
      ["style", "Pirate", null],
    ]);
    expect(back.added[0].text).toBe("Write notes for {{version}}");
  });
});
