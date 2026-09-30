// @vitest-environment jsdom
/**
 * F11 — the status strip above a terminal agent session: what it shows for
 * each status, source and confidence, that it never claims more than the
 * signals say (a session nothing reported on is a dimmed guess), the
 * sub-agent counter, and the preference that hides it.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api/settings", () => ({
  setSetting: vi.fn(async () => {}),
  getSetting: vi.fn(async () => ""),
  getSettings: vi.fn(async () => ({})),
}));

import { I18nProvider } from "../i18n/I18nProvider";
import { _resetSessionEventStoreForTest, dispatchSessionEvent, getSessionEventSnapshot } from "../agent/contract/sessionEventStore";
import type { SessionEvent } from "../agent/contract/events";
import { INBOX_SHORTCUT, SessionStatusStrip, guessedStatus, stripSourceText, stripStatus, STATUS_GLYPHS } from "../components/SessionStatusStrip";
import { PLATFORM } from "../utils/platform";
import { AGENT_STATUS_KINDS } from "../agent/contract/status";
import { foldStatus } from "../agent/status/deriveStatus";
import {
  _resetStatusStripPreferenceForTest,
  initStatusStripPreference,
  isStatusStripEnabled,
  setStatusStripEnabled,
  statusStripEnabledFrom,
  useStatusStripEnabled,
} from "../statusStrip/preference";
import { setSetting } from "../api/settings";
import { renderHook } from "@testing-library/react";

const SID = "strip-session";

const status = (kind: SessionEvent extends { type: "status"; status: { kind: infer K } } ? K : never, confidence: "exact" | "signal" | "guessed", source?: string, detail = ""): SessionEvent => ({
  type: "status",
  at: 1,
  ...(source ? { source } : {}),
  status: { kind, confidence, detail },
});

function renderStrip(phase = "shell_ready", agentName: string | null = "Claude Code") {
  return render(
    <I18nProvider>
      <SessionStatusStrip sessionId={SID} phase={phase} agentName={agentName} />
    </I18nProvider>,
  );
}

const strip = () => screen.getByRole("status");

beforeEach(() => {
  _resetSessionEventStoreForTest();
  _resetStatusStripPreferenceForTest();
});

afterEach(() => cleanup());

describe("guessedStatus / stripStatus", () => {
  it("guesses from the phase when nothing has been signalled, and says so", () => {
    expect(guessedStatus("busy")).toEqual({ kind: "working", confidence: "guessed", detail: "" });
    expect(guessedStatus("needs_input")).toEqual({ kind: "idle", confidence: "guessed", detail: "" });
    expect(guessedStatus("launching_agent").kind).toBe("starting");
    expect(guessedStatus("destroyed").kind).toBe("exited");
    const snap = getSessionEventSnapshot("nothing");
    expect(stripStatus(snap, "busy")).toEqual({ status: { kind: "working", confidence: "guessed", detail: "" }, source: "guessed" });
  });

  it("names the source of the last status event", () => {
    dispatchSessionEvent(SID, status("needs_approval", "exact", "hook:claude", "Bash"));
    expect(stripStatus(getSessionEventSnapshot(SID), "busy")).toEqual({
      status: { kind: "needs_approval", confidence: "exact", detail: "Bash" },
      source: "hook",
      reporter: "claude",
    });
    dispatchSessionEvent(SID, status("needs_approval", "signal", "osc"));
    expect(stripStatus(getSessionEventSnapshot(SID), "busy").source).toBe("osc");
    dispatchSessionEvent(SID, status("done_unread", "exact", "stream:opencode"));
    expect(stripStatus(getSessionEventSnapshot(SID), "busy").source).toBe("stream");
    dispatchSessionEvent(SID, status("working", "exact", "e2e"));
    expect(stripStatus(getSessionEventSnapshot(SID), "busy").source).toBe("e2e");
    dispatchSessionEvent(SID, status("idle", "guessed"));
    expect(stripStatus(getSessionEventSnapshot(SID), "busy").source).toBe("guessed");
    // An attention event in between does not change where the status came from.
    dispatchSessionEvent(SID, status("needs_answer", "exact", "hook:gemini"));
    dispatchSessionEvent(SID, { type: "attention", at: 2, source: "osc", detail: "ping" });
    expect(stripStatus(getSessionEventSnapshot(SID), "busy").source).toBe("hook");
  });

  it("the terminal's own heuristics (F10, source pty) never replace what the agent reported", () => {
    dispatchSessionEvent(SID, status("idle", "guessed", "pty"));
    expect(stripStatus(getSessionEventSnapshot(SID), "busy")).toEqual({
      status: { kind: "idle", confidence: "guessed", detail: "" },
      source: "guessed",
    });
    dispatchSessionEvent(SID, status("needs_approval", "exact", "hook:claude", "Bash"));
    dispatchSessionEvent(SID, status("working", "guessed", "pty"));
    expect(stripStatus(getSessionEventSnapshot(SID), "busy")).toEqual({
      status: { kind: "needs_approval", confidence: "exact", detail: "Bash" },
      source: "hook",
      reporter: "claude",
    });
  });

  it("an answered signal gives way to the terminal's guess once the agent resumes; an exact status never does", () => {
    const at = (e: SessionEvent, t: number): SessionEvent => ({ ...e, at: t });
    dispatchSessionEvent(SID, at(status("needs_approval", "signal", "osc", "Approval requested"), 10));
    dispatchSessionEvent(SID, at(status("needs_answer", "guessed", "pty"), 12));
    dispatchSessionEvent(SID, at(status("working", "guessed", "pty"), 30));
    // Nobody typed: the notification stands.
    expect(stripStatus(getSessionEventSnapshot(SID), "busy")).toMatchObject({ status: { kind: "needs_approval", confidence: "signal" }, source: "osc" });
    // The person answered at 20: the terminal's working guess shows, dimmed.
    expect(stripStatus(getSessionEventSnapshot(SID), "busy", [20])).toEqual({ status: { kind: "working", confidence: "guessed", detail: "" }, source: "guessed" });
    // Later terminal guesses follow until the agent reports again.
    dispatchSessionEvent(SID, at(status("idle", "guessed", "pty"), 40));
    expect(stripStatus(getSessionEventSnapshot(SID), "shell_ready", [20]).status.kind).toBe("idle");
    dispatchSessionEvent(SID, at(status("done_unread", "signal", "osc"), 50));
    expect(stripStatus(getSessionEventSnapshot(SID), "busy", [20])).toMatchObject({ status: { kind: "done_unread" }, source: "osc" });
    // An exact approval, answered and followed by work, stays.
    dispatchSessionEvent(SID, at(status("needs_approval", "exact", "hook:claude", "Bash"), 60));
    dispatchSessionEvent(SID, at(status("working", "guessed", "pty"), 80));
    expect(stripStatus(getSessionEventSnapshot(SID), "busy", [20, 70])).toMatchObject({ status: { kind: "needs_approval", confidence: "exact" }, source: "hook" });
  });

  it("the OS layer's process facts show only while nobody reported anything, and never replace a report", () => {
    const at = (e: SessionEvent, t: number): SessionEvent => ({ ...e, at: t });
    dispatchSessionEvent(SID, at(status("needs_answer", "guessed", "pty"), 1));
    dispatchSessionEvent(SID, at(status("working", "guessed", "os", "a command is running (zsh)"), 2));
    // A command runs under the agent: that beats the screen's shape.
    expect(stripStatus(getSessionEventSnapshot(SID), "needs_input")).toEqual({
      status: { kind: "working", confidence: "guessed", detail: "a command is running (zsh)" },
      source: "os",
    });
    // Quiet again: back to the screen's guess, not "idle".
    dispatchSessionEvent(SID, at(status("idle", "guessed", "os"), 3));
    expect(stripStatus(getSessionEventSnapshot(SID), "needs_input").status.kind).toBe("needs_answer");
    // The agent reports: the report stands, whatever the processes do next.
    dispatchSessionEvent(SID, at(status("done_unread", "exact", "hook:codex"), 4));
    dispatchSessionEvent(SID, at(status("working", "guessed", "os", "the agent is using the CPU"), 5));
    expect(stripStatus(getSessionEventSnapshot(SID), "busy")).toEqual({
      status: { kind: "done_unread", confidence: "exact", detail: "" },
      source: "hook",
      reporter: "codex",
    });
  });

  it("the launch helper echoing the agent keeps the agent as the one who said it; alone it is Hermes", () => {
    const at = (e: SessionEvent, t: number): SessionEvent => ({ ...e, at: t });
    dispatchSessionEvent(SID, at(status("starting", "exact", "hi"), 1));
    expect(stripStatus(getSessionEventSnapshot(SID), "busy")).toMatchObject({ status: { kind: "starting" }, source: "hermes" });
    // SessionStart from the agent, then the helper's "started" (idle) echo.
    dispatchSessionEvent(SID, at(status("idle", "exact", "hook:agy-like"), 2));
    dispatchSessionEvent(SID, at(status("idle", "exact", "hi"), 3));
    expect(stripStatus(getSessionEventSnapshot(SID), "busy")).toMatchObject({ status: { kind: "idle" }, source: "hook", reporter: "agy-like" });
    // The agent's exit, then the helper's "ended": still the agent's word.
    dispatchSessionEvent(SID, { type: "exit", at: 4, source: "hook:codex", code: 0, signal: null });
    dispatchSessionEvent(SID, at(status("exited", "exact", "hi"), 5));
    expect(stripStatus(getSessionEventSnapshot(SID), "busy")).toMatchObject({ status: { kind: "exited" }, source: "hook", reporter: "codex" });
  });

  it("the helper's 'started' landing after the agent's first prompt does not hide the work (measured with the real Codex)", () => {
    const at = (e: SessionEvent, t: number): SessionEvent => ({ ...e, at: t });
    dispatchSessionEvent(SID, at(status("starting", "exact", "hi"), 1));
    dispatchSessionEvent(SID, at(status("idle", "exact", "hook:codex"), 2)); // SessionStart
    dispatchSessionEvent(SID, at(status("working", "exact", "hook:codex"), 2)); // UserPromptSubmit, same poll
    dispatchSessionEvent(SID, at(status("idle", "exact", "hi"), 3)); // the helper's "started"
    expect(stripStatus(getSessionEventSnapshot(SID), "busy")).toMatchObject({ status: { kind: "working", confidence: "exact" }, source: "hook", reporter: "codex" });
  });

  it("Antigravity's guessed approval shows until the OS layer takes it back when the command starts", () => {
    const at = (e: SessionEvent, t: number): SessionEvent => ({ ...e, at: t });
    dispatchSessionEvent(SID, at(status("working", "exact", "hook:antigravity"), 1_000));
    dispatchSessionEvent(SID, at(status("working", "exact", "hook:antigravity"), 1_100)); // PreToolUse
    dispatchSessionEvent(SID, at(status("needs_approval", "guessed", "hook:antigravity", "run_command"), 2_700));
    const input = [4_000];
    expect(stripStatus(getSessionEventSnapshot(SID), "busy", input).status).toEqual({ kind: "needs_approval", confidence: "guessed", detail: "run_command" });
    // The process facts alone do not replace the named guess...
    dispatchSessionEvent(SID, at(status("working", "guessed", "os", "a command is running (zsh)"), 4_500));
    expect(stripStatus(getSessionEventSnapshot(SID), "busy", input).status.kind).toBe("needs_approval");
    // ...the OS layer's retraction, under the guess's own source, does.
    dispatchSessionEvent(SID, at(status("working", "guessed", "hook:antigravity", "a command is running (zsh)"), 4_500));
    expect(stripStatus(getSessionEventSnapshot(SID), "busy", input).status).toEqual({ kind: "working", confidence: "guessed", detail: "a command is running (zsh)" });
    expect(foldStatus(getSessionEventSnapshot(SID).events, undefined, input)).toMatchObject({ kind: "working", confidence: "guessed", source: "hook:antigravity" });
    // The command ends (the OS layer goes quiet): still working until the tool's own report.
    dispatchSessionEvent(SID, at(status("idle", "guessed", "os"), 9_000));
    expect(foldStatus(getSessionEventSnapshot(SID).events, undefined, input).kind).toBe("working");
    dispatchSessionEvent(SID, at(status("done_unread", "exact", "hook:antigravity"), 9_500));
    expect(stripStatus(getSessionEventSnapshot(SID), "busy", input)).toMatchObject({ status: { kind: "done_unread", confidence: "exact" }, source: "hook", reporter: "antigravity" });
  });

  it("an exit Hermes saw itself (the terminal's process) is exact, from Hermes", () => {
    dispatchSessionEvent(SID, { type: "exit", at: 1, source: "pty", code: 0, signal: null });
    expect(stripStatus(getSessionEventSnapshot(SID), "destroyed")).toEqual({ status: { kind: "exited", confidence: "exact", detail: "" }, source: "hermes" });
  });

  it("with only guesses, the strip shows the same best guess as the sidebar (a quiet named guess yields to process facts)", () => {
    const at = (e: SessionEvent, t: number): SessionEvent => ({ ...e, at: t });
    dispatchSessionEvent(SID, at(status("starting", "exact", "hi"), 1));
    dispatchSessionEvent(SID, at(status("idle", "guessed", "hi", "the agent's process is up and quiet"), 2));
    expect(stripStatus(getSessionEventSnapshot(SID), "idle")).toMatchObject({ status: { kind: "idle", confidence: "guessed" }, source: "guessed" });
    dispatchSessionEvent(SID, at(status("working", "guessed", "os", "a command is running (sh)"), 3));
    expect(stripStatus(getSessionEventSnapshot(SID), "idle")).toEqual({ status: { kind: "working", confidence: "guessed", detail: "a command is running (sh)" }, source: "os" });
    dispatchSessionEvent(SID, at(status("idle", "guessed", "os"), 4));
    expect(stripStatus(getSessionEventSnapshot(SID), "idle")).toMatchObject({ status: { kind: "idle", confidence: "guessed" }, source: "guessed" });
  });

  it("words the source: how sure first, then who said so", () => {
    const t = (key: string, v?: Record<string, string | number>) =>
      ({
        "status.confidence.exact": "exact",
        "status.confidence.signal": "signal",
        "status.confidence.guessed": "guessed",
        "status.source.osc": "notification",
        "status.source.e2e": "test",
        "status.source.os": "process activity",
        "status.reportedBy": `reported by ${v?.agent}`,
        "status.reportedByAgent": "reported by the agent",
      })[key] ?? key;
    expect(stripSourceText(t, "exact", "hook", "Codex")).toBe("exact · reported by Codex");
    expect(stripSourceText(t, "exact", "stream", null)).toBe("exact · reported by the agent");
    expect(stripSourceText(t, "signal", "osc", "Codex")).toBe("signal · notification");
    expect(stripSourceText(t, "exact", "e2e", null)).toBe("exact · test");
    expect(stripSourceText(t, "guessed", "os", null)).toBe("guessed · process activity");
    expect(stripSourceText(t, "guessed", "guessed", "Codex")).toBe("guessed");
  });

  it("has a glyph for every status kind", () => {
    for (const kind of AGENT_STATUS_KINDS) expect(STATUS_GLYPHS[kind], kind).toBeTruthy();
  });
});

describe("<SessionStatusStrip>", () => {
  it("shows a dimmed guess for a session with no signals", () => {
    renderStrip("busy");
    const el = strip();
    expect(el.dataset.statusKind).toBe("working");
    expect(el.dataset.confidence).toBe("guessed");
    expect(el.dataset.source).toBe("guessed");
    expect(el.className).toContain("session-status-strip-guessed");
    expect(el.textContent).toContain("working");
    expect(el.textContent).toContain("guessed");
    expect(el.textContent).toContain(INBOX_SHORTCUT);
  });

  it("shows needs approval with 'exact · reported by Claude Code' the moment the event lands, and the detail", () => {
    renderStrip("busy");
    act(() => {
      dispatchSessionEvent(SID, status("needs_approval", "exact", "hook:claude", "Bash"));
    });
    const el = strip();
    expect(el.dataset.statusKind).toBe("needs_approval");
    expect(el.dataset.confidence).toBe("exact");
    expect(el.dataset.source).toBe("hook");
    expect(el.className).not.toContain("session-status-strip-guessed");
    expect(el.querySelector(".session-status-strip-word")?.textContent).toBe("needs approval");
    expect(el.querySelector(".session-status-strip-source")?.textContent).toBe("exact · reported by Claude Code");
    expect(el.querySelector(".session-status-strip-detail")?.textContent).toBe("Bash");
  });

  it("marks a terminal notification as 'signal · notification', never exact", () => {
    renderStrip();
    act(() => {
      dispatchSessionEvent(SID, { type: "attention", at: 1, source: "osc", detail: "Approval requested" });
      dispatchSessionEvent(SID, status("needs_approval", "signal", "osc", "Approval requested"));
    });
    const el = strip();
    expect(el.dataset.confidence).toBe("signal");
    expect(el.querySelector(".session-status-strip-source")?.textContent).toBe("signal · notification");
  });

  it("names the agent the event came from, whatever the session's agent name, and says 'guessed' before any signal", () => {
    renderStrip("busy", null);
    expect(strip().querySelector(".session-status-strip-source")?.textContent).toBe("guessed");
    act(() => {
      dispatchSessionEvent(SID, status("working", "exact", "hook:claude"));
    });
    expect(strip().querySelector(".session-status-strip-source")?.textContent).toBe("exact · reported by Claude Code");
  });

  it("counts running sub-agents and drops the counter when the agent exits", () => {
    renderStrip();
    expect(strip().querySelector(".session-status-strip-subagents")).toBeNull();
    act(() => {
      dispatchSessionEvent(SID, { type: "subagents", at: 1, source: "hook:claude", running: 2 });
    });
    expect(strip().dataset.subagents).toBe("2");
    expect(strip().querySelector(".session-status-strip-subagents")?.textContent).toBe("2 sub-agents");
    act(() => {
      dispatchSessionEvent(SID, { type: "subagents", at: 2, running: 1 });
    });
    expect(strip().querySelector(".session-status-strip-subagents")?.textContent).toBe("1 sub-agent");
    act(() => {
      dispatchSessionEvent(SID, { type: "subagents", at: 2, running: 0 });
    });
    expect(strip().querySelector(".session-status-strip-subagents")).toBeNull();
    act(() => {
      dispatchSessionEvent(SID, { type: "subagents", at: 3, running: 1 });
      dispatchSessionEvent(SID, { type: "exit", at: 4, source: "hook:claude", code: 0, signal: null });
    });
    expect(strip().dataset.statusKind).toBe("exited");
    expect(strip().dataset.subagents).toBe("0");
  });

  it("asks for the attention inbox on the platform's inbox shortcut", () => {
    renderStrip();
    const button = strip().querySelector(".session-status-strip-inbox") as HTMLButtonElement;
    expect(INBOX_SHORTCUT).toBe(PLATFORM === "mac" ? "⌘I" : "Ctrl+I");
    expect(button.textContent).toBe(INBOX_SHORTCUT);
    expect(button.title).toBe(`Attention inbox (${INBOX_SHORTCUT})`);
    const heard: unknown[] = [];
    window.addEventListener("hermes:open-inbox", (e) => heard.push((e as CustomEvent).detail));
    act(() => {
      (strip().querySelector(".session-status-strip-inbox") as HTMLButtonElement).click();
    });
    expect(heard).toEqual([{ sessionId: SID }]);
  });

  it("re-renders only for its own session", () => {
    renderStrip();
    act(() => {
      dispatchSessionEvent("another-session", status("error", "exact", "hook:codex", "boom"));
    });
    expect(strip().dataset.statusKind).toBe("idle");
    expect(strip().dataset.confidence).toBe("guessed");
  });
});

describe("status strip preference", () => {
  it("is on unless the setting says off, and changes live", () => {
    expect(statusStripEnabledFrom(undefined)).toBe(true);
    expect(statusStripEnabledFrom("on")).toBe(true);
    expect(statusStripEnabledFrom("OFF ")).toBe(false);
    const { result } = renderHook(() => useStatusStripEnabled());
    expect(result.current).toBe(true);
    act(() => initStatusStripPreference({ status_strip: "off" }));
    expect(result.current).toBe(false);
    expect(isStatusStripEnabled()).toBe(false);
    act(() => {
      void setStatusStripEnabled(true);
    });
    expect(result.current).toBe(true);
    expect(setSetting).toHaveBeenCalledWith("status_strip", "on");
  });
});
