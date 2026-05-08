/**
 * Phase 2 (v1.0.0 redesign) — colophon formatter.
 *
 * The colophon is a quiet end-of-turn summary: `duration · output · cost`.
 * These tests cover the pure formatter and its three segment helpers. The
 * component-level tests live in `result-footer.test.tsx`.
 */
import { describe, expect, it } from "vitest";
import {
  formatColophon,
  formatCost,
  formatDuration,
  formatTokens,
} from "../utils/formatColophon";

describe("formatDuration", () => {
  it("returns empty string for undefined", () => {
    expect(formatDuration(undefined)).toBe("");
  });

  it("returns empty string for zero (segment is omitted)", () => {
    expect(formatDuration(0)).toBe("");
  });

  it("formats sub-second durations with one decimal place", () => {
    expect(formatDuration(400)).toBe("0.4s");
  });

  it("formats single-digit seconds with one decimal place", () => {
    expect(formatDuration(8500)).toBe("8.5s");
  });

  it("formats 9.9s with one decimal (still under 10s threshold)", () => {
    expect(formatDuration(9900)).toBe("9.9s");
  });

  it("formats 10s+ as integer seconds", () => {
    expect(formatDuration(23_000)).toBe("23s");
  });

  it("formats 59s as integer seconds", () => {
    expect(formatDuration(59_000)).toBe("59s");
  });

  it("formats 90s as `1m 30s`", () => {
    expect(formatDuration(90_000)).toBe("1m 30s");
  });

  it("formats exactly 60s as `1m 0s`", () => {
    expect(formatDuration(60_000)).toBe("1m 0s");
  });

  it("formats 1h as `1h 0m 0s`", () => {
    expect(formatDuration(3_600_000)).toBe("1h 0m 0s");
  });

  it("formats 1h 23m 45s correctly", () => {
    expect(formatDuration(3_600_000 + 23 * 60_000 + 45_000)).toBe("1h 23m 45s");
  });
});

describe("formatTokens", () => {
  it("returns empty string for undefined", () => {
    expect(formatTokens(undefined)).toBe("");
  });

  it("returns bare integer under 1_000", () => {
    expect(formatTokens(303)).toBe("303");
  });

  it("formats >= 1_000 as one-decimal k", () => {
    expect(formatTokens(1234)).toBe("1.2k");
  });

  it("formats >= 1_000_000 as one-decimal M", () => {
    expect(formatTokens(1_250_000)).toBe("1.3M");
  });

  it("renders zero as `0` (caller decides whether to omit)", () => {
    expect(formatTokens(0)).toBe("0");
  });
});

describe("formatCost", () => {
  it("returns empty string for undefined", () => {
    expect(formatCost(undefined)).toBe("");
  });

  it("renders zero as `$0.00` (not skipped)", () => {
    expect(formatCost(0)).toBe("$0.00");
  });

  it("rounds 4-decimal cost to 2 decimals", () => {
    expect(formatCost(0.1266)).toBe("$0.13");
  });

  it("rounds 12.345 to `$12.35`", () => {
    expect(formatCost(12.345)).toBe("$12.35");
  });

  it("preserves trailing zero precision", () => {
    expect(formatCost(0.1)).toBe("$0.10");
  });
});

describe("formatColophon", () => {
  it("returns empty string when all fields are missing", () => {
    expect(formatColophon({})).toBe("");
  });

  it("happy path: duration + tokens + cost", () => {
    expect(
      formatColophon({
        duration_ms: 8500,
        usage: { output_tokens: 303 },
        total_cost_usd: 0.1266,
      }),
    ).toBe("8.5s · 303 out · $0.13");
  });

  it("omits tokens segment when output_tokens is missing", () => {
    expect(
      formatColophon({
        duration_ms: 8500,
        usage: {},
        total_cost_usd: 0.1266,
      }),
    ).toBe("8.5s · $0.13");
  });

  it("omits tokens segment when usage object is missing entirely", () => {
    expect(
      formatColophon({
        duration_ms: 8500,
        total_cost_usd: 0.1266,
      }),
    ).toBe("8.5s · $0.13");
  });

  it("includes a $0.00 cost segment (zero is meaningful)", () => {
    expect(
      formatColophon({
        duration_ms: 1200,
        usage: { output_tokens: 50 },
        total_cost_usd: 0,
      }),
    ).toBe("1.2s · 50 out · $0.00");
  });

  it("omits duration segment when duration_ms is undefined", () => {
    expect(
      formatColophon({
        usage: { output_tokens: 303 },
        total_cost_usd: 0.13,
      }),
    ).toBe("303 out · $0.13");
  });

  it("formats large token counts with k suffix", () => {
    expect(
      formatColophon({
        duration_ms: 23_000,
        usage: { output_tokens: 1234 },
        total_cost_usd: 0.42,
      }),
    ).toBe("23s · 1.2k out · $0.42");
  });
});
