// Behavioural tests for the scenario runner (run.mjs) and the CI shard plan
// (ci-plan.mjs). run.mjs is started as CI starts it, against a folder of
// stand-in scenarios that pass, fail, or exit 0 without a result, so the
// exit code, the summary and results.json are what a CI step would see.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { listScenarioFiles } from "./acceptance.mjs";
import { CI_ELSEWHERE, CI_EXCLUDED, filesInShard, parseShard, shardOf, shardedScenarios } from "./ci-plan.mjs";
import { REPO_ROOT, SCENARIOS_DIR } from "./harness.mjs";

const RUN = join(REPO_ROOT, "e2e", "app", "run.mjs");

const PASS = `import { mkdirSync, writeFileSync } from "node:fs";
const dir = process.env.HERMES_E2E_EVIDENCE;
mkdirSync(dir, { recursive: true });
writeFileSync(dir + "/result.json", JSON.stringify({ status: "pass" }));
`;
const FAIL = `import { mkdirSync, writeFileSync } from "node:fs";
const dir = process.env.HERMES_E2E_EVIDENCE;
mkdirSync(dir, { recursive: true });
writeFileSync(dir + "/result.json", JSON.stringify({ status: "fail" }));
process.exit(1);
`;
// Exits 0 but never writes a result: must count as a failure.
const SILENT = "process.exit(0);\n";
// Cannot run here, and says so the way harness.mjs's skipScenario does.
const SKIP = `import { skipScenario } from ${JSON.stringify(pathToFileURL(join(REPO_ROOT, "e2e", "app", "harness.mjs")).href)};
skipScenario({ scenario: "real", reason: "real cli not available here, or CI" });
process.exit(0);
`;

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A scenarios folder with the given { file: source } and a ledger naming `ledgerRefs`. */
function rig(files, ledgerRefs = []) {
  const dir = mkdtempSync(join(tmpdir(), "run-mjs-"));
  dirs.push(dir);
  const scenarios = join(dir, "scenarios");
  mkdirSync(scenarios);
  for (const [file, src] of Object.entries(files)) writeFileSync(join(scenarios, file), src);
  const ledger = join(dir, "acceptance.yml");
  writeFileSync(
    ledger,
    `features:\n  X:\n    status: planned\n    criteria:\n      X-1:\n        text: "stand-in"\n        scenarios: [${ledgerRefs.join(", ")}]\n`,
  );
  return { dir, scenarios, ledger, out: join(dir, "evidence") };
}

function run(r, args, env = {}) {
  const res = spawnSync(process.execPath, [RUN, "--scenarios", r.scenarios, "--ledger", r.ledger, "--out", r.out, ...args], {
    encoding: "utf8",
    env: { ...process.env, GITHUB_ACTIONS: "", HERMES_E2E_OUT: r.dir, ...env },
  });
  const results = existsSync(join(r.out, "results.json")) ? JSON.parse(readFileSync(join(r.out, "results.json"), "utf8")) : null;
  return { code: res.status, out: res.stdout + res.stderr, results };
}

