// @vitest-environment jsdom
/**
 * F07 — the Agent view's typed error panel, rendered: which panel shows for
 * which failure, what Retry and Sign in do, and that the old exit notice is
 * unchanged while the "agentViewErrors" flag is off.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

const flags = { agentViewErrors: true };
vi.mock("../featureFlags", () => ({
  isFeatureFlagEnabled: (id: keyof typeof flags) => flags[id] ?? false,
}));

const SID = "sess-f07";
let resolveRespawn: ((ok: boolean) => void)[] = [];
const respawnAgent = vi.fn(
  () => new Promise<boolean>((resolve) => { resolveRespawn.push(resolve); }),
);
const createSession = vi.fn(async () => null);
vi.mock("../state/SessionContext", () => ({
  useSession: () => ({
    sendAgentEnvelope: vi.fn(async () => {}),
    respawnAgent,
    createSession,
    state: {
      sessions: {
        [SID]: { id: SID, ai_provider: "claude", working_directory: "/work/project", mode: "agent" },
      },
    },
  }),
}));

import { AgentSessionView } from "../agent/AgentSessionView";
import { getOrCreateAgentSessionStore, _resetAgentSessionStoresForTest } from "../agent/agentSessionStore";
import type { AgentEvent } from "../agent/types";

function setup() {
  const view = render(<AgentSessionView sessionId={SID} workspacePathCount={1} />);
  const store = getOrCreateAgentSessionStore(SID, async () => () => {});
  act(() => {
    store.injectEvent({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "hello" }] },
      session_id: SID,
    } as AgentEvent);
  });
  return { view, store };
}

const banner = (c: HTMLElement) => c.querySelector<HTMLElement>(".agent-error-banner");
const button = (c: HTMLElement, action: string) =>
  c.querySelector<HTMLButtonElement>(`.agent-error-banner-action[data-action="${action}"]`);

beforeEach(() => {
  flags.agentViewErrors = true;
  resolveRespawn = [];
  respawnAgent.mockClear();
  createSession.mockClear();
});

afterEach(() => {
  cleanup();
  _resetAgentSessionStoresForTest();
});

describe("Agent view error panel", () => {
  it("a crash shows `exited` with Retry instead of the old notice", () => {
    const { view, store } = setup();
    act(() => {
      store.injectStderr("fake-bridge: simulated crash\n");
      store.injectExit({ code: 3, signal: null });
    });
    const b = banner(view.container)!;
    expect(b).toHaveAttribute("data-kind", "exited");
    expect(b).toHaveTextContent("Claude stopped");
    expect(b).toHaveTextContent("exit code 3");
    expect(button(view.container, "retry")).toHaveTextContent("Retry");
    expect(view.container.querySelector(".agent-exit-notice")).toBeNull();
  });

  it("Retry restarts the session, a second click joins it, and success clears the panel", async () => {
    const { view, store } = setup();
    act(() => store.injectExit({ code: 3, signal: null }));
    const retry = button(view.container, "retry")!;
    fireEvent.click(retry);
    expect(respawnAgent).toHaveBeenCalledWith(SID);
    expect(button(view.container, "retry")).toHaveTextContent("Restarting…");
    // Still clickable: the second click goes to the same locked restart.
    fireEvent.click(button(view.container, "retry")!);
    expect(respawnAgent).toHaveBeenCalledTimes(2);
    await act(async () => {
      for (const r of resolveRespawn) r(true);
    });
    expect(banner(view.container)).toBeNull();
  });

  it("a failed Retry leaves the panel up", async () => {
    const { view, store } = setup();
    act(() => store.injectExit({ code: 3, signal: null }));
    fireEvent.click(button(view.container, "retry")!);
    await act(async () => {
      resolveRespawn[0](false);
    });
    expect(banner(view.container)).toHaveAttribute("data-kind", "exited");
    expect(button(view.container, "retry")).toHaveTextContent("Retry");
  });

  it("signed out shows `Claude is signed out` with Sign in, which opens the agent in a terminal session", () => {
    const { view, store } = setup();
    act(() => {
      store.injectEvent({
        type: "result",
        subtype: "success",
        is_error: true,
        result: "Not logged in · Please run /login",
        session_id: SID,
      } as unknown as AgentEvent);
      store.injectExit({ code: 0, signal: null });
    });
    const b = banner(view.container)!;
    expect(b).toHaveAttribute("data-kind", "signed_out");
    expect(b).toHaveTextContent("Claude is signed out");
    expect(button(view.container, "retry")).toBeNull();
    // The generic "couldn't continue" banner would repeat the same text.
    expect(view.container.querySelector(".agent-result-error")).toBeNull();
    fireEvent.click(button(view.container, "sign-in")!);
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({
      aiProvider: "claude",
      mode: "terminal",
      workingDirectory: "/work/project",
    }));
    expect(respawnAgent).not.toHaveBeenCalled();
  });

  it("unreadable output shows `protocol` while the process is still running", () => {
    const { view, store } = setup();
    act(() => {
      store.injectEvent({ type: "parse_error", raw: "not json {", error: "expected value" } as unknown as AgentEvent);
    });
    expect(banner(view.container)).toHaveAttribute("data-kind", "protocol");
    expect(button(view.container, "retry")).not.toBeNull();
  });

  it("a failed start shows `spawn_failed` with the reason in Details", () => {
    const { view, store } = setup();
    act(() => {
      store.injectStderr("[spawn:respawn] HERMES_BRIDGE_PATH points to a non-existent file: /work/b.mjs\n");
      store.injectExit({ code: -1, signal: "spawn-failed", kind: "spawn_failed" });
    });
    const b = banner(view.container)!;
    expect(b).toHaveAttribute("data-kind", "spawn_failed");
    expect(b.querySelector(".agent-error-banner-detail")).toHaveTextContent("non-existent file");
  });

  it("busy shows no action", () => {
    const { view, store } = setup();
    act(() => store.injectExit({ code: -1, signal: "spawn-failed", kind: "busy" }));
    expect(banner(view.container)).toHaveAttribute("data-kind", "busy");
    expect(view.container.querySelector(".agent-error-banner-action")).toBeNull();
  });

  it("with the flag off, the old exit notice is shown and no panel", () => {
    flags.agentViewErrors = false;
    const { view, store } = setup();
    act(() => store.injectExit({ code: 3, signal: null }));
    expect(banner(view.container)).toBeNull();
    expect(view.container.querySelector(".agent-exit-notice")).toHaveTextContent("Agent process crashed");
  });
});
