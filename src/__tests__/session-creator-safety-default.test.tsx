// @vitest-environment jsdom
/**
 * F35 — new sessions start in each agent's mapping of Hermes's one safety
 * default (flag on), and stay as they were with the flag off.
 *
 * Drives the real SessionCreator and asserts the permission mode it hands to
 * `onCreate` (which becomes the launch flags).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.reject(new Error("mocked"))),
}));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn(() => Promise.resolve("1.4.1")) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emit: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(() => Promise.resolve(null)), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn() }));
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
vi.mock("../api/git", () => ({ isGitRepo: vi.fn(() => Promise.resolve(false)) }));

import { SessionCreator } from "../components/SessionCreator";
import type { CreateSessionOpts } from "../types/session";
import { I18nProvider } from "../i18n/I18nProvider";
import { initFeatureFlags, __resetFeatureFlagsForTest, FEATURE_FLAG_OVERRIDES_KEY } from "../featureFlags";

type OnCreate = (opts: CreateSessionOpts) => Promise<void>;

async function openCreator(onCreate: OnCreate) {
  render(
    <I18nProvider>
      <SessionCreator onClose={() => {}} onCreate={onCreate} />
    </I18nProvider>,
  );
  await act(async () => {
    await Promise.resolve();
  });
}

function providerCard(label: string): HTMLElement {
  const card = screen
    .getAllByRole("button")
    .find((b) => b.classList.contains("session-creator-provider-card") && b.textContent?.startsWith(label));
  if (!card) throw new Error(`no provider card for ${label}`);
  return card;
}

const activePill = () => document.querySelector(".session-creator-permission-pill-active");
const defaultMarkers = () => Array.from(document.querySelectorAll(".session-creator-permission-pill-default"));

async function finishWizard() {
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await screen.findByText(/Select folders|Project context|Working directory/);
  const next = screen.getAllByRole("button").find((b) => b.classList.contains("session-creator-btn-primary"));
  fireEvent.click(next!);
  const create = await screen.findByRole("button", { name: /Create session/ });
  await act(async () => {
    fireEvent.click(create);
  });
}

beforeEach(() => {
  settingsStore.clear();
  localStorage.clear();
  __resetFeatureFlagsForTest();
});
afterEach(() => {
  cleanup();
  __resetFeatureFlagsForTest();
});

describe("SessionCreator — one safety default (flag on)", () => {
  beforeEach(async () => {
    await initFeatureFlags({ [FEATURE_FLAG_OVERRIDES_KEY]: JSON.stringify({ agentCatalog: true }) });
  });

  it("a new Claude session starts in accept-edits, marked as the Hermes default", async () => {
    const onCreate = vi.fn<OnCreate>(async () => {});
    await openCreator(onCreate);
    fireEvent.click(providerCard("Claude"));
    expect(activePill()).toHaveTextContent("Hermes default");
    expect(defaultMarkers()).toHaveLength(1);
    expect(screen.getByText("--permission-mode acceptEdits")).toBeInTheDocument();
    await finishWizard();
    expect(onCreate.mock.calls[0][0]).toMatchObject({ aiProvider: "claude", permissionMode: "acceptEdits" });
  });

  it("a new Codex session starts in its sandboxed mode", async () => {
    const onCreate = vi.fn<OnCreate>(async () => {});
    await openCreator(onCreate);
    fireEvent.click(providerCard("Claude"));
    fireEvent.click(providerCard("Codex"));
    expect(activePill()).toHaveTextContent("Hermes default");
    expect(screen.getByText("--sandbox workspace-write --ask-for-approval on-request")).toBeInTheDocument();
    await finishWizard();
    expect(onCreate.mock.calls[0][0]).toMatchObject({ aiProvider: "codex", permissionMode: "auto" });
  });

  it("a pill the user picks is kept", async () => {
    const onCreate = vi.fn<OnCreate>(async () => {});
    await openCreator(onCreate);
    fireEvent.click(providerCard("Claude"));
    const pills = Array.from(document.querySelectorAll<HTMLButtonElement>(".session-creator-permission-pill"));
    fireEvent.click(pills[0]); // "default": ask for everything
    expect(activePill()).not.toHaveTextContent("Hermes default");
    await finishWizard();
    expect(onCreate.mock.calls[0][0]).toMatchObject({ aiProvider: "claude", permissionMode: "default" });
  });

  it("a default mode saved in Settings wins over the Hermes default", async () => {
    settingsStore.set("default_permission_mode", "plan");
    const onCreate = vi.fn<OnCreate>(async () => {});
    await openCreator(onCreate);
    fireEvent.click(providerCard("Claude"));
    await finishWizard();
    expect(onCreate.mock.calls[0][0]).toMatchObject({ aiProvider: "claude", permissionMode: "plan" });
  });
});

describe("SessionCreator — flag off", () => {
  it("a new Claude session keeps the plain default and shows no marker", async () => {
    await initFeatureFlags({});
    const onCreate = vi.fn<OnCreate>(async () => {});
    await openCreator(onCreate);
    fireEvent.click(providerCard("Claude"));
    expect(defaultMarkers()).toHaveLength(0);
    await finishWizard();
    expect(onCreate.mock.calls[0][0]).toMatchObject({ aiProvider: "claude", permissionMode: "default" });
  });
});
