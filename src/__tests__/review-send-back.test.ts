// @vitest-environment jsdom
/** F21 Review Desk: the review file, the tagged line and the delivery receipt. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SessionEvent } from "../agent/contract/events";
import type { AgentStatus } from "../agent/contract/status";
import { encodePaste, pasteLine, reviewMarkdown, reviewTag, reviewTagId, type ReviewComment } from "../review/reviewModel";
import { deliveryReceiptAvailable, isBusy, isReceiptFor, sendReviewBack, type DeliveryState, type SendBackDeps } from "../review/sendBack";
import {
  _resetReviewStoreForTest,
  addComment,
  getReviewState,
  markSent,
  nextReviewNumber,
  removeComment,
  sentReviewOf,
  setDelivery,
  setViewed,
  subscribeReviewState,
} from "../review/reviewStore";
import { clearFakeTurns, getTurnDiffFor, injectFakeTurns, listTurnsFor } from "../review/turnSource";

const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));

const comment = (over: Partial<ReviewComment> = {}): ReviewComment => ({
  id: "c1",
  sessionId: "sess-b",
  turnN: 5,
  path: "src/util.js",
  side: "new",
  line: 12,
  excerpt: "const x = eval(input);",
  text: "Please avoid eval here.",
  createdAt: 1,
  ...over,
});

describe("the tagged line and the review file", () => {
  it("tags the line the person pastes and names the file", () => {
    expect(reviewTag(3)).toBe("[hermes-review #3]");
    expect(reviewTagId(3)).toBe("hermes-review#3");
    const line = pasteLine(3, "/data/reviews/sess-b/review-3.md");
    expect(line.startsWith("[hermes-review #3] ")).toBe(true);
    expect(line).toContain("/data/reviews/sess-b/review-3.md");
    expect(line).not.toContain("\n");
  });

  it("writes one Markdown file grouped by file with the tag at the end", () => {
    const md = reviewMarkdown({
      n: 3,
      agentLabel: "Agent B",
      repoPath: "/fixture/repo",
      branch: "hermes/task",
      comments: [comment(), comment({ id: "c2", path: "src/app.js", line: 2, side: "old", excerpt: "const b = 2;", text: "why?" }), comment({ id: "c3", line: 4, text: "second\nline" })],
    });
    expect(md).toContain("# Review 3 for Agent B");
    expect(md).toContain("Branch: hermes/task");
    expect(md.indexOf("## src/util.js")).toBeLessThan(md.indexOf("## src/app.js"));
    // Within a file, comments are ordered by line.
    expect(md.indexOf("**line 4**")).toBeLessThan(md.indexOf("**line 12**"));
    expect(md).toContain("**old line 2** (turn 5): `const b = 2;`");
    expect(md).toContain("  second\n  line");
    expect(md.trimEnd().endsWith("_[hermes-review #3]_")).toBe(true);
  });

  it("wraps the line in a bracketed paste ending with Enter", () => {
    const decoded = atob(encodePaste("[hermes-review #1] hi"));
    expect(decoded).toBe("\x1b[200~[hermes-review #1] hi\x1b[201~\r");
  });
});

describe("sendReviewBack", () => {
  const status = (kind: AgentStatus["kind"], confidence: AgentStatus["confidence"] = "exact"): AgentStatus => ({ kind, confidence, detail: "" });
  const event = (tags?: string[], kind: AgentStatus["kind"] = "working"): SessionEvent => ({ type: "status", at: 1, ...(tags ? { tags } : {}), status: status(kind) });

  function deps(over: Partial<SendBackDeps> = {}) {
    const listeners = new Map<string, Set<(e: SessionEvent) => void>>();
    const timers: { fn: () => void; ms: number }[] = [];
    const d: SendBackDeps & { emit: (sid: string, e: SessionEvent) => void; fire: () => void; pasted: string[]; listeners: typeof listeners; timers: typeof timers } = {
      writeFile: vi.fn(async (sid, n) => `/data/reviews/${sid}/review-${n}.md`),
      paste: vi.fn(async (_sid, line) => {
        d.pasted.push(line);
      }),
      onSessionEvent: (sid, l) => {
        const set = listeners.get(sid) ?? new Set();
        set.add(l);
        listeners.set(sid, set);
        return () => set.delete(l);
      },
      status: () => status("idle", "guessed"),
      canConfirm: () => true,
      setTimeout: (fn, ms) => {
        timers.push({ fn, ms });
        return timers.length;
      },
      clearTimeout: () => {},
      now: () => 42,
      ...over,
      emit: (sid, e) => {
        for (const l of listeners.get(sid) ?? []) l(e);
      },
      fire: () => {
        for (const t of timers.splice(0)) t.fn();
      },
      pasted: [],
      listeners,
      timers,
    };
    return d;
  }
  const request = (n = 3) => ({ sessionId: "sess-b", n, content: "# review", line: (p: string) => pasteLine(n, p) });
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it("only a working agent is busy, whatever the confidence", () => {
    expect(isBusy(status("working"))).toBe(true);
    expect(isBusy(status("working", "guessed"))).toBe(true);
    for (const kind of ["idle", "done_unread", "needs_approval", "needs_answer", "exited", "starting", "error"] as const) {
      expect(isBusy(status(kind)), kind).toBe(false);
    }
  });

  it("types nothing into a working agent: the send stops at waiting, and Hermes never pastes later on its own", async () => {
    let current = status("working");
    const d = deps({ status: () => current });
    const states: DeliveryState[] = [];
    const out = await sendReviewBack(d, request(3), (s) => states.push(s));
    expect(d.writeFile).toHaveBeenCalledOnce();
    expect(d.pasted).toHaveLength(0);
    expect(out).toEqual({ state: { kind: "waiting", reason: expect.stringContaining("Send now") }, filePath: "/data/reviews/sess-b/review-3.md" });
    expect(states.map((s) => s.kind)).toEqual(["sending", "waiting"]);
    expect(d.timers).toHaveLength(0); // no receipt timer without a paste
    expect(d.listeners.get("sess-b")?.size ?? 0).toBe(0); // nothing waits to paste later
    // The turn ends: still nothing — only the person's next press pastes.
    current = status("done_unread");
    d.emit("sess-b", event(undefined, "done_unread"));
    await settle();
    expect(d.pasted).toHaveLength(0);
    // "Send now": the same review goes out, then the receipt.
    const second = sendReviewBack(d, request(3), (s) => states.push(s));
    await vi.waitFor(() => expect(d.pasted).toHaveLength(1));
    expect(d.pasted[0]).toBe(pasteLine(3, "/data/reviews/sess-b/review-3.md"));
    expect(d.timers).toHaveLength(1);
    d.emit("sess-b", event(["hermes-review#3"]));
    expect((await second).state).toEqual({ kind: "delivered", at: 42 });
    expect(states.map((s) => s.kind)).toEqual(["sending", "waiting", "sending", "delivered"]);
    expect(d.listeners.get("sess-b")?.size).toBe(0);
  });

  it("Send now while the agent is still working stays at waiting, without pasting", async () => {
    const d = deps({ status: () => status("working", "guessed") });
    expect((await sendReviewBack(d, request(3))).state.kind).toBe("waiting");
    expect((await sendReviewBack(d, request(3))).state.kind).toBe("waiting");
    expect(d.pasted).toHaveLength(0);
  });

  it("an agent that cannot send a receipt ends as pasted: one paste, no timer, no listener, no red state", async () => {
    const d = deps({ canConfirm: () => false });
    const states: DeliveryState[] = [];
    const out = await sendReviewBack(d, request(3), (s) => states.push(s));
    expect(d.pasted).toEqual([pasteLine(3, "/data/reviews/sess-b/review-3.md")]);
    expect(out).toEqual({ state: { kind: "pasted", at: 42 }, filePath: "/data/reviews/sess-b/review-3.md" });
    expect(states.map((s) => s.kind)).toEqual(["sending", "pasted"]);
    expect(d.timers).toHaveLength(0);
    expect(d.listeners.get("sess-b")?.size ?? 0).toBe(0);
  });

  it("a receipt is only possible for a helper-started agent whose vendor takes a prompt hook", () => {
    const started = { state: "started", since: "2026-01-01T00:00:00Z", confidence: "exact" } as const;
    expect(deliveryReceiptAvailable({ ai_provider: "claude", agent_startup: started })).toBe(true);
    // Started without the helper (flag off): no hooks were installed.
    expect(deliveryReceiptAvailable({ ai_provider: "claude", agent_startup: null })).toBe(false);
    expect(deliveryReceiptAvailable({ ai_provider: "claude", agent_startup: undefined })).toBe(false);
    // Vendors whose launch carries no prompt hook, helper or not.
    for (const provider of ["gemini", "codex", "copilot", "opencode", "goose", "aider", "custom", "unknown-vendor"]) {
      expect(deliveryReceiptAvailable({ ai_provider: provider, agent_startup: started }), provider).toBe(false);
    }
    expect(deliveryReceiptAvailable({ ai_provider: null, agent_startup: started })).toBe(false);
    expect(deliveryReceiptAvailable(undefined)).toBe(false);
  });

  it("recognises the receipt by its tag only", () => {
    expect(isReceiptFor(event(["hermes-review#3"]), 3)).toBe(true);
    expect(isReceiptFor(event(["hermes-review#4"]), 3)).toBe(false);
    expect(isReceiptFor(event(), 3)).toBe(false);
  });

  it("writes the file, pastes ONE line, and reports delivered when the tag comes back", async () => {
    const d = deps();
    const states: DeliveryState[] = [];
    const p = sendReviewBack(d, request(), (s) => states.push(s));
    await Promise.resolve();
    await Promise.resolve();
    expect(d.writeFile).toHaveBeenCalledWith("sess-b", 3, "# review");
    await vi.waitFor(() => expect(d.pasted).toHaveLength(1));
    expect(d.pasted[0]).toBe(pasteLine(3, "/data/reviews/sess-b/review-3.md"));
    d.emit("sess-b", event(["hermes-review#3"]));
    const out = await p;
    expect(out).toEqual({ state: { kind: "delivered", at: 42 }, filePath: "/data/reviews/sess-b/review-3.md" });
    expect(states.map((s) => s.kind)).toEqual(["sending", "delivered"]);
    expect(d.listeners.get("sess-b")?.size).toBe(0); // unsubscribed
  });

  it("is not delivered when no tagged prompt arrives in time, and a foreign tag does not count", async () => {
    const d = deps();
    const p = sendReviewBack(d, request(3));
    await vi.waitFor(() => expect(d.pasted).toHaveLength(1));
    d.emit("sess-b", event(["hermes-review#2"]));
    d.emit("sess-a", event(["hermes-review#3"])); // another session
    d.fire();
    const out = await p;
    expect(out.state.kind).toBe("not_delivered");
    expect(out.filePath).toBe("/data/reviews/sess-b/review-3.md");
  });

  it("reports a failure when the file cannot be written or the paste fails, without pasting twice", async () => {
    const d1 = deps({ writeFile: vi.fn(async () => { throw new Error("disk full"); }) });
    const out1 = await sendReviewBack(d1, request());
    expect(out1.state.kind).toBe("failed");
    expect(d1.pasted).toHaveLength(0);
    const d2 = deps({ paste: vi.fn(async () => { throw new Error("no pty"); }) });
    const out2 = await sendReviewBack(d2, request());
    expect(out2.state).toEqual({ kind: "failed", reason: "could not paste into the terminal: Error: no pty" });
    expect(d2.listeners.get("sess-b")?.size).toBe(0);
  });

  it("a retry pastes the same line again and can succeed", async () => {
    const d = deps();
    const first = sendReviewBack(d, request(3));
    await vi.waitFor(() => expect(d.pasted).toHaveLength(1));
    d.fire();
    expect((await first).state.kind).toBe("not_delivered");
    const second = sendReviewBack(d, request(3));
    await vi.waitFor(() => expect(d.pasted).toHaveLength(2));
    expect(d.pasted[1]).toBe(d.pasted[0]);
    d.emit("sess-b", event(["hermes-review#3"]));
    expect((await second).state.kind).toBe("delivered");
  });
});

describe("the review store", () => {
  beforeEach(() => {
    _resetReviewStoreForTest();
    localStorage.clear();
  });

  it("keeps viewed marks and comments per repository and survives a reload", () => {
    const woken: number[] = [];
    const unsub = subscribeReviewState("/repo/a", () => woken.push(getReviewState("/repo/a").version));
    setViewed("/repo/a", "src/app.js", true);
    setViewed("/repo/a", "src/app.js", true); // no-op
    const c = addComment("/repo/a", { sessionId: "s", turnN: 1, path: "src/app.js", side: "new", line: 1, excerpt: "x", text: "y" });
    expect(getReviewState("/repo/a").viewed).toEqual(["src/app.js"]);
    expect(getReviewState("/repo/a").comments).toHaveLength(1);
    expect(getReviewState("/repo/b").viewed).toEqual([]);
    expect(woken).toEqual([1, 2]);
    expect(nextReviewNumber("/repo/a")).toBe(1);
    expect(nextReviewNumber("/repo/a")).toBe(2);
    setDelivery("/repo/a", 2, "s", { kind: "delivered", at: 5 }, "/f");
    expect(getReviewState("/repo/a").deliveries[2]).toEqual({ kind: "delivered", at: 5, sessionId: "s", filePath: "/f" });
    expect(sentReviewOf("/repo/a", c.id)).toBeNull();
    markSent("/repo/a", [c.id], 2);
    expect(sentReviewOf("/repo/a", c.id)).toBe(2);
    expect(sentReviewOf("/repo/b", c.id)).toBeNull();
    unsub();
    // A fresh store reads everything back — a sent comment stays sent
    // after a restart, so it is never re-sent as a new review, and its
    // delivery (session and file path) is still there for Retry.
    _resetReviewStoreForTest();
    const again = getReviewState("/repo/a");
    expect(again.viewed).toEqual(["src/app.js"]);
    expect(again.comments[0].id).toBe(c.id);
    expect(again.lastN).toBe(2);
    expect(sentReviewOf("/repo/a", c.id)).toBe(2);
    expect(again.deliveries).toEqual({ 2: { kind: "delivered", at: 5, sessionId: "s", filePath: "/f" } });
    removeComment("/repo/a", c.id);
    expect(getReviewState("/repo/a").comments).toEqual([]);
    setViewed("/repo/a", "src/app.js", false);
    expect(getReviewState("/repo/a").viewed).toEqual([]);
  });

  it("after a restart an in-flight send reads as not delivered, a waiting one stays waiting, and broken entries are dropped", () => {
    localStorage.setItem(
      "hermes.review./repo/e",
      JSON.stringify({
        lastN: 5,
        deliveries: {
          1: { kind: "sending", sessionId: "s", filePath: "/r/review-1.md" },
          2: { kind: "waiting", reason: "busy", sessionId: "s", filePath: "/r/review-2.md" },
          3: { kind: "not_delivered", reason: "silence", sessionId: "s", filePath: "/r/review-3.md" },
          4: { kind: "delivered", at: 9 }, // no session: cannot be retried, dropped
          5: { kind: "teleported", sessionId: "s", filePath: null },
          x: { kind: "delivered", at: 9, sessionId: "s", filePath: null },
        },
      }),
    );
    const s = getReviewState("/repo/e");
    expect(Object.keys(s.deliveries).map(Number).sort()).toEqual([1, 2, 3]);
    expect(s.deliveries[1]).toEqual({ kind: "not_delivered", reason: expect.stringContaining("closed"), sessionId: "s", filePath: "/r/review-1.md" });
    expect(s.deliveries[2]).toEqual({ kind: "waiting", reason: "busy", sessionId: "s", filePath: "/r/review-2.md" });
    expect(s.deliveries[3].kind).toBe("not_delivered");
  });

  it("ignores broken persisted data", () => {
    localStorage.setItem("hermes.review./repo/c", "{not json");
    expect(getReviewState("/repo/c").viewed).toEqual([]);
    localStorage.setItem("hermes.review./repo/d", JSON.stringify({ sent: { a: 1, b: "x", c: 0 } }));
    expect(getReviewState("/repo/d").sent).toEqual({ a: 1 });
  });
});

describe("turn source", () => {
  beforeEach(() => {
    clearFakeTurns();
    h.invoke.mockReset();
  });

  it("asks the backend unless turns were injected for that session", async () => {
    h.invoke.mockImplementation(async (cmd: string) => (cmd === "list_turns" ? [] : null));
    expect(await listTurnsFor("real")).toEqual([]);
    expect(h.invoke).toHaveBeenCalledWith("list_turns", { sessionId: "real" });
    const turn = { sessionId: "fake", n: 2, ref: "refs/hermes/fake/turn/2", startedAt: 1, endedAt: 2, diffstat: { files: 1, insertions: 1, deletions: 0 } };
    injectFakeTurns("fake", [{ turn: { ...turn, n: 3, ref: "refs/hermes/fake/turn/3" }, patch: "p3" }, { turn, patch: "p2" }]);
    expect((await listTurnsFor("fake")).map((t) => t.n)).toEqual([2, 3]);
    expect(await getTurnDiffFor("fake", 2)).toEqual({ turn, patch: "p2" });
    expect(await getTurnDiffFor("fake", 9)).toBeNull();
    h.invoke.mockClear();
    expect(await getTurnDiffFor("real", 1)).toBeNull();
    expect(h.invoke).toHaveBeenCalledWith("get_turn_diff", { sessionId: "real", n: 1 });
    clearFakeTurns("fake");
    h.invoke.mockRejectedValue(new Error("boom"));
    expect(await listTurnsFor("fake")).toEqual([]);
  });
});
