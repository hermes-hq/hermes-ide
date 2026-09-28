// @vitest-environment jsdom
/**
 * N20 — sessions survive quit, update and crash: the frontend's part.
 *
 *   1. The `sessionHost` flag reaches every `create_session` call.
 *   2. A quit asks "keep running or stop" only when a hosted session has an
 *      agent at work and nobody has answered yet.
 *   3. The dialog's three answers do three different things; Enter keeps
 *      (loses nothing), Escape cancels.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { QuitWithAgentsDialog } from "../components/QuitWithAgentsDialog";
import { I18nProvider } from "../i18n/I18nProvider";
import { createSession, quitMustAsk, sessionHostQuit } from "../api/sessions";
import { FEATURE_FLAGS } from "../featureFlags/registry";

afterEach(() => cleanup());
beforeEach(() => invoke.mockReset());

describe("the sessionHost flag", () => {
  it("is registered and reaches create_session as `sessionHost`", async () => {
    expect(FEATURE_FLAGS.some((f) => f.id === "sessionHost")).toBe(true);
    invoke.mockResolvedValueOnce({ id: "s1" });
    await createSession({
      sessionId: "s1",
      label: null,
      workingDirectory: null,
      color: null,
      workspacePaths: null,
      aiProvider: null,
      projectIds: null,
      sessionHost: true,
    });
    expect(invoke).toHaveBeenCalledWith("create_session", expect.objectContaining({ sessionId: "s1", sessionHost: true }));
  });

  it("session_host_quit carries the answer", async () => {
    invoke.mockResolvedValue(undefined);
    await sessionHostQuit(true);
    expect(invoke).toHaveBeenLastCalledWith("session_host_quit", { keepRunning: true });
    await sessionHostQuit(false);
    expect(invoke).toHaveBeenLastCalledWith("session_host_quit", { keepRunning: false });
  });
});

describe("quitMustAsk", () => {
  it("asks only for working hosted sessions without an answer yet", () => {
    expect(quitMustAsk({ working_session_ids: ["a"], quit_decision: null })).toBe(true);
    expect(quitMustAsk({ working_session_ids: [], quit_decision: null })).toBe(false);
    expect(quitMustAsk({ working_session_ids: ["a"], quit_decision: true })).toBe(false);
    expect(quitMustAsk({ working_session_ids: ["a"], quit_decision: false })).toBe(false);
  });
});

describe("QuitWithAgentsDialog", () => {
  const sessions = [
    { id: "s1", label: "Fix the parser" },
    { id: "s2", label: "Docs" },
  ];

  it("names the sessions and routes each button to its own answer", () => {
    const onKeep = vi.fn();
    const onStop = vi.fn();
    const onCancel = vi.fn();
    render(<QuitWithAgentsDialog sessions={sessions} onKeep={onKeep} onStop={onStop} onCancel={onCancel} />, { wrapper: I18nProvider });
    expect(screen.getByRole("dialog")).toHaveTextContent("Fix the parser");
    expect(screen.getByRole("dialog")).toHaveTextContent("Docs");
    expect(screen.getByRole("dialog")).toHaveTextContent("2 session(s)");

    fireEvent.click(screen.getByRole("button", { name: /keep running/i }));
    expect(onKeep).toHaveBeenCalledTimes(1);
    expect(onStop).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /stop and quit/i }));
    expect(onStop).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onKeep).toHaveBeenCalledTimes(1);
  });

  it("Enter keeps them running and Escape cancels; a backdrop click cancels too", () => {
    const onKeep = vi.fn();
    const onStop = vi.fn();
    const onCancel = vi.fn();
    render(<QuitWithAgentsDialog sessions={sessions} onKeep={onKeep} onStop={onStop} onCancel={onCancel} />, { wrapper: I18nProvider });
    fireEvent.keyDown(window, { key: "Enter" });
    expect(onKeep).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("quit-with-agents-dialog"));
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(onStop).not.toHaveBeenCalled();
  });
});
