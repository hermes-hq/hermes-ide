// Behavioural tests for the release gate's reading of GitHub check runs: only
// a completed, successful, newest run of the named check counts; a running
// one is waited for; a missing one blocks the release.
import { describe, expect, it } from "vitest";
import { latestCheckRun, requiredCheckState, waitForRequiredCheck } from "./required-check.mjs";

const run = (over = {}) => ({
  id: 1,
  name: "gate",
  status: "completed",
  conclusion: "success",
  started_at: "2026-01-01T10:00:00Z",
  html_url: "https://example.invalid/run/1",
  ...over,
});

describe("requiredCheckState", () => {
  it("passes on a completed successful run and names the run", () => {
    const r = requiredCheckState([run({ name: "Frontend" }), run()], "gate");
    expect(r.state).toBe("success");
    expect(r.detail).toContain("https://example.invalid/run/1");
  });

  it("is missing when no run has that name", () => {
    expect(requiredCheckState([run({ name: "Frontend" })], "gate").state).toBe("missing");
    expect(requiredCheckState([], "gate").state).toBe("missing");
    expect(requiredCheckState(null, "gate").state).toBe("missing");
  });

  it("is pending while the run is queued or in progress", () => {
    expect(requiredCheckState([run({ status: "in_progress", conclusion: null })], "gate").state).toBe("pending");
    expect(requiredCheckState([run({ status: "queued", conclusion: null })], "gate").state).toBe("pending");
  });

  it.each(["failure", "cancelled", "skipped", "neutral", "timed_out", "action_required", "stale"])(
    "fails on conclusion %s",
    (conclusion) => {
      const r = requiredCheckState([run({ conclusion })], "gate");
      expect(r.state).toBe("failure");
      expect(r.detail).toContain(conclusion);
    },
  );

  it("lets a newer re-run replace an older verdict, either way", () => {
    const old = run({ id: 1, conclusion: "failure", started_at: "2026-01-01T10:00:00Z" });
    const fresh = run({ id: 2, conclusion: "success", started_at: "2026-01-01T11:00:00Z" });
    expect(requiredCheckState([old, fresh], "gate").state).toBe("success");
    expect(requiredCheckState([fresh, old], "gate").state).toBe("success");
    const regressed = run({ id: 3, conclusion: "failure", started_at: "2026-01-01T12:00:00Z" });
    expect(requiredCheckState([fresh, regressed, old], "gate").state).toBe("failure");
    expect(latestCheckRun([fresh, regressed, old], "gate").id).toBe(3);
  });

  it("breaks a tie on start time by the higher run id", () => {
    const a = run({ id: 10, conclusion: "failure" });
    const b = run({ id: 11, conclusion: "success" });
    expect(latestCheckRun([b, a], "gate").id).toBe(11);
  });
});

describe("waitForRequiredCheck", () => {
  it("polls until the run completes and then reports its verdict", async () => {
    const answers = [
      [run({ status: "queued", conclusion: null })],
      [run({ status: "in_progress", conclusion: null })],
      [run()],
    ];
    const slept = [];
    const r = await waitForRequiredCheck(() => answers.shift(), "gate", {
      timeoutMs: 60_000,
      intervalMs: 1_000,
      sleep: async (ms) => slept.push(ms),
      now: () => 0,
    });
    expect(r.state).toBe("success");
    expect(slept).toEqual([1_000, 1_000]);
  });

  it("gives up as a failure when the deadline passes while still pending", async () => {
    let clock = 0;
    const r = await waitForRequiredCheck(() => [run({ status: "in_progress", conclusion: null })], "gate", {
      timeoutMs: 5_000,
      intervalMs: 2_000,
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    });
    expect(r.state).toBe("failure");
    expect(r.detail).toMatch(/gave up waiting/);
  });

  it("within the grace period, waits for a run CI has not registered yet", async () => {
    // A push to main starts CI and the release together: the first look can
    // land before CI has created its check runs.
    const answers = [[], [], [run({ status: "queued", conclusion: null })], [run()]];
    let clock = 0;
    const logged = [];
    const r = await waitForRequiredCheck(() => answers.shift(), "gate", {
      timeoutMs: 60 * 60_000,
      intervalMs: 30_000,
      missingGraceMs: 15 * 60_000,
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
      log: (m) => logged.push(m),
    });
    expect(r.state).toBe("success");
    expect(logged[0]).toMatch(/no check run named "gate" on this commit yet/);
  });

  it("after the grace period, a run that never appeared is missing", async () => {
    let clock = 0;
    let calls = 0;
    const r = await waitForRequiredCheck(
      () => {
        calls++;
        return [];
      },
      "gate",
      {
        timeoutMs: 60 * 60_000,
        intervalMs: 60_000,
        missingGraceMs: 5 * 60_000,
        sleep: async (ms) => {
          clock += ms;
        },
        now: () => clock,
      },
    );
    expect(r.state).toBe("missing");
    expect(calls).toBe(6);
  });

  it("does not wait at all for a missing or failed run", async () => {
    let calls = 0;
    const r = await waitForRequiredCheck(
      () => {
        calls++;
        return [];
      },
      "gate",
      { sleep: async () => {} },
    );
    expect(r.state).toBe("missing");
    expect(calls).toBe(1);
  });
});
