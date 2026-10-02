// @vitest-environment jsdom
/**
 * The task launcher (⌘N) after the QA pass, driven through the DOM with the
 * same in-memory capability commands as task-launcher-ui.test.tsx:
 *   - Launch & next keeps what was typed while the launch ran (SOLO-01);
 *   - the keyboard is never left on the page when the focused control goes
 *     away (SOLO-02), ⌘N on the open sheet gives it back;
 *   - a project switch brings that project's usual combination (SOLO-03);
 *   - an added account: its own sign-in, its own models, never swapped on
 *     its own (ACC-01/02/04/05), typed Claude model ids (ACC-11);
 *   - Enter in the path field confirms the folder (SOLO-11), "~" is read;
 *   - preset names are unique, an empty offer name keeps the offer
 *     (SOLO-17/18); the preview says what the launch adds (SOLO-19);
 *   - an empty repository, the current checkout said in red, the reason
 *     Launch is off tied to it (QAGIT-15/16, NEWCOMER-12).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { DoctorRow } from "../api/doctor";
import type { RepoProbe } from "../api/launcher";
import type { FakeCapabilityCommands } from "./fakes/capabilityCommands";

const h = vi.hoisted(() => ({
  doctor: [] as DoctorRow[],
  probe: new Map<string, RepoProbe>(),
  disk: { free_bytes: 100 * 1024 ** 3, required_bytes: 10 * 1024 ** 3, below_threshold: false },
  settings: new Map<string, string>(),
  projects: [] as { id: string; name: string; path: string; path_exists: boolean; session_count: number }[],
  cap: null as unknown as FakeCapabilityCommands,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "agent_doctor") return h.doctor;
    if (cmd === "task_repo_probe") {
      return h.probe.get(String(args.path)) ?? { git_root: null, branch_exists: false, local_branches: [], worktree_toml: null, current_branch: null, exists: false, is_dir: false, has_commits: false, resolved: String(args.path) };
    }
    if (cmd === "git_disk_status") return h.disk;
    if (cmd === "get_projects_ordered") return h.projects;
    const answer = h.cap.handle(cmd, args ?? {});
    if (answer) return answer.value;
    throw new Error(`command ${cmd} not found`);
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

import { TaskLauncher, type TaskLaunchRequest, type TaskLaunchResult } from "../components/TaskLauncher";
import { I18nProvider } from "../i18n/I18nProvider";
import { __resetDoctorForTest } from "../launcher/doctorStore";
import { fakeCapabilityCommands } from "./fakes/capabilityCommands";
import { __resetOffersForTest, clearLauncherDraft, setPendingSuggestion } from "../launcher/draft";
import { isMac } from "../utils/platform";
import type { AgentCapabilities, LaunchChoice } from "../agent/capabilities/types";

function doctorRow(id: string, name: string, over: Partial<DoctorRow> = {}): DoctorRow {
  return { id, name, installed: true, version: "1.2.3", min_version: null, version_ok: null, signed_in: "yes", signals: "exact", resume: true, retired: false, retired_note: null, beta: false, ...over };
}

vi.setConfig({ testTimeout: 20_000 });

const REPO = "/fixture-home/repo";
const OTHER = "/fixture-home/other";

beforeEach(() => {
  h.doctor = [doctorRow("claude", "Claude Code"), doctorRow("codex", "Codex CLI")];
  h.probe = new Map([
    [REPO, { git_root: REPO, branch_exists: false, local_branches: ["main", "develop", "feature/inbox"], worktree_toml: 'done_when = ["npm test"]\n', current_branch: "main" }],
    [OTHER, { git_root: OTHER, branch_exists: false, local_branches: ["main"], worktree_toml: null, current_branch: "main" }],
  ]);
  h.disk = { free_bytes: 100 * 1024 ** 3, required_bytes: 10 * 1024 ** 3, below_threshold: false };
  h.settings = new Map();
  h.projects = [
    { id: "p1", name: "repo", path: REPO, path_exists: true, session_count: 9 },
    { id: "p2", name: "other", path: OTHER, path_exists: true, session_count: 1 },
  ];
  __resetDoctorForTest();
  h.cap = fakeCapabilityCommands(() => h.doctor);
  clearLauncherDraft();
  setPendingSuggestion(null);
  __resetOffersForTest();
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 300));
  });

async function open(props: Partial<Parameters<typeof TaskLauncher>[0]> = {}, result: TaskLaunchResult = true) {
  const onLaunch = vi.fn(async (_req: TaskLaunchRequest) => result);
  const onSignIn = vi.fn();
  const onClose = vi.fn();
  const ui = render(
    <I18nProvider>
      <TaskLauncher defaultRepo={REPO} onLaunch={onLaunch} onSignIn={onSignIn} onClose={onClose} {...props} />
    </I18nProvider>,
  );
  await settle();
  await settle();
  return { onLaunch, onSignIn, onClose, ui };
}

const task = () => screen.getByPlaceholderText(/Describe the task/) as HTMLTextAreaElement;
const launchButton = () => document.querySelector(".task-launcher-launch") as HTMLButtonElement;
const chip = (name: string) => document.querySelector(`[data-chip="${name}"]`) as HTMLButtonElement;
const blocks = () => [...document.querySelectorAll(".task-launcher-block")].map((b) => b.getAttribute("data-kind"));
const modKey = isMac ? { metaKey: true } : { ctrlKey: true };

async function typeTask(text: string) {
  fireEvent.change(task(), { target: { value: text } });
  await settle();
}
async function pick(chipName: string, selector: string) {
  fireEvent.click(chip(chipName));
  fireEvent.click(document.querySelector(`.task-launcher-menu ${selector}`) as HTMLElement);
  await settle();
}

const choiceOf = (over: Partial<LaunchChoice>): LaunchChoice => ({
  agentId: "claude",
  accountId: "default",
  approvalModeId: "acceptEdits",
  modelId: "default",
  effort: null,
  extraArgs: "",
  prefix: "",
  channels: [],
  where: { kind: "new-worktree", baseBranch: "", branch: "" },
  trackAsFeature: false,
  ...over,
});

/** Claude with an added "Work" account (signed in or not). */
function withWork(signedIn: boolean, more: (c: AgentCapabilities) => AgentCapabilities = (c) => c) {
  h.cap.override.set("claude", (c) =>
    more({
      ...c,
      canAddAccount: true,
      acceptsTypedModel: true,
      accounts: [...c.accounts, { id: "work", label: "Work", detail: "", signedIn, signInState: signedIn ? "signed-in" : "signed-out" }],
    }),
  );
}

