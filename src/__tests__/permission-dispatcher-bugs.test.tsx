// @vitest-environment jsdom
/**
 * Failing-test bug reports for InteractivePermissionDispatcher
 * (src/agent/AgentSessionView.tsx, ~lines 285-435).
 *
 * Each `it` block below CURRENTLY FAILS on main (fix/thinking-empty-and-
 * codeblock-alignment) — the failures pin concrete defects in the perm
 * request flow.  Do NOT mark these as `.todo` or `.skip`; they're the
 * proof that the bug exists.  Pair each fix with the test going green.
 *
 * Bugs covered:
 *   B1 — bypass auto-allow useEffect double-fires for the SAME
 *        request id, sending DUPLICATE `_hermes_perm_response`
 *        envelopes (observed: 3 sends for one request in this test).
 *        Root cause: the effect's `store.clearPendingPermRequest()` is
 *        called optimistically, but React's StrictMode + the snapshot
 *        sub-bus re-fire the effect with the same closure-captured
 *        `request`.
 *   B1b — bypass auto-allow swallows send failures and clears the
 *        pending request, stranding the bridge on canUseTool. (Same
 *        useEffect; failure path has no recovery — only console.warn.)
 *   B2  — bypass auto-allow runs for AskUserQuestion / ExitPlanMode,
 *        feeding the SDK an `allow` response with NO `updatedInput`
 *        (no `answers` record) — which the SDK's Zod schema then
 *        treats as an empty answer set.
 *   B3  — `sendError` banner from a failed decision on request A
 *        survives into the render of an unrelated request B (state
 *        is local React state, not request-scoped).
 *   B4  — `inFlightRef` stays true across the boundary between
 *        request A's in-flight IPC and request B's arrival, so the
 *        FIRST click on B's modal is silently swallowed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// AgentSessionView pulls `listen` from @tauri-apps/api/event at module
// load time.  Stub with a no-op unlisten — the test drives state
// directly via the long-lived per-session store's `injectEvent` hook.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

// We need to mutate `sendAgentEnvelope`'s behaviour per-test, so the
// useSession mock reads from a module-level mutable factory.
let sendAgentEnvelopeImpl: (
  sessionId: string,
  envelope: unknown,
) => Promise<void> = async () => {};
const sendCalls: Array<{ sessionId: string; envelope: unknown }> = [];

vi.mock("../state/SessionContext", () => ({
  useSession: () => ({
    sendAgentEnvelope: (sessionId: string, envelope: unknown) => {
      sendCalls.push({ sessionId, envelope });
      return sendAgentEnvelopeImpl(sessionId, envelope);
    },
    state: { sessions: {} },
  }),
}));

// invoke() is fired-and-forgotten for "write_permission_rule" persists.
// Stub so the dynamic import resolves without trying to talk to Rust.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => undefined),
}));

import { AgentSessionView } from "../agent/AgentSessionView";
import {
  _resetAgentSessionStoresForTest,
  getOrCreateAgentSessionStore,
} from "../agent/agentSessionStore";
import type { PermRequest, PermResponse } from "../utils/permissionRequest";
import type { AgentEvent } from "../agent/types";

function bashRequest(id: string, command = "rm -rf /tmp/x"): PermRequest {
  return {
    type: "_hermes_perm_request",
    id,
    toolName: "Bash",
    input: { command },
  };
}

function askRequest(id: string): PermRequest {
  return {
    type: "_hermes_perm_request",
    id,
    toolName: "AskUserQuestion",
    input: {
      questions: [
        {
          question: "ship it?",
          header: "Q1",
          multiSelect: false,
          options: [{ label: "yes" }, { label: "no" }],
        },
      ],
    },
  };
}

beforeEach(() => {
  sendCalls.length = 0;
  sendAgentEnvelopeImpl = async () => {};
});

afterEach(() => {
  cleanup();
  _resetAgentSessionStoresForTest();
});

// ────────────────────────────────────────────────────────────────────
// B1 — bypass auto-allow useEffect double-fires for the same request
// ────────────────────────────────────────────────────────────────────
describe("InteractivePermissionDispatcher — bypass auto-allow double-fire (B1)", () => {
  it(
    "FAILING: bypass auto-allow effect sends MULTIPLE `_hermes_perm_response` " +
      "envelopes for ONE request id — the bridge sees duplicates",
    async () => {
      const SESSION_ID = "test-bypass-dupes";
      const store = getOrCreateAgentSessionStore(
        SESSION_ID,
        async () => () => {},
      );
      const initEvt: AgentEvent = {
        type: "system",
        subtype: "init",
        session_id: SESSION_ID,
        permissionMode: "bypassPermissions",
        cwd: "/tmp",
        model: "claude-3-7-sonnet",
      } as unknown as AgentEvent;
      const userMsg: AgentEvent = {
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "hi" }] },
        session_id: SESSION_ID,
      };
      act(() => {
        store.injectEvent(initEvt);
        store.injectEvent(userMsg);
      });

      // Successful sends so the .catch() doesn't restore anything.
      sendAgentEnvelopeImpl = async () => {};

      render(<AgentSessionView sessionId={SESSION_ID} workspacePathCount={1} />);

      // Inject ONE perm request.  Expectation: exactly ONE auto-allow
      // envelope leaves the dispatcher.  Reality: the effect fires
      // multiple times for the same request id.
      act(() => {
        store.injectEvent(bashRequest("perm-dup-1") as unknown as AgentEvent);
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      // Every call is for the same id (proves it's a re-fire of one
      // request, not two distinct requests landing).
      const ids = sendCalls.map((c) => (c.envelope as PermResponse).id);
      expect(new Set(ids).size).toBe(1);
      // The bug: more than one envelope is sent.  On main this is 3.
      expect(sendCalls.length).toBe(1);
    },
  );

  it(
    "FAILING: when bypass auto-allow's send fails, the request must be RESTORED " +
      "(otherwise the bridge hangs on canUseTool forever) — but right now it is " +
      "cleared from the store unconditionally, leaving the bridge waiting (B1b)",
    async () => {
      const SESSION_ID = "test-bypass-fail";
      const store = getOrCreateAgentSessionStore(
        SESSION_ID,
        async () => () => {},
      );
      const initEvt: AgentEvent = {
        type: "system",
        subtype: "init",
        session_id: SESSION_ID,
        permissionMode: "bypassPermissions",
        cwd: "/tmp",
        model: "claude-3-7-sonnet",
      } as unknown as AgentEvent;
      const userMsg: AgentEvent = {
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "hi" }] },
        session_id: SESSION_ID,
      };
      act(() => {
        store.injectEvent(initEvt);
        store.injectEvent(userMsg);
      });

      // Make the auto-allow IPC reject — simulate "Agent session not found"
      // after the bridge died between turns and respawn also failed.
      sendAgentEnvelopeImpl = async () => {
        throw new Error("bridge gone");
      };

      render(<AgentSessionView sessionId={SESSION_ID} workspacePathCount={1} />);

      act(() => {
        store.injectEvent(bashRequest("perm-bypass-1") as unknown as AgentEvent);
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      // We don't care HOW many sends happened (B1 covers that) — we
      // only care that all of them failed and nobody put the request
      // back.  The fix the dispatcher SHOULD do: restore the pending
      // perm request to the store so the user can decide manually
      // (mirrors decide()'s recovery via store.injectEvent(cached)).
      // Today the bypass effect only logs a console.warn and leaves
      // the store cleared.
      expect(store.getSnapshot().pendingPermRequest).not.toBeNull();
    },
  );
});

// ────────────────────────────────────────────────────────────────────
// B2 — bypass auto-allow ignores tool-specific shape requirements
// ────────────────────────────────────────────────────────────────────
describe("InteractivePermissionDispatcher — bypass on AskUserQuestion (B2)", () => {
  it(
    "FAILING: bypass auto-allow on AskUserQuestion sends `{behavior: allow}` " +
      "with NO updatedInput.answers — the SDK then sees an empty/missing " +
      "answers record, breaking the AskUserQuestion contract",
    async () => {
      const SESSION_ID = "test-bypass-askq";
      const store = getOrCreateAgentSessionStore(
        SESSION_ID,
        async () => () => {},
      );
      const initEvt: AgentEvent = {
        type: "system",
        subtype: "init",
        session_id: SESSION_ID,
        permissionMode: "bypassPermissions",
        cwd: "/tmp",
        model: "claude-3-7-sonnet",
      } as unknown as AgentEvent;
      const userMsg: AgentEvent = {
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "hi" }] },
        session_id: SESSION_ID,
      };
      act(() => {
        store.injectEvent(initEvt);
        store.injectEvent(userMsg);
      });

      render(<AgentSessionView sessionId={SESSION_ID} workspacePathCount={1} />);

      act(() => {
        store.injectEvent(askRequest("perm-askq") as unknown as AgentEvent);
      });

      await act(async () => {
        await Promise.resolve();
      });

      // Exactly one envelope was sent (the bypass auto-allow).
      expect(sendCalls).toHaveLength(1);
      const env = sendCalls[0].envelope as PermResponse;
      expect(env.type).toBe("_hermes_perm_response");

      // The SDK's AskUserQuestion tool contract requires that when we
      // approve, updatedInput.answers MUST be present (even if empty)
      // for the SDK to format a valid tool_result.  Bypass mode should
      // EITHER skip auto-allow for AskUserQuestion, OR synthesize a
      // sensible answers record.  Right now neither happens.
      const decision = env.decision as { behavior: string; updatedInput?: Record<string, unknown> };
      expect(decision.behavior).toBe("allow");
      expect(decision.updatedInput).toBeDefined();
      expect(decision.updatedInput).toHaveProperty("answers");
    },
  );
});

// ────────────────────────────────────────────────────────────────────
// B3 — sendError banner leaks across requests
// ────────────────────────────────────────────────────────────────────
describe("InteractivePermissionDispatcher — sendError state across requests (B3)", () => {
  it(
    "FAILING: a failed decision on request A leaves the error banner visible " +
      "while an UNRELATED request B is showing, confusing the user about which " +
      "request the error refers to",
    async () => {
      const SESSION_ID = "test-senderror-leak";
      const store = getOrCreateAgentSessionStore(
        SESSION_ID,
        async () => () => {},
      );
      const initEvt: AgentEvent = {
        type: "system",
        subtype: "init",
        session_id: SESSION_ID,
        permissionMode: "default",
        cwd: "/tmp",
        model: "claude-3-7-sonnet",
      } as unknown as AgentEvent;
      const userMsg: AgentEvent = {
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "hi" }] },
        session_id: SESSION_ID,
      };
      act(() => {
        store.injectEvent(initEvt);
        store.injectEvent(userMsg);
      });

      const view = render(
        <AgentSessionView sessionId={SESSION_ID} workspacePathCount={1} />,
      );

      // Request A arrives.
      act(() => {
        store.injectEvent(bashRequest("req-A", "echo A") as unknown as AgentEvent);
      });

      // First decision fails.  decide() restores request A via
      // store.injectEvent(cached) AND sets sendError.
      sendAgentEnvelopeImpl = async () => {
        throw new Error("disk full");
      };
      const denyBtn = view.container.querySelector(".perm-link-deny") as HTMLButtonElement;
      expect(denyBtn).not.toBeNull();
      await act(async () => {
        denyBtn.click();
        await Promise.resolve();
        await Promise.resolve();
      });

      // The error banner is visible for request A.
      expect(view.container.querySelector(".agent-perm-error")).not.toBeNull();

      // Now request B arrives — DIFFERENT id, different command.
      // (e.g. the bridge moved on after the user dismissed A elsewhere,
      // or a cached `persist` rule fired and a new tool call landed.)
      sendAgentEnvelopeImpl = async () => {};
      act(() => {
        store.injectEvent(
          bashRequest("req-B", "ls /completely/different") as unknown as AgentEvent,
        );
      });

      // The dispatcher renders request B.  But sendError lives in
      // dispatcher-local React state, NOT keyed by request.id, so the
      // banner is STILL on screen attributing the error to request B.
      // Expected: banner cleared when the request identity changes.
      expect(view.container.querySelector(".agent-perm-error")).toBeNull();
    },
  );
});

// ────────────────────────────────────────────────────────────────────
// B4 — inFlightRef latch lockout across requests
// ────────────────────────────────────────────────────────────────────
describe("InteractivePermissionDispatcher — inFlightRef lockout across requests (B4)", () => {
  it(
    "FAILING: while request A's IPC is in flight, a NEW request B arrives and " +
      "the user's first click on B is silently dropped because inFlightRef is " +
      "still true (the latch was set for A and only releases in A's .finally)",
    async () => {
      const SESSION_ID = "test-inflight-lockout";
      const store = getOrCreateAgentSessionStore(
        SESSION_ID,
        async () => () => {},
      );
      const initEvt: AgentEvent = {
        type: "system",
        subtype: "init",
        session_id: SESSION_ID,
        permissionMode: "default",
        cwd: "/tmp",
        model: "claude-3-7-sonnet",
      } as unknown as AgentEvent;
      const userMsg: AgentEvent = {
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "hi" }] },
        session_id: SESSION_ID,
      };
      act(() => {
        store.injectEvent(initEvt);
        store.injectEvent(userMsg);
      });

      const view = render(
        <AgentSessionView sessionId={SESSION_ID} workspacePathCount={1} />,
      );

      // Request A arrives.
      act(() => {
        store.injectEvent(bashRequest("req-A", "echo A") as unknown as AgentEvent);
      });

      // Make A's send block indefinitely so the latch stays set.
      let resolveA: (() => void) | null = null;
      sendAgentEnvelopeImpl = (_sid, _env) =>
        new Promise<void>((res) => {
          resolveA = () => res();
        });

      // User clicks Approve once on A — latches inFlightRef, optimistic
      // clear of the request, send is pending (will never resolve).
      const approveA = view.container.querySelector(
        ".perm-link-primary",
      ) as HTMLButtonElement;
      expect(approveA).not.toBeNull();
      await act(async () => {
        approveA.click();
        await Promise.resolve();
      });

      // sendCalls now has exactly one envelope (for A).
      expect(sendCalls).toHaveLength(1);
      expect((sendCalls[0].envelope as PermResponse).id).toBe("req-A");

      // Now request B arrives — modal re-shows.  Make B's send succeed
      // synchronously when called.
      let bSendInvoked = false;
      const previousImpl = sendAgentEnvelopeImpl;
      sendAgentEnvelopeImpl = async (_sid, env) => {
        // Sanity: the latch bug means we should NOT see this called
        // for B's first click.
        if ((env as PermResponse).id === "req-B") bSendInvoked = true;
      };
      act(() => {
        store.injectEvent(bashRequest("req-B", "echo B") as unknown as AgentEvent);
      });

      // User clicks Deny on B.
      const denyB = view.container.querySelector(
        ".perm-link-deny",
      ) as HTMLButtonElement;
      expect(denyB).not.toBeNull();
      await act(async () => {
        denyB.click();
        await Promise.resolve();
      });

      // EXPECTED behaviour: the click on request B sends an envelope
      // for req-B.  ACTUAL behaviour: inFlightRef.current is still true
      // from A (whose .finally has not run because resolveA was never
      // called), so decide() returns early and B's envelope is never
      // sent.  The user has to click again — and may not realize the
      // first click was lost.
      expect(bSendInvoked).toBe(true);
      expect(sendCalls.find((c) => (c.envelope as PermResponse).id === "req-B")).toBeDefined();

      // Tidy up: resolve A's pending promise so afterEach cleanup
      // doesn't leave dangling timers / promises.
      resolveA?.();
      // Reference previousImpl so TS doesn't flag it as unused.
      void previousImpl;
    },
  );
});
