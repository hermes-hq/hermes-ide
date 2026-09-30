// @vitest-environment jsdom
/**
 * F31 — the status bar's "Copy cost" copies what the bar shows: "n/a" when
 * no agent's cost is known (never "$0.00"), and the known part with its ≈
 * and how many sessions are n/a when only some are known.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";

const h = vi.hoisted(() => ({
  flag: true,
  sessions: [] as unknown[],
  handler: null as ((id: string) => void) | null,
}));

vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn() }));
vi.mock("../api/settings", () => ({
  setSetting: vi.fn(async () => {}),
  getSetting: vi.fn(async () => null),
  getSettings: vi.fn(async () => ({})),
}));
vi.mock("../api/menu", () => ({
  showContextMenu: vi.fn(() => new Promise(() => {})),
  separator: () => ({ type: "separator" as const }),
  menuItem: (id: string, label: string) => ({ type: "item" as const, id, label }),
  subMenu: (label: string, items: unknown[]) => ({ type: "submenu" as const, label, items }),
}));
// The native menu calls back with the chosen item's id.
vi.mock("../hooks/nativeMenuBridge", () => ({
  ensureListener: vi.fn(),
  registerContextMenuHandler: vi.fn((fn: (id: string) => void) => {
    h.handler = fn;
  }),
  clearContextMenuHandler: vi.fn(),
}));
vi.mock("../utils/themeManager", () => ({ DARK_THEMES: [], LIGHT_THEMES: [], applyTheme: vi.fn() }));
vi.mock("../featureFlags", () => ({ isFeatureFlagEnabled: (id: string) => id === "fleetControls" && h.flag }));
vi.mock("../state/SessionContext", () => ({
  useActiveSession: () => null,
  useSessionList: () => h.sessions,
  useTotalCost: () => 0.08,
  useTotalTokens: () => ({ input: 12000, output: 3000 }),
}));

import { StatusBar } from "../components/StatusBar";
import { I18nProvider } from "../i18n/I18nProvider";
import { _resetSessionEventStoreForTest, dispatchSessionEvent } from "../agent/contract/sessionEventStore";

const writeText = vi.fn(async (_text: string) => {});

/** Right-click the cost in the status bar and choose "Copy cost". */
function copyCost(): string {
  const { container } = render(
    <I18nProvider>
      <StatusBar />
    </I18nProvider>,
  );
  const cost = container.querySelector(".status-bar-cost");
  if (!cost) throw new Error("the status bar shows no cost");
  fireEvent.contextMenu(cost);
  expect(h.handler).not.toBeNull();
  act(() => h.handler?.("status.copy-cost"));
  expect(writeText).toHaveBeenCalledTimes(1);
  const copied = writeText.mock.calls[0][0];
  expect(copied).toBe((cost as HTMLElement).textContent);
  return copied;
}

beforeEach(() => {
  _resetSessionEventStoreForTest();
  h.flag = true;
  h.handler = null;
  h.sessions = [
    { id: "s1", label: "priced", ai_provider: "claude", detected_agent: null },
    { id: "s2", label: "unpriced", ai_provider: "codex", detected_agent: null },
  ];
  writeText.mockClear();
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});

afterEach(cleanup);

describe("the status bar's Copy cost", () => {
  it("copies n/a when no agent's cost is known, not $0.00", () => {
    expect(copyCost()).toBe("n/a");
  });

  it("copies the known part with its ≈, its mark and how many sessions are n/a", () => {
    dispatchSessionEvent("s1", { type: "usage", at: 1, source: "transcript:claude", inputTokens: 10, outputTokens: 10, costUsd: 0.37, confidence: "estimated" });
    expect(copyCost()).toBe("≈$0.37 (estimated) · 1 session n/a");
  });

  it("copies the exact total when every cost is known", () => {
    dispatchSessionEvent("s1", { type: "usage", at: 1, inputTokens: 10, outputTokens: 10, costUsd: 0.25 });
    dispatchSessionEvent("s2", { type: "usage", at: 1, inputTokens: 10, outputTokens: 10, costUsd: 0.17 });
    expect(copyCost()).toBe("$0.42");
  });

  it("with the flag off it copies the analyzer's total, as before", () => {
    h.flag = false;
    expect(copyCost()).toBe("$0.08");
  });
});
