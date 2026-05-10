// @vitest-environment jsdom
/**
 * Regression — AgentSessionView hook-order on first message.
 *
 * Bug shipped in 1.1.7/1.1.8 (this file added in the fix):
 *   React error #310 — "Rendered more hooks than during the previous render."
 *
 * Path:
 *   1. Open a fresh agent session.  state.messages.length === 0,
 *      state.initialized === false, exitInfo === null → AgentSessionView
 *      hits the empty-state early return.  Hooks BEFORE the early
 *      return run; hooks AFTER it do not.
 *   2. User sends the first message.  state.messages.length becomes 1
 *      → the early return is bypassed → ALL hooks run.
 *   3. Hook count between renders changes → React throws #310.
 *
 * The fix moves the post-early-return hooks (`useMemo` for todos,
 * the second `useSession()` call) above the early return so the hook
 * count is identical on both render paths.  This test renders the
 * empty state, injects a user message into the per-session store,
 * re-renders, and asserts no React invariant fired.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// AgentSessionView pulls `listen` from @tauri-apps/api/event at module
// load time.  Stub it with a no-op unlisten — the test drives state
// directly via the store's `injectEvent` test hook instead.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

// useSession needs a Provider; rather than mounting one, mock the
// module to return a minimal context value.  The component reads
// `sendAgentEnvelope` and `state.sessions[sessionId]` — nothing else.
vi.mock("../state/SessionContext", () => ({
  useSession: () => ({
    sendAgentEnvelope: vi.fn(async () => {}),
    state: { sessions: {} },
  }),
}));

import { AgentSessionView } from "../agent/AgentSessionView";
import {
  getOrCreateAgentSessionStore,
  _resetAgentSessionStoresForTest,
} from "../agent/agentSessionStore";
import type { AgentEvent } from "../agent/types";

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // React surfaces invariants (including hook-order #310) via
  // console.error before/instead of throwing in some paths; capture
  // both.  Don't silence the host console — collected calls are
  // asserted on at the end of each test.
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  _resetAgentSessionStoresForTest();
  consoleErrorSpy.mockRestore();
});

describe("AgentSessionView — empty state → first message hook order", () => {
  it("does not violate React's hook-order invariant when the first user message lands", () => {
    const SESSION_ID = "test-hook-order-empty-to-first";

    // Path 1: render with no messages.  Hits the empty-state early
    // return.  Some hooks run.  This must not throw.
    const view = render(
      <AgentSessionView sessionId={SESSION_ID} workspacePathCount={1} />,
    );

    // Sanity: the empty-state hero is on screen, confirming we took
    // the early-return path.
    expect(view.container.textContent).toContain("awaiting first signal");

    // Inject a user message into the long-lived store — this is what
    // the user's first "Send" click does in production: the reducer
    // adds a user message and state.messages.length goes 0 → 1.
    const store = getOrCreateAgentSessionStore(
      SESSION_ID,
      async () => () => {},
    );
    const userEvent: AgentEvent = {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
      session_id: SESSION_ID,
    };
    act(() => {
      store.injectEvent(userEvent);
    });

    // Path 2: re-render.  The early return is now bypassed.  ALL
    // hooks must run.  Pre-fix this is where React threw:
    //   "Rendered more hooks than during the previous render."
    expect(() => {
      view.rerender(
        <AgentSessionView sessionId={SESSION_ID} workspacePathCount={1} />,
      );
    }).not.toThrow();

    // Belt and braces — even when React doesn't throw it logs the
    // hook-order invariant to console.error.  Match the canonical
    // strings (dev) and the minified code (prod).
    const allErrorText = consoleErrorSpy.mock.calls
      .map((args) => args.map((a) => String(a)).join(" "))
      .join("\n");
    expect(allErrorText).not.toMatch(/Rendered more hooks/i);
    expect(allErrorText).not.toMatch(/Rendered fewer hooks/i);
    expect(allErrorText).not.toMatch(/Minified React error #310/i);
    expect(allErrorText).not.toMatch(/should have a queue/i);
  });

  it("survives multiple re-renders after the first message (regression scaffolding)", () => {
    // Adds a second flip — first message arrives, then a second user
    // message arrives.  This exercises the steady-state render path
    // with the hooks-above-early-return ordering and pins it against
    // future refactors that might re-introduce a conditional hook.
    const SESSION_ID = "test-hook-order-multi-render";

    const view = render(
      <AgentSessionView sessionId={SESSION_ID} workspacePathCount={1} />,
    );
    const store = getOrCreateAgentSessionStore(
      SESSION_ID,
      async () => () => {},
    );

    for (let i = 0; i < 3; i++) {
      const evt: AgentEvent = {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "text", text: `msg ${i}` }],
        },
        session_id: SESSION_ID,
      };
      act(() => {
        store.injectEvent(evt);
      });
      expect(() => {
        view.rerender(
          <AgentSessionView sessionId={SESSION_ID} workspacePathCount={1} />,
        );
      }).not.toThrow();
    }

    const allErrorText = consoleErrorSpy.mock.calls
      .map((args) => args.map((a) => String(a)).join(" "))
      .join("\n");
    expect(allErrorText).not.toMatch(/Rendered (more|fewer) hooks/i);
    expect(allErrorText).not.toMatch(/Minified React error #310/i);
  });
});
