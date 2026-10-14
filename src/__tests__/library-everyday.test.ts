/**
 * The everyday rules behind the Library and Prompts (⌘J): a front door's
 * answers from the words a search left over, the launcher's task as a
 * query, the advice label, depth sections in the vocab's order (a level
 * added to the vocab needs no code), the domain groups, "Used yesterday",
 * and the picker's Essentials / Best match / More specific groups.
 */
import { describe, expect, it } from "vitest";
import {
  careKind,
  depthSections,
  domainGroups,
  fillFromLeftover,
  filterEssentials,
  isDeveloperRole,
  pairsWith,
  recentIds,
  taskQuery,
  usedWhen,
  usesFacets,
} from "../library/everyday";
import { buildItems } from "../library/promptPicker";
import { suggestDoors } from "../components/library/LibraryAsk";
import type { EntryArg, ItemState, LibraryHit } from "../library/types";

const hit = (id: string, over: Partial<LibraryHit> = {}): LibraryHit => ({
  id,
  version: "1.0.0",
  kind: "prompt",
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

const TRIP_ARGS: EntryArg[] = [
  { name: "destination", description: "Where to (or 'not sure')" },
  { name: "days", description: "How many days" },
  { name: "who", description: "Who's going" },
  { name: "budget", description: "Budget", enum: ["low", "mid", "high"] },
];

describe("a front door's answers from a search", () => {
  it("fills the place and the length from 'plan a 5-day trip to lisbon'", () => {
    expect(fillFromLeftover(TRIP_ARGS, ["5-day", "lisbon"])).toEqual({ destination: "Lisbon", days: "5 days" });
    expect(fillFromLeftover(TRIP_ARGS, ["Lisbon", "5", "days"])).toEqual({ destination: "Lisbon", days: "5 days" });
    expect(fillFromLeftover(TRIP_ARGS, ["two", "weeks", "Tokyo"])).toEqual({ destination: "Tokyo", days: "2 weeks" });
  });

  it("keeps months and a lone number out of the place", () => {
    const withWhen: EntryArg[] = [...TRIP_ARGS, { name: "when", description: "When (month or dates)" }];
    expect(fillFromLeftover(withWhen, ["5-day", "Lisbon", "May", "two"])).toEqual({ destination: "Lisbon", days: "5 days", when: "May", who: "2 people" });
    expect(fillFromLeftover(TRIP_ARGS.slice(0, 2), ["5-day", "Lisbon", "May", "two"])).toEqual({ destination: "Lisbon", days: "5 days" });
  });

  it("shares one question that asks where and when (hodios plan-a-trip)", () => {
    const hodios: EntryArg[] = [
      { name: "trip", description: 'Where and when, as far as you know, for example "5 days in Lisbon in May".', type: "text" },
      { name: "travellers", description: 'Who is going, for example "just me".', type: "text" },
      { name: "budget", description: "Total or per-person budget.", type: "text" },
    ];
    expect(fillFromLeftover(hodios, ["5-day", "lisbon"])).toEqual({ trip: "Lisbon, 5 days" });
    expect(fillFromLeftover(hodios, ["5-day", "Lisbon", "May", "two"])).toEqual({ trip: "Lisbon, 5 days, May", travellers: "2 people" });
  });

  it("fills who is going, and never a choice or a yes/no question", () => {
    expect(fillFromLeftover(TRIP_ARGS, ["Rome", "2", "people"])).toEqual({ destination: "Rome", who: "2 people" });
    expect(fillFromLeftover([{ name: "budget", description: "Budget", enum: ["low", "high"] }, { name: "kids", description: "With kids", type: "boolean" }], ["Rome"])).toEqual({});
  });

  it("puts other words in the first open question, as typed", () => {
    expect(fillFromLeftover([{ name: "goal", description: "Your goal" }], ["vegetarian", "protein"])).toEqual({ goal: "vegetarian protein" });
    expect(fillFromLeftover(TRIP_ARGS, [])).toEqual({});
    expect(fillFromLeftover([], ["Lisbon"])).toEqual({});
  });
});

describe("pairs_with", () => {
  it("reads a list or hodios' object form, tasks first and personas last", () => {
    expect(pairsWith(["a", { id: "b" }])).toEqual(["a", "b"]);
    expect(pairsWith({ personas: ["travel-planner"], prompts: ["choose-destination", "plan-itinerary"], workflows: ["w"] })).toEqual(["choose-destination", "plan-itinerary", "w", "travel-planner"]);
    expect(pairsWith(undefined)).toEqual([]);
  });
});

describe("the launcher's task as a query", () => {
  it("is the first line, trimmed and kept short", () => {
    expect(taskQuery("  Plan a 5-day trip to Lisbon in May for two  \nmid budget")).toBe("Plan a 5-day trip to Lisbon in May for two");
    expect(taskQuery("\n\nfix the flaky test")).toBe("fix the flaky test");
    expect(taskQuery("")).toBe("");
    const long = "word ".repeat(60);
    expect(taskQuery(long).length).toBeLessThanOrEqual(120);
    expect(taskQuery(long).endsWith(" ")).toBe(false);
  });
});

describe("advice labels", () => {
  it("names health first, then money, then legal", () => {
    expect(careKind(["medical"])).toBe("health");
    expect(careKind(["financial", "mental-health"])).toBe("health");
    expect(careKind(["financial"])).toBe("money");
    expect(careKind(["legal"])).toBe("legal");
    expect(careKind([])).toBeNull();
    expect(careKind(undefined)).toBeNull();
  });
});

describe("depth sections follow the vocab", () => {
  const levels = [
    { id: "basic", label: "Start here" },
    { id: "specific", label: "Specific" },
    { id: "advanced", label: "Advanced" },
  ];
  const hits = [hit("a", { depth: "advanced" }), hit("b", { depth: "basic" }), hit("c", { depth: null }), hit("d", { depth: "specific" })];

  it("puts basic first, a row without a level in the middle, and skips empty levels", () => {
    const s = depthSections(hits, levels);
    expect(s.map((x) => [x.level?.label, x.hits.map((h) => h.id)])).toEqual([
      ["Start here", ["b"]],
      ["Specific", ["c", "d"]],
      ["Advanced", ["a"]],
    ]);
    expect(depthSections([hit("b", { depth: "basic" })], levels).map((x) => x.level?.id)).toEqual(["basic"]);
  });

  it("shows a fourth level added to the vocab with no code change", () => {
    const four = [...levels.slice(0, 2), { id: "expert", label: "Expert" }, levels[2]];
    const s = depthSections([...hits, hit("e", { depth: "expert" })], four);
    expect(s.map((x) => x.level?.label)).toEqual(["Start here", "Specific", "Expert", "Advanced"]);
    // The middle of four levels is the third.
    expect(s.find((x) => x.level?.id === "expert")?.hits.map((h) => h.id)).toEqual(["c", "e"]);
  });

  it("is one unnamed section for a catalog without levels", () => {
    expect(depthSections(hits, [])).toEqual([{ level: null, hits }]);
  });
});

describe("browse groups", () => {
  it("groups domains as Everyday life, Work, Making & building, then anything new", () => {
    const d = (id: string, count: number) => ({ id, label: id, count, mine: false });
    const groups = domainGroups([d("software-engineering", 2096), d("travel", 177), d("career-hr", 463), d("home-cooking", 329), d("other", 3), d("space-travel", 5)]);
    expect(groups.map((g) => [g.id, g.domains.map((x) => x.id)])).toEqual([
      ["everyday", ["travel", "home-cooking"]],
      ["work", ["career-hr"]],
      ["making", ["software-engineering"]],
      ["more", ["space-travel"]],
    ]);
  });
});

describe("recent", () => {
  const state = (over: Partial<ItemState>): ItemState => ({ itemId: "x", pinned: false, favorite: false, hidden: false, useCount: 0, lastUsedAt: null, ...over });
  const now = new Date(2026, 9, 14, 12, 0, 0);
  const at = (d: Date) => Math.floor(d.getTime() / 1000);

  it("says used yesterday, opened today, n days ago", () => {
    expect(usedWhen(state({ useCount: 1, lastUsedAt: at(new Date(2026, 9, 13, 23, 0)) }), now)).toEqual({ kind: "yesterday", uses: 1 });
    expect(usedWhen(state({ lastUsedAt: at(new Date(2026, 9, 14, 8, 0)) }), now)).toEqual({ kind: "today", uses: 0 });
    expect(usedWhen(state({ useCount: 3, lastUsedAt: at(new Date(2026, 9, 10, 8, 0)) }), now)).toEqual({ kind: "days", days: 4, uses: 3 });
    expect(usedWhen(state({ pinned: true }), now)).toEqual({ kind: "pinned" });
    expect(usedWhen(undefined, now)).toBeNull();
  });

  it("lists opened and used entries newest first, never hidden ones", () => {
    const list = [state({ itemId: "a", lastUsedAt: 10 }), state({ itemId: "b", lastUsedAt: 30 }), state({ itemId: "c", lastUsedAt: 20, hidden: true }), state({ itemId: "d" })];
    expect(recentIds(list)).toEqual(["b", "a"]);
  });
});

describe("essentials", () => {
  const ess = [hit("plan-a-trip", { door: true, intents: ["plan"], topic: "travel" }), hit("eat-healthier", { door: true, intents: ["plan"], topic: "health", adv: ["medical"] }), hit("write-an-email", { door: true, intents: ["write"], topic: "work" })];

  it("narrow by intent and topic", () => {
    expect(filterEssentials(ess, "plan", null).map((h) => h.id)).toEqual(["plan-a-trip", "eat-healthier"]);
    expect(filterEssentials(ess, "plan", "health").map((h) => h.id)).toEqual(["eat-healthier"]);
    expect(filterEssentials(ess, null, null)).toHaveLength(3);
  });

  it("are suggested while typing, never the routed one twice", () => {
    const route = { to: ess[1], refine: [], phrase: "diet" };
    expect(suggestDoors(ess, null, "plan").map((h) => h.id)).toEqual(["plan-a-trip"]);
    // The routed front door is already the first result: not suggested again.
    expect(suggestDoors(ess, route, "eat").map((h) => h.id)).toEqual([]);
    expect(suggestDoors(ess, null, "eat").map((h) => h.id)).toEqual(["eat-healthier"]);
    expect(suggestDoors(ess, null, "")).toEqual([]);
  });
});

describe("Prompts (⌘J) groups", () => {
  const base = { filter: "all" as const, context: "launcher" as const, mine: [], pinnedHits: [], recent: [], personal: true };

  it("opens on Recent then the Essentials, never an A–Z first page", () => {
    const items = buildItems({ ...base, query: "", recent: [{ hit: hit("review-pull-request"), at: 5 }], essentials: [hit("plan-a-trip", { door: true })], hits: [hit("accept-a-job-offer")] });
    expect(items.filter((i) => i.type === "group").map((i) => (i as { group: string }).group)).toEqual(["recent", "essentials", "forYou"]);
    expect(items[1].key).toBe("lib:review-pull-request");
  });

  it("with a query leads with the front door, then the specialists", () => {
    const items = buildItems({ ...base, query: "plan a 5-day trip to lisbon", essentials: [], best: [hit("plan-a-trip", { door: true })], refine: [hit("plan-itinerary")], hits: [hit("plan-road-trip"), hit("plan-a-trip")] });
    expect(items.map((i) => i.key)).toEqual(["group:best", "lib:plan-a-trip", "group:refine", "lib:plan-itinerary", "group:library", "lib:plan-road-trip"]);
  });
});

describe("The search box's facet hint", () => {
  it("is for developer roles only", () => {
    for (const r of ["software-engineer", "frontend-engineer", "ml-engineer", "tech-lead", "developer"]) expect(isDeveloperRole(r)).toBe(true);
    for (const r of ["traveler", "home-cook", "parent", "product-manager", "designer", "individual"]) expect(isDeveloperRole(r)).toBe(false);
  });

  it("knows a search that used the query language", () => {
    expect(usesFacets("cat:testing")).toBe(true);
    expect(usesFacets("flaky works:codex")).toBe(true);
    expect(usesFacets("plan a trip: lisbon")).toBe(false);
    expect(usesFacets("http://example.test")).toBe(false);
    expect(usesFacets("cat:")).toBe(false);
  });
});