describe("run.mjs exit code and summary", { timeout: 60_000 }, () => {
  it("passes when every run of this invocation passes, even though results.json holds an old failure", () => {
    const r = rig({ "a.mjs": PASS });
    mkdirSync(r.out, { recursive: true });
    const old = [{ scenario: "old", platform: process.platform, run: 1, status: "fail", exitCode: 1 }];
    writeFileSync(join(r.out, "results.json"), JSON.stringify(old));
    const { code, out, results } = run(r, ["a.mjs"]);
    expect(code).toBe(0);
    expect(out).toContain("runs: 1; failed: 0");
    expect(out).toContain("RUN: PASS");
    expect(out).not.toContain("FAILED:");
    // the old run is kept for the acceptance gate
    expect(results.map((x) => `${x.scenario}:${x.status}`)).toEqual(["old:fail", "a:pass"]);
  });

  it("fails, names the failed scenario and still runs the rest with --keep-going", () => {
    const r = rig({ "a.mjs": PASS, "b.mjs": FAIL, "c.mjs": PASS });
    const { code, out, results } = run(r, ["--keep-going"]);
    expect(code).toBe(1);
    expect(out).toMatch(/FAILED: b \(run 1\/1, exit 1, result fail\)/);
    expect(out).toContain("RUN: FAIL (b)");
    expect(out).not.toMatch(/FAILED: [ac] /);
    expect(results.map((x) => `${x.scenario}:${x.status}`)).toEqual(["a:pass", "b:fail", "c:pass"]);
  });

  it("counts a scenario that exits 0 without a result as failed", () => {
    const r = rig({ "quiet.mjs": SILENT });
    const { code, out } = run(r, ["quiet.mjs"]);
    expect(code).toBe(1);
    expect(out).toContain("FAILED: quiet (run 1/1, exit 0, result none)");
  });

  it("reports a scenario that says it cannot run here as skipped, not as a pass or a failure", () => {
    const r = rig({ "a.mjs": PASS, "real.mjs": SKIP });
    const { code, out, results } = run(r, ["a.mjs", "real.mjs"], { CI: "true" });
    expect(code).toBe(0);
    expect(out).toContain("=== real (1/1): SKIP (real cli not available here, or CI)");
    expect(out).toContain("SKIPPED: real (real cli not available here, or CI)");
    expect(out).toContain("failed: 0; skipped here: 1");
    expect(out).not.toContain("FAILED:");
    expect(out).toContain("RUN: PASS");
    expect(results.map((x) => `${x.scenario}:${x.status}`)).toEqual(["a:pass", "real:skip"]);
  });

  it("a skip result with a non-zero exit is still a failure", () => {
    const odd = `import { mkdirSync, writeFileSync } from "node:fs";
const dir = process.env.HERMES_E2E_EVIDENCE;
mkdirSync(dir, { recursive: true });
writeFileSync(dir + "/result.json", JSON.stringify({ status: "skip", reason: "odd" }));
process.exit(3);
`;
    const r = rig({ "odd.mjs": odd });
    const { code, out } = run(r, ["odd.mjs"]);
    expect(code).toBe(1);
    expect(out).toContain("FAILED: odd (run 1/1, exit 3, result skip)");
  });

  it("a skip inside a runScenario body still runs the scenario's cleanups", () => {
    const steps = JSON.stringify(pathToFileURL(join(REPO_ROOT, "e2e", "app", "n11-steps.mjs")).href);
    const harness = JSON.stringify(pathToFileURL(join(REPO_ROOT, "e2e", "app", "harness.mjs")).href);
    const inBody = `import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { skipScenario } from ${harness};
import { runScenario } from ${steps};
await runScenario("inbody", async ({ evidenceDir, log, onCleanup }) => {
  onCleanup(() => writeFileSync(join(process.env.HERMES_E2E_OUT, "cleaned-up"), "yes"));
  skipScenario({ scenario: "inbody", evidenceDir, reason: "Windows outside CI", log });
  throw new Error("the body went on after the skip");
});
`;
    const r = rig({ "inbody.mjs": inBody });
    const { code, out, results } = run(r, ["inbody.mjs"]);
    expect(code).toBe(0);
    expect(out).toContain("=== inbody (1/1): SKIP (Windows outside CI)");
    expect(results.map((x) => `${x.scenario}:${x.status}`)).toEqual(["inbody:skip"]);
    expect(existsSync(join(r.dir, "cleaned-up"))).toBe(true);
  });

  it("stops at the first failure without --keep-going and says what did not run", () => {
    const r = rig({ "a.mjs": FAIL, "b.mjs": PASS, "c.mjs": PASS });
    const { code, out, results } = run(r, []);
    expect(code).toBe(1);
    expect(results.map((x) => x.scenario)).toEqual(["a"]);
    expect(out).toContain("not run (stopped at the first failure; pass --keep-going to run them): b, c");
  });

  it("prints a GitHub error annotation for each failure on a runner", () => {
    const r = rig({ "b.mjs": FAIL });
    const { out } = run(r, ["b.mjs"], { GITHUB_ACTIONS: "true" });
    expect(out).toMatch(/^::error title=Real-app scenario failed::b failed on /m);
  });

  it("an earlier failing invocation does not change the next one's exit code", () => {
    const r = rig({ "a.mjs": PASS, "b.mjs": FAIL });
    expect(run(r, ["b.mjs"]).code).toBe(1);
    const second = run(r, ["a.mjs"]);
    expect(second.code).toBe(0);
    expect(second.out).toContain("1 from earlier invocations, not counted above");
    expect(second.results.map((x) => `${x.scenario}:${x.status}`)).toEqual(["b:fail", "a:pass"]);
  });

  it("starts a new results.json with --fresh", () => {
    const r = rig({ "a.mjs": PASS });
    run(r, ["a.mjs"]);
    const { results } = run(r, ["--fresh", "a.mjs"]);
    expect(results).toHaveLength(1);
  });
});

