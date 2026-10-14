// @vitest-environment jsdom
/**
 * The everyday Library against a fake backend: a new user's home asks
 * "What do you want to do?" over the Essentials (narrowed by intent and
 * topic, health ones labelled); "plan a 5-day trip to lisbon" leads with
 * its front door, shows Lisbon and 5 days filled in, offers the
 * specialists and sections the rest by depth (foldable, with counts); an
 * empty search with no filters does not blame filters; opening an entry
 * puts it in Recent.
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

const door = (id: string, over: Record<string, unknown> = {}) => hit(id, { door: true, essential: true, depth: "basic", ...over });
const ESSENTIALS = [
  door("plan-a-trip", { title: "Plan a trip", intents: ["plan"], topic: "travel", domain: "travel", category: "trip-planning" }),
  door("eat-healthier", { title: "Eat healthier", intents: ["plan"], topic: "health", adv: ["medical"] }),
  door("write-an-email", { title: "Write an email", intents: ["write"], topic: "work" }),
];
const TRIP = {
  id: "plan-a-trip",
  resolvedFrom: null,
  row: { id: "plan-a-trip", v: "1.0.0", kind: "prompt", title: "Plan a trip", desc: "Where, when, budget: a day-by-day plan.", dom: "travel", cat: "trip-planning", status: "experimental", tier: "curated", works: ["claude-code"], ess: 2 },
  body: {
    schema: 1,
    fm: {
      id: "plan-a-trip",
      kind: "prompt",
      title: "Plan a trip",
      version: "1.0.0",
      args: [
        { name: "destination", description: "Where to (or 'not sure')" },
        { name: "days", description: "How many days" },
      ],
      pairs_with: ["plan-itinerary"],
    },
    body: "Plan a trip to {{destination}} for {{days}}.",
    steps: [],
  },
  state: { itemId: "plan-a-trip", pinned: false, favorite: false, hidden: false, useCount: 0, lastUsedAt: null },
  isNew: false,
};
const DIET = {
  ...TRIP,
  id: "eat-healthier",
  row: { ...TRIP.row, id: "eat-healthier", title: "Eat healthier", desc: "A realistic meal plan.", dom: "health-wellbeing", cat: "nutrition", adv: ["medical"] },
  body: { ...TRIP.body, fm: { ...TRIP.body.fm, id: "eat-healthier", title: "Eat healthier", args: [{ name: "goal", description: "Your goal" }], pairs_with: [] } },
};

const states: Array<Record<string, unknown>> = [];
let roles: string[] = [];

function backend(cmd: string, args: Record<string, unknown>) {
  switch (cmd) {
    case "library_status":
      return { ready: true, catalog: { catalog: "2026.1101.0", seq: 12, manifestSha256: "x", source: "bundled", rows: 10400, appliedAt: 1 }, bundled: ["2026.1101.0", 12], hasBundledArchive: true, offlineBodies: 10400, updates: "auto", lastCheck: null, lastSuccess: null, lastError: null, trustedKeys: 0, importMs: 120, lastOutcome: null, checking: false, error: null };
    case "library_item_states":
      return [...states];
    case "library_shelves":
      return {
        shelves: [],
        personalised: true,
        stack: [],
        projectAgents: [],
        profile: { roles, domains: [], categories: [], subjects: [], stack: [] },
        domains: [
          { id: "software-engineering", label: "Software engineering", count: 2096, mine: false, categories: [{ id: "code-review", label: "Code review", count: 80 }] },
          { id: "travel", label: "Travel", count: 177, mine: false, categories: [{ id: "trip-planning", label: "Trip planning", count: 60 }] },
        ],
        catalog: null,
        essentials: ESSENTIALS,
        intents: [
          { id: "write", label: "Write", hint: "emails, posts, letters" },
          { id: "plan", label: "Plan", hint: "trips, meals, money" },
        ],
        topics: [
          { id: "travel", label: "Travel" },
          { id: "health", label: "Health" },
          { id: "work", label: "Work" },
        ],
        depths: [
          { id: "basic", label: "Start here" },
          { id: "specific", label: "Specific" },
          { id: "advanced", label: "Advanced" },
        ],
      };
    case "library_resolve":
      return {};
    case "library_hits":
      return (args.ids as string[]).map((id) => hit(id, { title: id === "plan-itinerary" ? "Plan a trip itinerary" : id }));
    case "library_search": {
      const req = args.request as { query: string; filters: Record<string, string[]> };
      if (req.query.includes("zzz")) return { hits: [], total: 0, totalCapped: false, nextCursor: null, kindCounts: {}, depthCounts: {}, tookMs: 1, route: null, leftover: [], partial: false };
      if (/trip/.test(req.query)) {
        return {
          hits: [hit("plan-weekend-trip", { depth: "basic" }), hit("plan-road-trip", { depth: "specific" }), hit("plan-school-field-trip", { depth: "advanced" })],
          total: 4,
          totalCapped: false,
          nextCursor: null,
          kindCounts: { prompt: 4 },
          depthCounts: { basic: 2, specific: 1, advanced: 1 },
          tookMs: 2,
          route: { to: ESSENTIALS[0], refine: [hit("plan-itinerary", { title: "Plan a trip itinerary", depth: "specific" })], phrase: "trip" },
          leftover: req.query.includes("lisbon") ? ["5-day", "lisbon"] : [],
          partial: req.query.includes("lisbon"),
        };
      }
      return { hits: [hit("audit-news-diet", { depth: "advanced", adv: [] }), hit("plan-sustainable-weight-loss", { depth: "specific", adv: ["medical"] })], total: 2, totalCapped: false, nextCursor: null, kindCounts: {}, depthCounts: {}, tookMs: 1, route: { to: ESSENTIALS[1], refine: [], phrase: "diet" }, leftover: [], partial: false };
    }
    case "library_get":
      return args.id === "eat-healthier" ? DIET : TRIP;
    case "library_record_open":
      states.push({ itemId: args.id, pinned: false, favorite: false, hidden: false, useCount: 0, lastUsedAt: 1_800_000_000 });
      return null;
    default:
      return null;
  }
}

beforeEach(() => {
  h.writes.length = 0;
  states.length = 0;
  roles = [];
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

async function type(view: ReturnType<typeof mount>, text: string) {
  const input = view.container.querySelector("input.lib-search-input") as HTMLInputElement;
  await act(async () => {
    fireEvent.change(input, { target: { value: text } });
  });
}

describe("The everyday Library", () => {
  it("shows a new user the Essentials, narrowed by intent and topic, with health labelled", async () => {
    const view = mount();
    await waitFor(() => expect(view.container.querySelector("[data-testid=library-essentials]")).toBeTruthy());
    expect(view.container.querySelector(".lib-ask-title")?.textContent).toBe("What do you want to do?");
    const cards = () => [...view.container.querySelectorAll("[data-testid=library-essentials] .lib-card")].map((c) => c.getAttribute("data-entry"));
    expect(cards()).toEqual(["plan-a-trip", "eat-healthier", "write-an-email"]);
    expect(view.container.querySelector('.lib-card[data-entry="eat-healthier"] .lib-care')?.textContent).toBe("Health · safety checks");
    // No "Personalised from" strip when nothing personal is known.
    expect(view.container.querySelector(".lib-context")?.textContent).not.toContain("Personalised");
    await act(async () => {
      fireEvent.click(view.container.querySelector('.lib-intent[data-intent="plan"]')!);
    });
    expect(cards()).toEqual(["plan-a-trip", "eat-healthier"]);
    await act(async () => {
      fireEvent.click(view.container.querySelector('.lib-topic[data-topic="health"]')!);
    });
    expect(cards()).toEqual(["eat-healthier"]);
    // Browse everything: grouped, and a domain opens on its categories.
    expect([...view.container.querySelectorAll(".lib-browse-title")].map((x) => x.textContent)).toEqual(["Everyday life", "Making & building"]);
    await act(async () => {
      fireEvent.click(view.container.querySelector('.lib-domain[data-domain="travel"]')!);
    });
    await act(async () => {
      fireEvent.click(view.container.querySelector('.lib-category[data-category="trip-planning"]')!);
    });
    await waitFor(() => expect(h.invoke.mock.calls.some((c) => c[0] === "library_search" && c[1].request.filters.cat?.[0] === "trip-planning")).toBe(true));
  });

  it("leads 'plan a 5-day trip to lisbon' with its front door, Lisbon and 5 days filled in", async () => {
    const view = mount();
    await waitFor(() => expect(view.container.querySelector("[data-testid=library-essentials]")).toBeTruthy());
    await type(view, "plan a 5-day trip to lisbon");
    await waitFor(() => expect(view.container.querySelector("[data-testid=library-front]")?.getAttribute("data-entry")).toBe("plan-a-trip"));
    await waitFor(() => expect(view.container.querySelector("[data-testid=library-front]")?.textContent).toContain("Lisbon · 5 days filled in from your search."));
    expect(view.container.querySelector("[data-testid=library-refine]")?.textContent).toContain("Plan a trip itinerary");
    // The front door is open beside the results, its questions answered.
    await waitFor(() => expect((view.container.querySelector('[data-arg="destination"] input, [data-arg="destination"] textarea') as HTMLInputElement | null)?.value).toBe("Lisbon"));
    expect((view.container.querySelector('[data-arg="days"] input, [data-arg="days"] textarea') as HTMLInputElement).value).toBe("5 days");
    expect(view.container.querySelector(".lib-detail-label")?.textContent).toBeTruthy();
    expect(view.container.textContent).toContain("A few questions (all optional)");
    await waitFor(() => expect(view.container.querySelector("[data-testid=library-leads]")?.textContent).toContain("Plan a trip itinerary"));
    // The rest in depth sections, basic first, each with its count.
    const sections = [...view.container.querySelectorAll(".lib-group--section")].map((g) => g.textContent?.replace(/[▸▾]\s*/, ""));
    expect(sections).toEqual(["Start here2", "Specific1", "Advanced1"]);
    expect(view.container.textContent).toContain("no entry has every word");
    // A section folds.
    await act(async () => {
      fireEvent.click(view.container.querySelector('.lib-group--section[data-section="advanced"]')!);
    });
    expect(view.container.querySelector('.lib-row[data-entry="plan-school-field-trip"]')).toBeNull();
    // The detail badges only an exception: this entry is experimental.
    expect([...view.container.querySelectorAll(".lib-detail-meta > *")].map((b) => b.textContent)).toEqual(["v1.0.0", "Experimental", "Available offline"]);
    expect(view.container.querySelector(".lib-body--open")).toBeTruthy();
    // An automatic selection is not an "open": nothing went to Recent.
    expect(h.invoke.mock.calls.some((c) => c[0] === "library_record_open")).toBe(false);
  });

  it("labels health rows and says plainly when nothing matches", async () => {
    const view = mount();
    await waitFor(() => expect(view.container.querySelector("[data-testid=library-essentials]")).toBeTruthy());
    await type(view, "diet");
    await waitFor(() => expect(view.container.querySelector('.lib-row[data-entry="plan-sustainable-weight-loss"] .lib-care')?.textContent).toBe("Health · safety checks"));
    expect(view.container.querySelector("[data-testid=library-front] .lib-care")).toBeTruthy();
    await waitFor(() => expect(view.container.querySelector(".lib-carebox")?.textContent).toContain("Not medical advice"));
    await type(view, "zzzqqq");
    await waitFor(() => expect(view.container.querySelector(".lib-empty")?.textContent).toContain("Nothing matches “zzzqqq”."));
    expect(view.container.querySelector(".lib-empty")?.textContent).not.toContain("filters");
  });

  it("shows no status badge for an incubating entry", async () => {
    const incubating = { ...TRIP, row: { ...TRIP.row, status: "incubating" } };
    h.invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => (cmd === "library_get" ? incubating : backend(cmd, args)));
    const view = mount();
    await waitFor(() => expect(view.container.querySelector('.lib-card[data-entry="plan-a-trip"]')).toBeTruthy());
    await act(async () => {
      fireEvent.click(view.container.querySelector('.lib-card[data-entry="plan-a-trip"]')!);
    });
    await waitFor(() => expect(view.container.querySelector(".lib-detail-meta")).toBeTruthy());
    expect([...view.container.querySelectorAll(".lib-detail-meta > *")].map((b) => b.textContent)).toEqual(["v1.0.0", "Available offline"]);
  });

  it("keeps the query-language hint for developers, or once it has been used", async () => {
    const view = mount();
    await waitFor(() => expect(view.container.querySelector("[data-testid=library-essentials]")).toBeTruthy());
    expect(view.container.querySelector(".lib-search-hint")).toBeNull();
    await type(view, "trip cat:trip-planning");
    await waitFor(() => expect(view.container.querySelector(".lib-search-hint")?.textContent).toBe("try cat:testing works:codex"));
    const { setSetting } = await import("../api/settings");
    expect(setSetting).toHaveBeenCalledWith("library_facets_used", "true");
    cleanup();
    roles = ["frontend-engineer"];
    const dev = mount();
    await waitFor(() => expect(dev.container.querySelector(".lib-search-hint")).toBeTruthy());
  });

  it("puts an opened entry in Recent", async () => {
    const view = mount();
    await waitFor(() => expect(view.container.querySelector('.lib-card[data-entry="plan-a-trip"]')).toBeTruthy());
    expect(view.container.querySelector('[data-nav="recent"]')).toBeNull();
    await act(async () => {
      fireEvent.click(view.container.querySelector('.lib-card[data-entry="plan-a-trip"]')!);
    });
    await waitFor(() => expect(view.container.querySelector('[data-nav="recent"]')).toBeTruthy());
    expect(h.invoke.mock.calls.find((c) => c[0] === "library_record_open")?.[1]).toEqual({ id: "plan-a-trip" });
  });
});
