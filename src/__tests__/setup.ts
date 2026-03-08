import { vi } from "vitest";

vi.mock("@aptabase/tauri", () => ({
  trackEvent: vi.fn(),
}));
