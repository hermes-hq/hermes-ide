// @vitest-environment jsdom
/**
 * The task launcher (⌘N), driven through the DOM with the agent catalog,
 * the doctor and the settings table behind it:
 *   - it opens pre-set to the usual full combination of the repository, so
 *     a task and Enter launch it (with the approval mode, model, effort,
 *     extra args, prefix and channels on the launch);
 *   - every chip: agent · account (Custom agent listed), project (most used
 *     first), where (new worktree + base, existing branch, current checkout),
 *     approval (the agent's real modes, Skip all in red with its note),
 *     model, effort (disabled when the model has none);
 *   - + options: extra args, the Settings prefix, channels, editable checks,
 *     Track as a feature (instead of a size), Also on with its own choices;
 *   - "Hermes will run", Recent, Launch & next (⌘⏎) keeps the sheet, Enter
 *     from any field, Esc, the draft that survives a click outside;
 *   - presets: Save as preset…, ⌘1–⌘4 apply one and keep the task, a stale
 *     preset falls back with a warning, "Save as preset?" after 3 identical
 *     launches, once;
 *   - the rows that stop Launch (signed out, not a repository, branch taken,
 *     low disk) and a launch that could only be queued;
 *   - capabilities that cannot be read stop Launch with a way to try again
 *     (never a list of Hermes's own).
 * The capability commands are answered by a typed in-memory fake with the
 * backend's rules (src/__tests__/fakes/capabilityCommands.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
      return h.probe.get(String(args.path)) ?? { git_root: null, branch_exists: false, local_branches: [], worktree_toml: null, current_branch: null };
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
import { clearLauncherDraft, setPendingSuggestion } from "../launcher/draft";
import { isMac } from "../utils/platform";
import type { AgentCapabilities } from "../agent/capabilities/types";

function doctorRow(id: string, name: string, over: Partial<DoctorRow> = {}): DoctorRow {
  return { id, name, installed: true, version: "1.2.3", min_version: null, version_ok: null, signed_in: "yes", signals: "exact", resume: true, retired: false, retired_note: null, beta: false, ...over };
}

// Each test opens the sheet (and some reopen it), waiting for the doctor,
// the settings and the debounced repository probe every time.
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
    { id: "p2", name: "other", path: OTHER, path_exists: true, session_count: 9 },
    { id: "p1", name: "repo", path: REPO, path_exists: true, session_count: 1 },
  ];
  __resetDoctorForTest();
  h.cap = fakeCapabilityCommands(() => h.doctor);
  clearLauncherDraft();
  setPendingSuggestion(null);
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
  const onOpenAdvanced = vi.fn();
  const onClose = vi.fn();
  const ui = render(
    <I18nProvider>
      <TaskLauncher defaultRepo={REPO} onLaunch={onLaunch} onSignIn={onSignIn} onOpenAdvanced={onOpenAdvanced} onClose={onClose} {...props} />
    </I18nProvider>,
  );
  await settle();
  await settle();
  return { onLaunch, onSignIn, onOpenAdvanced, onClose, ui };
}

const task = () => screen.getByPlaceholderText(/Describe the task/) as HTMLTextAreaElement;
const launchButton = () => document.querySelector(".task-launcher-launch") as HTMLButtonElement;
const chip = (name: string) => document.querySelector(`[data-chip="${name}"]`) as HTMLButtonElement;
const blocks = () => [...document.querySelectorAll(".task-launcher-block")].map((b) => b.getAttribute("data-kind"));
const preview = () => document.querySelector(".task-launcher-command")?.textContent ?? "";
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
/** Picks a value of a Select the way the mouse does: open its list, click the option. */
function choose(selector: string, value: string) {
  const trigger = document.querySelector(selector) as HTMLElement;
  expect(trigger?.getAttribute("role")).toBe("combobox");
  fireEvent.click(trigger);
  const list = document.getElementById(trigger.getAttribute("aria-controls") ?? "") as HTMLElement;
  fireEvent.click(list.querySelector(`[data-value="${value}"]`) as HTMLElement);
}
async function expand() {
  fireEvent.click(document.querySelector(".task-launcher-expand") as HTMLElement);
  await settle();
}
async function launchWithEnter() {
  fireEvent.keyDown(task(), { key: "Enter" });
  await settle();
}

