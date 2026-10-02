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
  setAttentionBadge: vi.fn(async (_count: number, _notices?: number) => "dock-badge"),
  setKeepAwake: vi.fn(async (_active: boolean) => "caffeinate"),
  sendAwayNotification: vi.fn(async (_payload: unknown) => ({ outcome: "sent", status: 200, target: "webhook" })),
  notifyAttention: vi.fn((_title: string, _body: string) => true),
}));

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("../api/settings", () => ({ getSetting: vi.fn(async () => ""), getSettings: vi.fn(async () => ({})), setSetting: vi.fn(async () => {}) }));
vi.mock("../api/git", () => ({ listAllWorktrees: vi.fn(async () => []) }));
vi.mock("../api/attention", () => ({
  AWAY_NOTIFY_URL_KEY: "away_notify_url",
  setAttentionBadge: h.setAttentionBadge,
  setKeepAwake: h.setKeepAwake,
  sendAwayNotification: h.sendAwayNotification,
}));
vi.mock("../utils/notifications", () => ({ notifyAttention: h.notifyAttention }));

import { AttentionCenter } from "../components/AttentionCenter";
import { I18nProvider } from "../i18n/I18nProvider";
import { _resetInboxForTest, listInboxItems, raiseInboxItem } from "../agent/contract/inbox";
import { _resetAwayPrefsForTest, applyAwayPref } from "../attention/awayPrefs";
import { _resetAwayLastForTest, getAwayLast } from "../attention/awayStatus";
import { _resetSessionEventStoreForTest, dispatchSessionEvent } from "../agent/contract/sessionEventStore";
import type { AgentStatusKind } from "../agent/contract/status";
import { _resetMutesForTest } from "../attention/mutes";
import { setWindowFocusOverride } from "../attention/windowFocus";
import { attentionDebug } from "../attention/debug";
import { _resetUserLabelsForTest, rememberUserLabel } from "../attention/userLabels";
import { _resetStartupSessionsForTest, markStartupSession } from "../attention/startupSessions";
import { isMac } from "../utils/platform";
import { openOverlays, overlayOpened } from "../state/overlays";
import type { SessionData } from "../types/session";