describe("Launch & next and the keyboard", () => {
  it("keeps the next task typed while the launch ran (SOLO-01)", async () => {
    let finish: (v: TaskLaunchResult) => void = () => {};
    const onLaunch = vi.fn(() => new Promise<TaskLaunchResult>((r) => (finish = r)));
    await open({ onLaunch });
    await typeTask("Fix the flaky login test");
    fireEvent.keyDown(task(), { key: "Enter", ...modKey });
    await settle();
    expect(launchButton()).toHaveTextContent("Launching…");
    fireEvent.change(task(), { target: { value: "Rename formatDate to formatDay" } });
    await act(async () => finish(true));
    await settle();
    expect(task().value).toBe("Rename formatDate to formatDay");
    expect(document.querySelector(".task-launcher-launched")).toHaveTextContent("Fix the flaky login test");
    // The next one gets its own branch, not the launched one's.
    expect(chip("where")).toHaveTextContent("hermes/rename-formatdate-to-formatday");
  });

  it("clears the field when nothing new was typed (Launch & next as before)", async () => {
    await open();
    await typeTask("One");
    fireEvent.keyDown(task(), { key: "Enter", ...modKey });
    await settle();
    expect(task().value).toBe("");
    expect(document.activeElement).toBe(task());
  });

  it("gives the task field the keyboard back when the focused control goes away (SOLO-02)", async () => {
    const { onClose, ui } = await open();
    // The preset form: Esc, then Save.
    fireEvent.click(screen.getByRole("button", { name: "Save as preset…" }));
    const name = document.querySelector(".task-launcher-preset-name") as HTMLInputElement;
    expect(document.activeElement).toBe(name);
    fireEvent.keyDown(name, { key: "Escape" });
    expect(document.querySelector(".task-launcher-preset-name")).toBeNull();
    expect(document.activeElement).toBe(task());
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save as preset…" }));
    fireEvent.change(document.querySelector(".task-launcher-preset-name") as HTMLInputElement, { target: { value: "Quick fix" } });
    (document.querySelector(".task-launcher-preset-save") as HTMLButtonElement).focus();
    fireEvent.click(document.querySelector(".task-launcher-preset-save") as HTMLButtonElement);
    await settle();
    expect(document.activeElement).toBe(task());
    // A key that reaches the page itself: Esc closes, any other key brings the keyboard back.
    (document.activeElement as HTMLElement).blur();
    expect(document.activeElement).toBe(document.body);
    fireEvent.keyDown(document.body, { key: "a" });
    expect(document.activeElement).toBe(task());
    (document.activeElement as HTMLElement).blur();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalledWith({ keepDraft: true });
    // ⌘N on the open sheet: the task field again.
    (document.activeElement as HTMLElement).blur();
    ui.rerender(
      <I18nProvider>
        <TaskLauncher defaultRepo={REPO} onLaunch={vi.fn(async () => true)} onSignIn={vi.fn()} onClose={onClose} focusNonce={1} />
      </I18nProvider>,
    );
    await settle();
    expect(document.activeElement).toBe(task());
  });

  it("Enter in the path field confirms the folder and never launches (SOLO-11)", async () => {
    const { onLaunch } = await open();
    await typeTask("Rename foo to bar");
    fireEvent.click(chip("project"));
    const path = document.querySelector(".task-launcher-repo") as HTMLInputElement;
    fireEvent.change(path, { target: { value: OTHER } });
    await settle();
    fireEvent.keyDown(path, { key: "Enter" });
    await settle();
    expect(onLaunch).not.toHaveBeenCalled();
    expect(document.querySelector(".task-launcher-menu")).toBeNull();
    expect(document.activeElement).toBe(task());
    expect(chip("project")).toHaveTextContent("other");
    fireEvent.keyDown(task(), { key: "Enter" });
    await settle();
    expect(onLaunch).toHaveBeenCalledTimes(1);
    expect(onLaunch.mock.calls[0][0].repoRoot).toBe(OTHER);
  });
});

