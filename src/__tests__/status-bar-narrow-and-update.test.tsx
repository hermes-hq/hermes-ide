// @vitest-environment jsdom
/**
 * CHAOS-15 and CHAOS-08 — the status bar in a narrow window folds Check for
 * updates, Report a Bug and Keyboard Shortcuts into a "⋯" menu and drops the
 * folder name and the age; the version chip says "Checking…" while a check
 * the person asked for runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const h = vi.hoisted(() => ({ narrow: false, open: vi.fn() }));

vi.mock("@tauri-apps/plugin-shell", () => ({ open: h.open }));
vi.mock("../api/settings", () => ({ setSetting: vi.fn(async () => {}), getSetting: vi.fn(async () => null), getSettings: vi.fn(async () => ({})) }));
vi.mock("../api/menu", () => ({
  showContextMenu: vi.fn(() => new Promise(() => {})),
  separator: () => ({ type: "separator" as const }),
  menuItem: (id: string, label: string) => ({ type: "item" as const, id, label }),
  subMenu: (label: string, items: unknown[]) => ({ type: "submenu" as const, label, items }),
}));
vi.mock("../hooks/nativeMenuBridge", () => ({ ensureListener: vi.fn(), registerContextMenuHandler: vi.fn(), clearContextMenuHandler: vi.fn() }));
vi.mock("../utils/themeManager", () => ({ DARK_THEMES: [], LIGHT_THEMES: [], applyTheme: vi.fn() }));
vi.mock("../featureFlags", () => ({ isFeatureFlagEnabled: () => false }));
vi.mock("../state/SessionContext", () => ({
  useActiveSession: () => ({ id: "s1", label: "s1", working_directory: "/srv/demo/demo-repo", created_at: new Date().toISOString(), mode: "terminal", phase: "idle", detected_agent: null }),
  useSessionList: () => [{ id: "s1" }],
  useTotalCost: () => 0,
  useTotalTokens: () => ({ input: 0, output: 0 }),
}));

import { StatusBar } from "../components/StatusBar";
import { I18nProvider } from "../i18n/I18nProvider";

beforeEach(() => {
  h.narrow = false;
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("max-width") ? h.narrow : false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function bar(props: Partial<Parameters<typeof StatusBar>[0]> = {}) {
  const onCheckForUpdates = vi.fn();
  const onOpenShortcuts = vi.fn();
  render(
    <I18nProvider>
      <StatusBar onCheckForUpdates={onCheckForUpdates} onOpenShortcuts={onOpenShortcuts} {...props} />
    </I18nProvider>,
  );
  return { onCheckForUpdates, onOpenShortcuts };
}

describe("the status bar in a wide window", () => {
  it("shows the folder, the age, the version chip and both buttons; no ⋯", () => {
    bar();
    expect(document.querySelector(".status-bar-cwd")).toHaveTextContent("demo-repo");
    expect(document.querySelector(".status-bar-elapsed")).not.toBeNull();
    expect(document.querySelector(".status-version-chip")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Report a Bug" })).toBeInTheDocument();
    expect(document.querySelector(".status-more-btn")).toBeNull();
  });

  it("says Checking… on the version chip while a check runs, and the chip does nothing meanwhile", () => {
    const { onCheckForUpdates } = bar({ updateChecking: true });
    const chip = document.querySelector(".status-version-chip")!;
    expect(chip).toHaveAttribute("data-state", "checking");
    expect(chip).toHaveAttribute("aria-busy", "true");
    expect(chip).toHaveTextContent("Checking…");
    fireEvent.click(chip);
    expect(onCheckForUpdates).not.toHaveBeenCalled();
  });
});

describe("the status bar in a narrow window (under 760 px)", () => {
  it("drops the folder and the age and folds the three controls into ⋯", () => {
    h.narrow = true;
    const { onCheckForUpdates, onOpenShortcuts } = bar();
    expect(document.querySelector(".status-bar-cwd")).toBeNull();
    expect(document.querySelector(".status-bar-elapsed")).toBeNull();
    expect(document.querySelector(".status-version-chip")).toBeNull();
    expect(document.querySelector(".status-bug-btn")).toBeNull();
    expect(document.querySelector(".status-shortcuts-btn")).toBeNull();
    const more = screen.getByRole("button", { name: "More" });
    fireEvent.click(more);
    const items = screen.getAllByRole("menuitem").map((i) => i.textContent);
    expect(items[0]).toContain("Check for updates");
    expect(items[1]).toContain("Report a Bug");
    expect(items[2]).toContain("Keyboard Shortcuts");
    fireEvent.click(screen.getAllByRole("menuitem")[0]);
    expect(onCheckForUpdates).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    fireEvent.click(screen.getAllByRole("menuitem")[2]);
    expect(onOpenShortcuts).toHaveBeenCalledTimes(1);
  });

  it("keeps a chip with news (an update ready) on the bar", () => {
    h.narrow = true;
    bar({ updateAvailable: true, updateVersion: "9.9.9" });
    expect(document.querySelector(".status-version-chip")).toHaveAttribute("data-state", "available");
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent).join(" ")).not.toContain("Check for updates");
  });
});
