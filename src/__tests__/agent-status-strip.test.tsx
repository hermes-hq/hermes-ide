/**
 * F10 — the status strip (StatusBar) shows the active session's derived
 * status as glyph + word when the flag is on, and the old phase capsules
 * when it is off.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn(async () => "1.4.0") }));
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

let currentSession: SessionData | null = null;
vi.mock("../state/SessionContext", () => ({
  useActiveSession: () => currentSession,
  useSessionList: () => (currentSession ? [currentSession] : []),
  useTotalCost: () => 0,
  useTotalTokens: () => ({ input: 0, output: 0 }),
}));

import { renderToString } from "react-dom/server";
import type { SessionData } from "../types/session";
import { StatusBar } from "../components/StatusBar";
import { I18nProvider } from "../i18n/I18nProvider";
import { initFeatureFlags, __resetFeatureFlagsForTest, FEATURE_FLAG_OVERRIDES_KEY } from "../featureFlags";
import { _resetSessionEventStoreForTest, dispatchSessionEvent } from "../agent/contract/sessionEventStore";
import { _resetAttentionStoreForTest } from "../agent/status/attentionStore";

async function setFlag(on: boolean) {
  __resetFeatureFlagsForTest();
  await initFeatureFlags({ [FEATURE_FLAG_OVERRIDES_KEY]: JSON.stringify({ launchHelper: on }) });
}

function session(phase: string): SessionData {
  return {
    id: "s1",
    label: "s1",
    description: "",
    color: "",
    group: null,
    phase,
    working_directory: "/work/p",
    shell: "/bin/zsh",
    created_at: new Date().toISOString(),
    last_activity_at: new Date().toISOString(),
    workspace_paths: [],
    detected_agent: { name: "Agent", provider: "x", model: null, detected_at: "", confidence: 1 },
    metrics: {} as SessionData["metrics"],
    ai_provider: "x",
    auto_approve: false,
    permission_mode: "default",
    custom_prefix: "",
    custom_suffix: "",
    channels: [],
    context_injected: false,
    ssh_info: null,
    mode: "terminal",
  };
}

const render = () =>
  renderToString(
    <I18nProvider>
      <StatusBar />
    </I18nProvider>,
  );

afterEach(() => {
  __resetFeatureFlagsForTest();
  _resetSessionEventStoreForTest();
  _resetAttentionStoreForTest();
});

describe("status strip", () => {
  it("flag off: the old phase capsule, no status tag", async () => {
    await setFlag(false);
    currentSession = session("needs_input");
    const html = render();
    expect(html).toContain("status-capsule-needs");
    expect(html).not.toContain("agent-status-tag");
  });

  it("flag on: the derived status as glyph + word, with the detail in the tooltip; no phase capsule", async () => {
    await setFlag(true);
    currentSession = session("idle"); // the PTY heuristic says idle ("ready")...
    dispatchSessionEvent("s1", {
      type: "status",
      at: 1,
      source: "hook:x",
      status: { kind: "needs_approval", confidence: "exact", detail: "Bash: npm test" },
    });
    dispatchSessionEvent("s1", { type: "status", at: 2, source: "pty", status: { kind: "idle", confidence: "guessed", detail: "" } });
    const html = render();
    // ...but the agent said it waits on an approval, and that wins.
    expect(html).toContain('data-status="needs_approval"');
    expect(html).toContain(">!</span>");
    expect(html).toContain(">needs approval</span>");
    expect(html).toContain("Bash: npm test");
    expect(html).not.toContain("status-capsule");
  });

  it("flag on: a status that needs a person is announced assertively, others politely", async () => {
    await setFlag(true);
    currentSession = session("busy");
    dispatchSessionEvent("s1", { type: "status", at: 1, source: "hook:x", status: { kind: "working", confidence: "exact", detail: "" } });
    expect(render()).toMatch(/status-bar-agent-status" role="status" aria-live="polite"/);
    for (const kind of ["needs_approval", "needs_answer", "gate", "check_failed", "error", "limited"] as const) {
      dispatchSessionEvent("s1", { type: "status", at: 2, source: "hook:x", status: { kind, confidence: "exact", detail: "" } });
      const html = render();
      expect(html).toContain(`data-status="${kind}"`);
      expect(html).toMatch(/status-bar-agent-status" role="status" aria-live="assertive"/);
    }
    dispatchSessionEvent("s1", { type: "status", at: 3, source: "hook:x", status: { kind: "plan_ready", confidence: "exact", detail: "" } });
    expect(render()).toMatch(/status-bar-agent-status" role="status" aria-live="polite"/);
  });
});
