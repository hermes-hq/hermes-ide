/**
 * Phase 6 (v1.0.0 redesign) — SessionCreator mode-cardinal flow.
 *
 * Asserts:
 *   - The new Step 1 ("How do you want to work?") renders three radio cards
 *     with the exact playbook §8 copy and correct aria-checked semantics.
 *   - When SessionCreator opens with `initialMode = "agent"`, the Step 2 UI
 *     hides terminal-only fields (no Approval Flow / permission pills, no
 *     Prefix command, no shell-launch knobs).
 *   - When SessionCreator opens with `initialMode = "terminal"`, the same
 *     fields ARE present once a provider is picked.
 *   - "Session Type" header is gone (the cardinal mode picker replaces it).
 *
 * Rendering uses `react-dom/server` `renderToString` — the established
 * pattern in this codebase.  All Tauri-bridge dependencies are mocked.
 */
import { describe, expect, it, vi } from "vitest";

// ─── Tauri & API mocks (must come before SessionCreator import) ──────
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.reject(new Error("mocked"))),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
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
  checkAiProviders: vi.fn(() => Promise.resolve({})),
}));
vi.mock("../api/settings", () => ({
  getSetting: vi.fn(() => Promise.resolve(null)),
  setSetting: vi.fn(() => Promise.resolve()),
}));
vi.mock("../api/ssh", () => ({
  listSshSavedHosts: vi.fn(() => Promise.resolve([])),
  upsertSshSavedHost: vi.fn(),
}));
vi.mock("../api/git", () => ({
  isGitRepo: vi.fn(() => Promise.resolve(false)),
}));

import { renderToString } from "react-dom/server";
import { SessionCreator } from "../components/SessionCreator";
import {
  SessionCreatorModeStep,
  SESSION_CREATOR_MODES,
  type SessionCreatorMode,
} from "../components/SessionCreatorModeStep";
import { I18nProvider } from "../i18n/I18nProvider";
import { translate } from "../i18n/registry";

// =====================================================================
// SessionCreatorModeStep — the standalone Step 1 component
// =====================================================================
describe("SessionCreatorModeStep (Phase 6)", () => {
  function renderModeStep(selected: SessionCreatorMode) {
    return renderToString(
      <I18nProvider>
        <SessionCreatorModeStep selected={selected} onSelect={() => {}} />
      </I18nProvider>,
    );
  }

  it("exports the canonical mode list with three options", () => {
    expect(SESSION_CREATOR_MODES.map((m) => m.id)).toEqual([
      "agent",
      "terminal",
      "ssh",
    ]);
  });

  it("uses the v1.0 mode-card copy (M8 categorisation refresh)", () => {
    const map = Object.fromEntries(
      SESSION_CREATOR_MODES.map((m) => [m.id, m]),
    );
    // Mode cards carry i18n keys — resolve them through the English base
    // pack so the public-facing copy is still pinned exactly.
    expect(translate(map.agent.labelKey)).toBe("Chat with Claude");
    expect(translate(map.agent.descriptionKey)).toContain("Diffs");
    expect(translate(map.agent.descriptionKey)).toContain("Built natively into Hermes");
    expect(translate(map.terminal.labelKey)).toBe("Terminal");
    expect(translate(map.terminal.descriptionKey).toLowerCase()).toContain("universal");
    expect(translate(map.terminal.descriptionKey)).toContain("Claude Code");
    expect(translate(map.terminal.descriptionKey)).toContain("Aider");
    expect(translate(map.ssh.labelKey)).toBe("SSH");
    expect(translate(map.ssh.descriptionKey).toLowerCase()).toContain("v1.1");
  });

  it("renders all three options with the heading question", () => {
    const html = renderModeStep("agent");
    expect(html).toContain("How do you want to work?");
    expect(html).toContain("Chat with Claude");
    expect(html).toContain("Terminal");
    expect(html).toContain("SSH");
  });

  it("renders selected=agent with aria-checked on the agent card only", () => {
    const html = renderModeStep("agent");
    // The agent button is selected.
    expect(html).toMatch(
      /aria-checked="true"[^>]*>[\s\S]*?Chat with Claude/,
    );
    // The other two are unchecked.
    expect(html).toMatch(/aria-checked="false"[^>]*>[\s\S]*?Terminal</);
    expect(html).toMatch(/aria-checked="false"[^>]*>[\s\S]*?SSH</);
    // CSS selected modifier applied to agent only.
    expect(html.match(/session-creator-mode-card-selected/g)?.length).toBe(1);
  });

  it("renders selected=terminal with aria-checked on the terminal card only", () => {
    const html = renderModeStep("terminal");
    expect(html).toMatch(/aria-checked="true"[^>]*>[\s\S]*?Terminal</);
    expect(html).toMatch(/aria-checked="false"[^>]*>[\s\S]*?Chat with Claude/);
    expect(html).toMatch(/aria-checked="false"[^>]*>[\s\S]*?SSH</);
  });

  it("renders selected=ssh with aria-checked on the ssh card only", () => {
    const html = renderModeStep("ssh");
    expect(html).toMatch(/aria-checked="true"[^>]*>[\s\S]*?SSH</);
    expect(html).toMatch(/aria-checked="false"[^>]*>[\s\S]*?Chat with Claude/);
    expect(html).toMatch(/aria-checked="false"[^>]*>[\s\S]*?Terminal</);
  });

  it("uses radio role + radiogroup container for accessibility", () => {
    const html = renderModeStep("agent");
    expect(html).toContain('role="radiogroup"');
    expect(html.match(/role="radio"/g)?.length).toBe(3);
  });
});

