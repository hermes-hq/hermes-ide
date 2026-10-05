// @vitest-environment jsdom
/**
 * F28 Feature Tracks: the store that turns the watcher's reports into the
 * Track view's state, the ◆ inbox items and the gate guard.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { _resetInboxForTest, listInboxItems } from "../agent/contract/inbox";
import { _resetSessionEventStoreForTest, dispatchSessionEvent } from "../agent/contract/sessionEventStore";
import {
  _resetTrackStoreForTest,
  applyTrackSnapshot,
  configureTrackStore,
  forgetTrack,
  getTrackState,
  inboxItemsFor,
  noteOwnApproval,
  OWN_WRITE_WINDOW_MS,
  slugFor,
  useTrack,
} from "../track/store";
import type { TrackWorktreeSnapshot } from "../track/api";

const WT = "/repo/wt";
const featureMd = (phase: string, gate: string, track = "Light") => `---\nslug: demo\ntrack: ${track}\nphase: ${phase}\ngate: ${gate}\n---\n# Demo\n\nFind things.\n`;

function snap(over: Partial<TrackWorktreeSnapshot> & { text?: string; questions?: string | null; modifiedAt?: number; files?: { name: string; lines: number; modifiedAt: number }[] } = {}): TrackWorktreeSnapshot {
  const { text, questions, modifiedAt, files, ...rest } = over;
  return {
    worktreePath: WT,
    branch: "hermes/demo",
    features: [
      {
        slug: "demo",
        featureText: text ?? featureMd("questions", "none"),
        featureModifiedAt: modifiedAt ?? 10_000,
        questionsText: questions ?? null,
        files: files ?? [],
      },
    ],
    at: 20_000,
    ...rest,
  };
}

let now = 100_000;
const sessions = [
  { id: "writer", working_directory: WT, created_at: "2026-01-01T00:00:00Z" },
  { id: "reader", working_directory: WT, created_at: "2026-01-02T00:00:00Z" },
  { id: "elsewhere", working_directory: "/repo/other", created_at: "2026-01-01T00:00:00Z" },
];
let revertGate: ReturnType<typeof vi.fn>;
let readFile: ReturnType<typeof vi.fn>;
let alerts: string[];

beforeEach(() => {
  now = 100_000;
  alerts = [];
  _resetInboxForTest(() => now);
  _resetSessionEventStoreForTest();
  _resetTrackStoreForTest(() => now);
  revertGate = vi.fn(() => Promise.resolve());
  readFile = vi.fn((_wt: string, _slug: string, name: string) => Promise.resolve(`handed over ${name}`));
  configureTrackStore({ sessions: () => sessions, revertGate, readFile, onAlert: (m) => alerts.push(m) });
});

describe("the track state", () => {
  it("parses the watcher's report into meta, questions and the worktree's slug", () => {
    const state = applyTrackSnapshot(snap({ questions: "- [ ] ! Which engine?\n- [x] Done?\n", files: [{ name: "questions.md", lines: 2, modifiedAt: 1 }] }));
    expect(state.slug).toBe("demo");
    expect(state.branch).toBe("hermes/demo");
    expect(state.version).toBe(1);
    const f = state.features[0];
    expect(f.meta).toMatchObject({ slug: "demo", track: "Light", phase: "questions", gate: "none" });
    expect(f.error).toBeNull();
    expect(f.body).toContain("Find things.");
    expect(f.questions).toEqual([
      { line: 1, text: "Which engine?", open: true, blocking: true },
      { line: 2, text: "Done?", open: false, blocking: false },
    ]);
    expect(getTrackState(WT)).toBe(state);
    expect(getTrackState("/nowhere").version).toBe(0);
  });

  it("reports an unreadable feature.md with its line and raises an error item", () => {
    const state = applyTrackSnapshot(snap({ text: "---\nslug: demo\ntrack: Light\ngate: maybe\n---\n" }));
    expect(state.features[0].meta).toBeNull();
    expect(state.features[0].error).toEqual({ message: "gate must be one of none, waiting, approved", line: 4 });
    expect(listInboxItems().map((i) => [i.kind, i.detail, i.sessionId, i.source])).toEqual([["error", "demo: feature.md can't be read (line 4)", "writer", "track"]]);
  });

  it("picks the slug from the branch, else the only folder", () => {
    expect(slugFor("hermes/demo", [{ slug: "demo" }, { slug: "other" }])).toBe("demo");
    expect(slugFor("main", [{ slug: "demo" }])).toBe("demo");
    expect(slugFor("main", [{ slug: "a" }, { slug: "b" }])).toBeNull();
    expect(slugFor(null, [])).toBeNull();
  });

  it("wakes a React subscriber exactly when its worktree changes", () => {
    const { result } = renderHook(() => useTrack(WT));
    expect(result.current.version).toBe(0);
    act(() => {
      applyTrackSnapshot(snap());
    });
    expect(result.current.version).toBe(1);
    act(() => {
      applyTrackSnapshot({ ...snap(), worktreePath: "/repo/other" });
    });
    expect(result.current.version).toBe(1);
    act(() => {
      forgetTrack(WT);
    });
    expect(result.current.version).toBe(0);
  });
});

describe("the ◆ inbox items", () => {
  it("raises a gate item for a waiting phase, addressed to the writer, and resolves it when the gate moves", () => {
    applyTrackSnapshot(snap({ text: featureMd("questions", "waiting") }));
    expect(listInboxItems().map((i) => [i.kind, i.detail, i.sessionId])).toEqual([["gate", "demo: questions is ready for review", "writer"]]);
    // The same report again raises nothing new.
    applyTrackSnapshot(snap({ text: featureMd("questions", "waiting") }));
    expect(listInboxItems()).toHaveLength(1);
    applyTrackSnapshot(snap({ text: featureMd("plan", "none") }));
    expect(listInboxItems()).toHaveLength(0);
    // The next phase's hand-over is a new item with its own words.
    applyTrackSnapshot(snap({ text: featureMd("plan", "waiting") }));
    expect(listInboxItems().map((i) => i.detail)).toEqual(["demo: plan is ready for review"]);
  });

  it("addresses items to the session with a turn history over an older plain shell", () => {
    dispatchSessionEvent("reader", { type: "turn_start", at: 60_000, n: 1 });
    dispatchSessionEvent("reader", { type: "turn_end", at: 70_000, n: 1 });
    applyTrackSnapshot(snap({ text: featureMd("questions", "waiting") }));
    expect(listInboxItems().map((i) => i.sessionId)).toEqual(["reader"]);
  });

  it("raises one item per blocking open question and none for answered or plain ones", () => {
    applyTrackSnapshot(snap({ questions: "- [ ] ! Which engine?\n- [ ] Colour?\n- [x] ! Old blocker\n" }));
    expect(listInboxItems().map((i) => i.detail)).toEqual(["demo: question — Which engine?"]);
    applyTrackSnapshot(snap({ questions: "- [x] ! Which engine? — Postgres\n- [ ] Colour?\n" }));
    expect(listInboxItems()).toHaveLength(0);
  });

  it("keys items so a resolved item is raised again only when the cause comes back", () => {
    const state = applyTrackSnapshot(snap({ text: featureMd("plan", "waiting"), questions: "- [ ] ! A?\n" }));
    expect([...inboxItemsFor(state, "writer").keys()]).toEqual(["demo/gate/plan", "demo/question/1"]);
    forgetTrack(WT);
    expect(listInboxItems()).toHaveLength(0);
  });

  it("keeps a newer report when an older read arrives after it", () => {
    // track_watch read the folder before the feature existed; the watcher's
    // change event (read later) reached the window first.
    applyTrackSnapshot(snap({ at: 30_000 }));
    const kept = applyTrackSnapshot({ worktreePath: WT, branch: "hermes/demo", features: [], at: 29_500 });
    expect(kept.slug).toBe("demo");
    expect(getTrackState(WT).features.map((f) => f.slug)).toEqual(["demo"]);
    // A newer read still lands.
    applyTrackSnapshot({ worktreePath: WT, branch: "hermes/demo", features: [], at: 30_500 });
    expect(getTrackState(WT).features).toEqual([]);
  });

  it("raises nothing for a Quick worktree with no feature", () => {
    applyTrackSnapshot({ worktreePath: WT, branch: "hermes/quick", features: [], at: 1 });
    expect(getTrackState(WT).slug).toBeNull();
    expect(listInboxItems()).toHaveLength(0);
  });
});

describe("the gate guard (an agent approving its own gate)", () => {
  const waiting = () => applyTrackSnapshot(snap({ text: featureMd("questions", "waiting"), modifiedAt: 50_000 }));
  const approved = (modifiedAt: number) => applyTrackSnapshot(snap({ text: featureMd("plan", "approved"), modifiedAt }));

  it("reverts an approval written during the writer's turn and raises an error item", async () => {
    waiting();
    dispatchSessionEvent("writer", { type: "turn_start", at: 60_000, n: 1 });
    approved(61_000);
    expect(revertGate).toHaveBeenCalledWith(WT, "demo", "questions");
    expect(alerts).toEqual(["demo: the agent approved its own gate during its turn; reverted to waiting"]);
    const errors = listInboxItems().filter((i) => i.kind === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].sessionId).toBe("writer");
    // The gate item is gone (the file no longer says waiting) until the revert lands.
    expect(listInboxItems().filter((i) => i.kind === "gate")).toHaveLength(0);
    // The revert's echo: waiting again, no second revert.
    applyTrackSnapshot(snap({ text: featureMd("questions", "waiting"), modifiedAt: 62_000 }));
    expect(revertGate).toHaveBeenCalledTimes(1);
    expect(listInboxItems().filter((i) => i.kind === "gate")).toHaveLength(1);
  });

  it("uses the turn history when the turn already ended", () => {
    waiting();
    dispatchSessionEvent("reader", { type: "turn_start", at: 60_000, n: 1 });
    dispatchSessionEvent("reader", { type: "turn_end", at: 70_000, n: 1 });
    approved(65_000);
    expect(revertGate).toHaveBeenCalledWith(WT, "demo", "questions");
    expect(listInboxItems().find((i) => i.kind === "error")?.sessionId).toBe("reader");
  });

  it("accepts an approval outside every turn (a person ran hi approve)", () => {
    waiting();
    dispatchSessionEvent("writer", { type: "turn_start", at: 60_000, n: 1 });
    dispatchSessionEvent("writer", { type: "turn_end", at: 70_000, n: 1 });
    approved(90_000);
    expect(revertGate).not.toHaveBeenCalled();
    expect(listInboxItems().filter((i) => i.kind === "error")).toHaveLength(0);
    expect(getTrackState(WT).features[0].meta?.gate).toBe("approved");
  });

  it("accepts the approval Hermes wrote itself even while a turn is running", () => {
    waiting();
    dispatchSessionEvent("writer", { type: "turn_start", at: 60_000, n: 1 });
    noteOwnApproval(WT, "demo");
    approved(61_000);
    expect(revertGate).not.toHaveBeenCalled();
    // The token is single-use: the next unexplained approval is caught.
    applyTrackSnapshot(snap({ text: featureMd("plan", "waiting"), modifiedAt: 62_000 }));
    approved(63_000);
    expect(revertGate).toHaveBeenCalledTimes(1);
  });

  it("forgets an own-approval token that is too old", () => {
    waiting();
    dispatchSessionEvent("writer", { type: "turn_start", at: 60_000, n: 1 });
    noteOwnApproval(WT, "demo");
    now += OWN_WRITE_WINDOW_MS + 1;
    approved(61_000);
    expect(revertGate).toHaveBeenCalledTimes(1);
  });

  it("ignores sessions in other worktrees and an unchanged approved file", () => {
    waiting();
    dispatchSessionEvent("elsewhere", { type: "turn_start", at: 60_000, n: 1 });
    approved(61_000);
    expect(revertGate).not.toHaveBeenCalled();
    approved(61_000);
    expect(revertGate).not.toHaveBeenCalled();
  });
});

describe("baselines for sending edits back", () => {
  it("captures the phase file when the gate goes to waiting, once per hand-over", async () => {
    applyTrackSnapshot(snap({ text: featureMd("plan", "none"), files: [{ name: "plan.md", lines: 3, modifiedAt: 1 }] }));
    expect(readFile).not.toHaveBeenCalled();
    applyTrackSnapshot(snap({ text: featureMd("plan", "waiting"), files: [{ name: "plan.md", lines: 3, modifiedAt: 1 }] }));
    expect(readFile).toHaveBeenCalledWith(WT, "demo", "plan.md");
    await Promise.resolve();
    await Promise.resolve();
    expect(getTrackState(WT).features[0].baseline).toEqual({ "plan.md": "handed over plan.md" });
    // Still waiting, file edited by the person: the baseline stays.
    applyTrackSnapshot(snap({ text: featureMd("plan", "waiting"), files: [{ name: "plan.md", lines: 5, modifiedAt: 2 }] }));
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(getTrackState(WT).features[0].baseline["plan.md"]).toBe("handed over plan.md");
  });
});
