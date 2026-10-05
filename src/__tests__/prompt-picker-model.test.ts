/**
 * The Prompts palette's rules (src/library/promptPicker.ts): what the list
 * shows and in what order, how the keyboard moves, how much of a 10,000-row
 * list is in the DOM, how a prompt reads (never as raw template tags), and
 * when a paste needs a typed lead line.
 */
import { describe, expect, it } from "vitest";
import {
  BLANK_CLOSE,
  BLANK_OPEN,
  FILL_CLOSE,
  FILL_OPEN,
  buildItems,
  composeText,
  editableText,
  filtersFor,
  kindsFor,
  layoutItems,
  markedValues,
  moveSelection,
  needsLeadLine,
  pickables,
  prefillTarget,
  readableSections,
  savedArgs,
  unmark,
  visibleRange,
  type BuildInput,
  type PickerItem,
} from "../library/promptPicker";
import type { LibraryHit } from "../library/types";
import type { MyPrompt } from "../library/myPrompts";

const hit = (id: string, kind: LibraryHit["kind"] = "prompt", over: Partial<LibraryHit> = {}): LibraryHit => ({
  id,
  version: "1.0.0",
  kind,
  title: id.replace(/-/g, " "),
  description: `About ${id}`,
  domain: "software-engineering",
  domainLabel: "Software engineering",
  category: "testing",
  categoryLabel: "Testing",
  status: "incubating",
  tier: "curated",
  works: ["claude-code"],
  stack: [],
  stage: [],
  score: 1,
  reasons: [],
  isNew: false,
  rank: 1,
  ...over,
});

