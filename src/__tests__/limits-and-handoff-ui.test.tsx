// @vitest-environment jsdom
/**
 * N19 UI: the "limited" tag follows the session's events, and the handoff
 * dialog offers only agents that can take the task, shows what the new
 * agent is told, and starts the session with that seed.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));

const createSession = vi.fn();
vi.mock("../state/SessionContext", () => ({
  useSession: () => ({ createSession }),
}));
vi.mock("../api/sessions", () => ({
  checkAiProviders: vi.fn(async () => ({ claude: true, codex: true, gemini: false, copilot: true })),
  updateSessionGroup: vi.fn(async () => undefined),
}));
vi.mock("../api/projects", () => ({
  getSessionProjects: vi.fn(async () => [{ id: "p1" }]),
}));
const gitCalls: string[] = [];
vi.mock("../api/git", () => ({
  gitStatus: vi.fn(async () => ({
    timestamp: 0,
    projects: [
      {
        project_id: "p1",
        project_name: "repo",
        project_path: "/fixture-home/repo",
        is_git_repo: true,
        branch: "hermes/fix-login",
        remote_branch: null,
        ahead: 0,
        behind: 0,
        files: [
          { path: "src/login.ts", status: "untracked", area: "untracked", old_path: null },
          { path: "README.md", status: "modified", area: "unstaged", old_path: null },
        ],
        has_conflicts: false,
        stash_count: 0,
        error: null,
      },
    ],
  })),
  getSessionWorktreeInfo: vi.fn(async () => ({
    id: "w",
    sessionId: "s1",
    projectId: "p1",
    worktreePath: "/fixture-home/wt",
    branchName: "hermes/fix-login",
    isMainWorktree: false,
    createdAt: "",
  })),
  gitListBranchesForProject: vi.fn(async () => [{ name: "hermes/fix-login" }]),
  createWorktree: vi.fn(async (...a: unknown[]) => void gitCalls.push(`create ${a.slice(0, 3).join(" ")}`)),
  attachWorktree: vi.fn(async (...a: unknown[]) => void gitCalls.push(`attach ${a.join(" ")}`)),
  removeWorktree: vi.fn(async () => undefined),
  detachWorktree: vi.fn(async () => undefined),
}));

import { I18nProvider } from "../i18n/I18nProvider";
import { SessionLimitTag } from "../components/SessionLimitTag";
import { HandoffDialog } from "../components/HandoffDialog";
import { _resetSessionEventStoreForTest, dispatchSessionEvent } from "../agent/contract/sessionEventStore";
import type { SessionData } from "../types/session";

const wrap = (ui: ReactNode) => render(<I18nProvider>{ui}</I18nProvider>);

const session: SessionData = {
  id: "s1",
  label: "Login fix",
  description: "Make the login redirect work",
  color: "",
  group: null,
  phase: "idle",
  working_directory: "/fixture-home/wt",
  shell: "/bin/zsh",
  created_at: "",
  last_activity_at: "",
  workspace_paths: [],
  detected_agent: null,
  metrics: {} as SessionData["metrics"],
  ai_provider: "claude",
  auto_approve: false,
  permission_mode: "default",
  custom_prefix: "",
  custom_suffix: "",
  channels: [],
  context_injected: false,
  ssh_info: null,
  mode: "terminal",
};

beforeEach(() => {
  cleanup();
  _resetSessionEventStoreForTest();
  createSession.mockReset();
  gitCalls.length = 0;
});

describe("SessionLimitTag", () => {
  it("appears only while the session is limited, with the reset time, and offers the handoff", () => {
    const onHandOff = vi.fn();
    const { container } = wrap(<SessionLimitTag sessionId="s1" onHandOff={onHandOff} />);
    expect(container.querySelector(".session-limit-tag")).toBeNull();

    const resetsAt = Date.now() + 2 * 3_600_000;
    act(() => {
      dispatchSessionEvent("s1", { type: "limit", at: 1, state: "limited", resetsAt, window: "five_hour" });
      dispatchSessionEvent("s1", { type: "status", at: 1, status: { kind: "limited", confidence: "exact", detail: "" } });
    });
    const tag = container.querySelector(".session-limit-tag") as HTMLElement;
    expect(tag).not.toBeNull();
    expect(tag.dataset.resetsAt).toBe(String(resetsAt));
    expect(tag.dataset.confidence).toBe("exact");
    expect(tag.textContent).toContain("limited");
    expect(tag.textContent).toMatch(/resets \d/);
    fireEvent.click(screen.getByText("Hand off…"));
    expect(onHandOff).toHaveBeenCalledTimes(1);

    act(() => {
      dispatchSessionEvent("s1", { type: "limit", at: 2, state: "cleared", resetsAt: null, window: null });
      dispatchSessionEvent("s1", { type: "status", at: 2, status: { kind: "working", confidence: "exact", detail: "" } });
    });
    expect(container.querySelector(".session-limit-tag")).toBeNull();
  });

  it("says when no reset time was reported, and has no button without a handler", () => {
    const { container } = wrap(<SessionLimitTag sessionId="s2" />);
    act(() => {
      dispatchSessionEvent("s2", { type: "status", at: 1, status: { kind: "limited", confidence: "exact", detail: "" } });
    });
    expect(container.querySelector(".session-limit-tag")?.textContent).toContain("reset time not reported");
    expect(container.querySelector(".session-limit-handoff")).toBeNull();
  });
});

describe("SessionLimitTag next to the status tag", () => {
  it("says \"limited\" once: the status tag has the word, this tag the reset time and the handoff", async () => {
    const { AgentStatusTag } = await import("../components/AgentStatusTag");
    const onHandOff = vi.fn();
    const { container } = wrap(
      <div className="session-item-meta">
        <AgentStatusTag sessionId="s3" />
        <SessionLimitTag sessionId="s3" onHandOff={onHandOff} withStatusTag />
      </div>,
    );
    const resetsAt = Date.now() + 3_600_000;
    act(() => {
      dispatchSessionEvent("s3", { type: "limit", at: 1, state: "limited", resetsAt, window: "five_hour" });
      dispatchSessionEvent("s3", { type: "status", at: 1, status: { kind: "limited", confidence: "exact", detail: "" } });
    });
    const text = container.querySelector(".session-item-meta")!.textContent ?? "";
    expect(text.match(/limited/g)).toHaveLength(1); // "rate limited", from the status tag
    expect(container.querySelector(".session-limit-word")).toBeNull();
    expect(container.querySelector(".session-limit-tag")?.textContent).toMatch(/resets \d/);
    expect(screen.getByText("Hand off…")).toBeTruthy();
  });

  it("keeps its word when the row shows no status tag", () => {
    const { container } = wrap(<SessionLimitTag sessionId="s4" />);
    act(() => {
      dispatchSessionEvent("s4", { type: "status", at: 1, status: { kind: "limited", confidence: "exact", detail: "" } });
    });
    expect(container.querySelector(".session-limit-word")?.textContent).toBe("limited");
  });
});

describe("HandoffDialog", () => {
  it("continue: ready agents only, the seed names the task and the files, Start creates the session with it", async () => {
    act(() => {
      dispatchSessionEvent("s1", { type: "status", at: 1, status: { kind: "limited", confidence: "exact", detail: "" } });
    });
    createSession.mockImplementation(async (opts: { sessionId: string }) => ({ ...session, id: opts.sessionId }));
    const onClose = vi.fn();
    wrap(<HandoffDialog session={session} initialKind="continue" onClose={onClose} />);

    // The first ready agent is picked once the list is known.
    const agent = (id: string) => document.querySelector<HTMLInputElement>(`.handoff-agents input[value="${id}"]`);
    await waitFor(() => expect(agent("codex")?.checked).toBe(true));
    const agents = [...document.querySelectorAll<HTMLInputElement>(".handoff-agents input")];
    expect(agents.some((a) => a.value === "claude")).toBe(false);
    expect(agent("codex")!.disabled).toBe(false);
    expect(agent("gemini")!.disabled).toBe(true);
    expect(agent("gemini")!.closest("label")!.textContent).toContain("not installed");

    await waitFor(() => expect(document.querySelector(".handoff-file")).not.toBeNull());
    const seed = document.querySelector(".handoff-seed-text")!.textContent!;
    expect(seed).toContain("Make the login redirect work");
    expect(seed).toContain("until it hit its usage limit");
    expect(seed).toContain("- new: src/login.ts");
    expect(seed).toContain("- modified: README.md");

    // The task is editable and the seed follows it.
    fireEvent.change(document.querySelector(".handoff-task")!, { target: { value: "Finish the redirect" } });
    expect(document.querySelector(".handoff-seed-text")!.textContent).toContain("Task:\nFinish the redirect\n");

    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(gitCalls).toEqual([expect.stringMatching(/^attach .+ p1 hermes\/fix-login$/)]);
    const opts = createSession.mock.calls[0][0];
    expect(opts.aiProvider).toBe("codex");
    expect(opts.parentSessionId).toBe("s1");
    expect(opts.seedPrompt).toContain("Task:\nFinish the redirect\n");
    expect(opts.seedPrompt).toContain("src/login.ts");
  });

  it("duplicate: no file list, a child branch, and an error stays in the dialog", async () => {
    createSession.mockImplementation(async () => null);
    const onClose = vi.fn();
    wrap(<HandoffDialog session={session} initialKind="duplicate" onClose={onClose} />);
    await waitFor(() => expect(document.querySelector('.handoff-agents input[value="codex"]')).not.toBeNull());
    await waitFor(() => expect((screen.getByRole("button", { name: "Start" }) as HTMLButtonElement).disabled).toBe(false));
    expect(document.querySelector(".handoff-files")).toBeNull();
    expect(document.querySelector(".handoff-seed-text")!.textContent).toContain("work independently");
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(document.querySelector(".handoff-error")).not.toBeNull());
    expect(gitCalls[0]).toMatch(/^create .+ p1 hermes\/fix-login--codex$/);
    expect(onClose).not.toHaveBeenCalled();
    expect(document.querySelector(".handoff-error")!.textContent).toContain("Could not start the new session");
  });
});