let clock = 1_000_000;
/** These tests are not about the morning view (the inbox opening by itself at startup). */
const notAtStart = () => false;

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
      <AttentionCenter canOpenOnStart={notAtStart} sessions={SESSIONS} activeSessionId={current} onJump={onJump} />
    </I18nProvider>,
  );
  onJump.mockImplementation((id: string) => {
    current = id;
    ui.rerender(
      <I18nProvider>
        <AttentionCenter canOpenOnStart={notAtStart} sessions={SESSIONS} activeSessionId={current} onJump={onJump} />
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
  _resetUserLabelsForTest();
  _resetAwayPrefsForTest();
  _resetAwayLastForTest();
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
    expect(h.setAttentionBadge).toHaveBeenLastCalledWith(3, 0);

    for (let i = 0; i < 4; i++) pressNext();
    expect(onJump.mock.calls.map((c) => c[0])).toEqual(["B", "C", "A", "B"]);

    status("B", "working");
    expect(badge()).toHaveAttribute("data-count", "2");
    expect(h.setAttentionBadge).toHaveBeenLastCalledWith(2, 0);
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

  it("rows are 44 px ListRows: ↓ moves the highlight, the session in view is the current row; the count is brass only while something waits", () => {
    const { badge } = setup("A");
    const counter = () => badge().querySelector(".h-counter");
    expect(counter()).toHaveAttribute("data-tone", "neutral");
    status("B", "needs_approval", "Bash: rm -rf build");
    clock += 1_000;
    status("A", "needs_answer", "Ship it?");
    expect(counter()).toHaveAttribute("data-tone", "attention");
    expect(counter()).toHaveTextContent("2");

    pressInbox();
    const list = screen.getByRole("listbox", { name: "Attention inbox" });
    const options = () => within(list).getAllByRole("option");
    for (const o of options()) expect(o).toHaveClass("h-row", "h-row--lg");
    // B waited longest: it is highlighted first; A is the session in view.
    expect(options().map((o) => o.getAttribute("data-session-id"))).toEqual(["B", "A"]);
    expect(options()[0]).toHaveAttribute("data-highlighted");
    expect(options()[0]).not.toHaveAttribute("data-current");
    expect(options()[1]).toHaveAttribute("data-current");
    expect(options()[1]).toHaveAttribute("aria-current", "true");
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(options()[0]).not.toHaveAttribute("data-highlighted");
    expect(options()[1]).toHaveAttribute("data-highlighted");
    expect(list).toHaveAttribute("aria-activedescendant", options()[1].id);
  });

  it("no OS notification for the session you look at in a focused window; others notify once and go away minimal", () => {
    rememberUserLabel("B", "bravo-task");
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
    // Hermes is in front of the person: the away messages wait (2 min by
    // default) and go once the window loses the focus: B's, and A's too (a
    // focused window on A did not mean someone was sitting at it).
    expect(h.sendAwayNotification).not.toHaveBeenCalled();
    act(() => setWindowFocusOverride(false));
    expect(h.sendAwayNotification).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(h.sendAwayNotification.mock.calls)).not.toMatch(/zebra|otter|walrus|export const/);
    const payload = h.sendAwayNotification.mock.calls.map((c) => c[0] as Record<string, string>).find((p) => p.task === "bravo-task")!;
    expect(Object.keys(payload).sort()).toEqual(["agent", "state", "task", "where"]);
    expect(payload.task).toBe("bravo-task");
    expect(payload.state).toBe("needs_approval");
    expect(JSON.stringify(payload)).not.toMatch(/zebra|otter|walrus|export const/);

    // The same session asking again while its item is open: grouped.
    status("B", "needs_answer", "Really?");
    expect(h.notifyAttention).toHaveBeenCalledTimes(1);
  });

  it("keeps the keyboard when the window regains focus, and tells the app it is open", () => {
    const onOpenChange = vi.fn();
    const { ui } = setup("D");
    ui.rerender(
      <I18nProvider>
        <AttentionCenter canOpenOnStart={notAtStart} sessions={SESSIONS} activeSessionId="D" onJump={() => {}} onOpenChange={onOpenChange} />
      </I18nProvider>,
    );
    const xterm = document.createElement("div");
    xterm.className = "xterm";
    const terminal = document.createElement("textarea");
    xterm.appendChild(terminal);
    document.body.appendChild(xterm);
    status("B", "needs_approval");
    pressInbox();
    const list = screen.getByRole("listbox", { name: "Attention inbox" });
    expect(list).toHaveFocus();
    expect(onOpenChange).toHaveBeenLastCalledWith(true);

    // Something behind the inbox grabs the keyboard as the window comes back.
    terminal.focus();
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(list).toHaveFocus();
    terminal.focus();
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(list).toHaveFocus();

    // A terminal taking the focus on its own (a pane finishing its layout):
    // handed back at once, without waiting for a frame.
    vi.stubGlobal("requestAnimationFrame", () => 0);
    act(() => {
      terminal.focus();
    });
    expect(list).toHaveFocus();
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
    // Another dialog's field is left alone.
    const field = document.createElement("input");
    document.body.appendChild(field);
    act(() => {
      field.focus();
    });
    expect(field).toHaveFocus();
    field.remove();
    act(() => {
      list.focus();
    });

    fireEvent.keyDown(list, { key: "Escape" });
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    // Closed, it leaves the keyboard alone.
    terminal.focus();
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(terminal).toHaveFocus();
    xterm.remove();
  });

  describe("closing gives the keyboard back to the terminal it came from", () => {
    function terminalInPage() {
      const xterm = document.createElement("div");
      xterm.className = "xterm";
      const terminal = document.createElement("textarea");
      xterm.appendChild(terminal);
      document.body.appendChild(xterm);
      return { terminal, remove: () => xterm.remove() };
    }

    it("Esc", () => {
      setup("D");
      const { terminal, remove } = terminalInPage();
      status("B", "needs_approval");
      terminal.focus();
      pressInbox();
      const list = screen.getByRole("listbox", { name: "Attention inbox" });
      expect(list).toHaveFocus();
      act(() => {
        fireEvent.keyDown(list, { key: "Escape" });
      });
      expect(screen.queryByRole("listbox")).toBeNull();
      expect(document.activeElement).not.toBe(document.body);
      expect(terminal).toHaveFocus();
      remove();
    });

    it("the shortcut that opened it", () => {
      setup("D");
      const { terminal, remove } = terminalInPage();
      status("B", "needs_approval");
      terminal.focus();
      pressInbox();
      expect(screen.getByRole("listbox", { name: "Attention inbox" })).toHaveFocus();
      pressInbox();
      expect(screen.queryByRole("listbox")).toBeNull();
      expect(terminal).toHaveFocus();
      remove();
    });

    it("the badge, also when clicking the badge took the focus first", () => {
      const { badge } = setup("D");
      const { terminal, remove } = terminalInPage();
      status("B", "needs_approval");
      terminal.focus();
      // A click focuses the button it lands on (WebKitGTK, Chromium) before it opens the inbox.
      act(() => {
        badge().focus();
        fireEvent.click(badge());
      });
      expect(screen.getByRole("listbox", { name: "Attention inbox" })).toHaveFocus();
      act(() => {
        badge().focus();
        fireEvent.click(badge());
      });
      expect(screen.queryByRole("listbox")).toBeNull();
      expect(terminal).toHaveFocus();
      remove();
    });

    it("a terminal that is gone: the session in view gets the keyboard", () => {
      const { onJump } = setup("D");
      const { terminal, remove } = terminalInPage();
      status("B", "needs_approval");
      terminal.focus();
      pressInbox();
      remove();
      act(() => {
        fireEvent.keyDown(screen.getByRole("listbox", { name: "Attention inbox" }), { key: "Escape" });
      });
      expect(onJump).toHaveBeenLastCalledWith("D");
    });
  });

  it("one overlay at a time: the palette opening closes the inbox, and the inbox opening closes the palette", () => {
    setup("D");
    status("B", "needs_approval");
    pressInbox();
    expect(screen.getByRole("listbox", { name: "Attention inbox" })).toBeInTheDocument();
    expect(openOverlays()).toEqual(["inbox"]);
    const closePalette = vi.fn();
    let paletteClosed: () => void = () => {};
    act(() => {
      paletteClosed = overlayOpened("palette", closePalette);
    });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(openOverlays()).toEqual(["palette"]);
    expect(closePalette).not.toHaveBeenCalled();
    pressInbox();
    expect(screen.getByRole("listbox", { name: "Attention inbox" })).toBeInTheDocument();
    expect(closePalette).toHaveBeenCalledTimes(1);
    paletteClosed();
    expect(openOverlays()).toEqual(["inbox"]);
    pressInbox();
    expect(openOverlays()).toEqual([]);
  });

  it("an auto-named session's away message carries no task name", () => {
    const named = { ...SESSIONS, E: session("E", "Rotate the walrus-prod password") };
    render(
      <I18nProvider>
        <AttentionCenter canOpenOnStart={notAtStart} sessions={named} activeSessionId={null} onJump={() => {}} />
      </I18nProvider>,
    );
    setWindowFocusOverride(false);
    status("E", "needs_approval");
    expect(h.sendAwayNotification).toHaveBeenCalledTimes(1);
    const payload = h.sendAwayNotification.mock.calls[0][0] as Record<string, string>;
    expect(payload.task).toBe("");
    expect(JSON.stringify(payload)).not.toContain("walrus");
  });

  it("reads a ready item when you look at its session", () => {
    const { ui, onJump } = setup("D");
    setWindowFocusOverride(true);
    status("C", "done_unread");
    expect(listInboxItems().map((i) => i.kind)).toEqual(["ready"]);
    onJump("C");
    ui.rerender(
      <I18nProvider>
        <AttentionCenter canOpenOnStart={notAtStart} sessions={SESSIONS} activeSessionId="C" onJump={onJump} />
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
        <AttentionCenter canOpenOnStart={notAtStart} sessions={rest} activeSessionId={null} onJump={() => {}} />
      </I18nProvider>,
    );
    expect(listInboxItems()).toEqual([]);
    expect(badge()).toHaveAttribute("data-count", "0");
  });
});

