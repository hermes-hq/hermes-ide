// Behavioural tests for the acceptance ledger: the YAML reader, the ledger
// rules, and the repository's own ledger against its own scenarios folder.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ALL_PLATFORMS,
  collectResults,
  evaluateLedger,
  formatRows,
  listScenarioFiles,
  loadLedger,
  normaliseLedger,
  parseScenarioRef,
  parseYaml,
} from "./acceptance.mjs";
import { REPO_ROOT, SCENARIOS_DIR } from "./harness.mjs";
import { CI_EXCLUDED, CI_JOB_SCENARIOS } from "./ci-plan.mjs";

describe("parseYaml (ledger subset)", () => {
  it("reads nested maps, block lists, flow lists, quotes and comments", () => {
    const doc = parseYaml(`
# leading comment
features:
  N01:
    name: "Proof rig: tests" # trailing comment
    status: shipped
    count: 3
    flag: true
    nothing:
    criteria:
      N01-1:
        text: 'it''s fine'
        scenarios: [a.mjs, "b.mjs@linux", c.mjs@darwin,win32]
      N01-2:
        scenarios:
          - d.mjs
          - e.mjs
`);
    expect(doc.features.N01.name).toBe("Proof rig: tests");
    expect(doc.features.N01.status).toBe("shipped");
    expect(doc.features.N01.count).toBe(3);
    expect(doc.features.N01.flag).toBe(true);
    expect(doc.features.N01.nothing).toBeNull();
    expect(doc.features.N01.criteria["N01-1"].text).toBe("it's fine");
    expect(doc.features.N01.criteria["N01-1"].scenarios).toEqual(["a.mjs", "b.mjs@linux", "c.mjs@darwin", "win32"]);
    expect(doc.features.N01.criteria["N01-2"].scenarios).toEqual(["d.mjs", "e.mjs"]);
  });

  it("keeps a # inside quotes and a list of maps", () => {
    const doc = parseYaml(`items:\n  - name: "a # not a comment"\n    size: 1\n  - name: b\n`);
    expect(doc.items).toEqual([{ name: "a # not a comment", size: 1 }, { name: "b" }]);
  });

  it("refuses tabs, bad indentation, duplicate keys and flow maps", () => {
    expect(() => parseYaml("a:\n\tb: 1")).toThrow(/tabs/);
    expect(() => parseYaml("a:\n  b: 1\n c: 2")).toThrow(/indentation/);
    expect(() => parseYaml("a: 1\na: 2")).toThrow(/duplicate/);
    expect(() => parseYaml("a: {b: 1}")).toThrow(/flow maps/);
    expect(() => parseYaml('a: "open')).toThrow(/unterminated/);
  });
});

describe("parseScenarioRef", () => {
  it("defaults to every platform and accepts an @platform suffix", () => {
    expect(parseScenarioRef("x.mjs")).toEqual({ file: "x.mjs", platforms: ALL_PLATFORMS });
    expect(parseScenarioRef("x.mjs@linux")).toEqual({ file: "x.mjs", platforms: ["linux"] });
    expect(parseScenarioRef("x.mjs@darwin,win32").platforms).toEqual(["darwin", "win32"]);
  });
  it("rejects unknown platforms and non-scenario names", () => {
    expect(() => parseScenarioRef("x.mjs@windows")).toThrow(/unknown platform/);
    expect(() => parseScenarioRef("x.ts")).toThrow(/not a scenario file/);
    expect(() => parseScenarioRef("")).toThrow();
  });
});

describe("normaliseLedger", () => {
  it("requires a features map and a known status", () => {
    expect(() => normaliseLedger({})).toThrow(/features/);
    expect(() => normaliseLedger({ features: { A: { status: "done" } } })).toThrow(/status must be one of/);
    expect(() => normaliseLedger({ features: { A: { status: "shipped", criteria: [] } } })).toThrow(/criteria/);
  });
  it("tolerates a feature without criteria and fills defaults", () => {
    const m = normaliseLedger({ features: { A: { status: "planned" } } });
    expect(m.features).toEqual([{ id: "A", name: "A", status: "planned", criteria: [] }]);
  });
});