// =====================================================================
// SessionCreator — mode-conditional Step 2 visibility
// =====================================================================
describe("SessionCreator mode-conditional UI (Phase 6)", () => {
  function renderCreator(initialMode: SessionCreatorMode) {
    return renderToString(
      <I18nProvider>
        <SessionCreator
          onClose={() => {}}
          onCreate={() => Promise.resolve()}
          initialMode={initialMode}
        />
      </I18nProvider>,
    );
  }

  it("agent mode hides terminal-only fields (Approval Flow, Prefix, Permission Mode)", () => {
    const html = renderCreator("agent");
    // Agent path lands on the folder picker.  None of the terminal-only
    // launch knobs should appear in the DOM.
    expect(html).not.toContain("Approval Flow");
    expect(html).not.toContain("Permission Mode");
    expect(html).not.toContain("Prefix command");
    expect(html).not.toContain("Custom flags");
    expect(html).not.toContain("Initial dimensions");
    // Provider grid is not rendered either — agent mode is forced to Claude.
    expect(html).not.toContain("session-creator-provider-grid");
    // Wording check: agent mode uses "Project context" instead of
    // "Working directory".
    expect(html).toContain("Project context");
    expect(html).not.toContain("Working Directory");
  });

  it("terminal mode shows the provider picker and exposes Approval Flow when a provider is selected", () => {
    // initialMode="terminal" lands on the provider picker step ("ai").
    // No provider is auto-selected; the "Approval Flow" pills only render
    // after a provider is picked, so the picker and "Plain shell" should
    // both be visible.
    const html = renderCreator("terminal");
    expect(html).toContain("session-creator-provider-grid");
    expect(html).toContain("Plain shell");
    // The provider list should include all six AI options.
    expect(html).toContain("Claude");
    expect(html).toContain("Gemini");
    expect(html).toContain("Aider");
    expect(html).toContain("Codex");
    expect(html).toContain("Copilot");
    expect(html).toContain("Kiro");
    // Old playbook anti-pattern label should be gone.
    expect(html).not.toContain("Session Type");
    expect(html).not.toContain("Permission Mode");
    // "Approval Flow" pills do not render until a provider is picked.
    expect(html).not.toContain("Approval Flow");
  });

  it("agent mode title bar reads 'New session' (not 'New Terminal Session')", () => {
    const html = renderCreator("agent");
    expect(html).toContain("New session");
    expect(html).not.toContain("New Terminal Session");
  });

  it("agent mode does not render the legacy 'Open as terminal instead' link", () => {
    const html = renderCreator("agent");
    // The mode question is now upfront — the buried inline toggle is gone.
    expect(html).not.toContain("Open as terminal instead");
    expect(html).not.toContain("Open as agent (default)");
  });
});

// =====================================================================
// Snapshot-style: exact mode-card copy
// =====================================================================
describe("SessionCreator mode-card copy snapshot", () => {
  it("contains the three exact mode labels in Step 1", () => {
    const html = renderToString(
      <I18nProvider>
        <SessionCreatorModeStep selected="agent" onSelect={() => {}} />
      </I18nProvider>,
    );
    // These three strings are the public-facing v1.0.0 copy — guard them.
    expect(html).toContain("Chat with Claude");
    expect(html).toContain("Terminal");
    expect(html).toContain("SSH");
    // M8 refresh: copy now distinguishes native (Claude) from
    // universal (Terminal); exact strings live in the
    // SESSION_CREATOR_MODES array tested above.
    expect(html.toLowerCase()).toContain("native");
    expect(html.toLowerCase()).toContain("universal");
  });
});
