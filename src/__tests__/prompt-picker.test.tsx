// @vitest-environment jsdom
/**
 * The Prompts palette against a fake library: it opens on Pinned and For
 * you, the arrows move, Return on a prompt with an empty required blank goes
 * to that blank, filling it and pressing ⌘Return inserts (⌘⇧Return sends),
 * the preview never shows raw template tags, the launcher gets a persona as
 * "Act as", "Save to Mine" keeps the blanks, and the empty states say what
 * to do.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const h = vi.hoisted(() => ({ invoke: vi.fn(), settings: {} as Record<string, string> }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("../api/settings", () => ({
  getSetting: vi.fn(async (k: string) => h.settings[k] ?? ""),
  setSetting: vi.fn(async (k: string, v: string) => {
    h.settings[k] = v;
  }),
  getSettings: vi.fn(async () => ({})),
}));

import { I18nProvider } from "../i18n/I18nProvider";
import { PromptPicker, resetPickerDrafts, type PickerDelivery, type PromptPick } from "../components/library/PromptPicker";
import { resetMyPromptsCache } from "../library/myPrompts";

const hit = (id: string, kind = "prompt", over: Record<string, unknown> = {}) => ({
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

const HITS = [
  hit("add-regression-test", "prompt", { title: "Add a regression test for a bug", reasons: [{ code: "stack", value: "rust", label: "Rust" }] }),
  hit("bugfix-track", "workflow", { title: "Bugfix track" }),
  hit("code-reviewer", "persona", { title: "Code reviewer" }),
  hit("concise", "style", { title: "Concise" }),
];

const ENTRIES: Record<string, unknown> = {
  "add-regression-test": {
    id: "add-regression-test",
    resolvedFrom: null,
    row: { id: "add-regression-test", v: "1.0.0", kind: "prompt", title: "Add a regression test for a bug", desc: "Writes the smallest failing test.", dom: "software-engineering", cat: "testing", status: "incubating", tier: "curated", works: ["claude-code"] },
    body: {
      schema: 1,
      fm: {
        id: "add-regression-test",
        kind: "prompt",
        title: "Add a regression test for a bug",
        version: "1.0.0",
        args: [
          { name: "bug", description: "The bug, with the input that triggers it.", type: "text", required: true },
          { name: "fix", description: "The commit that fixes it.", type: "string" },
        ],
        output_contract: { sections: ["Test", "Proof", "Notes"] },
        pairs_with: { personas: ["code-reviewer"] },
      },
      body: "<context>\nA regression test must fail without the fix.\n</context>\n\n<task>\nAdd a regression test for: {{bug}}\n{{#fix}}The fix is in {{fix}}.\n{{/fix}}1. State the bug.\n2. Prove it.\n</task>\n\n<output_format>\n## Test\nThe test.\n</output_format>",
      steps: [],
    },
    state: { itemId: "add-regression-test", pinned: false, favorite: false, hidden: false, useCount: 0, lastUsedAt: null },
    isNew: false,
  },
  "bugfix-track": {
    id: "bugfix-track",
    resolvedFrom: null,
    row: { id: "bugfix-track", v: "1.0.0", kind: "workflow", title: "Bugfix track", desc: "From report to fix.", dom: "software-engineering", cat: "debugging", status: "incubating", tier: "curated", works: ["claude-code"] },
    body: { schema: 1, fm: { id: "bugfix-track", kind: "workflow", title: "Bugfix track", version: "1.0.0", args: [] }, body: "Fix the bug in steps.", steps: [] },
    state: { itemId: "bugfix-track", pinned: true, favorite: false, hidden: false, useCount: 0, lastUsedAt: null },
    isNew: false,
  },
  "code-reviewer": {
    id: "code-reviewer",
    resolvedFrom: null,
    row: { id: "code-reviewer", v: "1.0.0", kind: "persona", title: "Code reviewer", desc: "Reviews like a senior engineer.", dom: "software-engineering", cat: "code-review", status: "incubating", tier: "curated", works: ["claude-code"] },
    body: { schema: 1, fm: { id: "code-reviewer", kind: "persona", title: "Code reviewer", version: "1.0.0" }, body: "You are a senior engineer reviewing a change.", steps: [] },
    state: { itemId: "code-reviewer", pinned: false, favorite: false, hidden: false, useCount: 0, lastUsedAt: null },
    isNew: false,
  },
};

function backend(cmd: string, args: Record<string, unknown>) {
  switch (cmd) {
    case "library_status":
      return { ready: true };
    case "library_item_states":
      return [{ itemId: "bugfix-track", pinned: true, favorite: false, hidden: false, useCount: 0, lastUsedAt: null }];
    case "library_hits":
      return HITS.filter((x) => (args.ids as string[]).includes(x.id));
    case "library_search": {
      const req = args.request as { query: string; filters: { kind: string[] } };
      const q = req.query.toLowerCase();
      const hits = HITS.filter((x) => req.filters.kind.includes(x.kind) && (!q || x.title.toLowerCase().includes(q)));
      return { hits, total: hits.length, totalCapped: false, nextCursor: null, kindCounts: {}, tookMs: 1 };
    }
    case "library_get":
      return ENTRIES[args.id as string];
    case "library_installs":
      return { lock: { schema: 1, entries: [] }, records: [] };
    default:
      return null;
  }
}

beforeEach(() => {
  for (const k of Object.keys(h.settings)) delete h.settings[k];
  resetMyPromptsCache();
  resetPickerDrafts();
  try {
    localStorage.setItem("hermes.prompts.seen", "1");
  } catch {
    /* jsdom storage */
  }
  h.invoke.mockReset();
  h.invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => backend(cmd, args));
});
afterEach(() => cleanup());