function ledger(status, scenarios = ["s.mjs"]) {
  return normaliseLedger({
    features: { F: { name: "F", status, criteria: { "F-1": { text: "t", scenarios } } } },
  });
}
const run = (platform, status, n = 1) => ({ scenario: "s", platform, run: n, status });
const greenEverywhere = ALL_PLATFORMS.map((p) => run(p, "pass"));

describe("evaluateLedger", () => {
  it("passes a shipped feature that is green on all platforms", () => {
    const { errors, rows } = evaluateLedger(ledger("shipped"), { scenarioFiles: ["s.mjs"], results: greenEverywhere });
    expect(errors).toEqual([]);
    expect(rows.map((r) => r.green)).toEqual([true, true, true]);
    expect(formatRows(rows)).toContain("green");
  });

  it("fails a shipped feature when a platform has no result", () => {
    const results = greenEverywhere.filter((r) => r.platform !== "win32");
    const { errors } = evaluateLedger(ledger("shipped"), { scenarioFiles: ["s.mjs"], results });
    expect(errors).toEqual(["F/F-1: s.mjs has no result on win32"]);
  });

  it("never counts a skip as a pass: a platform that only skipped has no result", () => {
    const results = [...greenEverywhere.filter((r) => r.platform !== "win32"), run("win32", "skip")];
    const { errors, rows } = evaluateLedger(ledger("shipped"), { scenarioFiles: ["s.mjs"], results });
    expect(errors).toEqual(["F/F-1: s.mjs has no result on win32"]);
    expect(rows.find((r) => r.platform === "win32")).toMatchObject({ runs: 0, green: false });
    // A skip next to a pass is not a failure either.
    expect(evaluateLedger(ledger("shipped"), { scenarioFiles: ["s.mjs"], results: [...greenEverywhere, run("linux", "skip", 2)] }).errors).toEqual([]);
  });

  it("fails a shipped feature when any run on a platform is red", () => {
    const results = [...greenEverywhere, run("linux", "fail", 2)];
    const { errors } = evaluateLedger(ledger("shipped"), { scenarioFiles: ["s.mjs"], results });
    expect(errors).toEqual(["F/F-1: s.mjs failed 1 of 2 run(s) on linux"]);
  });

  it("fails a shipped feature with no scenario or a missing file, even without results", () => {
    expect(evaluateLedger(ledger("shipped", []), { scenarioFiles: [] }).errors[0]).toMatch(/no scenario proving it/);
    expect(evaluateLedger(ledger("shipped"), { scenarioFiles: [] }).errors[0]).toMatch(/does not exist/);
  });

  it("only requires the platforms a scenario names", () => {
    const l = ledger("shipped", ["s.mjs@linux"]);
    expect(evaluateLedger(l, { scenarioFiles: ["s.mjs"], results: [run("linux", "pass")] }).errors).toEqual([]);
    expect(evaluateLedger(l, { scenarioFiles: ["s.mjs"], results: [run("darwin", "pass")] }).errors).toEqual([
      "F/F-1: s.mjs has no result on linux",
    ]);
  });

  it("lets planned features have gaps and warns about unreferenced scenarios", () => {
    const { errors, warnings } = evaluateLedger(ledger("planned", []), { scenarioFiles: ["orphan.mjs"], results: [] });
    expect(errors).toEqual([]);
    expect(warnings).toEqual(["orphan.mjs is not referenced by any feature in the ledger"]);
  });

  it("checks partial features' listed scenarios but allows missing ones", () => {
    const { errors } = evaluateLedger(ledger("partial"), { scenarioFiles: ["s.mjs"], results: [run("darwin", "fail")] });
    expect(errors).toContain("F/F-1: s.mjs failed 1 of 1 run(s) on darwin");
    expect(evaluateLedger(ledger("partial", []), { scenarioFiles: [] }).errors).toEqual([]);
  });

  it("a scenario whose CI job the plan skipped is not applicable when it has no result, and still counts when it has one", () => {
    const l = ledger("partial", ["s.mjs@linux"]);
    // Without the note: missing, the gate is red (a pull request that does not touch packaging).
    expect(evaluateLedger(l, { scenarioFiles: ["s.mjs"], results: [] }).errors).toEqual(["F/F-1: s.mjs has no result on linux"]);
    const notRun = new Map([["s.mjs", "e2e-installers skipped"]]);
    const skipped = evaluateLedger(l, { scenarioFiles: ["s.mjs"], results: [], notRun });
    expect(skipped.errors).toEqual([]);
    expect(formatRows(skipped.rows)).toContain("not run here (e2e-installers skipped)");
    // A red result is red, skipped job or not.
    expect(evaluateLedger(l, { scenarioFiles: ["s.mjs"], results: [run("linux", "fail")], notRun }).errors).toEqual([
      "F/F-1: s.mjs failed 1 of 1 run(s) on linux",
    ]);
    // Other scenarios are still required.
    const two = ledger("shipped", ["s.mjs@linux", "t.mjs@linux"]);
    expect(evaluateLedger(two, { scenarioFiles: ["s.mjs", "t.mjs"], results: [], notRun }).errors).toEqual(["F/F-1: t.mjs has no result on linux"]);
  });
});

