/**
 * The SSH jump host must reach the backend on every ssh-spawning call,
 * otherwise sessions behind a bastion can't connect.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn((..._args: unknown[]) => Promise.resolve([]));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

import {
  createSession,
  sshListTmuxSessions,
  sshListTmuxWindows,
  sshTmuxNewWindow,
  sshTmuxRenameWindow,
  sshTmuxSelectWindow,
} from "../api/sessions";

describe("SSH jump host is forwarded to the backend", () => {
  beforeEach(() => invoke.mockClear());

  function lastArgs() {
    return invoke.mock.calls.at(-1)?.[1] as Record<string, unknown>;
  }

  it("createSession passes sshJumpHost", async () => {
    await createSession({
      sessionId: null, label: null, workingDirectory: null, color: null,
      workspacePaths: null, aiProvider: null, projectIds: null,
      sshHost: "db.internal", sshJumpHost: "bastion.example.com",
    });
    expect(lastArgs().sshJumpHost).toBe("bastion.example.com");
  });

  it("tmux commands pass jumpHost", async () => {
    await sshListTmuxSessions("db.internal", 22, "alice", "bastion");
    expect(lastArgs().jumpHost).toBe("bastion");
    await sshListTmuxWindows("db.internal", "main", 22, "alice", "bastion");
    expect(lastArgs().jumpHost).toBe("bastion");
    await sshTmuxSelectWindow("db.internal", "main", 1, 22, "alice", "bastion");
    expect(lastArgs().jumpHost).toBe("bastion");
    await sshTmuxRenameWindow("db.internal", "main", 1, "x", 22, "alice", "bastion");
    expect(lastArgs().jumpHost).toBe("bastion");
    await sshTmuxNewWindow("db.internal", "main", 22, "alice", "bastion");
    expect(lastArgs().jumpHost).toBe("bastion");
  });
});
