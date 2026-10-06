// @vitest-environment jsdom
/**
 * F16 — the three-step welcome and the agent doctor, driven through the DOM:
 *   - the doctor lists version, sign-in, signals and resume per agent, with
 *     copy-install for a missing one and Sign in for a signed-out one, and
 *     flags a retired tool;
 *   - with no agent installed, Continue stays enabled and the doctor says a
 *     shell works anyway;
 *   - the welcome is three screens: agents, repo, first task; launching the
 *     first task finishes it; Finish without a task finishes it too;
 *   - usage stats read "off" and finishing never turns them on;
 *   - Sign in steps the welcome aside until "Back to setup";
 *   - OnboardingGate shows it only with the taskLauncher flag, else the
 *     classic wizard.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { DoctorRow } from "../api/doctor";
import type { FakeCapabilityCommands } from "./fakes/capabilityCommands";

const h = vi.hoisted(() => ({
  doctor: [] as DoctorRow[],
  doctorCalls: 0,
  settings: new Map<string, string>(),
  projects: [] as { id: string; name: string; path: string; path_exists: boolean }[],
  flags: { taskLauncher: true } as Record<string, boolean>,
  cap: null as unknown as FakeCapabilityCommands,
  missing: false,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "agent_doctor") {
      h.doctorCalls += 1;
      return h.doctor;
    }
    if (cmd === "task_repo_probe") {
      // As the backend reads a typed path: trimmed, "~" as the home folder.
      const raw = String(args.path).trim();
      const path = raw.startsWith("~/") ? `/fixture-home/${raw.slice(2)}` : raw;
      const isRepo = path.endsWith("/repo");
      return { git_root: isRepo ? path : null, branch_exists: false, local_branches: [], worktree_toml: null, exists: !h.missing, is_dir: !h.missing, has_commits: true, resolved: path };
    }
    if (cmd === "git_disk_status") return { free_bytes: 100 * 1024 ** 3, required_bytes: 10 * 1024 ** 3, below_threshold: false };
    // The launcher's capability commands (in-memory, the backend's rules).
    const answer = h.cap.handle(cmd, args ?? {});
    if (answer) return answer.value;
    throw new Error(`unexpected ${cmd}`);
  }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(async () => null) }));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn() }));
vi.mock("../api/settings", () => ({
  getSetting: vi.fn(async (k: string) => h.settings.get(k) ?? ""),
  setSetting: vi.fn(async (k: string, v: string) => {
    h.settings.set(k, v);
  }),
  getSettings: vi.fn(async () => Object.fromEntries(h.settings)),
}));
vi.mock("../api/projects", () => ({
  getProjectsOrdered: vi.fn(async () => h.projects),
  createProject: vi.fn(async (path: string) => ({ id: "new", name: "repo", path })),
}));
vi.mock("../api/sessions", () => ({ checkAiProviders: vi.fn(async () => ({})) }));
vi.mock("../featureFlags", async (orig) => {
  const real = await orig<typeof import("../featureFlags")>();
  return { ...real, isFeatureFlagEnabled: (id: string) => h.flags[id] ?? false };
});

import { SetupWizard } from "../components/SetupWizard";
import { AgentDoctor } from "../components/AgentDoctor";
import { OnboardingGate } from "../components/OnboardingGate";
import { I18nProvider } from "../i18n/I18nProvider";
import { __resetDoctorForTest } from "../launcher/doctorStore";
import { fakeCapabilityCommands } from "./fakes/capabilityCommands";

function row(id: string, name: string, over: Partial<DoctorRow> = {}): DoctorRow {
  return { id, name, installed: true, version: "1.2.3", min_version: null, version_ok: null, signed_in: "yes", signals: "exact", resume: true, retired: false, retired_note: null, beta: false, ...over };
}

beforeEach(() => {
  h.doctor = [];
  h.doctorCalls = 0;
  h.settings = new Map();
  h.projects = [];
  h.flags = { taskLauncher: true };
  h.missing = false;
  h.cap = fakeCapabilityCommands(() => h.doctor);
  __resetDoctorForTest();
});
afterEach(() => cleanup());

// The welcome steps wait for the doctor and the debounced path check each time.
vi.setConfig({ testTimeout: 20_000 });

const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 300));
  });

describe("AgentDoctor", () => {
  it("shows each agent's state and the actions that fix it", async () => {
    h.doctor = [
      row("claude", "Claude Code", { version: "2.1.300", signed_in: "no" }),
      row("codex", "Codex CLI", { version: "0.100.0", min_version: "0.145.0", version_ok: false, signals: "exact" }),
      row("gemini", "Gemini CLI", { installed: false, version: null, signed_in: "unknown", retired: true, retired_note: "Retired for personal accounts" }),
      row("aider", "Aider", { signals: "none", resume: false, signed_in: "unknown" }),
    ];
    const onSignIn = vi.fn();
    const writeText = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });
    render(
      <I18nProvider>
        <AgentDoctor onSignIn={onSignIn} />
      </I18nProvider>,
    );
    await settle();
    const cells = (id: string) => {
      const tr = document.querySelector(`tr[data-agent-id="${id}"]`)!;
      return Object.fromEntries([...tr.querySelectorAll("td[data-col]")].map((td) => [td.getAttribute("data-col"), td.textContent]));
    };
    expect(cells("claude")).toEqual({ installed: "Yes", version: "2.1.300", "signed-in": "No", signals: "Exact", resume: "Yes" });
    expect(cells("codex").version).toBe("0.100.0Needs 0.145.0 or newer");
    expect(cells("gemini")).toMatchObject({ installed: "Not installed", "signed-in": "—" });
    expect(cells("aider")).toMatchObject({ "signed-in": "Unknown", signals: "None", resume: "No" });
    expect(document.querySelector('tr[data-agent-id="gemini"] .agent-doctor-badge')?.textContent).toBe("Retired");
    // Installed agents first.
    expect([...document.querySelectorAll("tr[data-agent-id]")].map((r) => r.getAttribute("data-agent-id"))).toEqual(["claude", "codex", "aider", "gemini"]);

    fireEvent.click(screen.getByRole("button", { name: "Sign in to Claude Code" }));
    expect(onSignIn).toHaveBeenCalledWith("claude");
    fireEvent.click(screen.getByRole("button", { name: "Copy install command for Gemini CLI" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("npm install -g @google/gemini-cli"));
  });

  it("with no agent installed, says Hermes still works as a terminal", async () => {
    h.doctor = [row("claude", "Claude Code", { installed: false })];
    render(
      <I18nProvider>
        <AgentDoctor onSignIn={() => {}} />
      </I18nProvider>,
    );
    await settle();
    expect(screen.getByText(/No agent found yet/)).toBeInTheDocument();
  });

  it("Check again asks the CLIs again", async () => {
    h.doctor = [row("claude", "Claude Code")];
    render(
      <I18nProvider>
        <AgentDoctor onSignIn={() => {}} />
      </I18nProvider>,
    );
    await settle();
    expect(h.doctorCalls).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await settle();
    expect(h.doctorCalls).toBe(2);
  });
});

async function openWizard() {
  const onLaunch = vi.fn(async () => true);
  const onSignIn = vi.fn();
  const onOpenShell = vi.fn();
  const onDone = vi.fn();
  render(
    <I18nProvider>
      <SetupWizard onLaunch={onLaunch} onSignIn={onSignIn} onOpenShell={onOpenShell} onDone={onDone} />
    </I18nProvider>,
  );
  await settle();
  return { onLaunch, onSignIn, onOpenShell, onDone };
}

const stepTitle = () => document.querySelector(".setup-title")?.textContent;
/** Step 1: tick "I accept the Privacy Policy", as the classic welcome asks too. */
const acceptPolicy = () => fireEvent.click(screen.getByRole("checkbox", { name: "I accept the Privacy Policy" }));