describe("acceptance-check.mjs --skipped-job", () => {
  const check = (...args) =>
    spawnSync(process.execPath, [join(REPO_ROOT, "e2e", "acceptance-check.mjs"), ...args], { cwd: REPO_ROOT, encoding: "utf8" });

  it("names only jobs the CI plan knows, and every one of their scenarios is run nowhere else", () => {
    const r = check("--skipped-job", "no-such-job");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/unknown job "no-such-job"/);
    for (const files of Object.values(CI_JOB_SCENARIOS)) {
      for (const f of files) {
        expect(listScenarioFiles(SCENARIOS_DIR)).toContain(f);
        expect(CI_EXCLUDED[f]).toBeTruthy();
      }
    }
  });

  it("with the installer job skipped, the installer scenarios' missing results do not fail the gate; without it they do", () => {
    const dir = mkdtempSync(join(tmpdir(), "hermes-gate-"));
    try {
      // Green results for every scenario on every platform the ledger asks for, except the installers.
      const l = loadLedger(join(REPO_ROOT, "e2e", "acceptance.yml"));
      const installers = new Set(CI_JOB_SCENARIOS["e2e-installers"]);
      const runs = [];
      for (const f of l.features) {
        for (const c of f.criteria) {
          for (const { file, platforms } of c.scenarios) {
            if (installers.has(file)) continue;
            for (const platform of platforms) runs.push({ scenario: file.replace(/\.mjs$/, ""), platform, status: "pass" });
          }
        }
      }
      mkdirSync(join(dir, "e2e-evidence-x"), { recursive: true });
      writeFileSync(join(dir, "e2e-evidence-x", "results.json"), JSON.stringify({ runs }));
      const red = check("--results", dir);
      expect(red.status).toBe(1);
      expect(red.stdout).toMatch(/F25-winget-install\.mjs has no result on win32/);
      expect(red.stdout).toMatch(/F25-appimage-update\.mjs has no result on linux/);
      const green = check("--results", dir, "--skipped-job", "e2e-installers");
      expect(green.stdout).toContain("ACCEPTANCE GATE: PASS");
      expect(green.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("collectResults", () => {
  it("gathers every results.json below a folder, and accepts a single file", () => {
    const dir = mkdtempSync(join(tmpdir(), "hermes-ledger-"));
    try {
      mkdirSync(join(dir, "a", "deep"), { recursive: true });
      mkdirSync(join(dir, "b"));
      writeFileSync(join(dir, "a", "deep", "results.json"), JSON.stringify([run("darwin", "pass")]));
      writeFileSync(join(dir, "b", "results.json"), JSON.stringify({ runs: [run("linux", "pass")] }));
      writeFileSync(join(dir, "b", "other.json"), "[]");
      expect(collectResults(dir).map((r) => r.platform).sort()).toEqual(["darwin", "linux"]);
      expect(collectResults(join(dir, "b", "results.json"))).toHaveLength(1);
      expect(collectResults(join(dir, "missing"))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the repository's ledger", () => {
  it("loads, names only existing scenarios, and lists every scenario file", () => {
    const l = loadLedger(join(REPO_ROOT, "e2e", "acceptance.yml"));
    const files = listScenarioFiles(SCENARIOS_DIR);
    expect(files).toContain("terminal-echo.mjs");
    const { errors, warnings } = evaluateLedger(l, { scenarioFiles: files });
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
  });
});
