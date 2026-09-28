// @vitest-environment jsdom
/**
 * Terminal first (ADR 003) — the session creator flow.
 *
 * Drives the real SessionCreator through clicks and asserts what it hands to
 * `onCreate` and what it stores:
 *   - The creator opens on the agent step; there is no separate mode step.
 *   - A Claude session is a terminal session unless "Agent view for Claude"
 *     is ticked.
 *   - The Agent view option only exists for agents that have one.
 *   - The choice is remembered per agent (session_mode_by_provider) and
 *     preselected next time.
 *   - "Connect over SSH" switches to the SSH form and Back returns.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// ─── Tauri & API mocks (must come before SessionCreator import) ──────
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.reject(new Error("mocked"))),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emit: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(() => Promise.resolve(null)),
  save: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-shell", () => ({
  open: vi.fn(),
}));
vi.mock("../api/projects", () => ({
  getProjectsOrdered: vi.fn(() => Promise.resolve([])),
  createProject: vi.fn(),
  deleteProject: vi.fn(),
}));
vi.mock("../api/sessions", () => ({
  getSessions: vi.fn(() => Promise.resolve([])),
  sshListTmuxSessions: vi.fn(() => Promise.resolve([])),
  checkAiProviders: vi.fn(() =>
    Promise.resolve({ claude: true, codex: true, gemini: true, aider: true, copilot: true, kiro: true }),
  ),
}));

// In-memory settings store, so the creator reads back what it wrote.
const settingsStore = new Map<string, string>();
vi.mock("../api/settings", () => ({
  getSetting: vi.fn((key: string) => Promise.resolve(settingsStore.get(key) ?? null)),
  setSetting: vi.fn((key: string, value: string) => {
    settingsStore.set(key, value);
    return Promise.resolve();
  }),
}));
vi.mock("../api/ssh", () => ({
  listSshSavedHosts: vi.fn(() => Promise.resolve([])),
  upsertSshSavedHost: vi.fn(),
}));
vi.mock("../api/git", () => ({
  isGitRepo: vi.fn(() => Promise.resolve(false)),
}));

import { SessionCreator } from "../components/SessionCreator";
import type { CreateSessionOpts } from "../types/session";
import { I18nProvider } from "../i18n/I18nProvider";
import { _resetUserLabelsForTest, shareableLabel } from "../attention/userLabels";

type OnCreate = (opts: CreateSessionOpts) => Promise<void>;

async function openCreator(onCreate: OnCreate = vi.fn(async () => {})) {
  const utils = render(
    <I18nProvider>
      <SessionCreator onClose={() => {}} onCreate={onCreate} />
    </I18nProvider>,
  );
  // Let the mount-time settings / availability loads settle.
  await act(async () => {
    await Promise.resolve();
  });
  return utils;
}

function providerCard(label: string): HTMLElement {
  const card = screen
    .getAllByRole("button")
    .find((b) => b.classList.contains("session-creator-provider-card") && b.textContent?.startsWith(label));
  if (!card) throw new Error(`no provider card for ${label}`);
  return card;
}

function agentViewCheckbox(): HTMLInputElement | null {
  return screen.queryByRole("checkbox", { name: /Agent view for Claude/ }) as HTMLInputElement | null;
}

/** Walk the remaining steps (folder, confirm) and press Create. */
async function finishWizard() {
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  // Folder step: nothing selected = default folder.
  await screen.findByText(/Select folders|Project context|Working directory/);
  const next = screen
    .getAllByRole("button")
    .find((b) => b.classList.contains("session-creator-btn-primary"));
  fireEvent.click(next!);
  const create = await screen.findByRole("button", { name: /Create session/ });
  await act(async () => {
    fireEvent.click(create);
  });
}

beforeEach(() => {
  settingsStore.clear();
});
afterEach(() => cleanup());