describe("morning view and ⌘I position", () => {
  beforeEach(() => {
    _resetStartupSessionsForTest();
    // B, C and D were restored when Hermes started; A is started later.
    for (const id of ["B", "C", "D"]) markStartupSession(id);
  });

  function mount(opts: { canOpen?: () => boolean; onStartTasks?: () => void; active?: string | null } = {}) {
    const onJump = vi.fn();
    const view = (active: string | null) => (
      <I18nProvider>
        <AttentionCenter sessions={SESSIONS} activeSessionId={active} onJump={onJump} canOpenOnStart={opts.canOpen} onStartTasks={opts.onStartTasks} />
      </I18nProvider>
    );
    const ui = render(view(opts.active ?? null));
    return { ui, onJump, view };
  }

  it("opens by itself on the agents blocked at startup, oldest first, each with its place and how sure the status is", () => {
    const onStartTasks = vi.fn();
    mount({ onStartTasks });
    status("B", "needs_approval", "Bash: npm install");
    clock += 1_000;
    status("C", "needs_answer", "Pin the timezone?");
    const dialog = screen.getByRole("dialog", { name: "Attention inbox" });
    expect(dialog).toHaveAttribute("data-morning", "true");
    expect(within(dialog).getByText("2 agents are waiting on you")).toBeInTheDocument();
    const options = within(dialog).getAllByRole("option");
    expect(options.map((o) => o.getAttribute("data-session-id"))).toEqual(["B", "C"]);
    expect(options.map((o) => o.querySelector(".attention-option-place")?.textContent)).toEqual(["1 of 2 waiting", "2 of 2 waiting"]);
    expect(options.map((o) => o.querySelector(".attention-option-confidence")?.getAttribute("data-confidence"))).toEqual(["exact", "exact"]);
    fireEvent.click(within(dialog).getByRole("button", { name: /Start today's tasks/ }));
    expect(onStartTasks).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog", { name: "Attention inbox" })).toBeNull();
  });

  it("opens only once, and not while something else has the screen", () => {
    let busy = true;
    mount({ canOpen: () => !busy });
    status("B", "needs_approval");
    expect(screen.queryByRole("dialog")).toBeNull();
    busy = false;
    clock += 1_000;
    status("C", "needs_answer");
    expect(screen.getByRole("dialog")).toHaveAttribute("data-morning", "true");
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    clock += 1_000;
    status("A", "needs_approval");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("stays closed for a session started after Hermes started, even at once", () => {
    mount();
    status("A", "needs_approval");
    expect(screen.queryByRole("dialog")).toBeNull();
    status("B", "needs_approval");
    expect(screen.getByRole("dialog")).toHaveAttribute("data-morning", "true");
  });

  it("stays closed for an agent that gets blocked later in the day", () => {
    const now = Date.now();
    const spy = vi.spyOn(Date, "now").mockReturnValue(now);
    mount();
    spy.mockReturnValue(now + 10 * 60_000);
    status("B", "needs_approval");
    expect(screen.queryByRole("dialog")).toBeNull();
    spy.mockRestore();
  });

  it("⌘I says where in the line the agent it jumped to is", () => {
    const { ui, onJump, view } = mount({ canOpen: () => false });
    status("B", "needs_approval");
    clock += 1_000;
    status("C", "needs_answer");
    clock += 1_000;
    status("A", "plan_ready");
    pressNext();
    expect(onJump).toHaveBeenLastCalledWith("B");
    expect(document.querySelector(".attention-position")?.textContent).toBe("1 of 3 waiting");
    ui.rerender(view("B"));
    pressNext();
    expect(onJump).toHaveBeenLastCalledWith("C");
    expect(document.querySelector(".attention-position")?.textContent).toBe("2 of 3 waiting");
  });

  it("calls agents agents and Hermes notices notices in the morning title", () => {
    mount();
    act(() => {
      raiseInboxItem({ kind: "error", sessionId: null, detail: "Only 2 GB left", source: "worktree" });
    });
    status("B", "needs_approval");
    clock += 1_000;
    status("C", "needs_answer");
    act(() => {
      raiseInboxItem({ kind: "gate", sessionId: "B", detail: "Plan ready", source: "track" });
    });
    const dialog = screen.getByRole("dialog", { name: "Attention inbox" });
    expect(dialog.querySelector(".attention-morning-title")?.textContent).toBe("2 agents are waiting on you · 1 Hermes notice");
  });
});

describe("what the counts count (LEAD-07) and ⌘I with nothing waiting (LEAD-12)", () => {
  it("the badge and the dock count agents, the same ones ⌘I visits; a Hermes notice is named apart", () => {
    const { badge } = setup("D");
    status("A", "needs_approval");
    clock += 1_000;
    status("B", "needs_approval");
    act(() => {
      raiseInboxItem({ kind: "gate", sessionId: "A", detail: "Plan ready", source: "track" });
      raiseInboxItem({ kind: "error", sessionId: null, detail: "Only 2 GB left", source: "worktree" });
    });
    expect(badge()).toHaveAttribute("data-count", "2");
    expect(badge()).toHaveAttribute("data-notices", "1");
    expect(badge()).toHaveAccessibleName("Attention inbox: 2 agents blocked on you · Hermes · 1 notice");
    expect(h.setAttentionBadge).toHaveBeenLastCalledWith(2, 1);
    pressNext();
    expect(document.querySelector(".attention-position")?.getAttribute("data-total")).toBe("2");

    pressInbox();
    const list = screen.getByRole("listbox", { name: "Attention inbox" });
    const groups = within(list).getAllByRole("group");
    expect(groups.map((g) => g.getAttribute("data-section"))).toEqual(["blocked", "notices"]);
    expect(groups[0].querySelector(".attention-group-title")?.textContent).toBe("Blocked on you · 2 agents");
    expect(groups[1].querySelector(".attention-group-title")?.textContent).toBe("Hermes · 1 notice");
    expect(within(groups[1]).getAllByRole("option").map((o) => o.getAttribute("data-session-id"))).toEqual([""]);
  });

  it("a Hermes notice alone still marks the badge and the dock, and ⌘I opens the inbox on it", () => {
    const { badge, onJump } = setup("D");
    let notice: ReturnType<typeof raiseInboxItem> | undefined;
    act(() => {
      notice = raiseInboxItem({ kind: "error", sessionId: null, detail: "Only 2 GB left", source: "worktree" });
    });
    expect(badge()).toHaveAttribute("data-count", "0");
    expect(badge()).toHaveAttribute("data-notices", "1");
    expect(badge()).toHaveClass("attention-badge-hot");
    expect(badge().querySelector(".attention-badge-count")?.textContent).toBe("!");
    expect(h.setAttentionBadge).toHaveBeenLastCalledWith(0, 1);

    pressNext();
    expect(onJump).not.toHaveBeenCalled();
    expect(document.querySelector(".attention-position")).toBeNull();
    const list = screen.getByRole("listbox", { name: "Attention inbox" });
    expect(within(list).getByRole("option", { selected: true })).toHaveAttribute("data-item-id", notice!.id);

    // Dismissed (Enter on a notice): a quiet zero, the dock cleared.
    fireEvent.keyDown(list, { key: "Enter" });
    expect(badge()).not.toHaveClass("attention-badge-hot");
    expect(badge().querySelector(".attention-badge-count")?.textContent).toBe("0");
    expect(h.setAttentionBadge).toHaveBeenLastCalledWith(0, 0);
  });

  it("an agent and a notice: the badge shows the agent count, ⌘I goes to the agent", () => {
    const { badge, onJump } = setup("D");
    status("A", "needs_approval");
    act(() => {
      raiseInboxItem({ kind: "error", sessionId: null, detail: "Only 2 GB left", source: "worktree" });
    });
    expect(badge().querySelector(".attention-badge-count")?.textContent).toBe("1");
    expect(h.setAttentionBadge).toHaveBeenLastCalledWith(1, 1);
    pressNext();
    expect(onJump).toHaveBeenLastCalledWith("A");
  });

  it("one agent with two requests: the header counts one agent", () => {
    setup("D");
    status("A", "needs_approval");
    act(() => {
      raiseInboxItem({ kind: "gate", sessionId: "A", detail: "Plan ready", source: "track" });
    });
    pressInbox();
    const list = screen.getByRole("listbox", { name: "Attention inbox" });
    const group = within(list).getAllByRole("group")[0];
    expect(group.querySelector(".attention-group-title")?.textContent).toBe("Blocked on you · 1 agent");
    expect(within(group).getAllByRole("option")).toHaveLength(2);
  });

  it("one agent reads in the singular", () => {
    const { badge } = setup("D");
    status("A", "needs_approval");
    expect(badge()).toHaveAccessibleName("Attention inbox: 1 agent blocked on you");
  });

  it("⌘I with nothing waiting says so on screen, then the note goes", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { onJump } = setup("D");
      pressNext();
      expect(onJump).not.toHaveBeenCalled();
      const note = document.querySelector(".attention-position");
      expect(note?.textContent).toBe("Nothing is waiting on you");
      expect(note).toHaveAttribute("data-total", "0");
      act(() => {
        vi.advanceTimersByTime(3_100);
      });
      expect(document.querySelector(".attention-position")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("away messages that fail, and where an agent works (LEAD-09, LEAD-10)", () => {
  const PLACED: Record<string, SessionData> = {
    A: { ...session("A", "alpha-task"), working_directory: "/srv/demo/api-repo", created_at: "2026-01-01T10:00:00Z" } as SessionData,
    B: { ...session("B", "bravo-task"), working_directory: "/srv/demo/web-repo", created_at: "2026-01-01T10:01:00Z" } as SessionData,
    C: { ...session("C", "charlie-task"), working_directory: "/srv/demo/web-repo", created_at: "2026-01-01T10:02:00Z" } as SessionData,
  };
  const flush = () => act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

  it("each message says where its agent works, never its name unless asked", async () => {
    render(
      <I18nProvider>
        <AttentionCenter canOpenOnStart={notAtStart} sessions={PLACED} activeSessionId={null} onJump={() => {}} />
      </I18nProvider>,
    );
    setWindowFocusOverride(false);
    status("B", "needs_approval");
    status("C", "needs_approval");
    const sent = h.sendAwayNotification.mock.calls.map((c) => c[0] as Record<string, string>);
    expect(sent.map((p) => p.where)).toEqual(["web-repo #1", "web-repo #2"]);
    expect(sent.map((p) => p.task)).toEqual(["", ""]);
    applyAwayPref("away_notify_names", "on");
    status("A", "needs_approval");
    const named = h.sendAwayNotification.mock.calls[2][0] as Record<string, string>;
    expect(named).toEqual({ agent: "Claude Code", task: "alpha-task", state: "needs_approval", where: "api-repo #1" });
    await flush();
  });

  it("the first failure raises one Hermes notice; a message that gets through takes it away", async () => {
    h.sendAwayNotification.mockImplementation(async () => ({ outcome: "failed", error: "the address answered 500 Internal Server Error", target: "webhook" }));
    render(
      <I18nProvider>
        <AttentionCenter canOpenOnStart={notAtStart} sessions={PLACED} activeSessionId={null} onJump={() => {}} />
      </I18nProvider>,
    );
    setWindowFocusOverride(false);
    status("A", "needs_approval");
    await flush();
    status("B", "needs_approval");
    await flush();
    const notices = () => listInboxItems().filter((i) => i.sessionId === null).map((i) => i.detail);
    expect(notices()).toEqual(["Away message could not be sent (the address answered 500 Internal Server Error) — check Settings > General"]);
    expect(getAwayLast()).toMatchObject({ outcome: "failed", error: "the address answered 500 Internal Server Error" });
    h.sendAwayNotification.mockImplementation(async () => ({ outcome: "sent", status: 200, target: "webhook" }));
    status("C", "needs_approval");
    await flush();
    expect(notices()).toEqual([]);
    expect(getAwayLast()).toMatchObject({ outcome: "sent" });
  });
});
