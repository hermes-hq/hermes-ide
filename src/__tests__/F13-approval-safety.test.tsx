// @vitest-environment jsdom
/**
 * F13 — approvals in Agent view cannot be accepted by accident.
 *
 *   - The permission prompt never takes keyboard focus, so an Enter the
 *     user meant for the composer can't press "Approve once".
 *   - "Always allow" writes the rule to the session's project
 *     (.claude/settings.local.json, scope "local"), never to the global
 *     ~/.claude/settings.json (scope "user").
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

const sendCalls: Array<{ sessionId: string; envelope: unknown }> = [];
let sessions: Record<string, { working_directory: string; permission_mode?: string }> = {};

vi.mock("../state/SessionContext", () => ({
  useSession: () => ({
    sendAgentEnvelope: async (sessionId: string, envelope: unknown) => {
      sendCalls.push({ sessionId, envelope });
    },
    state: { sessions },
  }),
}));

const invokeMock = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { PermissionRequestModal } from "../components/PermissionRequestModal";
import { AgentSessionView } from "../agent/AgentSessionView";
import {
  _resetAgentSessionStoresForTest,
  getOrCreateAgentSessionStore,
} from "../agent/agentSessionStore";
import type { PermRequest, PermResponse } from "../utils/permissionRequest";
import type { AgentEvent } from "../agent/types";

const bashRequest: PermRequest = {
  type: "_hermes_perm_request",
  id: "perm-1",
  toolName: "Bash",
  input: { command: "rm -rf build" },
};

beforeEach(() => {
  sendCalls.length = 0;
  sessions = {};
  invokeMock.mockClear();
});

afterEach(() => {
  cleanup();
  _resetAgentSessionStoresForTest();
});

describe("F13 — the permission prompt never takes keyboard focus", () => {
  it("typing and pressing Enter in the composer while the prompt appears does not decide it", async () => {
    const user = userEvent.setup();
    const onDecision = vi.fn();
    const onSend = vi.fn();
    function Screen({ showPrompt }: { showPrompt: boolean }) {
      return (
        <div>
          <textarea
            aria-label="composer"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onSend(e.currentTarget.value);
              }
            }}
          />
          {showPrompt && (
            <PermissionRequestModal request={bashRequest} permissionMode="default" onDecision={onDecision} />
          )}
        </div>
      );
    }
    const view = render(<Screen showPrompt={false} />);
    const composer = screen.getByLabelText("composer");
    await user.click(composer);
    await user.keyboard("please clean");

    // The agent asks for approval while the user is mid-sentence.
    view.rerender(<Screen showPrompt={true} />);
    expect(screen.getByRole("dialog", { name: "Permission request" })).toBeInTheDocument();
    expect(document.activeElement).toBe(composer);

    await user.keyboard(" the build folder{Enter}");
    expect(onDecision).not.toHaveBeenCalled();
    expect(onSend).toHaveBeenCalledWith("please clean the build folder");
    expect(screen.getByRole("dialog", { name: "Permission request" })).toBeInTheDocument();
  });

  it("no button of the prompt is focused when it mounts, so a stray Enter presses nothing", async () => {
    const user = userEvent.setup();
    const onDecision = vi.fn();
    render(<PermissionRequestModal request={bashRequest} permissionMode="default" onDecision={onDecision} />);
    const dialog = screen.getByRole("dialog", { name: "Permission request" });
    expect(dialog.contains(document.activeElement)).toBe(false);
    await user.keyboard("{Enter}");
    expect(onDecision).not.toHaveBeenCalled();
  });

  it("opening Edit input does not move focus to Confirm edit", async () => {
    const user = userEvent.setup();
    const onDecision = vi.fn();
    render(<PermissionRequestModal request={bashRequest} permissionMode="default" onDecision={onDecision} />);
    await user.click(screen.getByRole("button", { name: "Edit input" }));
    const confirm = screen.getByRole("button", { name: "Confirm edit" });
    expect(document.activeElement).not.toBe(confirm);
    await user.keyboard("{Enter}");
    expect(onDecision).not.toHaveBeenCalled();
  });

  it("the prompt still decides when the user clicks a button", async () => {
    const user = userEvent.setup();
    const onDecision = vi.fn();
    render(<PermissionRequestModal request={bashRequest} permissionMode="default" onDecision={onDecision} />);
    await user.click(screen.getByRole("button", { name: "Approve once" }));
    expect(onDecision).toHaveBeenCalledWith({ kind: "allow" });
  });

  it("the Always allow hint names the project's settings.local.json, not the global file", () => {
    render(<PermissionRequestModal request={bashRequest} permissionMode="default" onDecision={vi.fn()} />);
    const always = screen.getByRole("button", { name: /Always allow/ });
    expect(always.getAttribute("title")).toContain(".claude/settings.local.json");
    expect(always.getAttribute("title")).not.toContain("~/.claude/settings.json");
  });
});

describe("F13 — Always allow is saved to the project, not globally", () => {
  async function showPrompt(sessionId: string) {
    const store = getOrCreateAgentSessionStore(sessionId, async () => () => {});
    act(() => {
      store.injectEvent({
        type: "system",
        subtype: "init",
        session_id: sessionId,
        permissionMode: "default",
        cwd: "/work/project",
        model: "fake-model",
      } as unknown as AgentEvent);
      store.injectEvent({
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "clean up" }] },
        session_id: sessionId,
      } as unknown as AgentEvent);
    });
    render(<AgentSessionView sessionId={sessionId} workspacePathCount={1} />);
    act(() => {
      store.injectEvent(bashRequest as unknown as AgentEvent);
    });
    return screen.getByRole("button", { name: /Always allow/ });
  }

  async function flush() {
    // The persist call goes through a dynamic import; let it settle.
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
    }
  }

  it("writes the rule with scope local for the session's working directory", async () => {
    sessions = { "s-local": { working_directory: "/work/project", permission_mode: "default" } };
    const user = userEvent.setup();
    const always = await showPrompt("s-local");
    await user.click(always);
    await flush();

    const writes = invokeMock.mock.calls.filter(([cmd]) => cmd === "write_permission_rule");
    expect(writes).toEqual([
      [
        "write_permission_rule",
        { pattern: "Bash(rm -rf build:*)", kind: "allow", scope: "local", projectDir: "/work/project" },
      ],
    ]);
    // The agent is told to allow and to remember the rule for this session.
    expect(sendCalls).toHaveLength(1);
    expect((sendCalls[0].envelope as PermResponse).decision).toEqual({
      behavior: "allow",
      persist: "Bash(rm -rf build:*)",
    });
  });

  it("without a project folder nothing is persisted — never falls back to the global file", async () => {
    sessions = { "s-none": { working_directory: "", permission_mode: "default" } };
    const user = userEvent.setup();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const always = await showPrompt("s-none");
    await user.click(always);
    await flush();
    warn.mockRestore();

    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "write_permission_rule")).toEqual([]);
    // The in-session allow still reaches the agent.
    expect(sendCalls).toHaveLength(1);
    expect((sendCalls[0].envelope as PermResponse).decision).toMatchObject({ behavior: "allow" });
  });
});
