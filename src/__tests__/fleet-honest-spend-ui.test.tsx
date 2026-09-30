/**
 * F31 — "No estimated cost appears anywhere" (with the fleetControls flag):
 * the status bar and the session row show only what the agent reported,
 * "n/a" otherwise, even when the terminal analyzer holds an estimate.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ flag: false, sessions: [] as unknown[] }));

vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn() }));
vi.mock("../api/settings", () => ({
  setSetting: vi.fn(async () => {}),
  getSetting: vi.fn(async () => null),
  getSettings: vi.fn(async () => ({})),
}));
vi.mock("../api/menu", () => ({
  showContextMenu: vi.fn(async () => null),
  separator: () => ({ type: "separator" as const }),
  menuItem: (id: string, label: string) => ({ type: "item" as const, id, label }),
  subMenu: (label: string, items: unknown[]) => ({ type: "submenu" as const, label, items }),
}));
vi.mock("../hooks/nativeMenuBridge", () => ({
  ensureListener: vi.fn(),
  registerContextMenuHandler: vi.fn(),
  clearContextMenuHandler: vi.fn(),
}));
vi.mock("../utils/themeManager", () => ({ DARK_THEMES: [], LIGHT_THEMES: [], applyTheme: vi.fn() }));
vi.mock("../featureFlags", () => ({ isFeatureFlagEnabled: (id: string) => id === "fleetControls" && h.flag }));
// The terminal analyzer's numbers: an ESTIMATED $0.08 and 15K tokens read off the screen.
vi.mock("../state/SessionContext", () => ({
  useActiveSession: () => null,
  useSessionList: () => h.sessions,
  useTotalCost: () => 0.08,
  useTotalTokens: () => ({ input: 12000, output: 3000 }),
}));

import { renderToString } from "react-dom/server";
import { StatusBar } from "../components/StatusBar";
import { ProjectSpend, SessionSpendChip } from "../fleet/FleetRowBadges";
import { I18nProvider } from "../i18n/I18nProvider";
import { _resetSessionEventStoreForTest, dispatchSessionEvent } from "../agent/contract/sessionEventStore";
import { _resetCapTripsForTest } from "../fleet/spendCapWatcher";

const bar = () => renderToString(<I18nProvider><StatusBar /></I18nProvider>);
const chip = (id: string, ai_provider: string | null, detected = false) =>
  renderToString(
    <I18nProvider>
      <SessionSpendChip
        session={{ id, ai_provider, detected_agent: detected ? { name: "Claude Code", provider: "anthropic", model: null, detected_at: "", confidence: 0.9 } : null }}
      />
    </I18nProvider>,
  );
const text = (html: string) => html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ").replace(/&lt;/g, "<").replace(/\s+/g, " ");

beforeEach(() => {
  _resetSessionEventStoreForTest();
  _resetCapTripsForTest();
  h.sessions = [{ id: "s1" }, { id: "s2" }];
});

describe("the status bar", () => {
  it("negative control: with the flag off it still shows the analyzer's estimate", () => {
    h.flag = false;
    expect(text(bar())).toContain("$0.08");
  });

  it("with the flag on it never shows the estimate, and shows no cost when no agent reported one", () => {
    h.flag = true;
    const out = text(bar());
    expect(out).not.toContain("$0.08");
    expect(out).not.toMatch(/\$\d/);
    expect(out).not.toContain("15.0K");
  });

  it("with the flag on it adds up exactly what the agents reported", () => {
    h.flag = true;
    dispatchSessionEvent("s1", { type: "usage", at: 1, inputTokens: 1000, outputTokens: 200, costUsd: 0.25 });
    dispatchSessionEvent("s2", { type: "usage", at: 1, inputTokens: 500, outputTokens: null, costUsd: 0.17 });
    const out = text(bar());
    expect(out).toContain("$0.42");
    expect(out).not.toContain("$0.08");
  });
});

describe("the session row's spend", () => {
  it("shows n/a for an agent that reports nothing", () => {
    const html = chip("s1", "codex");
    expect(html).toContain('data-spend="na"');
    expect(text(html)).toContain("n/a");
    expect(text(html)).not.toMatch(/\$/);
  });

  it("shows the reported cost, exactly", () => {
    dispatchSessionEvent("s1", { type: "usage", at: 1, inputTokens: 12000, outputTokens: 3400, costUsd: 1.2345 });
    const html = chip("s1", "claude");
    expect(html).toContain('data-spend="exact"');
    expect(text(html)).toContain("$1.23");
  });

  it("tokens without a cost are still n/a for spend", () => {
    dispatchSessionEvent("s1", { type: "usage", at: 1, inputTokens: 5, outputTokens: 5, costUsd: null });
    expect(chip("s1", "gemini")).toContain('data-spend="na"');
  });

  it("a plain shell with nothing reported shows nothing", () => {
    expect(chip("s1", null)).toBe("");
  });

  it("an agent recognised in a plain terminal shows n/a, not the analyzer's estimate", () => {
    expect(chip("s1", null, true)).toContain('data-spend="na"');
  });
});

// Hermes's estimate from the agent's transcript (a `usage` event with
// confidence "estimated"): shown, and always marked as an estimate — the
// same number in the row, the project header and the status bar.
describe("an estimated cost", () => {
  const estimate = (id: string, costUsd: number | null) =>
    dispatchSessionEvent(id, { type: "usage", at: 1, source: "transcript:claude", inputTokens: 96000, outputTokens: 2100, costUsd, confidence: "estimated" });
  const header = (ids: string[]) =>
    renderToString(<I18nProvider><ProjectSpend sessions={ids.map((id) => ({ id, label: `label-${id}`, agent: true }))} /></I18nProvider>);

  it("the row says ≈$1.23 (estimated), marked as such", () => {
    estimate("s1", 1.2345);
    const html = chip("s1", "claude");
    expect(html).toContain('data-spend="estimated"');
    expect(text(html)).toContain("≈$1.23 (estimated)");
  });

  it("the status bar adds it up and says it is an estimate", () => {
    h.flag = true;
    estimate("s1", 1.0);
    dispatchSessionEvent("s2", { type: "usage", at: 1, inputTokens: 10, outputTokens: 10, costUsd: 0.23 });
    const html = bar();
    expect(html).toContain('data-spend="estimated"');
    expect(text(html)).toContain("≈$1.23 (estimated)");
  });

  it("the project header shows the same sum, and n/a when no cost is known", () => {
    estimate("s1", 1.0);
    dispatchSessionEvent("s2", { type: "usage", at: 1, inputTokens: 10, outputTokens: 10, costUsd: 0.23 });
    expect(text(header(["s1", "s2"]))).toContain("≈$1.23 (estimated)");
    expect(text(header(["s1", "s2"]))).not.toContain("n/a");
    expect(header(["s2"])).toContain('data-spend="exact"');
    expect(text(header(["s2"]))).toContain("$0.23");
    expect(text(header(["s2"]))).not.toContain("estimated");
    estimate("s3", null);
    expect(header(["s3"])).toContain('data-spend="na"');
    expect(text(header(["s3"])).trim()).toBe("n/a");
  });

  it("tokens without a price stay n/a in the row", () => {
    estimate("s1", null);
    const html = chip("s1", "claude");
    expect(html).toContain('data-spend="na"');
    expect(text(html)).not.toContain("estimated");
  });
});

// A project (or the whole app) where one agent's cost is known and
// another's is not: the known sum is shown with how many sessions are n/a,
// never as if it were the total; the tooltip names them.
describe("a total where some sessions' cost is unknown", () => {
  const members = [
    { id: "s1", label: "priced", agent: true },
    { id: "s2", label: "unpriced", agent: true },
    { id: "s3", label: "plain shell", agent: false },
  ];
  const header = () => renderToString(<I18nProvider><ProjectSpend sessions={members} /></I18nProvider>);
  const title = (html: string, cls: string) => new RegExp(`class="[^"]*${cls}[^"]*"[^>]*title="([^"]*)"`).exec(html)?.[1] ?? null;

  beforeEach(() => {
    h.flag = true;
    h.sessions = [
      { id: "s1", label: "priced", ai_provider: "claude", detected_agent: null },
      { id: "s2", label: "unpriced", ai_provider: "codex", detected_agent: null },
      { id: "s3", label: "plain shell", ai_provider: null, detected_agent: null },
    ];
  });

  it("the header and the status bar show the known sum and 1 session n/a", () => {
    dispatchSessionEvent("s1", { type: "usage", at: 1, inputTokens: 10, outputTokens: 10, costUsd: 0.37 });
    // The narrow header counts them short; its tooltip says it in full.
    expect(text(header())).toContain("$0.37 · 1 n/a");
    expect(title(header(), "project-header-cost")).toContain("$0.37 · 1 session n/a");
    expect(text(bar())).toContain("$0.37 · 1 session n/a");
    for (const [html, cls] of [[header(), "project-header-cost"], [bar(), "status-bar-cost"]] as const) {
      expect(html).toContain('data-unknown="1"');
      const tip = title(html, cls) ?? "";
      expect(tip).toContain("No cost known for:");
      expect(tip).toContain("unpriced");
      expect(tip).not.toContain("plain shell");
    }
  });

  it("an estimate in the partial sum keeps the ≈ and the (estimated) mark", () => {
    dispatchSessionEvent("s1", { type: "usage", at: 1, source: "transcript:claude", inputTokens: 10, outputTokens: 10, costUsd: 0.37, confidence: "estimated" });
    expect(text(header())).toContain("≈$0.37 (estimated) · 1 n/a");
    expect(text(bar())).toContain("≈$0.37 (estimated) · 1 session n/a");
  });

  it("a session whose tokens have no price counts as unknown too; two are counted as two", () => {
    dispatchSessionEvent("s1", { type: "usage", at: 1, inputTokens: 10, outputTokens: 10, costUsd: 0.37 });
    dispatchSessionEvent("s3", { type: "usage", at: 1, source: "transcript:claude", inputTokens: 5, outputTokens: 5, costUsd: null, confidence: "estimated" });
    expect(text(header())).toContain("$0.37 · 2 n/a");
    expect(title(header(), "project-header-cost")).toContain("$0.37 · 2 sessions n/a");
  });

  it("when no cost is known at all, both say n/a", () => {
    expect(text(header()).trim()).toBe("n/a");
    expect(header()).toContain('data-spend="na"');
    const out = text(bar());
    expect(out).toContain("n/a");
    expect(out).not.toMatch(/\$\d/);
  });

  it("the known sum alone never passes for the total", () => {
    dispatchSessionEvent("s1", { type: "usage", at: 1, inputTokens: 10, outputTokens: 10, costUsd: 0.37 });
    expect(text(header()).trim()).not.toBe("$0.37");
    expect(text(bar())).not.toMatch(/\$0\.37(?! ·)/);
  });
});