function session(over: Partial<PickerDelivery> = {}) {
  const place = vi.fn(async (_text: string, opts: { send: boolean }) => (opts.send ? ("sent" as const) : ("pasted" as const)));
  const delivery: PickerDelivery = { label: "fix paste race", canSend: true, place, ...over };
  const onClose = vi.fn();
  const view = render(
    <I18nProvider>
      <PromptPicker context="session" delivery={delivery} onClose={onClose} />
    </I18nProvider>,
  );
  return { view, place, onClose };
}

const q = (view: ReturnType<typeof render>, sel: string) => view.container.querySelector(sel) as HTMLElement | null;
const search = (view: ReturnType<typeof render>) => q(view, ".pp-input") as HTMLInputElement;
const selected = (view: ReturnType<typeof render>) => q(view, '.pp-row[aria-selected="true"]')?.getAttribute("data-entry");
const key = (el: Element, k: string, extra: Partial<KeyboardEventInit> = {}) => fireEvent.keyDown(el, { key: k, ...extra });
/** The ranked rows have arrived (Pinned comes first, from another call). */
const ranked = (view: ReturnType<typeof render>) => waitFor(() => expect(q(view, '.pp-row[data-entry="add-regression-test"]')).toBeTruthy());

describe("Prompts palette", () => {
  it("opens on Pinned and For you, with the first row chosen and a reason on ranked rows", async () => {
    const { view } = session();
    await waitFor(() => expect(view.container.querySelectorAll(".pp-group").length).toBe(2));
    const groups = [...view.container.querySelectorAll(".pp-group")].map((g) => g.textContent);
    expect(groups[0]).toContain("Pinned");
    expect(groups[1]).toContain("For you");
    expect(selected(view)).toBe("bugfix-track");
    expect(q(view, '.pp-row[data-entry="add-regression-test"] .pp-row-why')?.textContent).toContain("Fits Rust");
    // With nothing typed, All opens on tasks; rules are never asked for here.
    expect([...view.container.querySelectorAll(".pp-row")].map((r) => r.getAttribute("data-kind"))).toEqual(["workflow", "prompt"]);
    expect(q(view, '[role="status"].pp-sr')?.textContent).toBe("2 prompts listed");
    const kinds = h.invoke.mock.calls.filter((c) => c[0] === "library_search").map((c) => c[1].request.filters.kind);
    expect(kinds.every((k: string[]) => !k.includes("rule"))).toBe(true);
    expect(document.activeElement).toBe(search(view));
  });

  it("moves with the arrows, sends Return to an empty required blank, inserts with ⌘Return once filled", async () => {
    const { view, place, onClose } = session();
    await waitFor(() => expect(selected(view)).toBe("bugfix-track"));
    await ranked(view);
    await act(async () => key(search(view), "ArrowDown"));
    expect(selected(view)).toBe("add-regression-test");
    await waitFor(() => expect(q(view, '[data-arg="bug"] textarea')).toBeTruthy());
    expect(q(view, ".pp-gives")?.textContent).toBe("Gives you: Test, proof, notes");
    // The preview reads as sections, never as template source.
    const receives = q(view, "[data-testid=prompt-receives]")!;
    await waitFor(() => expect(receives.textContent).toContain("A regression test must fail"));
    expect(receives.textContent).not.toMatch(/<\/?(context|task|output_format)>/);
    expect(receives.textContent).toContain("You get");
    expect(q(view, ".pp-blank")?.textContent).toBe("Bug");

    await act(async () => key(search(view), "Enter"));
    expect(place).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(q(view, '[data-arg="bug"] textarea'));
    expect(q(view, ".pp-need")?.textContent).toBe("Needed before inserting");

    const field = q(view, '[data-arg="bug"] textarea')!;
    await act(async () => fireEvent.change(field, { target: { value: "typing fast drops characters" } }));
    expect(q(view, ".pp-filled")?.textContent).toBe("typing fast drops characters");
    await act(async () => key(field, "Enter", { metaKey: true }));
    await waitFor(() => expect(place).toHaveBeenCalledTimes(1));
    const [text, opts] = place.mock.calls[0];
    expect(text).toContain("Add a regression test for: typing fast drops characters");
    expect(text).not.toContain("The fix is in");
    expect(opts).toEqual({ title: "Add a regression test for a bug", send: false });
    expect(onClose).toHaveBeenCalled();
    expect(h.invoke.mock.calls.some((c) => c[0] === "library_record_use" && c[1].id === "add-regression-test")).toBe(true);
  });

  it("⌘⇧Return inserts and sends", async () => {
    const { view, place } = session();
    await waitFor(() => expect(selected(view)).toBe("bugfix-track"));
    await act(async () => key(search(view), "Enter", { metaKey: true, shiftKey: true }));
    await waitFor(() => expect(place).toHaveBeenCalledTimes(1));
    expect(place.mock.calls[0][1].send).toBe(true);
  });

  it("puts the terminal selection into the first blank", async () => {
    const onClose = vi.fn();
    const view = render(
      <I18nProvider>
        <PromptPicker context="session" delivery={{ label: "s", canSend: true, place: vi.fn() }} prefill="thread panicked at writer.rs:88" onClose={onClose} />
      </I18nProvider>,
    );
    await waitFor(() => expect(selected(view)).toBe("bugfix-track"));
    await ranked(view);
    await act(async () => key(search(view), "ArrowDown"));
    await waitFor(() => expect((q(view, '[data-arg="bug"] textarea') as HTMLTextAreaElement | null)?.value).toBe("thread panicked at writer.rs:88"));
  });

  it("filters by kind, and Esc in the search closes", async () => {
    const { view, onClose } = session();
    await waitFor(() => expect(view.container.querySelector('[data-filter="persona"]')).toBeTruthy());
    await act(async () => fireEvent.click(q(view, '[data-filter="persona"]')!));
    await waitFor(() => expect(selected(view)).toBe("code-reviewer"));
    expect([...view.container.querySelectorAll(".pp-row")].map((r) => r.getAttribute("data-kind"))).toEqual(["persona"]);
    await act(async () => key(search(view), "Escape"));
    expect(onClose).toHaveBeenCalled();
  });

  it("from the launcher: a persona becomes Act as, a task comes with its text", async () => {
    const onUse = vi.fn((p: PromptPick) => p);
    const view = render(
      <I18nProvider>
        <PromptPicker context="launcher" embedded onUse={onUse} onClose={() => {}} />
      </I18nProvider>,
    );
    await waitFor(() => expect(selected(view)).toBe("bugfix-track"));
    expect(q(view, ".pp-primary")?.textContent).toContain("Use as task");
    expect(q(view, ".pp-send")).toBeNull();
    // No answer styles in a launch.
    expect(q(view, '[data-filter="style"]')).toBeNull();
    await act(async () => key(search(view), "Enter"));
    await waitFor(() => expect(onUse).toHaveBeenCalledTimes(1));
    expect(onUse.mock.calls[0][0]).toMatchObject({ kind: "workflow", id: "bugfix-track", title: "Bugfix track", mine: false, persona: null });
    expect(onUse.mock.calls[0][0].text).toContain("Fix the bug in steps.");

    await act(async () => fireEvent.click(q(view, '[data-filter="persona"]')!));
    await waitFor(() => expect(selected(view)).toBe("code-reviewer"));
    await waitFor(() => expect(q(view, "[data-testid=prompt-receives]")?.textContent).toContain("senior engineer"));
    await act(async () => key(search(view), "Enter"));
    await waitFor(() => expect(onUse).toHaveBeenCalledTimes(2));
    expect(onUse.mock.calls[1][0].kind).toBe("persona");
    expect(onUse.mock.calls[1][0].text).toContain("You are a senior engineer reviewing a change.");
  });

  it("Save to Mine keeps the blanks you left empty, and the copy opens under Mine", async () => {
    const { view } = session();
    await waitFor(() => expect(selected(view)).toBe("bugfix-track"));
    await ranked(view);
    await act(async () => key(search(view), "ArrowDown"));
    await waitFor(() => expect(q(view, '[data-arg="fix"] input')).toBeTruthy());
    await act(async () => fireEvent.change(q(view, '[data-arg="fix"] input')!, { target: { value: "4f2a9c1" } }));
    await act(async () => key(search(view), "s", { metaKey: true }));
    await waitFor(() => expect(q(view, ".pp-editor")).toBeTruthy());
    const editor = q(view, ".pp-editor") as HTMLTextAreaElement;
    expect(editor.value).toContain("{{bug}}");
    expect(editor.value).toContain("The fix is in 4f2a9c1.");
    expect(editor.value).not.toMatch(/<\/?task>/);
    const name = q(view, ".pp-savebar input") as HTMLInputElement;
    expect(name.value).toBe("Add a regression test for a bug (mine)");
    await act(async () => key(name, "Enter"));
    await waitFor(() => expect(h.settings.my_prompts).toBeTruthy());
    const saved = JSON.parse(h.settings.my_prompts);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ kind: "prompt", title: "Add a regression test for a bug (mine)", from: { id: "add-regression-test", version: "1.0.0" } });
    expect(saved[0].args.map((a: { name: string }) => a.name)).toEqual(["bug"]);
    await waitFor(() => expect(q(view, '[data-filter="mine"]')?.getAttribute("aria-pressed")).toBe("true"));
    await waitFor(() => expect(selected(view)).toBe(saved[0].id));
  });

  it("says what to do when Mine is empty and when nothing matches", async () => {
    const { view } = session();
    await waitFor(() => expect(view.container.querySelector('[data-filter="mine"]')).toBeTruthy());
    await act(async () => fireEvent.click(q(view, '[data-filter="mine"]')!));
    await waitFor(() => expect(q(view, '[data-empty="mine"]')).toBeTruthy());
    expect(q(view, '[data-empty="mine"]')?.textContent).toContain("Nothing saved yet");
    await act(async () => fireEvent.click(q(view, '[data-filter="mine"]')!));
    await act(async () => fireEvent.change(search(view), { target: { value: "kubernetes helm" } }));
    await waitFor(() => expect(q(view, '[data-empty="none"]')).toBeTruthy());
    expect(q(view, '[data-empty="none"]')?.textContent).toContain("No prompts match “kubernetes helm”");
    expect(q(view, '[data-empty="none"]')?.textContent).toContain("Use “kubernetes helm” as a new prompt");
  });

  it("shows the library error and keeps Mine working", async () => {
    h.invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => (cmd === "library_status" ? { ready: false } : backend(cmd, args)));
    h.settings.my_prompts = JSON.stringify([{ id: "mine-1", kind: "prompt", title: "Root cause, my way", description: "", text: "Find the root cause.", createdAt: 1, updatedAt: 1 }]);
    const { view } = session();
    await waitFor(() => expect(q(view, ".pp-note[role=alert]")?.textContent).toContain("The library could not be read."));
    await act(async () => fireEvent.click(q(view, '[data-filter="mine"]')!));
    await waitFor(() => expect(selected(view)).toBe("mine-1"));
  });
});
