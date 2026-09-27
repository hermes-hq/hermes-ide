// @vitest-environment jsdom
/**
 * F06 follow-up: the Copilot provider now launches the `copilot` CLI, so the
 * quick-action pills must offer its slash commands, not the retired
 * `gh copilot suggest` / `gh copilot explain` extension commands.
 *
 * Renders the real ProviderActionsBar and clicks a pill; only the terminal
 * write path is mocked so the sent command can be observed.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const sent: { sessionId: string; command: string }[] = [];
vi.mock("../terminal/TerminalPool", () => ({
  sendShortcutCommand: (sessionId: string, command: string) => sent.push({ sessionId, command }),
}));
vi.mock("../state/SessionContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/SessionContext")>()),
  useSession: () => ({ dispatch: vi.fn() }),
}));

import { ProviderActionsBar } from "../components/ProviderActionsBar";

function renderBar(aiProvider: string) {
  return render(
    <ProviderActionsBar sessionId="s1" agentName="" actions={[]} recentActions={[]} phase="idle" aiProvider={aiProvider} />,
  );
}

describe("Copilot quick actions", () => {
  afterEach(() => {
    cleanup();
    sent.length = 0;
  });

  it("offers Copilot CLI slash commands and none of the retired gh copilot commands", () => {
    const { container } = renderBar("copilot");
    const pills = Array.from(container.querySelectorAll(".pab-action")).map((b) => b.textContent);
    expect(pills).toEqual(["/compact", "/clear", "/diff", "/review", "/usage"]);
    expect(container.textContent).not.toContain("gh copilot");
  });

  it("sends the clicked slash command to the session's terminal", () => {
    renderBar("copilot");
    fireEvent.click(screen.getByRole("button", { name: "/review" }));
    expect(sent).toEqual([{ sessionId: "s1", command: "/review" }]);
  });
});
