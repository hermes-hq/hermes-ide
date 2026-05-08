/**
 * M7 — Agent prewarm.  Frontend merge contract for the static + live
 * init data.  Spec: docs/internal/v1-tui-parity-plan.md §8.12.
 */
import { describe, it, expect } from "vitest";
import {
  mergeMcpServers,
  mergeSlashCommands,
  mergeMemoryPaths,
} from "../utils/prewarm";

describe("mergeMcpServers (pw-7, pw-9)", () => {
  it("returns static list verbatim when init absent", () => {
    const got = mergeMcpServers(
      [{ name: "context7", status: "unknown" }],
      undefined,
    );
    expect(got).toEqual([{ name: "context7", status: "unknown" }]);
  });

  it("pw-9: live init.mcp_servers replaces static (live status > unknown)", () => {
    const got = mergeMcpServers(
      [{ name: "context7", status: "unknown" }, { name: "Sanity", status: "unknown" }],
      [{ name: "context7", status: "connected" }, { name: "Sanity", status: "failed" }],
    );
    expect(got).toEqual([
      { name: "context7", status: "connected" },
      { name: "Sanity", status: "failed" },
    ]);
  });

  it("static-only entries removed when init arrives (init is authoritative)", () => {
    const got = mergeMcpServers(
      [{ name: "old-server", status: "unknown" }],
      [{ name: "new-server", status: "connected" }],
    );
    expect(got).toEqual([{ name: "new-server", status: "connected" }]);
  });
});

describe("mergeSlashCommands (pw-7, pw-8)", () => {
  it("pw-8: returns static list when init absent", () => {
    const got = mergeSlashCommands(["/init", "/review"], undefined);
    expect(got).toEqual(["/init", "/review"]);
  });

  it("pw-7: prefers init when present", () => {
    const got = mergeSlashCommands(
      ["/init"],
      ["/help", "/clear", "/compact"],
    );
    expect(got).toEqual(["/help", "/clear", "/compact"]);
  });

  it("init=[] is still preferred over static (Claude reported empty list)", () => {
    const got = mergeSlashCommands(["/init"], []);
    expect(got).toEqual([]);
  });
});

describe("mergeMemoryPaths (pw-7, pw-8)", () => {
  it("returns static when init absent", () => {
    const got = mergeMemoryPaths(["/Users/dev/CLAUDE.md"], undefined);
    expect(got).toEqual(["/Users/dev/CLAUDE.md"]);
  });

  it("prefers init when present", () => {
    const got = mergeMemoryPaths(
      ["/Users/dev/CLAUDE.md"],
      ["/Users/dev/.claude/CLAUDE.md", "/Users/dev/proj/CLAUDE.md"],
    );
    expect(got).toEqual([
      "/Users/dev/.claude/CLAUDE.md",
      "/Users/dev/proj/CLAUDE.md",
    ]);
  });
});

// ─── Defensive shape handling (production crash repro) ─────────────
// The merge helpers were originally `livePaths !== undefined ? [...livePaths] : ...`
// — but `null`, missing, or non-array `live*` slipped past that guard
// and crashed render with "Spread syntax requires ...iterable".  These
// tests pin the defensive contract.

describe("defensive: live values that are not arrays", () => {
  it("mergeMcpServers: null live → falls back to static", () => {
    // @ts-expect-error — production data may be malformed
    expect(mergeMcpServers([{ name: "a", status: "u" }], null)).toEqual([
      { name: "a", status: "u" },
    ]);
  });
  it("mergeMcpServers: object live → falls back to static", () => {
    // @ts-expect-error
    expect(mergeMcpServers([{ name: "a", status: "u" }], { weird: 1 })).toEqual([
      { name: "a", status: "u" },
    ]);
  });
  it("mergeSlashCommands: null live → falls back to static", () => {
    // @ts-expect-error
    expect(mergeSlashCommands(["/init"], null)).toEqual(["/init"]);
  });
  it("mergeMemoryPaths: null live → falls back to static", () => {
    // @ts-expect-error
    expect(mergeMemoryPaths(["/x"], null)).toEqual(["/x"]);
  });
  it("static is also defensively handled (never crashes)", () => {
    // @ts-expect-error
    expect(mergeMcpServers(null, undefined)).toEqual([]);
    // @ts-expect-error
    expect(mergeSlashCommands(null, undefined)).toEqual([]);
    // @ts-expect-error
    expect(mergeMemoryPaths(null, undefined)).toEqual([]);
  });
});