describe("run.mjs repeat and shards", { timeout: 60_000 }, () => {
  it("--repeat-scenario repeats one scenario and runs the others once", () => {
    const r = rig({ "a.mjs": PASS, "echo.mjs": PASS });
    const { code, results } = run(r, ["--repeat-scenario", "echo.mjs=3"]);
    expect(code).toBe(0);
    expect(results.filter((x) => x.scenario === "echo").map((x) => x.run)).toEqual([1, 2, 3]);
    expect(results.filter((x) => x.scenario === "a")).toHaveLength(1);
  });

  it("--repeat-scenario takes several scenarios at once", () => {
    const r = rig({ "a.mjs": PASS, "b.mjs": PASS, "c.mjs": PASS });
    const { code, results } = run(r, ["--repeat-scenario", "a.mjs=2,b=3"]);
    expect(code).toBe(0);
    const runsOf = (n) => results.filter((x) => x.scenario === n).length;
    expect([runsOf("a"), runsOf("b"), runsOf("c")]).toEqual([2, 3, 1]);
  });

  it("a repeated scenario that fails once fails the invocation", () => {
    const r = rig({ "flaky.mjs": FAIL });
    const { code, out } = run(r, ["--keep-going", "--repeat", "2", "flaky.mjs"]);
    expect(code).toBe(1);
    expect(out).toContain("FAILED: flaky (run 1/2");
    expect(out).toContain("FAILED: flaky (run 2/2");
    expect(out).toContain("RUN: FAIL (flaky)");
  });

  it("each shard runs exactly its own files, and together the shards run every file once", () => {
    const names = Array.from({ length: 12 }, (_, i) => `s${i}.mjs`);
    const r = rig(Object.fromEntries(names.map((n) => [n, PASS])));
    const seen = [];
    for (let k = 1; k <= 3; k++) {
      rmSync(r.out, { recursive: true, force: true });
      const { code, results } = run(r, ["--ci-set", "shards", "--shard", `${k}/3`]);
      expect(code).toBe(0);
      const ran = results.map((x) => `${x.scenario}.mjs`);
      expect([...ran].sort()).toEqual(names.filter((n) => shardOf(n, 3) === k).sort());
      seen.push(...ran);
    }
    expect(seen.sort()).toEqual([...names].sort());
  });

  it("a failing scenario fails only the shard it lands on", () => {
    const names = Array.from({ length: 9 }, (_, i) => `s${i}.mjs`);
    const bad = "s4.mjs";
    const r = rig(Object.fromEntries(names.map((n) => [n, n === bad ? FAIL : PASS])));
    for (let k = 1; k <= 3; k++) {
      rmSync(r.out, { recursive: true, force: true });
      const { code, out } = run(r, ["--ci-set", "shards", "--keep-going", "--shard", `${k}/3`]);
      if (shardOf(bad, 3) === k) {
        expect(code).toBe(1);
        expect(out).toContain("RUN: FAIL (s4)");
      } else {
        expect(code).toBe(0);
      }
    }
  });

  it("a named scenario on another shard is not run there, and that is not a failure", () => {
    const r = rig({ "keys.mjs": FAIL });
    const other = (shardOf("keys.mjs", 3) % 3) + 1;
    const { code, results, out } = run(r, ["--shard", `${other}/3`, "keys.mjs"]);
    expect(code).toBe(0);
    expect(results).toEqual([]);
    expect(out).toContain("scenarios here (0): (none)");
  });

  it("skips a scenario the ledger limits to another platform, without failing", () => {
    const elsewhere = process.platform === "linux" ? "darwin" : "linux";
    const r = rig({ "only-there.mjs": FAIL, "a.mjs": PASS }, [`only-there.mjs@${elsewhere}`]);
    const { code, out, results } = run(r, ["--keep-going"]);
    expect(code).toBe(0);
    expect(out).toContain(`only-there: skipped on ${process.platform}`);
    expect(out).toContain("skipped here: 1");
    expect(results.map((x) => x.scenario)).toEqual(["a"]);
  });

  it("rejects a malformed shard or repeat", () => {
    const r = rig({ "a.mjs": PASS });
    expect(run(r, ["--shard", "4/3"]).code).not.toBe(0);
    expect(run(r, ["--shard", "two"]).code).not.toBe(0);
    expect(run(r, ["--repeat-scenario", "a.mjs=0"]).code).not.toBe(0);
    expect(run(r, ["--repeat-scenario", "a.mjs=2,"]).code).not.toBe(0);
    expect(run(r, ["--repeat-scenario", "missing.mjs=2"]).code).not.toBe(0);
  });
});

