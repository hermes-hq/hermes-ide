// @vitest-environment jsdom
/**
 * F04 (private by default) — the onboarding wizard's analytics checkbox
 * must start unchecked, and finishing without touching it must persist
 * `telemetry_enabled=false`. Previously the checkbox defaulted to checked
 * (`useState(true)`), so a fresh profile that clicked through onboarding
 * ended up opted in to analytics.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const mockGetSetting = vi.fn();
const mockGetSettings = vi.fn();
const mockSetSetting = vi.fn(() => Promise.resolve());
const mockCheckAiProviders = vi.fn(() => Promise.resolve({}));
const mockInvoke = vi.fn(() => Promise.resolve(true));

vi.mock("../api/settings", () => ({
  getSetting: (...args: unknown[]) => mockGetSetting(...args),
  getSettings: (...args: unknown[]) => mockGetSettings(...args),
  setSetting: (...args: unknown[]) => mockSetSetting(...args),
}));
vi.mock("../api/sessions", () => ({
  checkAiProviders: (...args: unknown[]) => mockCheckAiProviders(...args),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...(args as [])),
}));
vi.mock("@tauri-apps/plugin-shell", () => ({
  open: vi.fn(),
}));

beforeEach(() => {
  mockGetSetting.mockReset();
  mockGetSetting.mockResolvedValue(""); // onboarding never completed
  mockGetSettings.mockReset();
  mockGetSettings.mockResolvedValue({});
  mockSetSetting.mockClear();
  mockCheckAiProviders.mockClear();
  mockInvoke.mockClear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** Clicks through welcome → theme → ai_setup to reach the privacy step. */
async function goToPrivacyStep() {
  fireEvent.click(await screen.findByText("Get Started"));
  fireEvent.click(await screen.findByText("Next")); // theme -> ai_setup
  fireEvent.click(await screen.findByText("Next")); // ai_setup -> privacy
  await screen.findByText(/Help improve Hermes IDE/);
}

describe("OnboardingWizard privacy step", () => {
  it("analytics checkbox starts unchecked", async () => {
    const { OnboardingWizard } = await import("../components/OnboardingWizard");
    render(<OnboardingWizard />);

    await goToPrivacyStep();

    const analyticsCheckbox = screen.getByRole("checkbox", {
      name: /Help improve Hermes IDE/,
    });
    expect(analyticsCheckbox).not.toBeChecked();
  });

  it("finishing without touching the checkbox persists telemetry_enabled=false", async () => {
    const { OnboardingWizard } = await import("../components/OnboardingWizard");
    render(<OnboardingWizard />);

    await goToPrivacyStep();

    // Accept the policy (required to enable Finish) — analytics checkbox
    // is deliberately left untouched.
    fireEvent.click(screen.getByRole("checkbox", { name: /I accept the/ }));
    fireEvent.click(screen.getByText("Finish"));

    await waitFor(() => {
      expect(mockSetSetting).toHaveBeenCalledWith("telemetry_enabled", "false");
    });
    // Analytics is never started for a user who did not opt in.
    expect(mockInvoke).not.toHaveBeenCalledWith("enable_analytics");
  });

  it("ticking the checkbox persists the opt-in and starts analytics right away", async () => {
    const { OnboardingWizard } = await import("../components/OnboardingWizard");
    render(<OnboardingWizard />);

    await goToPrivacyStep();

    fireEvent.click(screen.getByRole("checkbox", { name: /Help improve Hermes IDE/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /I accept the/ }));
    fireEvent.click(screen.getByText("Finish"));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("enable_analytics");
    });
    expect(mockSetSetting).toHaveBeenCalledWith("telemetry_enabled", "true");
  });
});
