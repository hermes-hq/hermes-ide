/**
 * Audit findings — concrete bugs in `src/agent/agentSessionStore.ts`.
 *
 * Each `describe` block is named B1 / B2 / ... and contains a single
 * failing `it()` that demonstrates the bug.  No fixes applied —
 * these tests are intended as proof artifacts, not regressions to keep.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  AgentSessionStore,
  _capStderr,
  _resetAgentSessionStoresForTest,
} from "../agent/agentSessionStore";
import type { AgentEvent } from "../agent/types";

// ── Test bus (mirrors the helper from the existing suites). ─────────
type StubListenerHandle = {
  attached: boolean;
  fire: (payload: unknown) => void;
};
interface StubBus {
  channels: Map<string, Set<StubListenerHandle>>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  listen: <T>(name: string, handler: (msg: { payload: T }) => void) => Promise<() => void>;
}
function makeStubBus(): StubBus {
  const channels = new Map<string, Set<StubListenerHandle>>();
  return {
    channels,
    listen: <T,>(name: string, handler: (msg: { payload: T }) => void) => {
      let attached = true;
      const handle: StubListenerHandle = {
        get attached() { return attached; },
        set attached(v: boolean) { attached = v; },
        fire: (p: unknown) => handler({ payload: p as T }),
      };
      const set = channels.get(name) ?? new Set<StubListenerHandle>();
      set.add(handle);
      channels.set(name, set);
      return Promise.resolve(() => {
        handle.attached = false;
        set.delete(handle);
      });
    },
  };
}

// ── Event factories ─────────────────────────────────────────────────
function initEvent(sessionId: string): AgentEvent {
  return {
    type: "system",
    subtype: "init",
    session_id: sessionId,
    cwd: "/tmp",
    tools: [],
    mcp_servers: [],
    model: "claude-sonnet-4-6",
    permissionMode: "default",
    apiKeySource: "anthropic",
    output_style: "default",
    slash_commands: [],
  } as unknown as AgentEvent;
}
function permRequestEvent(id: string, toolName = "Bash"): AgentEvent {
  return {
    type: "_hermes_perm_request",
    id,
    toolName,
    input: { command: "echo hi" },
  } as unknown as AgentEvent;
}
function streamThinkingDelta(messageId: string, blockIndex: number, text: string): AgentEvent[] {
  // The reducer only accumulates streaming thinking text after a
  // `message_start` envelope has latched the assistant message id.
  return [
    {
      type: "stream_event",
      event: {
        type: "message_start",
        message: { id: messageId },
      },
    } as unknown as AgentEvent,
    {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: blockIndex,
        delta: { type: "thinking_delta", thinking: text },
      },
    } as unknown as AgentEvent,
  ];
}

beforeEach(() => {
  _resetAgentSessionStoresForTest();
});

// ────────────────────────────────────────────────────────────────────
// B1 — pendingPermRequest is NEVER cleared on bridge respawn (init)
// ────────────────────────────────────────────────────────────────────
describe("B1: pendingPermRequest survives bridge respawn (zombie modal)", () => {
  it("a fresh init event must clear any pending permission request, but does not", async () => {
    const bus = makeStubBus();
    const store = new AgentSessionStore("s1", bus.listen);
    await Promise.resolve();

    // Bridge asks for permission, modal pops up.
    const evCh = bus.channels.get("agent-event-s1")!;
    [...evCh][0].fire(permRequestEvent("perm-from-old-bridge"));
    expect(store.getSnapshot().pendingPermRequest?.id).toBe("perm-from-old-bridge");

    // Bridge dies (the perm request was never resolved — the bridge
    // was killed mid-canUseTool).  A respawn happens and we observe
    // the new init event.
    [...evCh][0].fire(initEvent("new-bridge-uuid"));

    // Bug: the perm modal is still showing the old bridge's request.
    // Clicking allow/deny would write a _hermes_perm_response with an
    // id the new bridge has never heard of — a no-op — and the modal
    // would stay clickable forever because the bridge will never echo
    // a matching cancel envelope.
    expect(store.getSnapshot().pendingPermRequest).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────
// B2 — streamingThinkingText leaks across bridge respawns
// ────────────────────────────────────────────────────────────────────
describe("B2: streamingThinkingText is not cleared on init (cross-respawn leak)", () => {
  it("init clears running tools / streaming id / currentStreamMessageId — but leaves streamingThinkingText behind", async () => {
    const bus = makeStubBus();
    const store = new AgentSessionStore("s1", bus.listen);
    await Promise.resolve();
    const evCh = bus.channels.get("agent-event-s1")!;

    // Old bridge streams a thinking delta, populating
    // streamingThinkingText["msg-old:0"] = "old text".
    for (const ev of streamThinkingDelta("msg-old", 0, "old text")) {
      [...evCh][0].fire(ev);
    }
    expect(store.getSnapshot().state.streamingThinkingText.size).toBe(1);

    // Bridge respawns.  reduceEvent's init branch clears
    // currentStreamMessageId, runningToolUseIds, streamingMessageId,
    // and freezes thinking timers — but never clears
    // streamingThinkingText, so the old bridge's text stays.
    [...evCh][0].fire(initEvent("new-bridge-uuid"));

    // Bug: streamingThinkingText still contains the dead bridge's
    // entries.  Repeated respawns would grow it without bound.
    expect(store.getSnapshot().state.streamingThinkingText.size).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────────
// B3 — empty stderr chunk replaces snapshot (render storm)
// ────────────────────────────────────────────────────────────────────
describe("B3: empty stderr chunk allocates a new snapshot identity", () => {
  it("getSnapshot must return the SAME reference when an empty stderr chunk arrives", async () => {
    const bus = makeStubBus();
    const store = new AgentSessionStore("s1", bus.listen);
    await Promise.resolve();
    const before = store.getSnapshot();

    // The stderr listener replaces the snapshot every single time,
    // even when the chunk is "" and the buffer is unchanged.  React's
    // useSyncExternalStore re-renders whenever the snapshot identity
    // changes; a chatty bridge that emits zero-length stderr writes
    // (or any other channel-level keepalive) would cause a render per
    // event.
    const stderrCh = bus.channels.get("agent-stderr-s1")!;
    [...stderrCh][0].fire("");

    const after = store.getSnapshot();
    expect(after.stderr).toBe(""); // sanity: nothing actually changed
    // Bug: snapshot identity changes anyway → re-render storm.
    expect(after).toBe(before);
  });
});

// ────────────────────────────────────────────────────────────────────
// B4 — _capStderr drops the LEADING bytes of `chunk`, then prefixes
// the truncation header which itself pushes the buffer over the cap
// ────────────────────────────────────────────────────────────────────
describe("B4: _capStderr returns a buffer LARGER than STDERR_MAX_BYTES", () => {
  it("the truncation header pushes the returned buffer above the documented cap", () => {
    const STDERR_MAX_BYTES = 1 << 20;
    // Force the slow path: combined > STDERR_MAX_BYTES.
    const buf = "a".repeat(STDERR_MAX_BYTES);
    const chunk = "b".repeat(1024);
    const out = _capStderr(buf, chunk);

    // Documented contract (from the source comment): "Cap stderr at
    // 1 MiB."  After capping, the function returns a string whose
    // length exceeds the cap by the size of the prepended header,
    // because it slices to STDERR_MAX_BYTES and THEN concatenates the
    // header + newline.  An adversarial bridge can keep this buffer
    // at (cap + ~80) bytes indefinitely — the cap is a soft promise.
    expect(out.length).toBeLessThanOrEqual(STDERR_MAX_BYTES);
  });
});

