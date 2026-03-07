import { vi } from "vitest";

vi.mock("@aptabase/web", () => ({
  trackEvent: vi.fn(),
  init: vi.fn(),
}));