describe("SessionCreator — terminal first", () => {
  it("opens on the agent step: no mode step, agents and a plain shell to pick from", async () => {
    await openCreator();
    expect(screen.getByText("What do you want to run?")).toBeInTheDocument();
    expect(screen.queryByText("How do you want to work?")).not.toBeInTheDocument();
    expect(screen.queryByText("Chat with Claude")).not.toBeInTheDocument();
    for (const label of ["Claude", "Gemini", "Aider", "Codex", "GitHub Copilot", "Kiro", "Plain shell"]) {
      expect(providerCard(label)).toBeInTheDocument();
    }
    // Nothing chosen yet → no Agent view option.
    expect(agentViewCheckbox()).toBeNull();
  });

  it("a new Claude session is a terminal session by default", async () => {
    const onCreate = vi.fn<OnCreate>(async () => {});
    await openCreator(onCreate);
    fireEvent.click(providerCard("Claude"));
    const box = agentViewCheckbox();
    expect(box).not.toBeNull();
    expect(box!.checked).toBe(false);
    // Terminal launch knobs are visible for a terminal session.
    expect(screen.getByText("Approval Flow")).toBeInTheDocument();

    await finishWizard();
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate.mock.calls[0][0]).toMatchObject({ aiProvider: "claude", mode: "terminal" });
    expect(JSON.parse(settingsStore.get("session_mode_by_provider")!)).toEqual({ claude: "terminal" });
  });

  it("ticking 'Agent view for Claude' creates an Agent-view session and hides terminal knobs", async () => {
    const onCreate = vi.fn<OnCreate>(async () => {});
    await openCreator(onCreate);
    fireEvent.click(providerCard("Claude"));
    fireEvent.click(agentViewCheckbox()!);
    expect(agentViewCheckbox()!.checked).toBe(true);
    expect(screen.queryByText("Approval Flow")).not.toBeInTheDocument();
    expect(screen.queryByText("Prefix command")).not.toBeInTheDocument();

    await finishWizard();
    expect(onCreate.mock.calls[0][0]).toMatchObject({ aiProvider: "claude", mode: "agent" });
    expect(JSON.parse(settingsStore.get("session_mode_by_provider")!)).toEqual({ claude: "agent" });
  });

  it("agents without an Agent view never show the option and always run in terminal mode", async () => {
    const onCreate = vi.fn<OnCreate>(async () => {});
    await openCreator(onCreate);
    fireEvent.click(providerCard("Codex"));
    expect(agentViewCheckbox()).toBeNull();
    fireEvent.click(providerCard("Plain shell"));
    expect(agentViewCheckbox()).toBeNull();
    fireEvent.click(providerCard("Codex"));

    await finishWizard();
    expect(onCreate.mock.calls[0][0]).toMatchObject({ aiProvider: "codex", mode: "terminal" });
  });

  it("switching from Claude with Agent view to another agent goes back to terminal", async () => {
    const onCreate = vi.fn<OnCreate>(async () => {});
    await openCreator(onCreate);
    fireEvent.click(providerCard("Claude"));
    fireEvent.click(agentViewCheckbox()!);
    fireEvent.click(providerCard("Gemini"));
    expect(agentViewCheckbox()).toBeNull();

    await finishWizard();
    expect(onCreate.mock.calls[0][0]).toMatchObject({ aiProvider: "gemini", mode: "terminal" });
  });

  it("a name typed here is remembered as the user's (it may go into an away message); no name, nothing remembered", async () => {
    _resetUserLabelsForTest();
    const onCreate = vi.fn<OnCreate>(async () => {});
    await openCreator(onCreate);
    fireEvent.click(providerCard("Claude"));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText(/Select folders|Project context|Working directory/);
    fireEvent.click(screen.getAllByRole("button").find((b) => b.classList.contains("session-creator-btn-primary"))!);
    const create = await screen.findByRole("button", { name: /Create session/ });
    const name = document.querySelector<HTMLInputElement>("input.command-palette-input")!;
    fireEvent.change(name, { target: { value: "billing-fix" } });
    await act(async () => {
      fireEvent.click(create);
    });
    const opts = onCreate.mock.calls[0][0];
    expect(opts.label).toBe("billing-fix");
    expect(opts.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(shareableLabel(opts.sessionId, "billing-fix")).toBe("billing-fix");
    cleanup();

    const unnamed = vi.fn<OnCreate>(async () => {});
    await openCreator(unnamed);
    fireEvent.click(providerCard("Claude"));
    await finishWizard();
    expect(unnamed.mock.calls[0][0].sessionId).toBeUndefined();
  });

  it("remembers the Agent view choice for Claude and preselects it next time", async () => {
    settingsStore.set("session_mode_by_provider", JSON.stringify({ claude: "agent" }));
    const onCreate = vi.fn<OnCreate>(async () => {});
    await openCreator(onCreate);
    fireEvent.click(providerCard("Claude"));
    expect(agentViewCheckbox()!.checked).toBe(true);
    // Codex is unaffected by Claude's choice.
    fireEvent.click(providerCard("Codex"));
    expect(agentViewCheckbox()).toBeNull();
    fireEvent.click(providerCard("Claude"));
    expect(agentViewCheckbox()!.checked).toBe(true);

    await finishWizard();
    expect(onCreate.mock.calls[0][0]).toMatchObject({ aiProvider: "claude", mode: "agent" });
  });

  it("preselects the last agent together with its remembered choice", async () => {
    settingsStore.set("last_ai_provider", "claude");
    settingsStore.set("session_mode_by_provider", JSON.stringify({ claude: "agent" }));
    await openCreator();
    await waitFor(() => expect(providerCard("Claude")).toHaveClass("selected"));
    expect(agentViewCheckbox()!.checked).toBe(true);
  });

  it("re-picking the selected agent keeps an unsaved Agent view tick", async () => {
    await openCreator();
    fireEvent.click(providerCard("Claude"));
    fireEvent.click(agentViewCheckbox()!);
    fireEvent.click(providerCard("Claude"));
    expect(agentViewCheckbox()!.checked).toBe(true);
  });

  it("'Connect over SSH' opens the SSH form and Back returns to the agent step", async () => {
    const onCreate = vi.fn<OnCreate>(async () => {});
    await openCreator(onCreate);
    fireEvent.click(screen.getByRole("button", { name: "Connect over SSH" }));
    expect(screen.getByText("SSH")).toBeInTheDocument();
    expect(screen.queryByText("What do you want to run?")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByText("What do you want to run?")).toBeInTheDocument();
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("Back from the SSH form keeps the agent and Agent view choice picked before", async () => {
    const onCreate = vi.fn<OnCreate>(async () => {});
    await openCreator(onCreate);
    fireEvent.click(providerCard("Claude"));
    fireEvent.click(agentViewCheckbox()!);
    fireEvent.click(screen.getByRole("button", { name: "Connect over SSH" }));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(providerCard("Claude")).toHaveClass("selected");
    expect(agentViewCheckbox()!.checked).toBe(true);
    await finishWizard();
    expect(onCreate.mock.calls[0][0]).toMatchObject({ aiProvider: "claude", mode: "agent" });
  });

  it("only the preselected agent is highlighted when the creator opens", async () => {
    settingsStore.set("last_ai_provider", "claude");
    await openCreator();
    await waitFor(() => expect(providerCard("Claude")).toHaveClass("selected"));
    const highlighted = screen
      .getAllByRole("button")
      .filter((b) => b.classList.contains("session-creator-provider-card") && b.classList.contains("selected"));
    expect(highlighted).toEqual([providerCard("Claude")]);
  });
});
