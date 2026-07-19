// @vitest-environment jsdom
/**
 * Regression — composer IME-stuck bug shipped in 1.1.12.
 *
 * The performance audit (commit 40dea69) added IME-composition handling
 * to SessionComposer.handleChange.  The intent was to skip the
 * slash-overlay refresh during a multi-tick composition (CJK / dead-keys
 * / voice dictation).  The first implementation also skipped the
 * draft dispatch — and on WebKit (the engine Tauri uses on macOS), the
 * `compositionend` event is not always reliably fired (focus loss
 * mid-composition, certain dead-key sequences on US-International /
 * Brazilian Portuguese keyboard layouts, IME cancellation by Esc).
 *
 * Once `isComposingRef.current` was stranded at `true`, every
 * subsequent keystroke saw `composing === true` and was dropped — the
 * controlled textarea stayed pinned at empty React state, and the
 * user could not type anything until the component unmounted.
 *
 * The fix: ALWAYS dispatch the draft on change.  Skip only the
 * (expensive) slash-overlay refresh during composition.  Also reset
 * `isComposingRef` on blur as a defensive net for the WebKit
 * "no compositionend" edge case.
 *
 * This test pins both halves of the contract.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// ─── Mocks ──────────────────────────────────────────────────────────
//
// SessionComposer pulls in a mountain of context.  We replace the
// pieces it actually reads with the minimum required to make the
// textarea render and to observe the dispatched action stream.

const dispatchMock = vi.fn();

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
    "test-session": { draft: "", height: 120, expanded: true },
  },
};

vi.mock("../state/SessionContext", () => ({
  useSession: () => ({
    state: fakeState,
    dispatch: dispatchMock,
    switchAgentModel: vi.fn(),
    switchAgentPermissionMode: vi.fn(),
    switchAgentEffort: vi.fn(),
    submitAgentMessage: vi.fn(async () => {}),
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
import { I18nProvider } from "../i18n/I18nProvider";

// Helper: filter the dispatch calls down to the SET_COMPOSER_DRAFT
// actions and return the draft string each one carried.  Lets the
// test express its expectations against the *user-visible* effect
// (what would land in the controlled textarea) without coupling to
// the rest of the action stream the composer also fires.
function getDispatchedDrafts(): string[] {
  return dispatchMock.mock.calls
    .map((call) => call[0])
    .filter(
      (action: unknown): action is { type: string; draft: string } =>
        typeof action === "object" &&
        action !== null &&
        (action as { type?: string }).type === "SET_COMPOSER_DRAFT",
    )
    .map((a) => a.draft);
}

beforeEach(() => {
  dispatchMock.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("SessionComposer IME-composition stuck regression (1.1.12 bug)", () => {
  it("dispatches draft updates even after a stranded compositionstart (no matching compositionend)", () => {
    const { container } = render(<I18nProvider><SessionComposer /></I18nProvider>);
    const textarea = container.querySelector(
      "textarea.session-composer-input",
    ) as HTMLTextAreaElement | null;
    expect(textarea).not.toBeNull();

    // Step 1 — composition starts (e.g., dead-key, IME, voice
    // dictation begins).  This sets isComposingRef.current = true.
    fireEvent.compositionStart(textarea!);

    // Step 2 — WebKit's pathological case: focus changes mid-
    // composition and compositionend NEVER arrives.  Simulated by
    // not firing the matching compositionEnd event.
    //
    // Step 3 — user comes back and starts typing.  Pre-fix the
    // `composing` guard saw a stranded `true` and DROPPED every
    // change without dispatching, so the controlled textarea stayed
    // pinned to React's empty `draft` and nothing the user typed
    // could land.
    fireEvent.change(textarea!, { target: { value: "hello" } });

    const drafts = getDispatchedDrafts();
    expect(drafts).toContain("hello");
  });

  it("focus-out clears the composing flag so the next refresh runs the slash-overlay path", () => {
    const { container } = render(<I18nProvider><SessionComposer /></I18nProvider>);
    const textarea = container.querySelector(
      "textarea.session-composer-input",
    ) as HTMLTextAreaElement | null;
    expect(textarea).not.toBeNull();

    // Strand the ref via compositionstart-with-no-end.
    fireEvent.compositionStart(textarea!);
    // Defensive blur reset — without this, an isolated WKWebView edge
    // case (focus moves to another input mid-composition) leaves the
    // ref stuck.
    fireEvent.blur(textarea!);

    // Subsequent typing must still dispatch.  Use a non-slash value so
    // we don't open the slash-command dropdown (which depends on
    // scrollIntoView, not implemented under jsdom).
    fireEvent.change(textarea!, { target: { value: "world" } });
    const drafts = getDispatchedDrafts();
    expect(drafts).toContain("world");
  });

  it("normal typing (no composition events) dispatches drafts as expected", () => {
    // Pins the happy path so a future refactor of the composing-
    // guard can't accidentally drop normal keystrokes either.
    const { container } = render(<I18nProvider><SessionComposer /></I18nProvider>);
    const textarea = container.querySelector(
      "textarea.session-composer-input",
    ) as HTMLTextAreaElement | null;
    expect(textarea).not.toBeNull();

    fireEvent.change(textarea!, { target: { value: "a" } });
    fireEvent.change(textarea!, { target: { value: "ab" } });
    fireEvent.change(textarea!, { target: { value: "abc" } });

    const drafts = getDispatchedDrafts();
    expect(drafts).toEqual(expect.arrayContaining(["a", "ab", "abc"]));
  });
});