describe("ci-plan", () => {
  it("puts a file on the same shard every time, in range", () => {
    for (const f of ["terminal-echo.mjs", "N06-db-migrations.mjs", "x.mjs"]) {
      for (const n of [1, 2, 3, 5]) {
        const s = shardOf(f, n);
        expect(s).toBeGreaterThanOrEqual(1);
        expect(s).toBeLessThanOrEqual(n);
        expect(shardOf(f, n)).toBe(s);
      }
    }
  });

  it("adding a scenario never moves another one to a different shard", () => {
    const before = ["a.mjs", "b.mjs", "c.mjs", "d.mjs"];
    const after = [...before, "new.mjs"];
    for (let k = 1; k <= 3; k++) {
      const was = filesInShard(before, { index: k, count: 3 });
      const now = filesInShard(after, { index: k, count: 3 }).filter((f) => f !== "new.mjs");
      expect(now).toEqual(was);
    }
  });

  it("parses K/N", () => {
    expect(parseShard("2/3")).toEqual({ index: 2, count: 3 });
    expect(() => parseShard("0/3")).toThrow();
    expect(() => parseShard("3")).toThrow();
  });

  it("every scenario the plan names exists, and the shards run all the others", () => {
    const all = listScenarioFiles(SCENARIOS_DIR);
    for (const f of [...Object.keys(CI_ELSEWHERE), ...Object.keys(CI_EXCLUDED)]) expect(all).toContain(f);
    const sharded = shardedScenarios(all);
    expect(sharded).toContain("terminal-echo.mjs");
    expect(sharded.length + Object.keys(CI_ELSEWHERE).length + Object.keys(CI_EXCLUDED).length).toBe(all.length);
    // with the repository's scenarios, no shard is empty
    for (let k = 1; k <= 3; k++) expect(filesInShard(sharded, { index: k, count: 3 }).length).toBeGreaterThan(0);
  });
});