describe("TaskLauncher: the defaults and Enter", () => {
  it("with nothing remembered: Claude in its safety default, a new worktree named from the task, the repo's checks; Enter launches", async () => {
    const { onLaunch, onClose } = await open();
    expect(chip("agent")).toHaveTextContent("Claude Code · default profile");
    expect(chip("approval")).toHaveTextContent("Accept edits");
    expect(chip("model")).toHaveTextContent("model: default");
    expect(launchButton()).toBeDisabled();
    await typeTask("Fix the login bug");
    expect(chip("where")).toHaveTextContent("new worktree · hermes/fix-the-login-bug");
    expect(preview()).toBe('claude --permission-mode acceptEdits "Fix the login bug"  ·  in worktree hermes/fix-the-login-bug from main');
    await launchWithEnter();
    expect(onLaunch).toHaveBeenCalledTimes(1);
    const req = onLaunch.mock.calls[0][0];
    expect(req).toMatchObject({ task: "Fix the login bug", repoRoot: REPO, track: "Quick", doneWhen: ["npm test"] });
    expect(req.agents).toHaveLength(1);
    expect(req.agents[0]).toMatchObject({
      id: "claude",
      mode: "terminal",
      branch: "hermes/fix-the-login-bug",
      createBranch: true,
      worktree: true,
      launch: { permissionMode: "acceptEdits", customPrefix: "", customSuffix: "", channels: [] },
    });
    expect(onClose).toHaveBeenCalledWith({ keepDraft: false });
    expect(h.settings.get("last_ai_provider")).toBe("claude");
    expect(h.cap.history).toHaveLength(1);
  });

  it("Settings apply: the default approval mode, the extra args and the agent's prefix", async () => {
    h.settings.set("default_permission_mode", "plan");
    h.settings.set("custom_command_suffix", "--verbose");
    h.settings.set("ai_agent_prefixes", JSON.stringify({ claude: "caffeinate -i" }));
    const { onLaunch } = await open();
    expect(chip("approval")).toHaveTextContent("Plan first");
    await typeTask("Fix it");
    expect(preview()).toBe('caffeinate -i claude --permission-mode plan "Fix it" --verbose  ·  in worktree hermes/fix-it from main');
    await expand();
    expect(screen.getByText("per agent · prefix from Settings: caffeinate -i")).toBeInTheDocument();
    await launchWithEnter();
    expect(onLaunch.mock.calls[0][0].agents[0].launch).toMatchObject({ permissionMode: "plan", customPrefix: "caffeinate -i", customSuffix: "--verbose" });
  });

  it("opens pre-set to the usual combination of the repository, so task + Enter launches it", async () => {
    const usual = { agentId: "codex", accountId: "default", approvalModeId: "bypassPermissions", modelId: "gpt-fake-luna", effort: "high", extraArgs: "", prefix: "", channels: [], where: { kind: "new-worktree", baseBranch: "develop", branch: "" }, trackAsFeature: false };
    const other = { ...usual, agentId: "claude", approvalModeId: "plan", modelId: "opus", effort: null };
    h.cap.history = [
        { repo: REPO, choice: other, at: 1 },
        { repo: REPO, choice: usual, at: 2 },
        { repo: REPO, choice: usual, at: 3 },
        { repo: OTHER, choice: other, at: 4 },
        { repo: OTHER, choice: other, at: 5 },
        { repo: OTHER, choice: other, at: 6 },
      ];
    const { onLaunch } = await open();
    expect(chip("agent")).toHaveTextContent("Codex CLI");
    expect(chip("approval")).toHaveTextContent("Skip all ⚠");
    expect(chip("approval")).toHaveClass("danger");
    expect(chip("model")).toHaveTextContent("model: gpt-fake-luna");
    expect(chip("effort")).toHaveTextContent("effort: high");
    await typeTask("Bump tauri");
    await launchWithEnter();
    const agent = onLaunch.mock.calls[0][0].agents[0];
    expect(agent).toMatchObject({ id: "codex", baseBranch: "develop", branch: "hermes/bump-tauri" });
    expect(agent.launch).toMatchObject({ permissionMode: "bypassPermissions", customSuffix: "", agentLaunch: { modelId: "gpt-fake-luna", effort: "high", accountId: null } });
  });

  it("without an active session, starts on the most used project (every launch is a session of its project)", async () => {
    h.projects = [
      { id: "p1", name: "repo", path: REPO, path_exists: true, session_count: 1 },
      { id: "p2", name: "other", path: OTHER, path_exists: true, session_count: 9 },
    ];
    await open({ defaultRepo: null });
    expect(chip("project")).toHaveTextContent("other");
    fireEvent.click(chip("project"));
    const items = [...document.querySelectorAll(".task-launcher-menu [data-project-path]")].map((b) => b.getAttribute("data-project-path"));
    expect(items).toEqual([OTHER, REPO]);
    expect(screen.getByRole("button", { name: "Browse…" })).toBeInTheDocument();
  });

  it("Shift+Enter is a new line, not a launch; Enter in any field launches", async () => {
    const { onLaunch } = await open();
    await typeTask("x");
    fireEvent.keyDown(task(), { key: "Enter", shiftKey: true });
    await settle();
    expect(onLaunch).not.toHaveBeenCalled();
    await expand();
    fireEvent.keyDown(document.querySelector(".task-launcher-extra-args") as HTMLElement, { key: "Enter" });
    await settle();
    expect(onLaunch).toHaveBeenCalledTimes(1);
  });
});