describe("the usual combination per project (SOLO-03)", () => {
  it("follows the project switched to, when the person has not changed the choice", async () => {
    h.cap.history = [
      { repo: OTHER, choice: choiceOf({ approvalModeId: "plan" }), at: 1 },
      { repo: REPO, choice: choiceOf({ agentId: "codex", approvalModeId: "auto" }), at: 2 },
    ] as never;
    await open();
    expect(chip("agent")).toHaveTextContent("Codex CLI");
    await pick("project", `[data-project-path="${OTHER}"]`);
    await settle();
    expect(chip("agent")).toHaveTextContent("Claude Code");
    expect(chip("approval")).toHaveTextContent("Plan first");
  });

  it("only says what the project usually runs when the person changed the choice", async () => {
    h.cap.history = [{ repo: OTHER, choice: choiceOf({ approvalModeId: "plan" }), at: 1 }] as never;
    await open();
    await pick("model", '[data-model-id="opus"]');
    await pick("project", `[data-project-path="${OTHER}"]`);
    await settle();
    expect(chip("model")).toHaveTextContent("model: opus");
    const note = document.querySelector(".task-launcher-other-usual") as HTMLElement;
    expect(note).toHaveTextContent("other usually runs Claude Code · Plan first");
    fireEvent.click(screen.getByRole("button", { name: "Use it" }));
    await settle();
    expect(chip("approval")).toHaveTextContent("Plan first");
    expect(chip("model")).toHaveTextContent("model: default");
  });
});