describe("SetupWizard", () => {
  it("reaches a launched first task in three screens", async () => {
    h.doctor = [row("claude", "Claude Code")];
    h.projects = [{ id: "p1", name: "repo", path: "/fixture-home/repo", path_exists: true }];
    const { onLaunch, onDone } = await openWizard();
    expect(stepTitle()).toBe("Your agents");
    expect(screen.getByText("Step 1 of 3")).toBeInTheDocument();
    expect(screen.getByText("Usage stats: off")).toBeInTheDocument();
    acceptPolicy();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await settle();
    expect(stepTitle()).toBe("Pick a repo");
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    fireEvent.click(screen.getByRole("radio", { name: /repo/ }));
    await settle();
    expect(document.querySelector(".setup-repo-state")?.getAttribute("data-git")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await settle();
    expect(stepTitle()).toBe("First task");
    expect(screen.getByText("Step 3 of 3")).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText(/Describe the task/), { target: { value: "Add a README" } });
    await settle();
    fireEvent.keyDown(screen.getByPlaceholderText(/Describe the task/), { key: "Enter" });
    await waitFor(() => expect(onLaunch).toHaveBeenCalled());
    expect(onLaunch.mock.calls[0][0]).toMatchObject({ task: "Add a README", repoRoot: "/fixture-home/repo" });
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(h.settings.get("onboarding_completed")).toBe("true");
    expect(h.settings.get("telemetry_enabled")).toBe("false");
    expect(document.querySelector(".setup-dialog")).toBeNull();
  });

  it("with no agent installed, Continue stays enabled and Open a shell finishes", async () => {
    h.doctor = [row("claude", "Claude Code", { installed: false })];
    const { onOpenShell, onDone } = await openWizard();
    acceptPolicy();
    const cont = screen.getByRole("button", { name: "Continue" });
    expect(cont).toBeEnabled();
    fireEvent.click(cont);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    await settle();
    expect(screen.getByText(/No agent is ready yet/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open a shell" }));
    await waitFor(() => expect(onOpenShell).toHaveBeenCalled());
    expect(onDone).toHaveBeenCalled();
    expect(h.settings.get("onboarding_completed")).toBe("true");
  });

  it("any folder can be picked: a plain one says the agent works in it directly; nothing at the path cannot", async () => {
    await openWizard();
    acceptPolicy();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await settle();
    fireEvent.change(document.querySelector(".setup-repo-input")!, { target: { value: "/fixture-home/plain" } });
    await settle();
    expect(screen.getByText("Not a git repository: the agent works directly in this folder.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
    // Said where a screen reader hears it, and tied to Continue.
    expect(document.getElementById("setup-repo-state")?.getAttribute("role")).toBe("status");
    expect(screen.getByRole("button", { name: "Continue" })).toHaveAccessibleDescription(/Not a git repository/);
    // Nothing at the path: said so, and Continue waits (NEWCOMER-07).
    h.missing = true;
    fireEvent.change(document.querySelector(".setup-repo-input")!, { target: { value: "/fixture-home/projcets/demo" } });
    await settle();
    expect(screen.getByText("No folder at this path")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    h.missing = false;
    // A repository: its root is shown, and Enter in the field moves on (NEWCOMER-09).
    fireEvent.change(document.querySelector(".setup-repo-input")!, { target: { value: "~/repo" } });
    await settle();
    expect(screen.getByText("Git repository: /fixture-home/repo")).toBeInTheDocument();
    expect(screen.getByText("→ /fixture-home/repo")).toBeInTheDocument();
    fireEvent.keyDown(document.querySelector(".setup-repo-input")!, { key: "Enter" });
    await settle();
    expect(stepTitle()).toBe("First task");
  });

  it("keeps the first task across Back, and asks before Finish throws it away (NEWCOMER-03, -05)", async () => {
    h.doctor = [row("claude", "Claude Code")];
    h.projects = [{ id: "p1", name: "repo", path: "/fixture-home/repo", path_exists: true }];
    const { onLaunch, onDone } = await openWizard();
    acceptPolicy();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await settle();
    fireEvent.click(screen.getByRole("radio", { name: /repo/ }));
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await settle();
    // Nothing typed: Finish is the one primary.
    expect(screen.getByRole("button", { name: "Finish" })).toHaveClass("h-btn--primary");
    fireEvent.change(screen.getByPlaceholderText(/Describe the task/), { target: { value: "Add a contributing guide" } });
    await settle();
    // A task typed: Start task is the primary, Finish becomes Skip for now.
    expect(screen.getByRole("button", { name: "Start task ⏎" })).toHaveClass("h-btn--primary");
    expect(screen.getByRole("button", { name: "Skip for now" })).not.toHaveClass("h-btn--primary");
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await settle();
    expect((screen.getByPlaceholderText(/Describe the task/) as HTMLTextAreaElement).value).toBe("Add a contributing guide");
    // Skip for now asks first; Keep as draft keeps it for ⌘N and finishes.
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(screen.getByText("Start “Add a contributing guide” now?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Keep as draft" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(onLaunch).not.toHaveBeenCalled();
    const { takeLauncherDraft } = await import("../launcher/draft");
    expect(takeLauncherDraft()).toMatchObject({ task: "Add a contributing guide", repoPath: "/fixture-home/repo" });
  });

  it("Start task ⏎ launches the typed task (NEWCOMER-03)", async () => {
    h.doctor = [row("claude", "Claude Code")];
    h.projects = [{ id: "p1", name: "repo", path: "/fixture-home/repo", path_exists: true }];
    const { onLaunch } = await openWizard();
    acceptPolicy();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await settle();
    fireEvent.click(screen.getByRole("radio", { name: /repo/ }));
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await settle();
    fireEvent.change(screen.getByPlaceholderText(/Describe the task/), { target: { value: "Add a README" } });
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Start task ⏎" }));
    await waitFor(() => expect(onLaunch).toHaveBeenCalled());
    expect(onLaunch.mock.calls[0][0]).toMatchObject({ task: "Add a README", repoRoot: "/fixture-home/repo" });
  });

  it("the menu bar does nothing behind it but Help, and says why (NEWCOMER-02)", async () => {
    const { registerMenuBarHandler, triggerMenuBarActionFromKeyboard, cleanupListener } = await import("../hooks/nativeMenuBridge");
    const ran: string[] = [];
    registerMenuBarHandler((a) => ran.push(a));
    await openWizard();
    act(() => triggerMenuBarActionFromKeyboard("file.new-session-tab"));
    expect(ran).toEqual([]);
    expect(screen.getByText("Finish setup first")).toBeInTheDocument();
    act(() => triggerMenuBarActionFromKeyboard("help.website"));
    expect(ran).toEqual(["help.website"]);
    cleanupListener();
  });

  it("asks for the Privacy Policy first: Continue waits until it is accepted, and says why", async () => {
    const { open: openUrl } = await import("@tauri-apps/plugin-shell");
    h.doctor = [row("claude", "Claude Code")];
    const { onDone } = await openWizard();
    const cont = screen.getByRole("button", { name: "Continue" });
    const box = screen.getByRole("checkbox", { name: "I accept the Privacy Policy" });
    expect(box).not.toBeChecked();
    expect(cont).toBeDisabled();
    expect(cont).toHaveAccessibleDescription("Accept the Privacy Policy to continue");
    // The link opens the same policy as the classic welcome, and ticks nothing.
    fireEvent.click(screen.getByRole("link", { name: "Privacy Policy" }));
    expect(openUrl).toHaveBeenCalledWith("https://hermes-ide.com/legal");
    expect(box).not.toBeChecked();
    fireEvent.click(cont);
    expect(stepTitle()).toBe("Your agents");
    // Keyboard: the box toggles like any checkbox.
    box.focus();
    fireEvent.click(box);
    expect(box).toBeChecked();
    expect(cont).toBeEnabled();
    expect(screen.queryByText("Accept the Privacy Policy to continue")).toBeNull();
    fireEvent.click(cont);
    await settle();
    expect(stepTitle()).toBe("Pick a repo");
    expect(onDone).not.toHaveBeenCalled();
    expect(h.settings.get("onboarding_completed")).toBeUndefined();
  });

  it("Sign in steps aside until Back to setup, which checks again", async () => {
    h.doctor = [row("claude", "Claude Code", { signed_in: "no" })];
    const { onSignIn } = await openWizard();
    fireEvent.click(screen.getByRole("button", { name: "Sign in to Claude Code" }));
    expect(onSignIn).toHaveBeenCalledWith("claude");
    expect(document.querySelector(".setup-dialog")).toBeNull();
    expect(screen.getByText(/Sign in to Claude Code in the terminal/)).toBeInTheDocument();
    h.doctor = [row("claude", "Claude Code", { signed_in: "yes" })];
    fireEvent.click(screen.getByRole("button", { name: "Back to setup" }));
    await settle();
    expect(document.querySelector('tr[data-agent-id="claude"]')?.getAttribute("data-signed-in")).toBe("yes");
    expect(h.doctorCalls).toBe(2);
  });

  it("uses no Agent-view words on the welcome screens", async () => {
    h.doctor = [row("codex", "Codex CLI")];
    await openWizard();
    expect(document.body.textContent).not.toMatch(/Agent view/i);
  });
});

describe("OnboardingGate", () => {
  const props = { onLaunch: vi.fn(async () => true), onSignIn: vi.fn(), onOpenShell: vi.fn() };

  it("shows the three-step welcome with the flag on", async () => {
    render(
      <I18nProvider>
        <OnboardingGate {...props} />
      </I18nProvider>,
    );
    // The view is lazy-loaded; allow for a slow first import.
    await waitFor(() => expect(document.querySelector(".setup-dialog")).not.toBeNull(), { timeout: 10_000 });
    expect(document.querySelector(".onboarding-dialog")).toBeNull();
  }, 20_000);

  it("keeps the classic wizard with the flag off", async () => {
    h.flags = { taskLauncher: false };
    render(
      <I18nProvider>
        <OnboardingGate {...props} />
      </I18nProvider>,
    );
    // The view is lazy-loaded; allow for a slow first import.
    await waitFor(() => expect(document.querySelector(".onboarding-dialog")).not.toBeNull(), { timeout: 10_000 });
    expect(document.querySelector(".setup-dialog")).toBeNull();
  }, 20_000);

  it("shows nothing once onboarding is done", async () => {
    h.settings.set("onboarding_completed", "true");
    render(
      <I18nProvider>
        <OnboardingGate {...props} />
      </I18nProvider>,
    );
    await settle();
    expect(document.querySelector(".setup-dialog, .onboarding-dialog")).toBeNull();
  });
});