describe("TaskLauncher: the chips", () => {
  it("agent · account lists every agent, the Custom agent too; switching agent brings its own approval modes", async () => {
    const { onLaunch } = await open();
    fireEvent.click(chip("agent"));
    const ids = [...document.querySelectorAll(".task-launcher-menu [data-agent-id]")].map((b) => b.getAttribute("data-agent-id"));
    expect(ids).toContain("claude");
    expect(ids).toContain("codex");
    expect(ids).toContain("custom");
    expect(screen.getByText("Account for Claude Code")).toBeInTheDocument();
    fireEvent.click(document.querySelector('.task-launcher-menu [data-agent-id="codex"]') as HTMLElement);
    await settle();
    expect(chip("approval")).toHaveTextContent("Auto");
    fireEvent.click(chip("approval"));
    const modes = [...document.querySelectorAll(".task-launcher-approval-modes [data-mode]")].map((b) => b.getAttribute("data-mode"));
    expect(modes).toEqual(["default", "auto", "bypassPermissions"]);
    await typeTask("Do it");
    await launchWithEnter();
    expect(onLaunch.mock.calls[0][0].agents[0]).toMatchObject({ id: "codex", launch: { permissionMode: "auto" } });
  });

  it("switching agent brings back what was last launched with it (per agent and account)", async () => {
    const choice = (over: Record<string, unknown>) => ({ agentId: "claude", accountId: "default", approvalModeId: "acceptEdits", modelId: "default", effort: null, extraArgs: "", prefix: "", channels: [], where: { kind: "new-worktree", baseBranch: "", branch: "" }, trackAsFeature: false, ...over });
    h.cap.history = [
        { repo: OTHER, choice: choice({ agentId: "codex", approvalModeId: "bypassPermissions", modelId: "gpt-fake-luna", effort: "max" }), at: 1 },
        { repo: REPO, choice: choice({ modelId: "opus" }), at: 2 },
      ];
    await open();
    expect(chip("model")).toHaveTextContent("model: opus");
    await pick("agent", '[data-agent-id="codex"]');
    await settle();
    expect(chip("model")).toHaveTextContent("model: gpt-fake-luna");
    expect(chip("effort")).toHaveTextContent("effort: max");
    expect(chip("approval")).toHaveTextContent("Skip all");
    // The agent menu is still open.
    fireEvent.click(document.querySelector('.task-launcher-menu [data-agent-id="gemini"]') as HTMLElement);
    await settle();
    expect(chip("model")).toHaveTextContent("model: default");
  });

  it("approval: Skip all is red, with its note and flag", async () => {
    await open();
    fireEvent.click(chip("approval"));
    const skip = document.querySelector('.task-launcher-approval-modes [data-mode="bypassPermissions"]') as HTMLElement;
    expect(skip).toHaveClass("danger");
    fireEvent.click(skip);
    await settle();
    expect(chip("approval")).toHaveClass("danger");
    expect(document.querySelector(".task-launcher-approval-note")).toHaveClass("danger");
    expect(document.querySelector(".task-launcher-approval-note")?.textContent).toMatch(/Never asks, for anything\. Only in a throwaway worktree/);
    expect(document.querySelector(".task-launcher-approval code")?.textContent).toBe("--permission-mode bypassPermissions");
  });

  it("model and effort: the model's efforts are offered; a model without any disables the effort chip", async () => {
    const { onLaunch } = await open();
    await pick("model", '[data-model-id="opus"]');
    expect(chip("model")).toHaveTextContent("model: opus");
    expect(chip("effort")).toBeEnabled();
    fireEvent.click(chip("effort"));
    const efforts = [...document.querySelectorAll(".task-launcher-menu [data-effort]")].map((b) => b.getAttribute("data-effort"));
    expect(efforts).toEqual(["", "low", "medium", "high", "xhigh", "max"]);
    fireEvent.click(document.querySelector('.task-launcher-menu [data-effort="max"]') as HTMLElement);
    await settle();
    await typeTask("Plan the refactor");
    expect(preview()).toContain('claude --permission-mode acceptEdits "Plan the refactor" --model opus --effort max');
    await pick("model", '[data-model-id="haiku"]');
    expect(chip("effort")).toBeDisabled();
    expect(chip("effort")).toHaveTextContent("effort: n/a for haiku");
    await launchWithEnter();
    expect(onLaunch.mock.calls[0][0].agents[0].launch).toMatchObject({ customSuffix: "", agentLaunch: { modelId: "haiku", effort: null } });
  });

  it("where: an existing branch, the current checkout, or a new worktree cut from another branch", async () => {
    const { onLaunch } = await open();
    await typeTask("Fix the badge");
    fireEvent.click(chip("where"));
    fireEvent.click(document.querySelector('.task-launcher-menu [data-where="existing-branch"]') as HTMLElement);
    await settle();
    choose(".task-launcher-menu .task-launcher-existing", "feature/inbox");
    await settle();
    expect(chip("where")).toHaveTextContent("existing branch · feature/inbox");
    await launchWithEnter();
    expect(onLaunch.mock.calls[0][0].agents[0]).toMatchObject({ branch: "feature/inbox", createBranch: false, worktree: true });

    cleanup();
    const second = await open();
    await typeTask("Fix the badge");
    await pick("where", '[data-where="current-checkout"]');
    expect(chip("where")).toHaveTextContent("current checkout · main");
    expect(preview()).toContain("in repo (main)");
    await launchWithEnter();
    expect(second.onLaunch.mock.calls[0][0].agents[0]).toMatchObject({ worktree: false, createBranch: false });

    cleanup();
    const third = await open();
    // The usual is now the current checkout (the latest of two tied launches).
    expect(chip("where")).toHaveTextContent("current checkout · main");
    await typeTask("Fix the badge");
    fireEvent.click(chip("where"));
    fireEvent.click(document.querySelector('.task-launcher-menu [data-where="new-worktree"]') as HTMLElement);
    await settle();
    choose(".task-launcher-menu .task-launcher-base", "develop");
    await settle();
    expect(preview()).toContain("in worktree hermes/fix-the-badge from develop");
    await launchWithEnter();
    expect(third.onLaunch.mock.calls[0][0].agents[0]).toMatchObject({ baseBranch: "develop", createBranch: true });
  });

  it("a Custom agent needs its command, then launches it", async () => {
    const { onLaunch } = await open();
    await pick("agent", '[data-agent-id="custom"]');
    await typeTask("Summarise the logs");
    expect(blocks()).toContain("custom-command");
    expect(launchButton()).toBeDisabled();
    fireEvent.change(document.querySelector(".task-launcher-custom-command") as HTMLInputElement, { target: { value: "my-agent --fast" } });
    await settle();
    await launchWithEnter();
    expect(onLaunch.mock.calls[0][0].agents[0]).toMatchObject({ id: "custom", launch: { agentCommand: "my-agent --fast" } });
  });

  it("the keyboard alone: arrows move between chips, Enter opens one, arrows + Enter pick, Esc closes the menu first", async () => {
    const { onClose } = await open();
    chip("agent").focus();
    fireEvent.keyDown(chip("agent"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(chip("project"));
    fireEvent.keyDown(chip("project"), { key: "ArrowRight" });
    fireEvent.keyDown(chip("where"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(chip("approval"));
    fireEvent.keyDown(chip("approval"), { key: "Enter" });
    await settle();
    expect(document.querySelector('.task-launcher-menu[data-menu="approval"]')).not.toBeNull();
    expect(document.activeElement?.getAttribute("data-mode")).toBe("acceptEdits");
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowRight" });
    expect(document.activeElement?.getAttribute("data-mode")).toBe("plan");
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Enter" });
    await settle();
    expect(chip("approval")).toHaveTextContent("Plan first");
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape" });
    await settle();
    expect(document.querySelector(".task-launcher-menu")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(task(), { key: "Escape" });
    expect(onClose).toHaveBeenCalledWith({ keepDraft: false });
  });
});

describe("TaskLauncher: + options", () => {
  it("extra args, channels, checks, Track as a feature and Also on all reach the launch", async () => {
    const { onLaunch } = await open();
    await typeTask("Add ru locale");
    fireEvent.keyDown(task(), { key: ".", ...modKey });
    await settle();
    expect(document.querySelector(".task-launcher-options")).not.toBeNull();
    fireEvent.change(document.querySelector(".task-launcher-extra-args") as HTMLInputElement, { target: { value: "--debug" } });
    fireEvent.change(document.querySelector(".task-launcher-channels") as HTMLInputElement, { target: { value: "plugin:telegram" } });
    fireEvent.change(document.querySelector(".task-launcher-check-input") as HTMLInputElement, { target: { value: "npm run test:ci" } });
    fireEvent.click(screen.getByRole("button", { name: "+ add check" }));
    await settle();
    const inputs = document.querySelectorAll(".task-launcher-check-input");
    fireEvent.change(inputs[1], { target: { value: "npx tsc --noEmit" } });
    expect(screen.queryByText("Size")).toBeNull();
    const feature = screen.getByRole("checkbox", { name: /Track as a feature/ });
    expect(screen.getByText(/Questions → research → design → plan before any code/)).toBeInTheDocument();
    fireEvent.click(feature);
    fireEvent.click(document.querySelector(".task-launcher-also-toggle") as HTMLElement);
    await settle();
    choose(".task-launcher-also-approval", "bypassPermissions");
    choose(".task-launcher-also-model", "gpt-fake-terra");
    await settle();
    choose(".task-launcher-also-effort", "ultra");
    await settle();
    expect(preview()).toContain('--channels plugin:telegram --debug  +  codex --dangerously-bypass-approvals-and-sandbox "Add ru locale" -m gpt-fake-terra -c model_reasoning_effort=ultra');
    await launchWithEnter();
    const req = onLaunch.mock.calls[0][0];
    expect(req.track).toBe("Full");
    expect(req.doneWhen).toEqual(["npm run test:ci", "npx tsc --noEmit"]);
    expect(req.agents.map((a) => [a.id, a.branch, a.launch.permissionMode, a.launch.customSuffix, a.launch.agentLaunch?.modelId, a.launch.agentLaunch?.effort, a.launch.channels])).toEqual([
      ["claude", "hermes/add-ru-locale", "acceptEdits", "--debug", null, null, ["plugin:telegram"]],
      ["codex", "hermes/add-ru-locale-codex", "bypassPermissions", "", "gpt-fake-terra", "ultra", []],
    ]);
    expect(req.choice.alsoOn?.agentId).toBe("codex");
  });

  it("offers the Agent view only for Claude, and launches in it when chosen", async () => {
    const { onLaunch } = await open();
    await expand();
    fireEvent.click(document.querySelector('.task-launcher-view [data-mode="agent"]') as HTMLElement);
    await typeTask("Explain the code");
    await launchWithEnter();
    expect(onLaunch.mock.calls[0][0].agents[0].mode).toBe("agent");
    expect(JSON.parse(h.settings.get("session_mode_by_provider") ?? "{}")).toEqual({ claude: "agent" });
    cleanup();
    await open();
    await pick("agent", '[data-agent-id="codex"]');
    await expand();
    expect(document.querySelector(".task-launcher-view")).toBeNull();
  });
});

describe("TaskLauncher: flow", () => {
  it("Launch & next (⌘⏎) keeps the sheet open with the same choice and an empty task", async () => {
    const { onLaunch, onClose } = await open();
    await pick("model", '[data-model-id="sonnet"]');
    for (const t of ["Task one", "Task two"]) {
      await typeTask(t);
      fireEvent.keyDown(task(), { key: "Enter", ...modKey });
      await settle();
      expect(task().value).toBe("");
    }
    expect(onLaunch.mock.calls.map((c) => [c[0].task, c[0].agents[0].launch.agentLaunch?.modelId])).toEqual([
      ["Task one", "sonnet"],
      ["Task two", "sonnet"],
    ]);
    expect(onClose).not.toHaveBeenCalled();
    expect(document.querySelector(".task-launcher-launched")?.textContent).toContain("Launched 2");
  });

  it("the draft survives a click outside, and Esc forgets it", async () => {
    const first = await open();
    await typeTask("Half-written task");
    await pick("model", '[data-model-id="opus"]');
    fireEvent.mouseDown(document.querySelector(".task-launcher-overlay") as HTMLElement);
    expect(first.onClose).toHaveBeenCalledWith({ keepDraft: true });
    cleanup();
    await open();
    expect(task().value).toBe("Half-written task");
    expect(chip("model")).toHaveTextContent("model: opus");
    fireEvent.keyDown(task(), { key: "Escape" });
    cleanup();
    await open();
    expect(task().value).toBe("");
  });

  it("Recent lists the last tasks; one click puts it back in the task field", async () => {
    h.settings.set(
      "task_launches",
      JSON.stringify([
        { sessionId: "a", task: "Bump tauri to 2.9", agentId: "claude", mode: "terminal", repo: REPO, branch: "hermes/a", track: "Quick", doneWhen: [], pairedWith: null, createdAt: 1 },
        { sessionId: "b", task: "Add ru locale", agentId: "claude", mode: "terminal", repo: REPO, branch: "hermes/b", track: "Quick", doneWhen: [], pairedWith: null, createdAt: 2 },
      ]),
    );
    await open();
    const recents = [...document.querySelectorAll(".task-launcher-recent")].map((b) => b.textContent);
    expect(recents).toEqual(["Add ru locale", "Bump tauri to 2.9"]);
    fireEvent.click(screen.getByRole("button", { name: "Bump tauri to 2.9" }));
    expect(task().value).toBe("Bump tauri to 2.9");
  });

  it("a launch that only got queued (running-agents cap) says so and still counts", async () => {
    await open({}, "queued");
    await typeTask("Queued task");
    fireEvent.keyDown(task(), { key: "Enter", ...modKey });
    await settle();
    expect(document.querySelector(".task-launcher-queued")?.textContent).toContain("waits for a free slot");
  });

  it("keeps Launch off and says so when the launch fails", async () => {
    await open({}, false);
    await typeTask("Fix it");
    await launchWithEnter();
    expect(blocks()).toContain("failed");
  });
});

describe("TaskLauncher: presets", () => {
  it("Save as preset… then ⌘1 applies it and keeps the task text", async () => {
    await open();
    await pick("model", '[data-model-id="opus"]');
    fireEvent.click(screen.getByRole("button", { name: "Save as preset…" }));
    const name = screen.getByRole("textbox", { name: "Preset name" });
    fireEvent.change(name, { target: { value: "Deep work" } });
    fireEvent.keyDown(name, { key: "Enter" });
    await settle();
    expect(h.cap.presets.map((p: { name: string }) => p.name)).toEqual(["Deep work"]);
    await pick("model", '[data-model-id="haiku"]');
    await typeTask("Keep this text");
    fireEvent.keyDown(task(), { key: "1", ...modKey });
    await settle();
    expect(chip("model")).toHaveTextContent("model: opus");
    expect(task().value).toBe("Keep this text");
    expect(document.querySelector(".task-launcher-preset.selected")?.textContent).toContain("Deep work");
  });

  it("⌘2 applies the second preset; a stale one shows the warning and the fallback, and launches the fallback", async () => {
    const base = { accountId: "default", extraArgs: "", prefix: "", channels: [], where: { kind: "new-worktree", baseBranch: "", branch: "" }, trackAsFeature: false };
    h.cap.presets = [
        { id: "p1", name: "Quick", choice: { ...base, agentId: "claude", approvalModeId: "acceptEdits", modelId: "haiku", effort: null } },
        { id: "p2", name: "Old", choice: { ...base, agentId: "codex", approvalModeId: "auto", modelId: "gpt-4-retired", effort: "ultra" } },
      ];
    const { onLaunch } = await open();
    const presets = [...document.querySelectorAll(".task-launcher-preset")].map((b) => b.textContent);
    expect(presets).toEqual([`${isMac ? "⌘1" : "Ctrl+1"}Quick`, `${isMac ? "⌘2" : "Ctrl+2"}Old`]);
    fireEvent.keyDown(task(), { key: "2", ...modKey });
    await settle();
    const warning = document.querySelector(".task-launcher-fallback") as HTMLElement;
    expect(warning).not.toBeNull();
    expect(within(warning).getByText(/Parts of the preset "Old" are not available now/)).toBeInTheDocument();
    expect([...warning.querySelectorAll("li")].map((l) => l.getAttribute("data-field"))).toEqual(["model", "effort"]);
    expect(chip("model")).toHaveTextContent("model: default");
    expect(chip("effort")).toHaveTextContent("effort: high");
    await typeTask("Run it");
    await launchWithEnter();
    expect(onLaunch.mock.calls[0][0].agents[0]).toMatchObject({ id: "codex", launch: { permissionMode: "auto", agentLaunch: { modelId: null, effort: "high" } } });
  });

  it("a preset whose second agent lost a model says the fallback is about the second agent", async () => {
    const base = { accountId: "default", extraArgs: "", prefix: "", channels: [], where: { kind: "new-worktree", baseBranch: "", branch: "" }, trackAsFeature: false };
    h.cap.presets = [
      { id: "p1", name: "Pair", choice: { ...base, agentId: "claude", approvalModeId: "acceptEdits", modelId: "haiku", effort: null, alsoOn: { ...base, agentId: "codex", approvalModeId: "auto", modelId: "gpt-4-retired", effort: null } } },
    ];
    await open();
    fireEvent.keyDown(task(), { key: "1", ...modKey });
    await settle();
    const warning = document.querySelector(".task-launcher-fallback") as HTMLElement;
    expect(warning).not.toBeNull();
    expect([...warning.querySelectorAll("li")].map((l) => [l.getAttribute("data-field"), l.textContent])).toEqual([
      ["model", "Also on: Model gpt-4-retired is not available: using default"],
    ]);
  });

  it("after 3 identical launches: 'Save as preset?' once; saving it makes a preset chip, and ⌘N opens on it as the usual", async () => {
    const { onLaunch } = await open();
    await pick("model", '[data-model-id="sonnet"]');
    for (const t of ["One", "Two"]) {
      await typeTask(t);
      fireEvent.keyDown(task(), { key: "Enter", ...modKey });
      await settle();
      expect(document.querySelector(".task-launcher-suggest")).toBeNull();
    }
    await typeTask("Three");
    fireEvent.keyDown(task(), { key: "Enter", ...modKey });
    await settle();
    expect(onLaunch).toHaveBeenCalledTimes(3);
    const suggest = document.querySelector(".task-launcher-suggest") as HTMLElement;
    expect(suggest).not.toBeNull();
    expect(suggest.textContent).toContain("You launched this combination 3 times");
    fireEvent.change(within(suggest).getByRole("textbox"), { target: { value: "Sonnet usual" } });
    fireEvent.click(within(suggest).getByRole("button", { name: "Save" }));
    await settle();
    expect(document.querySelector(".task-launcher-suggest")).toBeNull();
    cleanup();

    await open();
    expect(document.querySelector(".task-launcher-preset")?.textContent).toContain("Sonnet usual");
    expect(document.querySelector(".task-launcher-preset")).toHaveClass("selected");
    expect(chip("model")).toHaveTextContent("model: sonnet");
    // Offered once: a fourth launch does not ask again.
    await typeTask("Four");
    fireEvent.keyDown(task(), { key: "Enter", ...modKey });
    await settle();
    expect(document.querySelector(".task-launcher-suggest")).toBeNull();
  });

  it("'Save as preset?' left unanswered is not asked again: closing the sheet, reopening, a 4th identical launch", async () => {
    const first = await open();
    await pick("model", '[data-model-id="sonnet"]');
    for (const t of ["One", "Two", "Three"]) {
      await typeTask(t);
      fireEvent.keyDown(task(), { key: "Enter", ...modKey });
      await settle();
    }
    expect(document.querySelector(".task-launcher-suggest")?.textContent).toContain("You launched this combination 3 times");
    // Recorded as offered the moment it is shown.
    expect(h.cap.dismissed).toHaveLength(1);
    fireEvent.keyDown(task(), { key: "Escape" });
    expect(first.onClose).toHaveBeenCalledWith({ keepDraft: false });
    cleanup();
    const second = await open();
    expect(chip("model")).toHaveTextContent("model: sonnet");
    expect(document.querySelector(".task-launcher-suggest")).toBeNull();
    await typeTask("Four");
    fireEvent.keyDown(task(), { key: "Enter", ...modKey });
    await settle();
    expect(second.onLaunch).toHaveBeenCalledTimes(1);
    expect(h.cap.history).toHaveLength(4);
    expect(document.querySelector(".task-launcher-suggest")).toBeNull();
  });

  it("a launch that closes the sheet asks when ⌘N opens next, with the real count, and only then", async () => {
    h.cap.history = ["a", "b", "c", "d"].map((_, i) => ({ repo: REPO, choice: { agentId: "claude", accountId: "default", approvalModeId: "acceptEdits", modelId: "default", effort: null, extraArgs: "", prefix: "", channels: [], where: { kind: "new-worktree", baseBranch: "", branch: "" }, trackAsFeature: false }, at: i + 1 }) as never);
    await open();
    await typeTask("Fifth");
    await launchWithEnter();
    cleanup();
    await open();
    const suggest = document.querySelector(".task-launcher-suggest") as HTMLElement;
    expect(suggest?.textContent).toContain("You launched this combination 5 times");
    expect((within(suggest).getByRole("textbox") as HTMLInputElement).value).toBe("Claude Code · default");
    cleanup();
    await open();
    await typeTask("Sixth");
    await launchWithEnter();
    cleanup();
    await open();
    expect(document.querySelector(".task-launcher-suggest")).toBeNull();
  });

  it("dismissing 'Save as preset?' means never again for that combination", async () => {
    await open();
    for (const t of ["a", "b", "c"]) {
      await typeTask(t);
      fireEvent.keyDown(task(), { key: "Enter", ...modKey });
      await settle();
    }
    fireEvent.click(screen.getByRole("button", { name: "No, don't ask again" }));
    await settle();
    for (const t of ["d", "e", "f"]) {
      await typeTask(t);
      fireEvent.keyDown(task(), { key: "Enter", ...modKey });
      await settle();
    }
    expect(document.querySelector(".task-launcher-suggest")).toBeNull();
    expect(h.cap.dismissed).toHaveLength(1);
  });
});

describe("TaskLauncher: rows that stop Launch", () => {
  it("a signed-out agent disables Launch and offers Sign in", async () => {
    h.doctor = [doctorRow("claude", "Claude Code", { signed_in: "no" })];
    const { onSignIn, onLaunch } = await open();
    await typeTask("Fix it");
    expect(screen.getByText("Claude Code is signed out.")).toBeInTheDocument();
    expect(launchButton()).toBeDisabled();
    fireEvent.keyDown(task(), { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(onSignIn).toHaveBeenCalledWith("claude");
    expect(onLaunch).not.toHaveBeenCalled();
  });

  it("a sign-in done while the sheet is open unblocks Launch (the usual combination is judged again)", async () => {
    h.cap.history = [{ repo: REPO, choice: { agentId: "claude", accountId: "default", approvalModeId: "plan", modelId: "opus", effort: null, extraArgs: "", prefix: "", channels: [], where: { kind: "new-worktree", baseBranch: "", branch: "" }, trackAsFeature: false }, at: 1 }];
    h.doctor = [doctorRow("claude", "Claude Code", { signed_in: "no" })];
    await open();
    await typeTask("Fix it");
    expect(blocks()).toContain("signed-out");
    expect(launchButton()).toBeDisabled();
    h.doctor = [doctorRow("claude", "Claude Code")];
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await settle();
    await settle();
    expect(blocks()).toEqual([]);
    expect(launchButton()).toBeEnabled();
    expect(chip("model")).toHaveTextContent("model: opus");
  });

  it("a folder that is not a git repository blocks Launch", async () => {
    await open({ defaultRepo: "/fixture-home/plain" });
    await typeTask("Fix it");
    expect(blocks()).toEqual(["not-git"]);
    expect(launchButton()).toBeDisabled();
  });

  it("an existing branch blocks until the suggested free one is used", async () => {
    h.probe.set(REPO, { ...(h.probe.get(REPO) as RepoProbe), local_branches: ["main", "hermes/fix-it"] });
    await open();
    await typeTask("Fix it");
    expect(blocks()).toEqual(["branch-exists"]);
    fireEvent.click(screen.getByRole("button", { name: "Use hermes/fix-it-2" }));
    await settle();
    expect(blocks()).toEqual([]);
    expect(launchButton()).toBeEnabled();
  });

  it("low disk blocks a new worktree, not the current checkout", async () => {
    h.disk = { free_bytes: 2e9, required_bytes: 10e9, below_threshold: true };
    await open();
    await typeTask("Fix it");
    expect(blocks()).toEqual(["low-disk"]);
    await pick("where", '[data-where="current-checkout"]');
    expect(blocks()).toEqual([]);
  });
});

describe("TaskLauncher: what the agents offer comes from the capability commands only", () => {
  it("shows the agent's accounts and passes model, effort and account as the launch contract's options", async () => {
    h.cap.override.set("claude", (caps) => ({
      ...caps,
      accounts: [
        { id: "default", label: "Personal", detail: "Pro plan", signedIn: true },
        { id: "work", label: "Work", detail: "Max plan", profileEnv: { name: "CLAUDE_CONFIG_DIR", value: "~/.claude-work" }, signedIn: true },
      ],
    }));
    const { onLaunch } = await open();
    fireEvent.click(chip("agent"));
    fireEvent.click(document.querySelector('.task-launcher-menu [data-account-id="work"]') as HTMLElement);
    await settle();
    expect(chip("agent")).toHaveTextContent("Claude Code · Work");
    await pick("model", '[data-model-id="opus"]');
    await pick("effort", '[data-effort="high"]');
    await typeTask("Real work");
    expect(preview()).toContain('CLAUDE_CONFIG_DIR=~/.claude-work claude --permission-mode acceptEdits "Real work" --model opus --effort high');
    await launchWithEnter();
    expect(onLaunch.mock.calls[0][0].agents[0].launch.agentLaunch).toEqual({ modelId: "opus", effort: "high", accountId: "work", purpose: "agent" });
    expect(h.cap.calls.filter((c) => c.cmd === "remember_launch_choice")).toHaveLength(1);
  });

  it("capabilities that cannot be read stop Launch with the reason and Try again; no list of Hermes's own is shown", async () => {
    h.cap.failing.set("claude", "the model probe timed out");
    const { onLaunch } = await open();
    await typeTask("Fix it");
    expect(blocks()).toEqual(["caps-error"]);
    expect(screen.getByText(/Hermes could not read what Claude Code offers \(the model probe timed out\)/)).toBeInTheDocument();
    expect(launchButton()).toBeDisabled();
    fireEvent.click(chip("model"));
    expect(document.querySelectorAll(".task-launcher-menu [data-model-id]")).toHaveLength(0);
    fireEvent.click(chip("model"));
    fireEvent.keyDown(task(), { key: "Enter" });
    await settle();
    expect(onLaunch).not.toHaveBeenCalled();
    h.cap.failing.clear();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await settle();
    expect(blocks()).toEqual([]);
    expect(launchButton()).toBeEnabled();
    fireEvent.click(chip("model"));
    expect([...document.querySelectorAll(".task-launcher-menu [data-model-id]")].map((b) => b.getAttribute("data-model-id"))).toEqual(["default", "opus", "sonnet", "haiku"]);
  });

  it("an agent whose capabilities fail does not stop another agent", async () => {
    h.cap.failing.set("codex", "codex exited 1");
    const { onLaunch } = await open();
    await typeTask("Fix it");
    expect(blocks()).toEqual([]);
    await pick("agent", '[data-agent-id="codex"]');
    expect(blocks()).toEqual(["caps-error"]);
    // The agent menu is still open.
    fireEvent.click(document.querySelector('.task-launcher-menu [data-agent-id="claude"]') as HTMLElement);
    await settle();
    expect(blocks()).toEqual([]);
    await launchWithEnter();
    expect(onLaunch).toHaveBeenCalledTimes(1);
  });
});

describe("TaskLauncher: a base branch the repository does not have", () => {
  const stored = (baseBranch: string) => ({ agentId: "claude", accountId: "default", approvalModeId: "plan", modelId: "opus", effort: null, extraArgs: "", prefix: "", channels: [], where: { kind: "new-worktree", baseBranch, branch: "" }, trackAsFeature: false });

  it("a preset cut from release/gone warns, falls back to the current branch, and launches from it", async () => {
    h.cap.presets = [{ id: "p1", name: "Release fix", choice: stored("release/gone") } as never];
    const { onLaunch } = await open();
    await typeTask("Fix the release");
    fireEvent.keyDown(task(), { key: "1", ...modKey });
    await settle();
    const warning = document.querySelector(".task-launcher-fallback") as HTMLElement;
    expect(warning).not.toBeNull();
    expect(within(warning).getByText(/Parts of the preset "Release fix" are not available now/)).toBeInTheDocument();
    expect([...warning.querySelectorAll("li")].map((l) => [l.getAttribute("data-field"), l.textContent])).toEqual([
      ["where", "Base branch release/gone is not in this repository: the new worktree starts from the current branch"],
    ]);
    expect(chip("model")).toHaveTextContent("model: opus");
    expect(preview()).toContain("in worktree hermes/fix-the-release from main");
    expect(preview()).not.toContain("release/gone");
    fireEvent.click(chip("where"));
    expect(document.querySelector(".task-launcher-menu .task-launcher-base")?.getAttribute("data-value")).toBe("");
    await launchWithEnter();
    expect(onLaunch.mock.calls[0][0].agents[0]).toMatchObject({ baseBranch: "", createBranch: true, branch: "hermes/fix-the-release" });
  });

  it("the usual combination from another repository keeps its base only where that branch exists", async () => {
    h.cap.history = [{ repo: REPO, choice: stored("develop"), at: 1 } as never];
    const first = await open();
    await typeTask("Here develop exists");
    expect(document.querySelector(".task-launcher-fallback")).toBeNull();
    expect(preview()).toContain("from develop");
    await launchWithEnter();
    expect(first.onLaunch.mock.calls[0][0].agents[0].baseBranch).toBe("develop");
    cleanup();
    const second = await open({ defaultRepo: OTHER });
    await typeTask("Not here");
    const warning = document.querySelector(".task-launcher-fallback") as HTMLElement;
    expect(warning?.getAttribute("data-source")).toBe("usual");
    expect([...warning.querySelectorAll("li")].map((l) => l.getAttribute("data-field"))).toEqual(["where"]);
    expect(preview()).toContain("from main");
    expect(launchButton()).toBeEnabled();
    await launchWithEnter();
    expect(second.onLaunch.mock.calls[0][0].agents[0].baseBranch).toBe("");
  });

  it("switching project after choosing a base branch falls back the same way", async () => {
    await open();
    await typeTask("Switch me");
    fireEvent.click(chip("where"));
    choose(".task-launcher-menu .task-launcher-base", "develop");
    await settle();
    expect(preview()).toContain("from develop");
    await pick("project", `[data-project-path="${OTHER}"]`);
    await settle();
    const warning = document.querySelector(".task-launcher-fallback") as HTMLElement;
    expect(warning?.getAttribute("data-source")).toBe("repo");
    expect(within(warning).getByText("Parts of this choice are not available in this repository:")).toBeInTheDocument();
    expect(preview()).toContain("from main");
  });
});
