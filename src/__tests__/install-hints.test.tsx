// @vitest-environment jsdom
/**
 * The first-launch "AI tools" screen shows install commands for tools that
 * are not installed. Gemini and Copilot must point at what their vendors
 * ship today (Antigravity CLI; the npm Copilot CLI), not the retired
 * `@google/gemini-cli` package or the `gh-copilot` extension.
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

afterEach(cleanup);

async function openAiToolsScreen() {
  render(<OnboardingWizard />);
  fireEvent.click(await screen.findByRole("button", { name: "Get Started" }));
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await waitFor(() => expect(document.querySelectorAll(".onboarding-ai-install-cmd").length).toBeGreaterThan(0));
}

function installCommandFor(label: string): string | null {
  const card = [...document.querySelectorAll(".onboarding-ai-card")].find(
    (c) => c.querySelector(".onboarding-ai-card-name")?.textContent === label,
  );
  return card?.querySelector(".onboarding-ai-install-cmd")?.textContent ?? null;
}

describe("AI tool install hints", () => {
  it("points Gemini users to Antigravity CLI", async () => {
    await openAiToolsScreen();
    expect(installCommandFor("Gemini")).toBe("curl -fsSL https://antigravity.google/cli/install.sh | bash");
    expect(screen.getByText(/succeeded by Antigravity CLI/)).toBeInTheDocument();
  });

  it("points Copilot users to the npm Copilot CLI", async () => {
    await openAiToolsScreen();
    expect(installCommandFor("Copilot")).toBe("npm install -g @github/copilot");
  });

  it("never suggests a retired install command", async () => {
    await openAiToolsScreen();
    const all = [...document.querySelectorAll(".onboarding-ai-install-cmd")].map((e) => e.textContent ?? "");
    expect(all.some((c) => /gh extension install|@google\/gemini-cli/.test(c))).toBe(false);
  });
});
