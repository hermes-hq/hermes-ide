/**
 * F10 x F11 — when a person typed into a session: one mark per gap between
 * session events, the terminal's own replies and mouse reports ignored;
 * and the agent's first output after an answer, which stands in for the
 * terminal's working guess when the terminal never went quiet.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { _resetSessionEventStoreForTest, dispatchSessionEvent, getSessionEventSnapshot } from "../agent/contract/sessionEventStore";
import { _resetUserInputForTest, forgetUserInput, inputAwaitingOutput, isTerminalReport, noteUserInput, userInputTimes } from "../agent/status/userInput";
import { hasVisibleText, noteSessionOutput } from "../agent/status/resumeOnOutput";
import { _resetAttentionStoreForTest, getSessionStatus } from "../agent/status/attentionStore";

const SID = "typed";
const guess = (at: number) => dispatchSessionEvent(SID, { type: "status", at, source: "pty", status: { kind: "idle", confidence: "guessed", detail: "" } });

beforeEach(() => {
  _resetSessionEventStoreForTest();
  _resetUserInputForTest();
});

describe("user input marks", () => {
  it("keeps one mark per gap between session events", () => {
    guess(10);
    noteUserInput(SID, "y", 20);
    noteUserInput(SID, "e", 21);
    noteUserInput(SID, "s", 22);
    expect(userInputTimes(SID)).toEqual([20]);
    guess(30);
    noteUserInput(SID, "\r", 31);
    expect(userInputTimes(SID)).toEqual([20, 31]);
  });

  it("returns the same array until it changes", () => {
    guess(10);
    noteUserInput(SID, "y", 20);
    const a = userInputTimes(SID);
    noteUserInput(SID, "y", 21);
    expect(userInputTimes(SID)).toBe(a);
  });

  it("ignores what the terminal sends by itself", () => {
    for (const report of ["\x1b[I", "\x1b[O", "\x1b[12;40R", "\x1b[?1;2c", "\x1b[>0;276;0c", "\x1b[?2004;1$y", "\x1b[<0;10;5M", "\x1b[<64;3;4m", "\x1b]11;rgb:0000/0000/0000\x1b\\"]) {
      expect(isTerminalReport(report), JSON.stringify(report)).toBe(true);
      noteUserInput(SID, report, 5);
    }
    expect(userInputTimes(SID)).toEqual([]);
    for (const key of ["y", "\r", "\x1b", "\x1b[A", "\x1b[B", "\x03", "hello"]) expect(isTerminalReport(key), JSON.stringify(key)).toBe(false);
  });

  it("remembers the first key no output has followed yet", () => {
    expect(inputAwaitingOutput(SID)).toBeNull();
    noteUserInput(SID, "\x1b[I", 3); // a focus report is not a key
    expect(inputAwaitingOutput(SID)).toBeNull();
    noteUserInput(SID, "y", 5);
    noteUserInput(SID, "e", 6);
    expect(inputAwaitingOutput(SID)).toBe(5);
    forgetUserInput(SID);
    expect(inputAwaitingOutput(SID)).toBeNull();
  });

  it("drops marks older than the oldest event the store still keeps, and forgets a closed session", () => {
    guess(10);
    noteUserInput(SID, "a", 11);
    guess(12);
    noteUserInput(SID, "b", 13);
    expect(userInputTimes(SID)).toEqual([11, 13]);
    forgetUserInput(SID);
    expect(userInputTimes(SID)).toEqual([]);
  });
});

describe("the agent's first output after the person answered", () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  const osc = (at: number) => dispatchSessionEvent(SID, { type: "status", at, source: "osc", status: { kind: "needs_approval", confidence: "signal", detail: "Approval requested" } });

  beforeEach(() => _resetAttentionStoreForTest());

  it("tells visible text from escapes and whitespace", () => {
    expect(hasVisibleText(enc("running...\r\n"))).toBe(true);
    expect(hasVisibleText(enc("\x1b[?25l\x1b[2J\x1b[H\r\n  \x1b[0m"))).toBe(false);
    expect(hasVisibleText(enc("\x1b]9;Approval requested\x07"))).toBe(false);
    expect(hasVisibleText(enc("\x1b]777;notify;a;b\x1b\\"))).toBe(false);
    expect(hasVisibleText(enc("\x1b[32m✓\x1b[0m"))).toBe(true);
  });

  it("an answer followed by output right away (the terminal never went quiet) supersedes the signal", () => {
    osc(10);
    noteUserInput(SID, "y", 20);
    noteSessionOutput(SID, enc("\x1b[?1049l"), 25); // escapes only: not yet
    expect(getSessionStatus(SID).kind).toBe("needs_approval");
    noteSessionOutput(SID, enc("fake-agent: approval granted\r\n"), 30);
    expect(getSessionStatus(SID)).toMatchObject({ kind: "working", confidence: "guessed", source: "pty" });
    // Only the first output after the keys: no flood of events.
    const version = getSessionEventSnapshot(SID).version;
    noteSessionOutput(SID, enc("running...\r\n"), 40);
    expect(getSessionEventSnapshot(SID).version).toBe(version);
  });

  it("output without a key in between, or after an exact status, adds nothing", () => {
    osc(10);
    noteSessionOutput(SID, enc("spinner 1s\r\n"), 20);
    expect(getSessionEventSnapshot(SID).version).toBe(1);
    expect(getSessionStatus(SID).kind).toBe("needs_approval");
    dispatchSessionEvent(SID, { type: "status", at: 30, source: "hook:claude", status: { kind: "needs_approval", confidence: "exact", detail: "Bash" } });
    noteUserInput(SID, "y", 40);
    noteSessionOutput(SID, enc("ok\r\n"), 50);
    expect(getSessionEventSnapshot(SID).version).toBe(2);
    expect(getSessionStatus(SID)).toMatchObject({ kind: "needs_approval", confidence: "exact" });
  });

  it("keys typed before the signal (typed ahead) do not answer it", () => {
    noteUserInput(SID, "y", 5);
    osc(10);
    noteSessionOutput(SID, enc("box redrawn\r\n"), 20);
    expect(getSessionStatus(SID).kind).toBe("needs_approval");
  });
});