const mine = (id: string, over: Partial<MyPrompt> = {}): MyPrompt => ({
  id,
  kind: "prompt",
  title: id.replace(/-/g, " "),
  description: "",
  text: `Text of ${id}`,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

const base = (over: Partial<BuildInput> = {}): BuildInput => ({
  query: "",
  filter: "all",
  context: "session",
  mine: [],
  pinnedHits: [],
  recent: [],
  hits: [],
  personal: true,
  ...over,
});

const shape = (items: PickerItem[]) => items.map((i) => (i.type === "group" ? `#${i.group}` : i.key));

describe("the list", () => {
  it("with no query: Pinned, then Recent, then For you, and nothing twice", () => {
    const items = buildItems(
      base({
        mine: [mine("root-cause", { pinned: true }), mine("release-notes", { lastUsedAt: 50 })],
        pinnedHits: [hit("bugfix-track", "workflow")],
        recent: [{ hit: hit("add-regression-test"), at: 100 }, { hit: hit("bugfix-track", "workflow"), at: 90 }, { mine: mine("release-notes", { lastUsedAt: 50 }), at: 50 }],
        hits: [hit("add-regression-test"), hit("find-root-cause"), hit("concise", "style")],
      }),
    );
    expect(shape(items)).toEqual([
      "#pinned",
      "mine:root-cause",
      "lib:bugfix-track",
      "#recent",
      "lib:add-regression-test",
      "mine:release-notes",
      "#forYou",
      "lib:find-root-cause",
      "lib:concise",
    ]);
  });

  it("with a query: your own matches first, then the library's", () => {
    const items = buildItems(base({ query: "root", mine: [mine("root-cause"), mine("unrelated")], hits: [hit("find-root-cause")] }));
    expect(shape(items)).toEqual(["#mine", "mine:root-cause", "#library", "lib:find-root-cause"]);
  });

  it("matches pinned and recent rows against the query in their own filters", () => {
    const input = base({ query: "bugfix", pinnedHits: [hit("bugfix-track", "workflow"), hit("release-track", "workflow")], recent: [{ hit: hit("release-track", "workflow"), at: 1 }] });
    expect(shape(buildItems({ ...input, filter: "pinned" }))).toEqual(["#pinned", "lib:bugfix-track"]);
    expect(shape(buildItems({ ...input, filter: "recent" }))).toEqual([]);
  });

  it("Mine, Pinned and Recent show only themselves", () => {
    const input = base({
      mine: [mine("a", { pinned: true }), mine("b")],
      pinnedHits: [hit("p1")],
      recent: [{ hit: hit("r1"), at: 2 }],
      hits: [hit("x")],
    });
    expect(shape(buildItems({ ...input, filter: "mine" }))).toEqual(["#mine", "mine:a", "mine:b"]);
    expect(shape(buildItems({ ...input, filter: "pinned" }))).toEqual(["#pinned", "mine:a", "lib:p1"]);
    expect(shape(buildItems({ ...input, filter: "recent" }))).toEqual(["#recent", "lib:r1"]);
  });

  it("a kind filter narrows every group; workflows are tasks", () => {
    const items = buildItems(
      base({
        filter: "task",
        mine: [mine("my-persona", { kind: "persona", pinned: true }), mine("my-task", { pinned: true })],
        hits: [hit("bugfix-track", "workflow"), hit("code-reviewer", "persona"), hit("add-test")],
      }),
    );
    expect(shape(items)).toEqual(["#pinned", "mine:my-task", "#task", "lib:bugfix-track", "lib:add-test"]);
    expect(kindsFor("task", "session")).toEqual(["prompt", "workflow"]);
  });

  it("the launcher offers no answer styles and never asks for rules", () => {
    expect(kindsFor("all", "launcher")).toEqual(["prompt", "workflow", "persona"]);
    expect(kindsFor("all", "session")).not.toContain("rule");
    expect(filtersFor("launcher")).not.toContain("style");
    const items = buildItems(base({ context: "launcher", mine: [mine("terse", { kind: "style" })], hits: [hit("concise", "style"), hit("add-test")] }));
    expect(shape(items)).toEqual(["#forYou", "lib:add-test"]);
  });

  it("shows at most five recent rows above the rest", () => {
    const recent = Array.from({ length: 8 }, (_, i) => ({ hit: hit(`r${i}`), at: 100 - i }));
    const items = buildItems(base({ recent }));
    expect(pickables(items).map((r) => r.key)).toEqual(["lib:r0", "lib:r1", "lib:r2", "lib:r3", "lib:r4"]);
  });
});

describe("the keyboard", () => {
  const items = buildItems(base({ pinnedHits: [hit("a")], hits: [hit("b"), hit("c")] }));
  it("moves over rows, skipping group headers, and stops at the ends", () => {
    expect(moveSelection(items, null, 1)).toBe("lib:a");
    expect(moveSelection(items, "lib:a", 1)).toBe("lib:b");
    expect(moveSelection(items, "lib:c", 1)).toBe("lib:c");
    expect(moveSelection(items, "lib:a", -1)).toBe("lib:a");
    expect(moveSelection(items, "lib:a", 10)).toBe("lib:c");
    expect(moveSelection([], null, 1)).toBeNull();
  });
});

describe("the virtual list", () => {
  it("keeps about a screenful of 10,000 rows in the DOM", () => {
    const hits = Array.from({ length: 10_000 }, (_, i) => hit(`entry-${i}`));
    const items = buildItems(base({ hits }));
    const layout = layoutItems(items, 52, 28);
    expect(layout.total).toBe(28 + 10_000 * 52);
    const top = visibleRange(layout, 0, 480);
    expect(top.start).toBe(0);
    expect(top.end - top.start).toBeLessThan(30);
    const middle = visibleRange(layout, 52 * 5000, 480);
    expect(middle.end - middle.start).toBeLessThan(30);
    expect(items[middle.start].key).toMatch(/^lib:entry-49\d\d$/);
  });

  it("handles an empty list", () => {
    expect(visibleRange(layoutItems([], 52, 28), 0, 480)).toEqual({ start: 0, end: 0 });
  });
});

describe("reading a prompt", () => {
  const text = "<context>\nWhy it matters.\n</context>\n\n<task>\nAdd a regression test for: " + FILL_OPEN + "paste race" + FILL_CLOSE + "\n1. State the bug.\n2. Use `git stash`.\n</task>\n\n<output_format>\n## Test\nThe **test** file.\n- one\n- two\n</output_format>";
  it("turns tags into labelled sections and never shows them", () => {
    const sections = readableSections(text);
    expect(sections.map((s) => s.tag)).toEqual(["context", "task", "output_format"]);
    expect(JSON.stringify(sections)).not.toMatch(/<\/?(context|task|output_format)>/);
    const task = sections[1].blocks;
    expect(task[0]).toEqual({ kind: "p", parts: [{ t: "text", v: "Add a regression test for: " }, { t: "filled", v: "paste race" }] });
    expect(task[1].kind).toBe("ol");
    expect(sections[2].blocks[0]).toEqual({ kind: "h", parts: [{ t: "text", v: "Test" }] });
    expect(sections[2].blocks[2].kind).toBe("ul");
  });

  it("drops a stray tag that never closes", () => {
    expect(JSON.stringify(readableSections("Do it.\n</output_format>"))).not.toContain("output_format>");
  });

  it("marks your words and the blanks, and sends neither marker", () => {
    const v = markedValues({ bug: "paste race", fix: " " }, ["bug", "symptom"]);
    expect(v.bug).toBe(`${FILL_OPEN}paste race${FILL_CLOSE}`);
    expect(v.symptom).toBe(`${BLANK_OPEN}symptom${BLANK_CLOSE}`);
    expect(v.fix).toBeUndefined();
    expect(unmark(`a ${v.bug} b ${v.symptom}`)).toBe("a paste race b [symptom]");
    expect(readableSections(`Fix ${v.symptom}`)[0].blocks[0]).toEqual({ kind: "p", parts: [{ t: "text", v: "Fix " }, { t: "blank", v: "symptom" }] });
  });

  it("gives an editable copy with plain headings", () => {
    expect(editableText("<task>\nDo X\n</task>\n\nThanks", (t) => t.toUpperCase())).toBe("TASK:\nDo X\n\nThanks");
  });
});

describe("putting it together", () => {
  it("wraps the persona and the answer style in their own sections", () => {
    expect(composeText({ persona: "You review code.", body: "Review this.", style: "Be brief." })).toBe(
      "<role>\nYou review code.\n</role>\n\nReview this.\n\n<answer_style>\nBe brief.\n</answer_style>",
    );
    expect(composeText({ body: "Only this." })).toBe("Only this.");
  });

  it("asks for a lead line only for an agent that folds long pastes, and only when the text would fold", () => {
    const fold = { chars: 800, lines: 3 };
    expect(needsLeadLine("short", fold)).toBe(false);
    expect(needsLeadLine("a\nb\nc\nd", fold)).toBe(true);
    expect(needsLeadLine("x".repeat(801), fold)).toBe(true);
    expect(needsLeadLine("a\nb\nc\nd", null)).toBe(false);
  });

  it("puts a selection into the first empty required text blank", () => {
    const args = [
      { name: "widget", description: "", type: "enum", required: true, enum: ["tabs"] },
      { name: "bug", description: "", type: "text", required: true },
      { name: "fix", description: "", type: "string" },
    ];
    expect(prefillTarget(args, {})).toBe("bug");
    expect(prefillTarget(args, { bug: "filled" })).toBeNull();
  });

  it("keeps the blanks still in a saved copy, described as the source described them", () => {
    const source = [{ name: "bug", description: "The bug.", type: "text", required: true }];
    expect(savedArgs("Fix {{bug}} in {{ area }} and {{bug}} again", source)).toEqual([
      { name: "bug", description: "The bug.", type: "text", required: true },
      { name: "area", description: "", type: "text", required: true },
    ]);
    expect(savedArgs("No blanks", source)).toEqual([]);
  });
});
