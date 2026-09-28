/**
 * F12 + N16 — the rules of the attention inbox, without React or Tauri:
 * which section an item is in, what the badge counts, the order ⌘I visits
 * sessions, how a session's status becomes an inbox item, which new items
 * notify (grouped per session, never for the session you look at, never
 * while muted), and what an away message may carry.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  _resetInboxForTest,
  listInboxItems,
  raiseInboxItem,
  resolveInboxItem,
  type InboxItem,
} from "../agent/contract/inbox";
import {
  _resetSessionEventStoreForTest,
  clearSessionEvents,
  dispatchSessionEvent,
  subscribeAllSessionEvents,
} from "../agent/contract/sessionEventStore";
import type { AgentStatusKind } from "../agent/contract/status";
import {
  blockedCount,
  blockedSessionOrder,
  groupInbox,
  inboxKindForStatus,
  isMuted,
  nextBlockedSession,
  sectionOf,
} from "../attention/model";
import { startStatusBridge } from "../attention/statusBridge";
import { createNotifier, type AwayPayload, type NotifierDeps } from "../attention/notifier";
import { awayPayload, itemState, notificationText } from "../attention/describe";
import { isAwayUrlAcceptable } from "../attention/awayUrl";
import { _resetUserLabelsForTest, rememberUserLabel } from "../attention/userLabels";
import { deriveSessionLabelFromMessage } from "../utils/autoSessionLabel";
import { _resetMutesForTest, getMutes, muteSession, unmuteSession } from "../attention/mutes";
import { claimPcAppChords, isAppChordInTerminal } from "../utils/keymap";
import { matchAppShortcut } from "../utils/shortcuts";

let clock = 1_000;
const now = () => clock;

function status(sessionId: string, kind: AgentStatusKind, detail = "", at = clock) {
  dispatchSessionEvent(sessionId, { type: "status", at, status: { kind, confidence: "exact", detail } });
}

function item(over: Partial<InboxItem> & { id: string }): InboxItem {
  return { kind: "blocked", sessionId: "s", detail: "", createdAt: 0, source: "status", ...over };
}

beforeEach(() => {
  clock = 1_000;
  _resetInboxForTest(now);
  _resetSessionEventStoreForTest();
  _resetMutesForTest(now);
});

describe("sections, badge count and ⌘I order", () => {
  it("puts ready in Ready for you and every other kind in Blocked on you", () => {
    expect(sectionOf("ready")).toBe("ready");
    for (const k of ["blocked", "gate", "error", "limit"] as const) expect(sectionOf(k)).toBe("blocked");
  });

  it("maps statuses: answers needed -> blocked, done unseen -> ready, the rest -> nothing", () => {
    expect(inboxKindForStatus("needs_approval")).toBe("blocked");
    expect(inboxKindForStatus("needs_answer")).toBe("blocked");
    expect(inboxKindForStatus("plan_ready")).toBe("blocked");
    expect(inboxKindForStatus("done_unread")).toBe("ready");
    for (const k of ["working", "idle", "exited", "starting", "error", "gate", "limited", "check_failed"] as const) {
      expect(inboxKindForStatus(k)).toBeNull();
    }
  });

  const items = [
    item({ id: "c", sessionId: "C", createdAt: 30 }),
    item({ id: "a", sessionId: "A", createdAt: 10 }),
    item({ id: "r", sessionId: "R", kind: "ready", createdAt: 5 }),
    item({ id: "b", sessionId: "B", createdAt: 20 }),
    item({ id: "a2", sessionId: "A", kind: "gate", createdAt: 40 }),
    item({ id: "w", sessionId: null, kind: "error", createdAt: 1 }),
  ];

  it("groups oldest first", () => {
    const g = groupInbox(items);
    expect(g.blocked.map((i) => i.id)).toEqual(["w", "a", "b", "c", "a2"]);
    expect(g.ready.map((i) => i.id)).toEqual(["r"]);
  });

  it("counts Blocked on you items, leaving out muted sessions", () => {
    expect(blockedCount(items, new Map(), 0)).toBe(5);
    expect(blockedCount(items, new Map([["A", 100]]), 50)).toBe(3);
    expect(blockedCount(items, new Map([["A", 100]]), 100)).toBe(5); // the mute ran out
  });

  it("visits blocked sessions oldest first, once each, and wraps", () => {
    const mutes = new Map<string, number>();
    expect(blockedSessionOrder(items, mutes, 0)).toEqual(["A", "B", "C"]);
    expect(nextBlockedSession(items, mutes, 0, null)).toBe("A");
    expect(nextBlockedSession(items, mutes, 0, "R")).toBe("A"); // not blocked -> the oldest
    expect(nextBlockedSession(items, mutes, 0, "A")).toBe("B");
    expect(nextBlockedSession(items, mutes, 0, "B")).toBe("C");
    expect(nextBlockedSession(items, mutes, 0, "C")).toBe("A");
    expect(nextBlockedSession(items, new Map([["B", 9]]), 0, "A")).toBe("C"); // muted B is skipped
    expect(nextBlockedSession([], mutes, 0, "A")).toBeNull();
  });

  it("mutes for an hour and unmutes", () => {
    const until = muteSession("A");
    expect(until).toBe(1_000 + 60 * 60 * 1000);
    expect(isMuted(getMutes(), "A", clock)).toBe(true);
    expect(isMuted(getMutes(), "B", clock)).toBe(false);
    expect(isMuted(getMutes(), null, clock)).toBe(false);
    expect(unmuteSession("A")).toBe(true);
    expect(unmuteSession("A")).toBe(false);
    expect(isMuted(getMutes(), "A", clock)).toBe(false);
  });
});

describe("status bridge", () => {
  it("raises one item per blocked session, in the order they blocked", () => {
    const bridge = startStatusBridge();
    status("B", "needs_approval", "Bash: rm -rf build");
    clock = 2_000;
    status("C", "needs_answer", "Which database?");
    clock = 3_000;
    status("A", "plan_ready");
    const items = listInboxItems();
    expect(items.map((i) => [i.sessionId, i.kind, i.detail, i.source])).toEqual([
      ["B", "blocked", "Bash: rm -rf build", "status"],
      ["C", "blocked", "Which database?", "status"],
      ["A", "blocked", "", "status"],
    ]);
    expect(nextBlockedSession(items, new Map(), clock, null)).toBe("B");
    bridge.stop();
  });

  it("keeps an item's place when the same status is reported again, and resolves it when the agent moves on", () => {
    const bridge = startStatusBridge();
    status("A", "needs_approval", "Edit src/app.ts");
    const first = listInboxItems()[0];
    clock = 5_000;
    status("A", "needs_approval", "Edit src/app.ts");
    dispatchSessionEvent("A", { type: "turn_start", at: clock, n: 2 }); // not a status: nothing changes
    expect(listInboxItems()).toEqual([first]);
    status("A", "needs_approval", "Edit src/other.ts"); // a new request: a new item
    expect(listInboxItems()).toHaveLength(1);
    expect(listInboxItems()[0].detail).toBe("Edit src/other.ts");
    expect(listInboxItems()[0].createdAt).toBe(5_000);
    status("A", "working");
    expect(listInboxItems()).toEqual([]);
    bridge.stop();
  });

  it("the terminal's own heuristics (F10's PTY statuses) neither raise nor resolve an item", () => {
    const bridge = startStatusBridge();
    const guess = (sessionId: string, kind: AgentStatusKind) =>
      dispatchSessionEvent(sessionId, { type: "status", at: clock, source: "pty", status: { kind, confidence: "guessed", detail: "" } });
    guess("A", "needs_approval");
    expect(listInboxItems()).toEqual([]);
    status("B", "needs_answer", "Which database?");
    guess("B", "idle");
    guess("B", "working");
    expect(listInboxItems().map((i) => [i.sessionId, i.detail])).toEqual([["B", "Which database?"]]);
    status("B", "working");
    expect(listInboxItems()).toEqual([]);
    bridge.stop();
  });

  it("turns done_unread into a ready item that stays read once acknowledged", () => {
    const bridge = startStatusBridge();
    status("A", "done_unread");
    expect(listInboxItems().map((i) => i.kind)).toEqual(["ready"]);
    expect(bridge.acknowledgeReady("A")).toBe(true);
    expect(listInboxItems()).toEqual([]);
    dispatchSessionEvent("A", { type: "identity", at: clock, vendorSessionId: null, model: "m", permissionMode: null });
    expect(listInboxItems()).toEqual([]); // not raised again for the same status
    status("A", "done_unread"); // a new turn finished
    expect(listInboxItems().map((i) => i.kind)).toEqual(["ready"]);
    bridge.stop();
  });

  it("resolves on exit, on a cleared session and on forget; ignores statuses owned by other features", () => {
    const bridge = startStatusBridge();
    status("A", "needs_approval");
    dispatchSessionEvent("A", { type: "exit", at: clock, code: 0, signal: null });
    status("B", "needs_answer");
    clearSessionEvents("B");
    status("C", "needs_answer");
    bridge.forget("C");
    status("D", "error", "boom");
    status("E", "limited");
    expect(listInboxItems()).toEqual([]);
    bridge.stop();
  });

  it("picks up sessions that reported before it started, and stops listening when stopped", () => {
    status("A", "needs_approval");
    const bridge = startStatusBridge();
    expect(listInboxItems()).toHaveLength(1);
    bridge.stop();
    status("B", "needs_approval");
    expect(listInboxItems()).toHaveLength(1);
  });

  it("subscribeAllSessionEvents wakes for every session until unsubscribed", () => {
    const seen: string[] = [];
    const off = subscribeAllSessionEvents((id) => seen.push(id));
    status("A", "working");
    status("B", "idle");
    clearSessionEvents("A");
    off();
    status("C", "idle");
    expect(seen).toEqual(["A", "B", "A"]);
  });
});

describe("notifier", () => {
  function setup(over: Partial<NotifierDeps> = {}) {
    const os: string[] = [];
    const away: AwayPayload[] = [];
    let active: string | null = null;
    let focused = false;
    const deps: NotifierDeps = {
      now,
      isWindowFocused: () => focused,
      activeSessionId: () => active,
      mutes: getMutes,
      text: (i) => ({ title: `t-${i.id}`, body: "b" }),
      awayPayload: (i) => ({ agent: "Claude Code", task: `task-${i.sessionId}`, state: "needs_approval" }),
      showOs: (_t, i) => os.push(i.id),
      sendAway: (p) => away.push(p),
      ...over,
    };
    const n = createNotifier(deps);
    return {
      n,
      os,
      away,
      look: (sid: string | null, f: boolean) => {
        active = sid;
        focused = f;
      },
    };
  }

  it("notifies each blocked session once and sends one away message each", () => {
    const { n, os, away } = setup();
    const a = raiseInboxItem({ kind: "blocked", sessionId: "A", detail: "x", source: "status" });
    const b = raiseInboxItem({ kind: "blocked", sessionId: "B", detail: "y", source: "status" });
    n.update(listInboxItems());
    n.update(listInboxItems()); // nothing new
    expect(os).toEqual([a.id, b.id]);
    expect(away.map((p) => p.task)).toEqual(["task-A", "task-B"]);
    expect(n.log().map((e) => e.decision)).toEqual(["sent", "sent"]);
  });

  it("never notifies for the session you are looking at in a focused window", () => {
    const { n, os, away, look } = setup();
    look("A", true);
    raiseInboxItem({ kind: "blocked", sessionId: "A", detail: "x", source: "status" });
    const b = raiseInboxItem({ kind: "blocked", sessionId: "B", detail: "y", source: "status" });
    n.update(listInboxItems());
    expect(os).toEqual([b.id]);
    expect(away.map((p) => p.task)).toEqual(["task-B"]);
    expect(n.log().map((e) => [e.sessionId, e.decision])).toEqual([
      ["A", "suppressed-focused"],
      ["B", "sent"],
    ]);
  });

  it("does notify the looked-at session when the window is not focused (you are away)", () => {
    const { n, os, look } = setup();
    look("A", false);
    const a = raiseInboxItem({ kind: "blocked", sessionId: "A", detail: "x", source: "status" });
    n.update(listInboxItems());
    expect(os).toEqual([a.id]);
  });

  it("groups a session's further items until its open ones are resolved", () => {
    const { n, os, away } = setup();
    const a1 = raiseInboxItem({ kind: "blocked", sessionId: "A", detail: "1", source: "status" });
    n.update(listInboxItems());
    raiseInboxItem({ kind: "gate", sessionId: "A", detail: "plan", source: "track" });
    n.update(listInboxItems());
    expect(os).toEqual([a1.id]);
    expect(n.log().map((e) => e.decision)).toEqual(["sent", "grouped"]);
    for (const i of listInboxItems()) resolveInboxItem(i.id);
    n.update(listInboxItems());
    const a3 = raiseInboxItem({ kind: "blocked", sessionId: "A", detail: "3", source: "status" });
    n.update(listInboxItems());
    expect(os).toEqual([a1.id, a3.id]);
    expect(away).toHaveLength(2);
  });

  it("a session that goes from blocked to done notifies again (the group ended with the blocked item)", () => {
    const { n, os, away } = setup();
    const a = raiseInboxItem({ kind: "blocked", sessionId: "A", detail: "1", source: "status" });
    n.update(listInboxItems());
    resolveInboxItem(a.id);
    const r = raiseInboxItem({ kind: "ready", sessionId: "A", detail: "", source: "status" });
    n.update(listInboxItems());
    expect(os).toEqual([a.id, r.id]);
    expect(away).toHaveLength(1); // ready is not sent away
  });

  it("a request replaced by the next one in the same step stays grouped; looking at the session ends the group", () => {
    const { n, os } = setup();
    const a1 = raiseInboxItem({ kind: "blocked", sessionId: "A", detail: "edit 1", source: "status" });
    n.update(listInboxItems());
    resolveInboxItem(a1.id);
    raiseInboxItem({ kind: "blocked", sessionId: "A", detail: "edit 2", source: "status" });
    n.update(listInboxItems()); // one update sees both the resolve and the raise
    expect(os).toEqual([a1.id]);
    n.seen("A");
    for (const i of listInboxItems()) resolveInboxItem(i.id);
    const a3 = raiseInboxItem({ kind: "blocked", sessionId: "A", detail: "edit 3", source: "status" });
    n.update(listInboxItems());
    expect(os).toEqual([a1.id, a3.id]);
  });

  it("stays silent for a muted session", () => {
    const { n, os, away } = setup();
    muteSession("A");
    raiseInboxItem({ kind: "blocked", sessionId: "A", detail: "1", source: "status" });
    n.update(listInboxItems());
    expect(os).toEqual([]);
    expect(away).toEqual([]);
    expect(n.log()[0].decision).toBe("muted");
  });

  it("notifies a workspace item but never sends it away", () => {
    const { n, os, away } = setup();
    const w = raiseInboxItem({ kind: "error", sessionId: null, detail: "disk low", source: "worktree" });
    n.update(listInboxItems());
    expect(os).toEqual([w.id]);
    expect(away).toEqual([]);
  });
});

describe("what an away message and a notification say", () => {
  const session = { label: "fix-login", ai_provider: "claude", agent_name: "", detected_agent: null };
  const blocked = item({ id: "1", sessionId: "A", detail: "Bash: ./deploy.sh --cluster zebra-canary-42", source: "status" });

  beforeEach(() => {
    _resetUserLabelsForTest();
    rememberUserLabel("A", "fix-login");
  });

  it("the away message has exactly agent, task and state, never the detail", () => {
    const p = awayPayload(blocked, session, "needs_approval");
    expect(Object.keys(p).sort()).toEqual(["agent", "state", "task"]);
    expect(p.task).toBe("fix-login");
    expect(p.state).toBe("needs_approval");
    expect(JSON.stringify(p)).not.toContain("zebra");
    expect(JSON.stringify(p)).not.toContain("deploy");
  });

  it("the state is the inbox kind for items not raised from a status", () => {
    expect(itemState(item({ id: "g", kind: "gate", source: "track" }), "needs_approval")).toBe("gate");
    expect(itemState(blocked, null)).toBe("blocked");
  });

  it("long task names are cut", () => {
    rememberUserLabel("A", "x".repeat(300));
    const p = awayPayload(blocked, { ...session, label: "x".repeat(300) }, "needs_answer");
    expect(p.task.length).toBe(80);
  });

  it("never names the task after a prompt: an auto-named Agent view session sends no task", () => {
    _resetUserLabelsForTest();
    const prompt = "Rotate the walrus-prod database password and email it to ops\nthen restart";
    const autoLabel = deriveSessionLabelFromMessage(prompt)!;
    expect(autoLabel).toContain("walrus");
    const p = awayPayload(blocked, { ...session, label: autoLabel }, "needs_approval");
    expect(p.task).toBe("");
    expect(JSON.stringify(p)).not.toMatch(/walrus|Rotate|password/);
  });

  it("sends the placeholder name and names the user typed, and drops a name that changed since", () => {
    _resetUserLabelsForTest();
    expect(awayPayload(blocked, { ...session, label: "Session 4" }, "needs_approval").task).toBe("Session 4");
    expect(awayPayload(blocked, session, "needs_approval").task).toBe("");
    rememberUserLabel("A", "fix-login");
    expect(awayPayload(blocked, session, "needs_approval").task).toBe("fix-login");
    // Another session with the same words was not named by the user.
    const other = item({ id: "2", sessionId: "B", source: "status" });
    expect(awayPayload(other, session, "needs_approval").task).toBe("");
    // The user named it "Session 9", then the first message renamed it.
    rememberUserLabel("A", "Session 9");
    expect(awayPayload(blocked, { ...session, label: "ship the otter migration" }, "needs_approval").task).toBe("");
  });

  it("the OS notification names the agent and the state, and shows the detail locally", () => {
    const t = (k: string, v?: Record<string, string | number>) => (v ? `${k}:${JSON.stringify(v)}` : k);
    const text = notificationText(blocked, session, "needs_approval", t);
    expect(text.title).toContain("attention.notifyTitle");
    expect(text.title).toContain("attention.state.needs_approval");
    expect(text.body).toContain("fix-login");
    expect(text.body).toContain("Bash:");
  });

  it("accepts only an empty address or an http(s) URL", () => {
    expect(isAwayUrlAcceptable("")).toBe(true);
    expect(isAwayUrlAcceptable("  ")).toBe(true);
    expect(isAwayUrlAcceptable("https://ntfy.sh/topic")).toBe(true);
    expect(isAwayUrlAcceptable("http://127.0.0.1:8080/hook")).toBe(true);
    expect(isAwayUrlAcceptable("ftp://x")).toBe(false);
    expect(isAwayUrlAcceptable("javascript:alert(1)")).toBe(false);
    expect(isAwayUrlAcceptable("ntfy.sh/topic")).toBe(false);
  });
});

describe("keyboard", () => {
  const key = (k: string, mods: Partial<KeyboardEventInit>) => ({
    key: k,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...mods,
  });

  it("⌘I jumps and ⌘⇧I opens the inbox on macOS", () => {
    expect(matchAppShortcut(key("i", { metaKey: true }), true)).toBe("app.attention-next");
    expect(matchAppShortcut(key("I", { metaKey: true, shiftKey: true }), true)).toBe("app.attention-inbox");
  });

  it("Windows/Linux use Ctrl+Shift+I and Ctrl+Shift+A; bare Ctrl+I stays the terminal's Tab", () => {
    expect(matchAppShortcut(key("I", { ctrlKey: true, shiftKey: true }), false)).toBe("app.attention-next");
    expect(matchAppShortcut(key("A", { ctrlKey: true, shiftKey: true }), false)).toBe("app.attention-inbox");
    expect(matchAppShortcut(key("i", { ctrlKey: true }), false)).toBeNull();
  });

  it("the terminal gives Ctrl+Shift+I/A to the app only while the inbox claims them", () => {
    const ev = key("I", { ctrlKey: true, shiftKey: true });
    expect(isAppChordInTerminal(ev, "linux")).toBe(false);
    const release = claimPcAppChords(["{ctrl}{shift}I", "{ctrl}{shift}A"]);
    expect(isAppChordInTerminal(ev, "linux")).toBe(true);
    expect(isAppChordInTerminal(key("A", { ctrlKey: true, shiftKey: true }), "win")).toBe(true);
    expect(isAppChordInTerminal(key("i", { ctrlKey: true }), "linux")).toBe(false);
    release();
    expect(isAppChordInTerminal(ev, "linux")).toBe(false);
    // The built-in chords are never released by a claim.
    const again = claimPcAppChords(["{ctrl}{shift}P"]);
    again();
    expect(isAppChordInTerminal(key("P", { ctrlKey: true, shiftKey: true }), "linux")).toBe(true);
  });
});

