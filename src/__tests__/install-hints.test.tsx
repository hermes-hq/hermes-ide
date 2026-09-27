// @vitest-environment jsdom
/**
 * The first-launch "AI tools" screen shows install commands for tools that
 * are not installed. Each hint must install the command Hermes checks for
 * and launches: `gemini` from `@google/gemini-cli`, and `copilot` from the
 * npm Copilot CLI (the `gh-copilot` extension is retired). Gemini CLI no
 * longer serves personal Google accounts, so its card sends those users to
 * Antigravity CLI.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, cleanup, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn() }));
vi.mock("../api/settings", () => ({
  getSetting: vi.fn(() => Promise.resolve(null)),
  setSetting: vi.fn(() => Promise.resolve()),
  getSettings: vi.fn(() => Promise.resolve({})),
}));
vi.mock("../api/sessions", () => ({
  // A machine with none of the AI tools installed.
  checkAiProviders: vi.fn(() =>
    Promise.resolve({ claude: false, gemini: false, aider: false, codex: false, copilot: false, kiro: false }),
  ),
}));
vi.mock("../utils/analytics", () => ({ setAnalyticsEnabled: vi.fn() }));

import { OnboardingWizard } from "../components/OnboardingWizard";
import { getAgent } from "../catalog/agentCatalog";

afterEach(cleanup);

async function openAiToolsScreen() {
  render(<OnboardingWizard />);
  fireEvent.click(await screen.findByRole("button", { name: "Get Started" }));
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await waitFor(() => expect(document.querySelectorAll(".onboarding-ai-install-cmd").length).toBeGreaterThan(0));
}

function cardFor(label: string): Element | undefined {
  return [...document.querySelectorAll(".onboarding-ai-card")].find(
    (c) => c.querySelector(".onboarding-ai-card-name")?.textContent === label,
  );
}

function installCommandFor(label: string): string | null {
  return cardFor(label)?.querySelector(".onboarding-ai-install-cmd")?.textContent ?? null;
}

describe("AI tool install hints", () => {
  it("points Gemini users to the Gemini CLI that Hermes launches", async () => {
    await openAiToolsScreen();
    expect(installCommandFor("Gemini CLI (legacy)")).toBe("npm install -g @google/gemini-cli");
  });

  it("sends personal Google accounts to Antigravity CLI", () => {
    // Gemini CLI no longer serves personal Google accounts; the note the New
    // Session wizard shows for it names Antigravity CLI.
    expect(getAgent("gemini")?.status_note).toMatch(/personal Google accounts/);
    expect(getAgent("gemini")?.status_note).toMatch(/Antigravity CLI/);
  });

  it("points Copilot users to the npm Copilot CLI", async () => {
    await openAiToolsScreen();
    expect(installCommandFor("GitHub Copilot CLI")).toBe("npm install -g @github/copilot");
  });

  it("never suggests a retired install command", async () => {
    await openAiToolsScreen();
    const all = [...document.querySelectorAll(".onboarding-ai-install-cmd")].map((e) => e.textContent ?? "");
    expect(all.some((c) => /gh extension install|gh-copilot/.test(c))).toBe(false);
  });
});
