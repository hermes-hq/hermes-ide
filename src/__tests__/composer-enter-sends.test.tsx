// @vitest-environment jsdom
/**
 * Agent composer — Enter sends, Shift+Enter inserts a newline.
 *
 * Hermes previously used the email-composer convention (Cmd/Ctrl+Enter
 * sends, naked Enter inserts a newline).  Agent mode is a direct
 * competitor to Claude.ai / ChatGPT / Cursor, all of which use the
 * chat convention (Enter sends, Shift+Enter newline) — Hermes users
 * coming from those tools were Enter-firing reflexively and getting
 * stray newlines instead of sends.
 *
 * Contract:
 *   - Plain Enter  → submitAgentMessage called, draft cleared.
 *   - Shift+Enter  → submitAgentMessage NOT called (newline preserved
 *                    via default textarea behaviour).
 *   - Cmd/Ctrl+Enter → still sends (compat path for users who learned
 *                      the old binding).
 *   - During IME composition, plain Enter does NOT submit — the Enter
 *     is committing a codepoint, not a message.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const dispatchMock = vi.fn();
const submitAgentMessageMock = vi.fn(async () => {});

interface FakeSessionState {
  activeSessionId: string;
  sessions: Record<string, { id: string; mode: string }>;
  composers: Record<string, { draft: string; height: number; expanded: boolean }>;
}

const fakeState: FakeSessionState = {
  activeSessionId: "test-session",
  sessions: {
    "test-session": { id: "test-session", mode: "agent" },
  },
  composers: {
    // Non-empty draft so handleSubmit doesn't no-op.
    "test-session": { draft: "hello world", height: 120, expanded: true },
  },
};

vi.mock("../state/SessionContext", () => ({
  useSession: () => ({
    state: fakeState,
    dispatch: dispatchMock,
    switchAgentModel: vi.fn(),
    switchAgentPermissionMode: vi.fn(),
    switchAgentEffort: vi.fn(),
    submitAgentMessage: submitAgentMessageMock,
  }),
  useComposer: () => fakeState.composers["test-session"],
}));

vi.mock("../agent/useAgentInit", () => ({
  useAgentInit: () => null,
}));
vi.mock("../agent/useAgentPrewarm", () => ({
  useAgentPrewarm: () => ({ slashCommands: [], catalog: [] }),
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: async () => () => {},
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));
vi.mock("../api/agent", () => ({
  readImageForAttachment: vi.fn(),
}));

import { SessionComposer } from "../components/SessionComposer";

function getTextarea(container: HTMLElement): HTMLTextAreaElement {
  const el = container.querySelector("textarea.session-composer-input");
  if (!el) throw new Error("composer textarea not found");
  return el as HTMLTextAreaElement;
}

beforeEach(() => {
  dispatchMock.mockClear();
  submitAgentMessageMock.mockClear();
  // Reset the draft for each test (previous tests' clears mutated this).
  fakeState.composers["test-session"]!.draft = "hello world";
});

afterEach(() => {
  cleanup();
});

describe("Agent composer — Enter sends, Shift+Enter newline", () => {
  it("plain Enter submits the message", async () => {
    const { container } = render(<SessionComposer />);
    const ta = getTextarea(container);

    fireEvent.keyDown(ta, { key: "Enter" });

    // submitAgentMessage is async — give the promise a tick.
    await Promise.resolve();
    expect(submitAgentMessageMock).toHaveBeenCalledTimes(1);
    expect(submitAgentMessageMock.mock.calls[0][1]).toBe("hello world");
  });

  it("Shift+Enter does NOT submit (newline is the default textarea behaviour)", () => {
    const { container } = render(<SessionComposer />);
    const ta = getTextarea(container);

    fireEvent.keyDown(ta, { key: "Enter", shiftKey: true });

    expect(submitAgentMessageMock).not.toHaveBeenCalled();
  });

  it("Cmd/Ctrl+Enter still submits (compat path)", async () => {
    const { container } = render(<SessionComposer />);
    const ta = getTextarea(container);

    // Either modifier — isActionMod handles platform routing.
    fireEvent.keyDown(ta, { key: "Enter", metaKey: true, ctrlKey: true });

    await Promise.resolve();
    expect(submitAgentMessageMock).toHaveBeenCalledTimes(1);
  });

  it("Enter during an IME composition does NOT submit", () => {
    const { container } = render(<SessionComposer />);
    const ta = getTextarea(container);

    // Composition begins; Enter commits the IME codepoint, not the
    // message.  React/jsdom expose this via nativeEvent.isComposing on
    // the keydown — fireEvent passes the init dict through.
    fireEvent.compositionStart(ta);
    fireEvent.keyDown(ta, { key: "Enter", isComposing: true });

    expect(submitAgentMessageMock).not.toHaveBeenCalled();
  });

  it("plain Enter on an empty draft is a no-op (no submit, no error)", () => {
    fakeState.composers["test-session"]!.draft = "";
    const { container } = render(<SessionComposer />);
    const ta = getTextarea(container);

    fireEvent.keyDown(ta, { key: "Enter" });

    expect(submitAgentMessageMock).not.toHaveBeenCalled();
  });
});
