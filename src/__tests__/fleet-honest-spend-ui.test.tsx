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
import { SessionSpendChip } from "../fleet/FleetRowBadges";
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