describe("accounts", () => {
  it("signs in an added account in its own profile, said with its name (ACC-01, ACC-13)", async () => {
    withWork(false);
    const { onSignIn } = await open();
    await typeTask("Refactor the billing module");
    await pick("agent", '[data-account-id="work"]');
    expect(chip("agent")).toHaveTextContent("Claude Code · Work");
    const row = document.querySelector('.task-launcher-block[data-kind="signed-out"]') as HTMLElement;
    expect(row).toHaveTextContent("Your Work account for Claude Code is not signed in.");
    fireEvent.click(screen.getByRole("button", { name: "Sign in to Work" }));
    expect(onSignIn).toHaveBeenCalledWith("claude", "work");
    expect(launchButton()).toBeDisabled();
  });

  it("a signed-out default profile does not stop a signed-in added account (ACC-04)", async () => {
    h.doctor = [doctorRow("claude", "Claude Code", { signed_in: "no" }), doctorRow("codex", "Codex CLI")];
    withWork(true, (c) => ({ ...c, accounts: c.accounts.map((a) => (a.id === "default" ? { ...a, signedIn: false } : a)) }));
    await open();
    await typeTask("Client work");
    fireEvent.click(chip("agent"));
    expect(document.querySelector('.task-launcher-menu [data-agent-id="claude"]')).toHaveTextContent("default profile signed out · Work signed in");
    fireEvent.click(document.querySelector('.task-launcher-menu [data-account-id="work"]') as HTMLElement);
    await settle();
    expect(blocks()).toEqual([]);
    expect(launchButton()).toBeEnabled();
  });

  it("shows the chosen account's own models and moves off one it refuses (ACC-02)", async () => {
    withWork(true);
    h.cap.accountOverride.set("claude\nwork", (c) => ({ ...c, models: c.models.map((m) => (m.id === "opus" ? { ...m, available: false, unavailableReason: "opus is not on this plan" } : m)) }));
    await open();
    await pick("model", '[data-model-id="opus"]');
    await pick("agent", '[data-account-id="work"]');
    await settle();
    expect(chip("model")).toHaveTextContent("model: default");
    expect(document.querySelector('.task-launcher-fallback[data-source="account"]')).toHaveTextContent("Not available with Work:");
    fireEvent.click(chip("model"));
    expect(document.querySelector('.task-launcher-menu [data-model-id="opus"]')).toBeDisabled();
    expect(h.cap.calls.some((c) => c.cmd === "get_agent_capabilities" && c.args.accountId === "work")).toBe(true);
  });

  it("a preset on a signed-out account stays on it and waits: sign in, or the default this time (ACC-05)", async () => {
    withWork(false);
    h.cap.presets = [{ id: "p1", name: "Client X", choice: choiceOf({ accountId: "work", modelId: "opus" }) } as never];
    const { onLaunch, onSignIn } = await open();
    await typeTask("Fix the client's invoice export");
    fireEvent.keyDown(task(), { key: "1", ...modKey });
    await settle();
    expect(chip("agent")).toHaveTextContent("Claude Code · Work");
    const row = document.querySelector('.task-launcher-block[data-kind="account-held"]') as HTMLElement;
    expect(row).toHaveTextContent('The preset "Client X" uses your Work account, which is signed out.');
    expect(blocks()).toEqual(["account-held"]);
    expect(launchButton()).toBeDisabled();
    fireEvent.keyDown(task(), { key: "Enter" });
    expect(onLaunch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Sign in to Work" }));
    expect(onSignIn).toHaveBeenCalledWith("claude", "work");
    fireEvent.click(screen.getByRole("button", { name: "Use the default profile this time" }));
    await settle();
    expect(chip("agent")).toHaveTextContent("Claude Code · default profile");
    expect(launchButton()).toBeEnabled();
    expect(document.activeElement).toBe(task());
  });

  it("Check again asks the agent afresh (not the cache) and says it is checking (NEWCOMER-04)", async () => {
    h.doctor = [doctorRow("claude", "Claude Code", { signed_in: "no" })];
    await open();
    await typeTask("Fix it");
    expect(blocks()).toEqual(["signed-out"]);
    h.doctor = [doctorRow("claude", "Claude Code")];
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await settle();
    await settle();
    expect(h.cap.calls.some((c) => c.cmd === "get_agent_capabilities" && c.args.agentId === "claude" && c.args.refresh === true)).toBe(true);
    expect(blocks()).toEqual([]);
  });

  it("lets Claude take a typed model id, and names the account in the preset name (ACC-11)", async () => {
    withWork(true);
    const { onLaunch } = await open();
    await pick("agent", '[data-account-id="work"]');
    fireEvent.click(chip("model"));
    const typed = document.querySelector(".task-launcher-model-text") as HTMLInputElement;
    expect(typed.placeholder).toBe("or type a model id, e.g. claude-sonnet-4-5");
    fireEvent.change(typed, { target: { value: "claude-sonnet-4-5-20250929" } });
    fireEvent.keyDown(typed, { key: "Enter" });
    await settle();
    expect(document.querySelector(".task-launcher-menu")).toBeNull();
    expect(chip("model")).toHaveTextContent("model: claude-sonnet-4-5-20250929");
    fireEvent.click(screen.getByRole("button", { name: "Save as preset…" }));
    expect((document.querySelector(".task-launcher-preset-name") as HTMLInputElement).value).toBe("Claude Code · Work · claude-sonnet-4-5-20250929");
    fireEvent.keyDown(document.querySelector(".task-launcher-preset-name") as HTMLInputElement, { key: "Escape" });
    await typeTask("Pin the version");
    fireEvent.keyDown(task(), { key: "Enter" });
    await settle();
    expect(onLaunch.mock.calls[0][0].agents[0].choice).toMatchObject({ modelId: "claude-sonnet-4-5-20250929", accountId: "work" });
  });
});

describe("presets and the offer", () => {
  it("refuses a name another preset has, whatever its case, and says which (SOLO-17)", async () => {
    h.cap.presets = [{ id: "p1", name: "Quick fix", choice: choiceOf({ approvalModeId: "plan" }) } as never];
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Save as preset…" }));
    fireEvent.change(document.querySelector(".task-launcher-preset-name") as HTMLInputElement, { target: { value: "QUICK FIX" } });
    fireEvent.keyDown(document.querySelector(".task-launcher-preset-name") as HTMLInputElement, { key: "Enter" });
    await settle();
    expect(document.querySelector(".task-launcher-preset-error")).toHaveTextContent('You already have a preset called "Quick fix"');
    expect(h.cap.presets).toHaveLength(1);
    // The same combination as a preset is said too.
    await pick("approval", '[data-mode="plan"]');
    expect(document.querySelector(".task-launcher-preset-same")).toHaveTextContent(/Same as (⌘|Ctrl\+)1 Quick fix/);
  });

  it("Enter with an empty name keeps the offer; only 'No, don't ask again' records it (SOLO-18)", async () => {
    await open();
    for (const t of ["one", "two", "three"]) {
      await typeTask(`Offer task ${t}`);
      fireEvent.keyDown(task(), { key: "Enter", ...modKey });
      await settle();
    }
    const name = document.querySelector(".task-launcher-suggest-name") as HTMLInputElement;
    fireEvent.change(name, { target: { value: "" } });
    fireEvent.keyDown(name, { key: "Enter" });
    await settle();
    expect(document.querySelector(".task-launcher-suggest")).not.toBeNull();
    expect(h.cap.dismissed).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "No, don't ask again" }));
    await settle();
    expect(h.cap.dismissed).toHaveLength(1);
    expect(document.activeElement).toBe(task());
  });
});

