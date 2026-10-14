// @vitest-environment jsdom
/**
 * Prompts (⌘J) for everyday tasks: from the launcher it searches with the
 * task already typed (its first line), keeps personal order on a typed
 * query, leads with the front door the task routes to (its questions
 * answered from the task's own words: Lisbon, 5 days), then the
 * specialists; with nothing typed it opens on Recent and the Essentials,
 * never an alphabetical first page.
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
import { PromptPicker, resetPickerDrafts } from "../components/library/PromptPicker";
import { resetMyPromptsCache } from "../library/myPrompts";

const hit = (id: string, kind = "prompt", over: Record<string, unknown> = {}) => ({
  id,
  version: "1.0.0",
  kind,
  title: id.replace(/-/g, " "),
  description: `About ${id}`,
  domain: "travel",
  domainLabel: "Travel",
  category: "trip-planning",
  categoryLabel: "Trip planning",
  status: "experimental",
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

const TRIP = hit("plan-a-trip", "prompt", { title: "Plan a trip", door: true, essential: true, depth: "basic" });
const ITINERARY = hit("plan-itinerary", "prompt", { title: "Plan a trip itinerary", depth: "specific" });
const ENTRY = {
  id: "plan-a-trip",
  resolvedFrom: null,
  row: { id: "plan-a-trip", v: "1.0.0", kind: "prompt", title: "Plan a trip", desc: "A day-by-day plan.", dom: "travel", cat: "trip-planning", status: "experimental", tier: "curated", works: ["claude-code"], ess: 2 },
  body: {
    schema: 1,
    fm: {
      id: "plan-a-trip",
      kind: "prompt",
      title: "Plan a trip",
      version: "1.0.0",
      args: [
        { name: "destination", description: "Where to" },
        { name: "days", description: "How many days" },
      ],
    },
    body: "Plan a trip to {{destination}} for {{days}}.",
    steps: [],
  },
  state: { itemId: "plan-a-trip", pinned: false, favorite: false, hidden: false, useCount: 0, lastUsedAt: null },
  isNew: false,
};

function backend(cmd: string, args: Record<string, unknown>) {
  switch (cmd) {
    case "library_status":
      return { ready: true };
    case "library_item_states":
      return [{ itemId: "review-pull-request", pinned: false, favorite: false, hidden: false, useCount: 2, lastUsedAt: 1_800_000_000 }];
    case "library_essentials":
      return [TRIP];
    case "library_hits":
      return (args.ids as string[]).map((id) => hit(id, "prompt", { title: "Review a pull request", domain: "software-engineering" }));
    case "library_search": {
      const req = args.request as { query: string; filters: { kind: string[]; ess?: string[] } };
      if (req.filters.ess) return { hits: [TRIP], total: 1, totalCapped: false, nextCursor: null, kindCounts: {}, tookMs: 1 };
      if (!req.query) return { hits: [hit("accept-a-job-offer")], total: 1, totalCapped: false, nextCursor: null, kindCounts: {}, tookMs: 1 };
      return {
        hits: [hit("plan-road-trip"), TRIP],
        total: 3,
        totalCapped: false,
        nextCursor: null,
        kindCounts: {},
        tookMs: 1,
        route: { to: TRIP, refine: [ITINERARY], phrase: "trip" },
        leftover: ["5-day", "Lisbon", "May", "two"],
        partial: true,
      };
    }
    case "library_get":
      return ENTRY;
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

const groups = (view: ReturnType<typeof render>) => [...view.container.querySelectorAll(".pp-group")].map((g) => g.textContent);
const rows = (view: ReturnType<typeof render>) => [...view.container.querySelectorAll(".pp-row")].map((r) => r.getAttribute("data-entry"));

describe("Prompts (⌘J) for everyday tasks", () => {
  it("searches with the launcher's task and leads with the front door, its answers filled in", async () => {
    const view = render(
      <I18nProvider>
        <PromptPicker context="launcher" embedded initialQuery={"Plan a 5-day trip to Lisbon in May for two\nmid budget"} prefill={"Plan a 5-day trip to Lisbon in May for two\nmid budget"} onUse={() => {}} onClose={() => {}} />
      </I18nProvider>,
    );
    await waitFor(() => expect(view.container.querySelector(".pp-input")).toBeTruthy());
    const input = view.container.querySelector(".pp-input") as HTMLInputElement;
    expect(input.value).toBe("Plan a 5-day trip to Lisbon in May for two");
    expect(view.container.querySelector(".pp-from-task")?.textContent).toBe("from your task");
    await waitFor(() => expect(rows(view)[0]).toBe("plan-a-trip"));
    expect(groups(view).slice(0, 2)).toEqual(["Best match", "More specific"]);
    expect(rows(view)).toEqual(["plan-a-trip", "plan-itinerary", "plan-road-trip"]);
    const search = h.invoke.mock.calls.filter((c) => c[0] === "library_search" && c[1].request.query).at(-1)!;
    expect(search[1].request.query).toBe("Plan a 5-day trip to Lisbon in May for two");
    // Personal order stays on with a query (not the plain "best match" sort).
    expect(search[1].request.sort).toBe("you");
    await waitFor(() => expect((view.container.querySelector('[data-arg="destination"] input, [data-arg="destination"] textarea') as HTMLInputElement | null)?.value).toBe("Lisbon"));
    expect((view.container.querySelector('[data-arg="days"] input, [data-arg="days"] textarea') as HTMLInputElement).value).toBe("5 days");
  });

  it("opens on Recent and the Essentials with nothing typed", async () => {
    const view = render(
      <I18nProvider>
        <PromptPicker context="launcher" embedded onUse={() => {}} onClose={() => {}} />
      </I18nProvider>,
    );
    await waitFor(() => expect(groups(view)).toEqual(["Recent", "Essentials", "For you"]));
    expect(rows(view)).toEqual(["review-pull-request", "plan-a-trip", "accept-a-job-offer"]);
  });
});
