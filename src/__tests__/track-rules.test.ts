/** F28 Feature Tracks: the pure rules (turn history, roles, questions, editors). */
import { describe, it, expect } from "vitest";
import type { SessionEvent } from "../agent/contract/events";
import {
  attachedSessions,
  changeMadeDuringTurn,
  editorCommandFor,
  normalizePath,
  parseQuestions,
  previousPhase,
  TRACK_PHASES,
  TURN_SLACK_MS,
  writerSessionId,
} from "../track/rules";

const start = (n: number, at: number): SessionEvent => ({ type: "turn_start", at, n });
const end = (n: number, at: number): SessionEvent => ({ type: "turn_end", at, n });
const idle = { current: null, completed: 0 };

describe("changeMadeDuringTurn (the turn history guards the gate)", () => {
  it("is true while a turn is running, whatever the events say", () => {
    expect(changeMadeDuringTurn([], { current: 3, completed: 2 }, 0)).toBe(true);
  });

  it("is false when the session never started a turn", () => {
    expect(changeMadeDuringTurn([], idle, 5000)).toBe(false);
    expect(changeMadeDuringTurn([{ type: "status", at: 1, status: { kind: "idle", confidence: "guessed", detail: "" } }], idle, 5000)).toBe(false);
  });

  it.each<[string, number, boolean]>([
    ["before the turn started", 9000 - TURN_SLACK_MS - 1, false],
    ["just before the start (file clocks are coarse)", 9000 - TURN_SLACK_MS, true],
    ["inside the turn", 12000, true],
    ["at the end", 15000, true],
    ["just after the end", 15000 + TURN_SLACK_MS, true],
    ["well after the end: the person's own edit", 15000 + TURN_SLACK_MS + 1, false],
  ])("a file written %s -> %s", (_what, modifiedAt, expected) => {
    const events = [start(1, 1000), end(1, 2000), start(2, 9000), end(2, 15000)];
    expect(changeMadeDuringTurn(events, { current: null, completed: 2 }, modifiedAt)).toBe(expected);
  });

  it("treats a start with no end after it as still open (the end event was lost)", () => {
    const events = [start(1, 1000), end(1, 2000), start(2, 9000)];
    expect(changeMadeDuringTurn(events, idle, 99_000)).toBe(true);
    expect(changeMadeDuringTurn(events, idle, 100)).toBe(false);
  });

  it("counts failed and interrupted turns as ended", () => {
    const failed: SessionEvent = { type: "turn_failed", at: 5000, n: 1, detail: "x" };
    const interrupted: SessionEvent = { type: "turn_interrupted", at: 5000, n: 1 };
    expect(changeMadeDuringTurn([start(1, 1000), failed], idle, 20_000)).toBe(false);
    expect(changeMadeDuringTurn([start(1, 1000), interrupted], idle, 20_000)).toBe(false);
    expect(changeMadeDuringTurn([start(1, 1000), interrupted], idle, 4000)).toBe(true);
  });
});

describe("attached sessions and the writer", () => {
  const s = (id: string, dir: string, created: string, ssh?: unknown) => ({ id, working_directory: dir, created_at: created, ssh_info: ssh });

  it("the oldest local session in the worktree writes; the others read", () => {
    const sessions = [
      s("b", "/repo/wt", "2026-01-02T00:00:00Z"),
      s("a", "/repo/wt/", "2026-01-01T00:00:00Z"),
      s("c", "/repo/other", "2025-01-01T00:00:00Z"),
      s("d", "/repo/wt", "2024-01-01T00:00:00Z", { host: "box" }),
    ];
    expect(attachedSessions(sessions, "/repo/wt").map((x) => x.id)).toEqual(["a", "b"]);
    expect(writerSessionId(sessions, "/repo/wt")).toBe("a");
    expect(writerSessionId(sessions, "/nowhere")).toBeNull();
  });

  it("normalises Windows paths by slash and case, POSIX paths by slash only", () => {
    expect(normalizePath("C:\\Work\\Repo\\")).toBe("c:/work/repo");
    expect(normalizePath("/Repo/wt/")).toBe("/Repo/wt");
    expect(normalizePath("/")).toBe("/");
  });
});

describe("questions.md", () => {
  it("reads open, answered and blocking questions like the helper does", () => {
    const qs = parseQuestions("# Q\n\n- [ ] ! Which engine?\n- [ ] Cache size?\n- [x] Where? — src/index\n- [X] ! Answered blocker\n- [ ] (placeholder)\n- plain\n");
    expect(qs).toEqual([
      { line: 3, text: "Which engine?", open: true, blocking: true },
      { line: 4, text: "Cache size?", open: true, blocking: false },
      { line: 5, text: "Where? — src/index", open: false, blocking: false },
      { line: 6, text: "Answered blocker", open: false, blocking: true },
    ]);
    expect(parseQuestions("  - [ ] !  Indented?\r\n- [ ]\r\n")).toEqual([{ line: 1, text: "Indented?", open: true, blocking: true }]);
  });
});

describe("tracks and phases", () => {
  it("knows each track's phases and the phase an approval came from", () => {
    expect(TRACK_PHASES.Quick).toEqual([]);
    expect(TRACK_PHASES.Light).toEqual(["questions", "plan", "implement"]);
    expect(previousPhase("Light", "plan")).toBe("questions");
    expect(previousPhase("Light", "implement")).toBe("plan");
    expect(previousPhase("Light", "done")).toBe("implement");
    expect(previousPhase("Full", "research")).toBe("questions");
    expect(previousPhase("Full", "questions")).toBeNull();
  });
});

describe("editorCommandFor", () => {
  it("uses $EDITOR with a fallback in the shell's own syntax", () => {
    expect(editorCommandFor("/bin/zsh", "/r/.hermes/features/x/plan.md")).toBe("eval \"${EDITOR:-vi} '/r/.hermes/features/x/plan.md'\"");
    expect(editorCommandFor("/bin/bash", "/it's/plan.md")).toBe("eval \"${EDITOR:-vi} '/it'\\\\''s/plan.md'\"");
    expect(editorCommandFor("/bin/bash", "/a$b/plan.md")).toBe("eval \"${EDITOR:-vi} '/a\\$b/plan.md'\"");
    expect(editorCommandFor("/usr/bin/fish", "/r/plan.md")).toBe("set -q EDITOR; and eval $EDITOR '/r/plan.md'; or vi '/r/plan.md'");
    expect(editorCommandFor("C:\\Program Files\\PowerShell\\7\\pwsh.exe", "C:\\r\\plan.md")).toBe(
      "if ($env:EDITOR) { Invoke-Expression \"$env:EDITOR 'C:\\r\\plan.md'\" } else { notepad 'C:\\r\\plan.md' }",
    );
    expect(editorCommandFor("cmd.exe", "C:\\r\\plan.md")).toBe('if defined EDITOR (%EDITOR% "C:\\r\\plan.md") else (notepad "C:\\r\\plan.md")');
  });
});