describe("what Launch does, said before it", () => {
  it("adds the project context note to 'Hermes will run' (SOLO-19)", async () => {
    await open();
    expect(document.querySelector(".task-launcher-context-note")).toBeNull();
    await typeTask("Fix it");
    const note = document.querySelector(".task-launcher-context-note") as HTMLElement;
    expect(note).toHaveTextContent("+ project context note");
    expect(note.getAttribute("title")).toMatch(/for project context about the attached workspaces/);
  });

  it("an empty repository blocks a new worktree, and offers the current checkout (QAGIT-15)", async () => {
    h.probe.set(REPO, { git_root: REPO, branch_exists: false, local_branches: [], worktree_toml: null, current_branch: null, exists: true, is_dir: true, has_commits: false, resolved: REPO });
    await open();
    await typeTask("Fix it");
    expect(blocks()).toEqual(["no-commits"]);
    expect(document.querySelector('.task-launcher-block[data-kind="no-commits"]')).toHaveTextContent("This repository has no commits yet — make a first commit, or run on the current checkout.");
    fireEvent.click(screen.getByRole("button", { name: "Run on the current checkout" }));
    await settle();
    expect(blocks()).toEqual([]);
  });

  it("the current checkout is said in red, and the reason Launch is off is tied to it (QAGIT-16, NEWCOMER-12)", async () => {
    await open();
    await typeTask("Look at the build");
    await pick("where", '[data-where="current-checkout"]');
    expect(chip("where")).toHaveClass("danger");
    expect(document.querySelector(".task-launcher-unisolated")).toHaveTextContent("Not isolated: edits your project folder on main.");
    // A folder that is no repository: the project chip is red and Launch names why.
    fireEvent.click(chip("project"));
    fireEvent.change(document.querySelector(".task-launcher-repo") as HTMLInputElement, { target: { value: "/fixture-home/projcets/demo" } });
    await settle();
    expect(chip("project")).toHaveClass("danger");
    expect(document.querySelector(".task-launcher-repo-state")).toHaveTextContent("No folder at this path.");
    expect(launchButton()).toBeDisabled();
    expect(launchButton()).toHaveAccessibleDescription(/No folder at this path/);
    // The rows sit with Launch, outside the part that scrolls.
    expect(document.querySelector(".task-launcher-dock #task-launcher-blocks")).not.toBeNull();
  });
});
