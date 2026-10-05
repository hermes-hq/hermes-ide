// @vitest-environment jsdom
/**
 * The Library view against a fake backend: the first screen shows shelves
 * with their reasons (never the catalog), typing searches and groups the
 * results (Library, then Hermes classics), an open entry renders its
 * arguments and preview, and "Use in session" pastes into the focused
 * terminal without pressing Enter.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  writes: [] as string[],
  dispatch: vi.fn(),
  setActive: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("../api/settings", () => ({
  getSetting: vi.fn(async (k: string) => (k === "library_onboarded" ? "true" : "")),
  setSetting: vi.fn(async () => {}),
  getSettings: vi.fn(async () => ({})),
}));
vi.mock("../api/sessions", () => ({
  writeToSession: vi.fn(async (_id: string, b64: string) => {
    h.writes.push(atob(b64));
  }),
}));
vi.mock("../terminal/TerminalPool", () => ({
  dismissSuggestions: vi.fn(),
  clearGhostText: vi.fn(),
  focusTerminal: vi.fn(),
  getTerminal: () => ({ modes: { bracketedPasteMode: true } }),
}));
vi.mock("../launcher/doctorStore", () => ({
  ensureDoctor: vi.fn(),
  useAgentDoctor: () => ({
    rows: [
      { id: "claude", name: "Claude Code", installed: true, broken: null },
      { id: "codex", name: "Codex", installed: true, broken: null },
    ],
    loading: false,
    error: null,
    refresh: () => {},
  }),
}));
const SESSION = { id: "s1", label: "checkout totals", mode: "terminal", ai_provider: "claude", working_directory: "/fixture-home/orbit-web", phase: "idle" };
vi.mock("../state/SessionContext", () => ({
  useSession: () => ({ state: { activeSessionId: "s1", sessions: { s1: SESSION }, composers: {} }, dispatch: h.dispatch, setActive: h.setActive }),
  useSessionList: () => [SESSION],
}));

import { I18nProvider } from "../i18n/I18nProvider";
import { LibraryView } from "../components/library/LibraryView";

const hit = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  version: "1.0.0",
  kind: "prompt",
  title: id.replace(/-/g, " "),
  description: `About ${id}`,
  domain: "software-engineering",
  domainLabel: "Software engineering",
  category: "testing",
  categoryLabel: "Testing",
  status: "experimental",
  tier: "curated",
  works: ["claude-code", "codex"],
  stack: [],
  stage: [],
  score: 6,
  reasons: [],
  isNew: false,
  rank: 1,
  ...over,
});

const ENTRY = {
  id: "review-pull-request",
  resolvedFrom: null,
  row: { id: "review-pull-request", v: "1.2.0", kind: "prompt", title: "Review a pull request", desc: "Reviews a diff.", dom: "software-engineering", cat: "code-review", status: "experimental", tier: "curated", works: ["claude-code"] },
  body: {
    schema: 1,
    fm: { id: "review-pull-request", kind: "prompt", title: "Review a pull request", version: "1.2.0", args: [{ name: "diff", description: "Branch or diff", type: "text", required: true }] },
    body: "Review {{diff}} and list defects.",
    steps: [],
  },
  state: { itemId: "review-pull-request", pinned: false, favorite: false, hidden: false, useCount: 0, lastUsedAt: null },
  isNew: false,
};

function backend(cmd: string, args: Record<string, unknown>) {
  switch (cmd) {
    case "library_status":
      return { ready: true, catalog: { catalog: "2026.1004.2", seq: 8, manifestSha256: "x", source: "bundled", rows: 3634, appliedAt: 1 }, bundled: ["2026.1004.2", 8], hasBundledArchive: true, offlineBodies: 3634, updates: "auto", lastCheck: null, lastSuccess: null, lastError: null, trustedKeys: 0, importMs: 120, lastOutcome: null, checking: false, error: null };
    case "library_item_states":
      return [];
    case "library_shelves":
      return {
        shelves: [
          { id: "project", hits: [hit("write-component-tests", { reasons: [{ code: "stack", value: "react", label: "React" }] })], because: [{ value: "react", label: "React" }, { value: "typescript", label: "TypeScript" }] },
          { id: "start", hits: [hit("review-pull-request")], because: [] },
        ],
        personalised: true,
        stack: [{ value: "react", label: "React" }, { value: "typescript", label: "TypeScript" }],
        projectAgents: ["claude-code"],
        profile: { roles: [], domains: [], categories: [], subjects: [], stack: [] },
        domains: [{ id: "software-engineering", label: "Software engineering", count: 240, mine: false }],
        catalog: null,
      };
    case "library_resolve":
      return {};
    case "library_search":
      return { hits: [hit("review-pull-request", { kind: "prompt" })], total: 1, totalCapped: false, nextCursor: null, kindCounts: { prompt: 1 }, tookMs: 3, _args: args };
    case "library_get":
      return ENTRY;
    case "library_record_use":
      return null;
    default:
      return null;
  }
}

beforeEach(() => {
  h.writes.length = 0;
  h.invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => backend(cmd, args));
});
afterEach(() => cleanup());

function mount() {
  return render(
    <I18nProvider>
      <LibraryView onClose={() => {}} onStartTask={() => {}} />
    </I18nProvider>,
  );
}

describe("LibraryView", () => {
  it("opens on shelves with reasons, not the whole catalog", async () => {
    const view = mount();
    await waitFor(() => expect(view.container.querySelector('[data-shelf="project"]')).toBeTruthy());
    const project = view.container.querySelector('[data-shelf="project"]')!;
    expect(project.textContent).toContain("For this project");
    expect(project.textContent).toContain("orbit-web uses React, TypeScript");
    expect(project.querySelector(".lib-card-why")?.textContent).toBe("Your project uses React");
    expect(view.container.querySelectorAll(".lib-card")).toHaveLength(2);
    // The shelves were asked for with this moment's context, nothing more.
    const call = h.invoke.mock.calls.find((c) => c[0] === "library_shelves")!;
    expect(call[1].context).toMatchObject({ projectPath: "/fixture-home/orbit-web", activeWork: "claude-code", works: ["claude-code", "codex"] });
  });

  it("searches as you type and lists the library first", async () => {
    const view = mount();
    await waitFor(() => expect(view.container.querySelector("[data-testid=library-home]")).toBeTruthy());
    const input = view.container.querySelector("input[type=search]") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: "review" } });
    });
    await waitFor(() => expect(view.container.querySelector('[data-entry="review-pull-request"].lib-row')).toBeTruthy());
    const search = h.invoke.mock.calls.filter((c) => c[0] === "library_search").at(-1)!;
    expect(search[1].request.query).toBe("review");
    // The focused session's agent narrows the search (the "auto" chip).
    expect(search[1].request.filters.works).toEqual(["claude-code"]);
    expect(view.container.querySelector(".lib-group")?.textContent).toContain("Library");
  });

  it("renders an entry's arguments and pastes it without pressing Enter", async () => {
    const view = mount();
    await waitFor(() => expect(view.container.querySelector('[data-entry="review-pull-request"].lib-card')).toBeTruthy());
    await act(async () => {
      fireEvent.click(view.container.querySelector('[data-entry="review-pull-request"].lib-card')!);
    });
    await waitFor(() => expect(view.container.querySelector('[data-arg="diff"] textarea')).toBeTruthy());
    const use = view.container.querySelector(".lib-use") as HTMLButtonElement;
    expect(use.disabled).toBe(true); // the required argument is empty
    await act(async () => {
      fireEvent.change(view.container.querySelector('[data-arg="diff"] textarea')!, { target: { value: "feat/checkout" } });
    });
    await waitFor(() => expect(view.container.querySelector("[data-testid=library-preview]")?.textContent).toContain("Review feat/checkout and list defects."));
    await act(async () => {
      fireEvent.click(view.container.querySelector(".lib-use")!);
    });
    await waitFor(() => expect(h.writes).toHaveLength(1));
    expect(h.writes[0]).toBe("\x1b[200~Review feat/checkout and list defects.\x1b[201~");
    expect(h.invoke.mock.calls.some((c) => c[0] === "library_record_use")).toBe(true);
  });
});
