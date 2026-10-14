// @vitest-environment jsdom
/**
 * F06 follow-up, kept for the session action bar: the Copilot provider
 * launches the `copilot` CLI, so its actions and Commands list offer that
 * CLI's slash commands (from the agent catalog), never the retired
 * `gh copilot suggest` / `gh copilot explain` extension commands.
 *
 * Renders the real SessionActionsBar; only the backend is a stand-in, so
 * the command sent to the session can be observed.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const h = vi.hoisted(() => ({ sent: [] as { sessionId: unknown; line: unknown }[] }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown> = {}) => {
    if (cmd === "run_session_command") {
      h.sent.push({ sessionId: args.sessionId, line: args.line });
      return "sent";
    }
    if (cmd === "discover_agent_commands") return [];
    return undefined;
  }),
}));
vi.mock("../terminal/TerminalPool", () => ({ focusTerminal: vi.fn(), setSubmittedCommandListener: vi.fn(), getTerminal: () => null }));
vi.mock("../state/SessionContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/SessionContext")>()),
  useSession: () => ({
    state: { sessions: { s1: { id: "s1", label: "copilot", mode: "terminal", ai_provider: "copilot", detected_agent: null, working_directory: "/fixture-home/p" } } },
    dispatch: vi.fn(),
    createSession: vi.fn(),
  }),
}));

import { SessionActionsBar } from "../components/SessionActionsBar";
import { I18nProvider } from "../i18n/I18nProvider";

function renderBar() {
  return render(
    <I18nProvider>
      <SessionActionsBar sessionId="s1" paneId="p1" focused />
    </I18nProvider>,
  );
}

describe("Copilot quick actions", () => {
  afterEach(() => {
    cleanup();
    h.sent.length = 0;
  });

  it("offers Copilot CLI slash commands and none of the retired gh copilot commands", async () => {
    const { container } = renderBar();
    const chips = Array.from(container.querySelectorAll("[data-session-action]")).map((b) => b.getAttribute("aria-label"));
    expect(chips).toEqual(["Model", "Plan", "Review"]);
    fireEvent.click(container.querySelector("[data-session-commands]")!);
    const listbox = await screen.findByRole("listbox");
    const commands = within(listbox)
      .getAllByRole("option")
      .map((o) => o.getAttribute("data-command"));
    for (const c of ["/compact", "/context", "/usage", "/diff", "/review", "/clear"]) expect(commands).toContain(c);
    expect(commands.every((c) => c?.startsWith("/"))).toBe(true);
    expect(listbox.textContent).not.toContain("gh copilot");
  });

  it("sends the clicked action's slash command to the session", async () => {
    const { container } = renderBar();
    await act(async () => fireEvent.click(container.querySelector('[data-session-action="review"]')!));
    expect(h.sent).toEqual([{ sessionId: "s1", line: "/review" }]);
  });
});
