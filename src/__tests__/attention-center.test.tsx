// @vitest-environment jsdom
/**
 * F12 + N16 — the attention center, rendered: the badge counts sessions
 * blocked on you, ⌘I visits them oldest first and wraps, the inbox is a
 * keyboard-only listbox (↑↓, Space peek, Enter jump, M mute, Esc), the
 * focused session never notifies, away messages carry only agent/task/state,
 * the OS badge follows the count and the machine is kept awake exactly while
 * a session works.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act, fireEvent, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const h = vi.hoisted(() => ({
  setAttentionBadge: vi.fn(async (_count: number) => "dock-badge"),
  setKeepAwake: vi.fn(async (_active: boolean) => "caffeinate"),
  sendAwayNotification: vi.fn(async (_payload: unknown) => ({ outcome: "sent", status: 200, target: "webhook" })),
  notifyAttention: vi.fn((_title: string, _body: string) => true),
}));

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("../api/settings", () => ({ getSetting: vi.fn(async () => ""), setSetting: vi.fn(async () => {}) }));
vi.mock("../api/attention", () => ({
  AWAY_NOTIFY_URL_KEY: "away_notify_url",
  setAttentionBadge: h.setAttentionBadge,
  setKeepAwake: h.setKeepAwake,
  sendAwayNotification: h.sendAwayNotification,
}));
vi.mock("../utils/notifications", () => ({ notifyAttention: h.notifyAttention }));

import { AttentionCenter } from "../components/AttentionCenter";
import { I18nProvider } from "../i18n/I18nProvider";
import { _resetInboxForTest, listInboxItems } from "../agent/contract/inbox";
import { _resetSessionEventStoreForTest, dispatchSessionEvent } from "../agent/contract/sessionEventStore";
import type { AgentStatusKind } from "../agent/contract/status";
import { _resetMutesForTest } from "../attention/mutes";
import { setWindowFocusOverride } from "../attention/windowFocus";
import { attentionDebug } from "../attention/debug";
import { isMac } from "../utils/platform";
import type { SessionData } from "../types/session";

let clock = 1_000_000;

function session(id: string, label: string): SessionData {
  return { id, label, ai_provider: "claude", agent_name: "", detected_agent: null } as unknown as SessionData;
}

const SESSIONS: Record<string, SessionData> = {
  A: session("A", "alpha-task"),
  B: session("B", "bravo-task"),
  C: session("C", "charlie-task"),
  D: session("D", "delta-task"),
};

function status(id: string, kind: AgentStatusKind, detail = "") {
  act(() => {
    dispatchSessionEvent(id, { type: "status", at: clock, status: { kind, confidence: "exact", detail } });
  });
}

function pressNext() {
  act(() => {
    fireEvent.keyDown(window, isMac ? { key: "i", metaKey: true } : { key: "I", ctrlKey: true, shiftKey: true });
  });
}

function pressInbox() {
  act(() => {
    fireEvent.keyDown(window, isMac ? { key: "I", metaKey: true, shiftKey: true } : { key: "A", ctrlKey: true, shiftKey: true });
  });
}

function setup(active: string | null = null) {
  const onJump = vi.fn();
  let current = active;
  const ui = render(
    <I18nProvider>
      <AttentionCenter sessions={SESSIONS} activeSessionId={current} onJump={onJump} />
    </I18nProvider>,
  );
  onJump.mockImplementation((id: string) => {
    current = id;
    ui.rerender(
      <I18nProvider>
        <AttentionCenter sessions={SESSIONS} activeSessionId={current} onJump={onJump} />
      </I18nProvider>,
    );
  });
  const badge = () => screen.getByRole("button", { name: /Attention inbox/ });
  return { ui, onJump, badge };
}

beforeEach(() => {
  clock = Date.now();
  _resetInboxForTest(() => clock);
  _resetSessionEventStoreForTest();
  _resetMutesForTest(() => clock);
  setWindowFocusOverride(null);
  attentionDebug.os.length = 0;
  attentionDebug.away.length = 0;
  attentionDebug.badge.length = 0;
  attentionDebug.keepAwake.length = 0;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
  for (const f of Object.values(h)) f.mockClear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("F12 attention center", () => {
  it("counts three blocked sessions on the badge and the OS badge, and ⌘I visits them oldest first, wrapping", () => {
    const { onJump, badge } = setup("D");
    expect(badge()).toHaveAttribute("data-count", "0");
    status("B", "needs_approval", "Bash: npm publish");
    clock += 1_000;
    status("C", "needs_answer", "Which database?");
    clock += 1_000;
    status("A", "plan_ready");
    expect(badge()).toHaveAttribute("data-count", "3");
    expect(h.setAttentionBadge).toHaveBeenLastCalledWith(3);

    for (let i = 0; i < 4; i++) pressNext();
    expect(onJump.mock.calls.map((c) => c[0])).toEqual(["B", "C", "A", "B"]);

    status("B", "working");
    expect(badge()).toHaveAttribute("data-count", "2");
    expect(h.setAttentionBadge).toHaveBeenLastCalledWith(2);
  });

  it("the inbox is a listbox driven by the keyboard: groups, order, peek, mute, jump", () => {
    const { onJump, badge } = setup("D");
    status("B", "needs_approval", "Bash: rm -rf build");
    clock += 1_000;
    status("A", "needs_answer", "Ship it?");
    clock += 1_000;
    status("C", "done_unread");

    pressInbox();
    const list = screen.getByRole("listbox", { name: "Attention inbox" });
    expect(list).toHaveFocus();
    const groups = within(list).getAllByRole("group");
    expect(groups.map((g) => g.getAttribute("data-section"))).toEqual(["blocked", "ready"]);
    const options = within(list).getAllByRole("option");
    expect(options.map((o) => o.getAttribute("data-session-id"))).toEqual(["B", "A", "C"]);
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    expect(list).toHaveAttribute("aria-activedescendant", options[0].id);
    expect(screen.getByRole("status")).toHaveTextContent("2 blocked on you, 1 ready for you");

    // Space peeks at the request detail, read-only.
    fireEvent.keyDown(list, { key: " " });
    const peek = screen.getByRole("region", { name: "Request detail (read-only)" });
    expect(peek).toHaveTextContent("Bash: rm -rf build");
    expect(within(peek).queryByRole("textbox")).toBeNull();
    expect(within(peek).queryByRole("button")).toBeNull();
    fireEvent.keyDown(list, { key: "Escape" });
    expect(screen.queryByRole("region", { name: "Request detail (read-only)" })).toBeNull();

    // ↓ then M mutes A: it stays listed, leaves the count and the ⌘I cycle.
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(within(list).getAllByRole("option")[1]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(list, { key: "m" });
    expect(within(list).getAllByRole("option")[1]).toHaveAttribute("data-muted", "true");
    expect(badge()).toHaveAttribute("data-count", "1");
    expect(screen.getByRole("status")).toHaveTextContent("alpha-task muted for 1 hour");

    // Enter jumps to the selected pane and closes the inbox.
    fireEvent.keyDown(list, { key: "ArrowUp" });
    fireEvent.keyDown(list, { key: "Enter" });
    expect(onJump).toHaveBeenLastCalledWith("B");
    expect(screen.queryByRole("listbox")).toBeNull();

    // With A muted, ⌘I only has B.
    onJump.mockClear();
    pressNext();
    pressNext();
    expect(onJump.mock.calls.map((c) => c[0])).toEqual(["B", "B"]);
  });

  it("never notifies for the session you look at in a focused window; others notify once and go away minimal", () => {
    setup("A");
    setWindowFocusOverride(true);
    status("A", "needs_approval", "Bash: cat notes/zebra-plan.md");
    status("B", "needs_approval", "Edit src/otter.ts: export const plan = 'walrus'");
    expect(h.notifyAttention).toHaveBeenCalledTimes(1);
    expect(h.notifyAttention.mock.calls[0][1]).toContain("bravo-task");
    const decisions = attentionDebug.notifier!.log().map((e) => [e.sessionId, e.decision]);
    expect(decisions).toEqual([
      ["A", "suppressed-focused"],
      ["B", "sent"],
    ]);
    expect(h.sendAwayNotification).toHaveBeenCalledTimes(1);
    const payload = h.sendAwayNotification.mock.calls[0][0] as Record<string, string>;
    expect(Object.keys(payload).sort()).toEqual(["agent", "state", "task"]);
    expect(payload.task).toBe("bravo-task");
    expect(payload.state).toBe("needs_approval");
    expect(JSON.stringify(payload)).not.toMatch(/zebra|otter|walrus|export const/);

    // The same session asking again while its item is open: grouped.
    status("B", "needs_answer", "Really?");
    expect(h.notifyAttention).toHaveBeenCalledTimes(1);
  });

  it("reads a ready item when you look at its session", () => {
    const { ui, onJump } = setup("D");
    setWindowFocusOverride(true);
    status("C", "done_unread");
    expect(listInboxItems().map((i) => i.kind)).toEqual(["ready"]);
    onJump("C");
    ui.rerender(
      <I18nProvider>
        <AttentionCenter sessions={SESSIONS} activeSessionId="C" onJump={onJump} />
      </I18nProvider>,
    );
    expect(listInboxItems()).toEqual([]);
  });

  it("keeps the machine awake exactly while a session works", () => {
    setup(null);
    expect(h.setKeepAwake.mock.calls.map((c) => c[0])).toEqual([false]);
    status("A", "working");
    status("B", "working");
    status("A", "idle");
    expect(h.setKeepAwake.mock.calls.map((c) => c[0])).toEqual([false, true]);
    status("B", "done_unread");
    expect(h.setKeepAwake.mock.calls.map((c) => c[0])).toEqual([false, true, false]);
  });

  it("forgets a session that closed", () => {
    const { ui, badge } = setup(null);
    status("A", "needs_approval");
    expect(badge()).toHaveAttribute("data-count", "1");
    const rest = { ...SESSIONS };
    delete rest.A;
    ui.rerender(
      <I18nProvider>
        <AttentionCenter sessions={rest} activeSessionId={null} onJump={() => {}} />
      </I18nProvider>,
    );
    expect(listInboxItems()).toEqual([]);
    expect(badge()).toHaveAttribute("data-count", "0");
  });
});
