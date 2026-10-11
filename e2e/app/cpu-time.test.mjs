// Tests for cpu-time.mjs: Linux CPU time comes in clock ticks, not the whole
// seconds procps' `ps` prints (QA-review-track-big-files read 0 % or 12.5 %
// of a core and nothing in between).
import { describe, expect, it } from "vitest";
import { cpuSeconds, parseProcStat, parsePsTime } from "./cpu-time.mjs";

describe("cpu-time", () => {
  it("reads ps time on macOS (centiseconds) and Linux (whole seconds, days)", () => {
    expect(parsePsTime("0:01.23\n")).toBeCloseTo(1.23);
    expect(parsePsTime("  01:02:03")).toBe(3723);
    expect(parsePsTime("2-00:00:01")).toBe(172_801);
  });

  it("reads utime + stime from /proc/<pid>/stat at clock-tick resolution", () => {
    // pid 4242, a command name with a space and a ")", utime 7, stime 3
    const stat = "4242 (hermes ide) x) S 1 4242 4242 0 -1 4194560 1000 0 0 0 7 3 0 0 20 0 30 0 100 0 0";
    expect(parseProcStat(stat, 100)).toBeCloseTo(0.1);
  });

  it("sees a tenth of a second of CPU (finer than whole seconds)", () => {
    // Burn 0.3 s of CPU as this process counts it (wall time varies with load).
    const before = cpuSeconds(process.pid);
    const start = process.cpuUsage();
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const u = process.cpuUsage(start);
      if (u.user + u.system >= 300_000) break;
    }
    const used = cpuSeconds(process.pid) - before;
    // Whole seconds (procps' ps) would read 0 or 1 here.
    expect(used).toBeGreaterThan(0.2);
    expect(used).toBeLessThan(0.8);
  });
});
