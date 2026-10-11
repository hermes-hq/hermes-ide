/**
 * Stop in the Agent view, and permission prompts from parallel tool calls.
 *
 *   - Two requests open at once: both must stay answerable (the turn waits
 *     on every one), not the second replacing the first.
 *   - Stop during a prompt ends the turn: the prompt goes away.
 *   - The SDK's "[Request interrupted by user]" note is not a user message.
 *   - The `error_during_execution` result of a stopped turn is not an error.
 */
import { describe, it, expect } from "vitest";
import { AgentSessionStore } from "../agent/agentSessionStore";
import { reduceAll } from "../agent/messageStore";
import { selectFatalError } from "../agent/errorSelector";
import { agentViewObservationOf } from "../agent/providers/agentViewProvider";
import type { AgentEvent } from "../agent/types";

type Handler = (msg: { payload: unknown }) => void;

async function makeStore() {
  const handlers: Record<string, Handler> = {};
  const listen = (async (name: string, h: Handler) => {
    handlers[name] = h;
    return () => {};
  }) as never;
  const store = new AgentSessionStore("s-perm", listen);
  await Promise.resolve();
  return { store, fire: (p: unknown) => handlers["agent-event-s-perm"]({ payload: p }) };
}

function perm(id: string, url: string) {
  return { type: "_hermes_perm_request", id, toolName: "WebFetch", input: { url } };
}

const init = { type: "system", subtype: "init", session_id: "x", model: "haiku", permissionMode: "default" };
const prompt = { type: "user", uuid: "u1", message: { role: "user", content: [{ type: "text", text: "Write a story" }] } };
const interrupted = {
  type: "user",
  uuid: "u2",
  message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] },
};
const stoppedResult = { type: "result", subtype: "error_during_execution", is_error: true, uuid: "r1" };

describe("parallel permission requests", () => {
  it("keeps the first request after a second arrives, and shows it once the second is answered", async () => {
    const { store, fire } = await makeStore();
    fire(perm("perm-1", "https://example.com"));
    fire(perm("perm-2", "https://example.org"));
    expect(store.getSnapshot().pendingPermRequest?.id).toBe("perm-1");

    store.clearPendingPermRequest("perm-1");
    expect(store.getSnapshot().pendingPermRequest?.id).toBe("perm-2");
    store.clearPendingPermRequest("perm-2");
    expect(store.getSnapshot().pendingPermRequest).toBeNull();
  });

  it("removing one request by id leaves a newer one in place", async () => {
    const { store, fire } = await makeStore();
    fire(perm("perm-1", "https://example.com"));
    fire(perm("perm-2", "https://example.org"));
    store.clearPendingPermRequest("perm-2");
    expect(store.getSnapshot().pendingPermRequest?.id).toBe("perm-1");
  });
});

describe("Stop during a permission prompt", () => {
  it("drops the prompt when the turn ends", async () => {
    const { store, fire } = await makeStore();
    fire(init);
    fire(perm("perm-1", "https://example.com"));
    expect(store.getSnapshot().pendingPermRequest).not.toBeNull();
    fire({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user for tool use]" }] },
    });
    // The bridge settles the cancelled request before the turn's result.
    fire({ type: "_hermes_perm_settled", id: "perm-1" });
    fire(stoppedResult);
    expect(store.getSnapshot().pendingPermRequest).toBeNull();
    expect(agentViewObservationOf(store.getSnapshot()).kind).not.toBe("needs_approval");
  });

  it("keeps a background sub-agent's request open when the main turn ends", async () => {
    const { store, fire } = await makeStore();
    fire(init);
    fire(perm("perm-1", "https://example.com"));
    fire({ type: "result", subtype: "success", is_error: false, uuid: "r2" });
    expect(store.getSnapshot().pendingPermRequest?.id).toBe("perm-1");

    store.injectEvent({ type: "_hermes_perm_settled", id: "perm-1" } as unknown as AgentEvent);
    expect(store.getSnapshot().pendingPermRequest).toBeNull();
  });
});

describe("Stop during a turn", () => {
  const events = [
    init,
    prompt,
    { type: "assistant", message: { id: "m1", role: "assistant", content: [{ type: "text", text: "Once" }], stop_reason: null } },
    interrupted,
    stoppedResult,
  ] as unknown as AgentEvent[];

  it("does not show the interrupt note as a message the user typed", () => {
    const s = reduceAll(events);
    const userTexts = s.messages
      .filter((m) => m.role === "user")
      .map((m) => (m.blocks[0] as { text?: string }).text);
    expect(userTexts).toEqual(["Write a story"]);
  });

  it("ends the turn without an error banner or an errored session", async () => {
    const s = reduceAll(events);
    expect(selectFatalError(s)).toBeNull();
    expect(s.lastError).toBeNull();

    const { store, fire } = await makeStore();
    for (const e of events) fire(e);
    expect(agentViewObservationOf(store.getSnapshot()).kind).toBe("done_unread");
  });

  it("still reports error_during_execution as an error when nobody pressed Stop", () => {
    const s = reduceAll([init, prompt, stoppedResult] as unknown as AgentEvent[]);
    expect(selectFatalError(s)).not.toBeNull();
  });
});
