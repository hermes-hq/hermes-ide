// @vitest-environment jsdom
/**
 * F15 — the task launcher sheet, driven through the DOM:
 *   - typing a task names the branch hermes/<slug>; Enter launches with the
 *     task, the repository's main checkout, the agent and the track;
 *   - a signed-out agent disables Launch and offers Sign in;
 *   - a folder that is not a repository, an existing branch and low disk
 *     each block Launch with their own row;
 *   - the Agent view choice exists only for Claude and is remembered;
 *   - "also run on a second agent" adds the second agent on its own branch;
 *   - the done-when line comes from .hermes/worktree.toml.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { DoctorRow } from "../api/doctor";
import type { RepoProbe } from "../api/launcher";

const h = vi.hoisted(() => ({
  doctor: [] as DoctorRow[],
  probe: new Map<string, RepoProbe>(),
  disk: { free_bytes: 100 * 1024 ** 3, required_bytes: 10 * 1024 ** 3, below_threshold: false },
  settings: new Map<string, string>(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "agent_doctor") return h.doctor;
    if (cmd === "task_repo_probe") {
      return h.probe.get(String(args.path)) ?? { git_root: null, branch_exists: false, local_branches: [], worktree_toml: null };
    }
    if (cmd === "git_disk_status") return h.disk;
    throw new Error(`unexpected ${cmd}`);
  }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(async () => null) }));
vi.mock("../api/settings", () => ({
  getSetting: vi.fn(async (k: string) => h.settings.get(k) ?? ""),
  setSetting: vi.fn(async (k: string, v: string) => {
    h.settings.set(k, v);
  }),
  getSettings: vi.fn(async () => Object.fromEntries(h.settings)),
}));

import { TaskLauncher, type TaskLaunchRequest } from "../components/TaskLauncher";
import { I18nProvider } from "../i18n/I18nProvider";
import { __resetDoctorForTest } from "../launcher/doctorStore";

function doctorRow(id: string, name: string, over: Partial<DoctorRow> = {}): DoctorRow {
  return { id, name, installed: true, version: "1.2.3", min_version: null, version_ok: null, signed_in: "yes", signals: "exact", resume: true, retired: false, retired_note: null, beta: false, ...over };
}

const REPO = "/fixture-home/repo";

beforeEach(() => {
  h.doctor = [doctorRow("claude", "Claude Code"), doctorRow("codex", "Codex CLI")];
  h.probe = new Map([[REPO, { git_root: REPO, branch_exists: false, local_branches: ["main"], worktree_toml: 'done_when = ["npm test"]\n' }]]);
  h.disk = { free_bytes: 100 * 1024 ** 3, required_bytes: 10 * 1024 ** 3, below_threshold: false };
  h.settings = new Map();
  __resetDoctorForTest();
});
afterEach(() => cleanup());

async function open(props: Partial<Parameters<typeof TaskLauncher>[0]> = {}) {
  const onLaunch = vi.fn(async (_req: TaskLaunchRequest) => true);
  const onSignIn = vi.fn();
  const onOpenAdvanced = vi.fn();
  render(
    <I18nProvider>
      <TaskLauncher defaultRepo={REPO} onLaunch={onLaunch} onSignIn={onSignIn} onOpenAdvanced={onOpenAdvanced} onClose={() => {}} {...props} />
    </I18nProvider>,
  );
  // Doctor, settings and the (debounced) repository probe.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 300));
  });
  return { onLaunch, onSignIn, onOpenAdvanced };
}

const task = () => screen.getByPlaceholderText(/Describe the task/) as HTMLTextAreaElement;
const launchButton = () => screen.getByRole("button", { name: "Launch" });
const branchInput = () => document.querySelector(".task-launcher-branch") as HTMLInputElement;
const blocks = () => [...document.querySelectorAll(".task-launcher-block")].map((b) => b.getAttribute("data-kind"));

describe("TaskLauncher", () => {
  it("names the branch from the task and launches on Enter", async () => {
    const { onLaunch } = await open();
    expect(launchButton()).toBeDisabled();
    fireEvent.change(task(), { target: { value: "Fix the login bug" } });
    expect(branchInput().value).toBe("hermes/fix-the-login-bug");
    expect(screen.getByText("npm test")).toBeInTheDocument();
    await waitFor(() => expect(launchButton()).toBeEnabled());
    fireEvent.keyDown(task(), { key: "Enter" });
    await waitFor(() => expect(onLaunch).toHaveBeenCalledTimes(1));
    expect(onLaunch.mock.calls[0][0]).toEqual({
      task: "Fix the login bug",
      repoRoot: REPO,
      agents: [{ id: "claude", mode: "terminal", branch: "hermes/fix-the-login-bug" }],
      track: "Quick",
      doneWhen: ["npm test"],
    });
    // Remembered for next time.
    expect(h.settings.get("last_ai_provider")).toBe("claude");
    expect(JSON.parse(h.settings.get("session_mode_by_provider") ?? "{}")).toEqual({ claude: "terminal" });
  });

  it("Shift+Enter is a new line, not a launch", async () => {
    const { onLaunch } = await open();
    fireEvent.change(task(), { target: { value: "x" } });
    fireEvent.keyDown(task(), { key: "Enter", shiftKey: true });
    await act(async () => {});
    expect(onLaunch).not.toHaveBeenCalled();
  });

  it("a signed-out agent disables Launch and offers Sign in", async () => {
    h.doctor = [doctorRow("claude", "Claude Code", { signed_in: "no" })];
    const { onSignIn, onLaunch } = await open();
    fireEvent.change(task(), { target: { value: "Fix it" } });
    expect(screen.getByText("Claude Code is signed out.")).toBeInTheDocument();
    expect(launchButton()).toBeDisabled();
    fireEvent.keyDown(task(), { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(onSignIn).toHaveBeenCalledWith("claude");
    expect(onLaunch).not.toHaveBeenCalled();
  });

  it("a folder that is not a git repository blocks Launch", async () => {
    await open({ defaultRepo: "/fixture-home/plain" });
    fireEvent.change(task(), { target: { value: "Fix it" } });
    expect(blocks()).toEqual(["not-git"]);
    expect(launchButton()).toBeDisabled();
  });

  it("an existing branch blocks until a free one is used", async () => {
    h.probe.set(REPO, { git_root: REPO, branch_exists: true, local_branches: ["hermes/fix-it"], worktree_toml: null });
    await open();
    fireEvent.change(task(), { target: { value: "Fix it" } });
    expect(blocks()).toEqual(["branch-exists"]);
    expect(launchButton()).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Use hermes/fix-it-2" }));
    expect(branchInput().value).toBe("hermes/fix-it-2");
    expect(blocks()).toEqual([]);
    expect(launchButton()).toBeEnabled();
    // Typing another task no longer renames a branch the user chose.
    fireEvent.change(task(), { target: { value: "Something else" } });
    expect(branchInput().value).toBe("hermes/fix-it-2");
  });

  it("low disk blocks Launch", async () => {
    h.disk = { free_bytes: 2e9, required_bytes: 10e9, below_threshold: true };
    await open();
    fireEvent.change(task(), { target: { value: "Fix it" } });
    expect(blocks()).toEqual(["low-disk"]);
    expect(screen.getByText("Only 2.0 GB free; a new worktree needs 10.0 GB.")).toBeInTheDocument();
  });

  it("offers the Agent view only for Claude, and launches in it when chosen", async () => {
    const { onLaunch } = await open();
    expect(screen.getByRole("radio", { name: "Agent view" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "Agent view" }));
    fireEvent.change(task(), { target: { value: "Fix it" } });
    fireEvent.click(launchButton());
    await waitFor(() => expect(onLaunch).toHaveBeenCalled());
    expect(onLaunch.mock.calls[0][0].agents[0]).toEqual({ id: "claude", mode: "agent", branch: "hermes/fix-it" });
    expect(JSON.parse(h.settings.get("session_mode_by_provider") ?? "{}")).toEqual({ claude: "agent" });

    fireEvent.change(document.querySelector(".task-launcher-agent")!, { target: { value: "codex" } });
    expect(screen.queryByRole("radio", { name: "Agent view" })).toBeNull();
  });

  it("runs the task on a second agent on its own branch", async () => {
    const { onLaunch } = await open();
    fireEvent.change(task(), { target: { value: "Fix it" } });
    fireEvent.click(screen.getByLabelText("Also run on a second agent"));
    fireEvent.click(screen.getByRole("radio", { name: "Full" }));
    await waitFor(() => expect(launchButton()).toBeEnabled());
    fireEvent.click(launchButton());
    await waitFor(() => expect(onLaunch).toHaveBeenCalled());
    const req = onLaunch.mock.calls[0][0];
    expect(req.agents).toEqual([
      { id: "claude", mode: "terminal", branch: "hermes/fix-it" },
      { id: "codex", mode: "terminal", branch: "hermes/fix-it-codex" },
    ]);
    expect(req.track).toBe("Full");
  });

  it("says when an agent cannot take the task at launch", async () => {
    h.doctor = [doctorRow("aider", "Aider")];
    await open();
    fireEvent.change(document.querySelector(".task-launcher-agent")!, { target: { value: "aider" } });
    expect(document.querySelector('[data-kind="no-first-prompt"]')?.textContent).toMatch(/Aider can't take the task when it starts/);
  });

  it("keeps Launch off and says so when the launch fails", async () => {
    const onLaunch = vi.fn(async () => false);
    await open({ onLaunch });
    fireEvent.change(task(), { target: { value: "Fix it" } });
    fireEvent.click(launchButton());
    await waitFor(() => expect(screen.getByText("The task could not start.")).toBeInTheDocument());
  });

  it("links to the advanced creator", async () => {
    const { onOpenAdvanced } = await open();
    fireEvent.click(document.querySelector(".task-launcher-advanced")!);
    expect(onOpenAdvanced).toHaveBeenCalled();
  });
});
