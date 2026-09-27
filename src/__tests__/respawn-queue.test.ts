/**
 * F07 — the frontend half of the respawn lock: overlapping plain restarts of
 * one session run the restart once; restarts that carry new settings run
 * after, never alongside.
 */
import { describe, it, expect } from "vitest";
import { createRespawnQueue } from "../utils/respawnQueue";

/** A restart whose completion the test controls; counts how often it ran. */
function controllable() {
  let started = 0;
  let running = 0;
  let maxRunning = 0;
  const pending: Array<(ok: boolean) => void> = [];
  const restart = () => {
    started += 1;
    running += 1;
    maxRunning = Math.max(maxRunning, running);
    return new Promise<boolean>((resolve) => {
      pending.push((ok) => {
        running -= 1;
        resolve(ok);
      });
    });
  };
  return {
    restart,
    finishNext: (ok = true) => pending.shift()!(ok),
    get started() { return started; },
    get maxRunning() { return maxRunning; },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("createRespawnQueue", () => {
  it("two overlapping plain restarts run once and share the result", async () => {
    const q = createRespawnQueue();
    const r = controllable();
    const a = q.run("s", { joinable: true }, r.restart);
    const b = q.run("s", { joinable: true }, r.restart);
    await tick();
    expect(r.started).toBe(1);
    r.finishNext(true);
    expect(await a).toBe(true);
    expect(await b).toBe(true);
    expect(q.busy("s")).toBe(false);
  });

  it("a plain restart after the first finished runs again", async () => {
    const q = createRespawnQueue();
    const r = controllable();
    const a = q.run("s", { joinable: true }, r.restart);
    await tick();
    r.finishNext(true);
    await a;
    const b = q.run("s", { joinable: true }, r.restart);
    await tick();
    expect(r.started).toBe(2);
    r.finishNext(false);
    expect(await b).toBe(false);
  });

  it("a restart with new settings waits for the running one, then runs", async () => {
    const q = createRespawnQueue();
    const r = controllable();
    const a = q.run("s", { joinable: true }, r.restart);
    const b = q.run("s", { joinable: false }, r.restart);
    await tick();
    expect(r.started).toBe(1);
    r.finishNext(true);
    await a;
    await tick();
    expect(r.started).toBe(2);
    expect(r.maxRunning).toBe(1);
    r.finishNext(true);
    expect(await b).toBe(true);
  });

  it("a plain restart during a settings restart joins it", async () => {
    const q = createRespawnQueue();
    const r = controllable();
    const a = q.run("s", { joinable: false }, r.restart);
    const b = q.run("s", { joinable: true }, r.restart);
    await tick();
    r.finishNext(true);
    expect(await a).toBe(true);
    expect(await b).toBe(true);
    expect(r.started).toBe(1);
  });

  it("with joining off (the negative control), both restarts run, one after the other", async () => {
    const q = createRespawnQueue();
    const r = controllable();
    const a = q.run("s", { joinable: false }, r.restart);
    const b = q.run("s", { joinable: false }, r.restart);
    await tick();
    r.finishNext(true);
    await a;
    await tick();
    r.finishNext(true);
    await b;
    expect(r.started).toBe(2);
    expect(r.maxRunning).toBe(1);
  });

  it("a failed or throwing restart does not wedge the queue", async () => {
    const q = createRespawnQueue();
    const a = q.run("s", { joinable: true }, () => Promise.reject(new Error("boom")));
    await expect(a).rejects.toThrow("boom");
    const r = controllable();
    const b = q.run("s", { joinable: true }, r.restart);
    await tick();
    r.finishNext(true);
    expect(await b).toBe(true);
  });

  it("sessions do not wait for each other", async () => {
    const q = createRespawnQueue();
    const r = controllable();
    q.run("a", { joinable: true }, r.restart);
    q.run("b", { joinable: true }, r.restart);
    await tick();
    expect(r.started).toBe(2);
  });
});
