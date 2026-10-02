// @vitest-environment jsdom
/**
 * F28 Track panel: it says in plain words what is happening and what the
 * person does next, shows how far each phase file got, tells the writer
 * agent (which stopped at the gate) to go on when the person approves or
 * skips, and warns when that agent runs in Skip all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const h = vi.hoisted(() => ({ calls: [] as [string, Record<string, unknown>][], next: { from: "questions", to: "research" } }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown>) => {
    h.calls.push([cmd, args]);
    if (cmd === "track_approve" || cmd === "track_skip") return h.next;
    return null;
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import { TrackPanel } from "../components/TrackPanel";
import { I18nProvider } from "../i18n/I18nProvider";
import { _resetTrackStoreForTest, applyTrackSnapshot } from "../track/store";
import { _resetSessionEventStoreForTest, dispatchSessionEvent } from "../agent/contract/sessionEventStore";
import type { SessionData } from "../types/session";

const WT = "/fixture-home/wt/fail-notice";
const feature = (phase: string, gate: string, files: { name: string; lines: number }[] = []) =>
  applyTrackSnapshot({
    worktreePath: WT,
    branch: "hermes/fail-notice",
    at: 1,
    features: [
      {
        slug: "fail-notice",
        featureText: `---\nslug: fail-notice\ntrack: Full\nphase: ${phase}\ngate: ${gate}\ndone_when: []\n---\nBuild the failure notification\n`,
        featureModifiedAt: 1,
        questionsText: null,
        files: files.map((f) => ({ ...f, modifiedAt: 1 })),
      },
    ],
  });
const agent = (over: Partial<SessionData> = {}) => ({ id: "agent-1", label: "Claude", working_directory: WT, created_at: "2026-10-01T10:00:00Z", permission_mode: "acceptEdits", mode: "terminal", ...over }) as unknown as SessionData;

function show(session: SessionData) {
  const sent: [string, string][] = [];
  const onSend = vi.fn(async (id: string, line: string) => {
    sent.push([id, line]);
  });
  render(
    <I18nProvider>
      <TrackPanel session={session} sessions={[session]} onOpenInEditorSplit={() => {}} onSendToWriter={onSend} onClose={() => {}} />
    </I18nProvider>,
  );
  return sent;
}
const explain = () => screen.getByTestId("track-explain").textContent;

beforeEach(() => {
  h.calls = [];
  _resetTrackStoreForTest();
  _resetSessionEventStoreForTest();
  // The writer is an agent (it has run a turn).
  dispatchSessionEvent("agent-1", { type: "turn_start", at: 1, n: 1 });
  dispatchSessionEvent("agent-1", { type: "turn_end", at: 2, n: 1 });
});
afterEach(cleanup);

describe("Track panel: what is happening, what you do next", () => {
  it("while the agent writes questions.md: what it writes and how far it got", () => {
    feature("questions", "none", [{ name: "questions.md", lines: 12 }]);
    show(agent());
    expect(explain()).toBe("The agent is writing questions.md for questions (12/40 lines so far). When it hands it over it stops, and you review it here.");
    expect(document.querySelector('[data-file="questions.md"]')?.textContent).toBe("12/40");
  });

  it("before it wrote anything", () => {
    feature("questions", "none");
    show(agent());
    expect(explain()).toBe("Waiting for the agent to start questions: it writes questions.md, then stops for your review.");
  });

  it("at the gate: read, edit, send edits, approve or skip; approving tells the agent to run `hi phase`", async () => {
    feature("questions", "waiting", [{ name: "questions.md", lines: 9 }]);
    const sent = show(agent());
    expect(explain()).toMatch(/^questions is ready for your review\. Read questions\.md \(o\) or edit it \(⇧O\)\. Then send your edits back \(r\), approve to start research \(.+⏎\), or skip \(⇧S\)\.$/);
    await act(async () => {
      fireEvent.click(document.querySelector(".track-approve") as HTMLElement);
    });
    expect(h.calls.find(([c]) => c === "track_approve")?.[1]).toEqual({ worktreePath: WT, slug: "fail-notice" });
    expect(sent).toEqual([["agent-1", "hermes track: fail-notice: questions approved by the person. Run `hi phase` now and do the research phase the same way: write its file, run `hi phase done`, then stop and wait for the person's review."]]);
  });

  it("skipping tells the agent too", async () => {
    feature("questions", "waiting", [{ name: "questions.md", lines: 9 }]);
    const sent = show(agent());
    await act(async () => {
      fireEvent.click(document.querySelector(".track-skip") as HTMLElement);
    });
    // A skip asks first (QA-review-8); confirming it tells the agent.
    expect(sent).toEqual([]);
    await act(async () => {
      fireEvent.click(document.querySelector("button.track-skip-confirm") as HTMLElement);
    });
    expect(sent[0][1]).toContain("questions skipped by the person. Run `hi phase` now");
  });

  it("after the approval: the agent was told; with no agent attached, the person is told what to run", () => {
    feature("research", "approved", [{ name: "questions.md", lines: 9 }]);
    show(agent());
    expect(explain()).toBe("Approved. The agent was told to start research: it writes the next file and stops again for your review.");
    // Every phase file written so far still shows its size.
    expect(document.querySelector('[data-file="questions.md"]')?.textContent).toBe("9/40");
    cleanup();
    _resetSessionEventStoreForTest();
    show(agent({ id: "shell-1" } as Partial<SessionData>));
    expect(explain()).toContain("run `hi phase` to start research");
  });

  it("an agent in Skip all gets a warning: the gates rely on it stopping", () => {
    feature("questions", "none");
    show(agent({ permission_mode: "bypassPermissions" }));
    expect(screen.getByTestId("track-skip-all").textContent).toBe("This agent runs in Skip all: nothing stops it at a gate except itself. The gates rely on the agent stopping.");
    cleanup();
    show(agent());
    expect(screen.queryByTestId("track-skip-all")).toBeNull();
  });
});
