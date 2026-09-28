// Behavioural tests for the real-app scenario steps in .github/workflows/ci.yml:
// each step script is taken from the workflow and run under bash the way
// GitHub runs it (`bash -e -o pipefail`), once per shard the workflow's
// matrix lists and with the SHARD value its env block builds. `node` is a
// stub that runs the real run.mjs against stand-in scenarios (which pass or
// fail on demand) and `xvfb-run` a stub that just runs its command, so what
// is checked is what the steps do on a runner:
//
//   - together the shards run every scenario exactly once, and terminal-echo
//     as many times as REPEAT says;
//   - a failing scenario fails its own shard's step, which names it, and no
//     other shard;
//   - a step's exit code is its own invocation's: an older failed run in
//     results.json does not fail it;
//   - the key-press and build-toolchain scenarios run where the plan says.
//
// Skipped on Windows: the stubs are POSIX shell scripts run by bash. The
// workflow's own steps run under `shell: bash` on every OS, so what these
// tests cover is the same there.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CI_ELSEWHERE, CI_EXCLUDED, shardedScenarios } from "./ci-plan.mjs";
import { REPO_ROOT } from "./harness.mjs";

const WORKFLOW = join(REPO_ROOT, ".github", "workflows", "ci.yml");
const workflowLines = () => readFileSync(WORKFLOW, "utf8").split("\n");

/** The `run: |` block of the step with this exact name, dedented. */
function stepScript(name) {
  const lines = workflowLines();
  const at = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  if (at < 0) throw new Error(`no step named "${name}" in ci.yml`);
  const stepIndent = lines[at].indexOf("-");
  let runAt = -1;
  for (let i = at + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() && l.search(/\S/) <= stepIndent) break; // next step
    if (l.trim() === "run: |") {
      runAt = i;
      break;
    }
  }
  if (runAt < 0) throw new Error(`step "${name}" has no run block`);
  const runIndent = lines[runAt].search(/\S/);
  const body = [];
  for (let i = runAt + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() && l.search(/\S/) <= runIndent) break;
    body.push(l);
  }
  const indent = Math.min(...body.filter((l) => l.trim()).map((l) => l.search(/\S/)));
  return body.map((l) => l.slice(indent)).join("\n");
}

/** The e2e-app job's shard list and the SHARD value it builds for one of them. */
function shardMatrix() {
  const lines = workflowLines();
  const job = lines.findIndex((l) => l === "  e2e-app:");
  if (job < 0) throw new Error("no e2e-app job in ci.yml");
  const end = lines.findIndex((l, i) => i > job && /^ {2}\S/.test(l));
  const jobLines = lines.slice(job, end < 0 ? undefined : end);
  const list = jobLines.map((l) => /^\s+shard:\s*\[([^\]]*)\]/.exec(l)).find(Boolean);
  const env = jobLines.map((l) => /^\s+SHARD:\s*\$\{\{\s*matrix\.shard\s*\}\}(.*)$/.exec(l)).find(Boolean);
  if (!list || !env) throw new Error("e2e-app: no shard list or SHARD env");
  const shards = list[1].split(",").map((s) => s.trim());
  return { shards, shardValue: (k) => `${k}${env[1].trim()}` };
}

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

// Stand-ins named like the real scenarios the plan treats specially, plus
// ordinary ones.
const ORDINARY = ["terminal-echo.mjs", ...Array.from({ length: 14 }, (_, i) => `S${String(i).padStart(2, "0")}-stand-in.mjs`)];
const SPECIAL = [...Object.keys(CI_ELSEWHERE), ...Object.keys(CI_EXCLUDED)];
const ALL = [...ORDINARY, ...SPECIAL];

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeRig(failing = []) {
  const dir = mkdtempSync(join(tmpdir(), "ci-shards-"));
  dirs.push(dir);
  const scenarios = join(dir, "scenarios");
  mkdirSync(scenarios);
  for (const f of ALL) writeFileSync(join(scenarios, f), failing.includes(f) ? FAIL : PASS);
  const ledger = join(dir, "acceptance.yml");
  writeFileSync(ledger, 'features:\n  X:\n    status: planned\n    criteria:\n      X-1:\n        text: "stand-in"\n        scenarios: []\n');
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const stub = (file, text) => {
    writeFileSync(join(bin, file), text);
    chmodSync(join(bin, file), 0o755);
  };
  stub("node", `#!/bin/sh\nexec "${process.execPath}" "$@" --scenarios "${scenarios}" --ledger "${ledger}"\n`);
  // xvfb-run -a -s "<server args>" <command...>
  stub(
    "xvfb-run",
    `#!/bin/sh
while [ $# -gt 0 ]; do
  case "$1" in
    -a) shift ;;
    -s) shift 2 ;;
    *) break ;;
  esac
done
exec "$@"
`,
  );
  return { dir, bin, out: join(dir, "out") };
}

/** Run a step for one shard in a fresh output folder; returns the exit code, output and recorded runs. */
function runStep(rig, step, { shard, repeat = "1", keepOut = false } = {}) {
  if (!keepOut) rmSync(rig.out, { recursive: true, force: true });
  const res = spawnSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", stepScript(step)], {
    cwd: REPO_ROOT,
    env: {
      PATH: `${rig.bin}:${process.env.PATH}`,
      HOME: rig.dir,
      HERMES_E2E_OUT: rig.out,
      REPEAT: repeat,
      ...(shard ? { SHARD: shard } : {}),
    },
    encoding: "utf8",
  });
  const file = join(rig.out, "evidence", "results.json");
  const runs = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
  return { code: res.status, out: res.stdout + res.stderr, runs };
}

const SCENARIO_STEPS = ["Run scenarios (Linux, virtual display)", "Run scenarios"];
const KEY_STEPS = [
  "Terminal keys with real key presses (Linux, virtual display)",
  "Terminal keys with real key presses (Windows)",
  "Terminal keys (macOS)",
];

// Each test starts a node process per stand-in scenario: give a loaded
// machine time.
describe.skipIf(process.platform === "win32")("real-app shard steps in ci.yml", { timeout: 60_000 }, () => {
  const { shards, shardValue } = shardMatrix();

  it("the matrix lists shards 1..N and SHARD says N", () => {
    expect(shards).toEqual(shards.map((_, i) => String(i + 1)));
    expect(shardValue(1)).toBe(`1/${shards.length}`);
  });

  for (const step of SCENARIO_STEPS) {
    describe(step, () => {
      it("together the shards run every scenario once, and terminal-echo REPEAT times", () => {
        const rig = makeRig();
        const seen = [];
        for (const k of shards) {
          const { code, runs } = runStep(rig, step, { shard: shardValue(k), repeat: "3" });
          expect(code).toBe(0);
          seen.push(...runs.map((r) => `${r.scenario}.mjs#${r.run}`));
        }
        const want = shardedScenarios(ALL).flatMap((f) => (f === "terminal-echo.mjs" ? [1, 2, 3] : [1]).map((n) => `${f}#${n}`));
        expect(seen.sort()).toEqual(want.sort());
        for (const f of SPECIAL) expect(seen.some((s) => s.startsWith(`${f}#`))).toBe(false);
      });

      it("a failing scenario fails its own shard, which names it, and no other", () => {
        const bad = "S05-stand-in.mjs";
        const rig = makeRig([bad]);
        let failedShards = 0;
        for (const k of shards) {
          const { code, out, runs } = runStep(rig, step, { shard: shardValue(k) });
          if (runs.some((r) => r.scenario === "S05-stand-in")) {
            failedShards++;
            expect(code).not.toBe(0);
            expect(out).toContain("FAILED: S05-stand-in (run 1/1");
            expect(out).toContain("RUN: FAIL (S05-stand-in)");
            // --keep-going: the rest of the shard still ran
            expect(runs.length).toBeGreaterThan(1);
          } else {
            expect(code).toBe(0);
            expect(out).not.toContain("FAILED:");
          }
        }
        expect(failedShards).toBe(1);
      });

      it("exits 0 when this invocation passed, even with an older failure in results.json", () => {
        const rig = makeRig();
        const evidence = join(rig.out, "evidence");
        mkdirSync(evidence, { recursive: true });
        writeFileSync(join(evidence, "results.json"), JSON.stringify([{ scenario: "earlier", platform: process.platform, run: 1, status: "fail" }]));
        const { code, out, runs } = runStep(rig, step, { shard: shardValue(1), keepOut: true });
        expect(code).toBe(0);
        expect(out).toContain("RUN: PASS");
        expect(runs[0].scenario).toBe("earlier");
      });
    });
  }

  for (const step of KEY_STEPS) {
    it(`${step}: runs the key-press scenario on exactly one shard`, () => {
      const rig = makeRig();
      const ran = [];
      for (const k of shards) {
        const { code, runs } = runStep(rig, step, { shard: shardValue(k) });
        expect(code).toBe(0);
        ran.push(...runs.map((r) => r.scenario));
      }
      const keys = Object.keys(CI_ELSEWHERE).filter((f) => CI_ELSEWHERE[f] === "keys").map((f) => f.replace(/\.mjs$/, ""));
      expect(ran.sort()).toEqual(keys.sort());
    });
  }

  it("the key-press step fails when its scenario fails", () => {
    const keysFile = Object.keys(CI_ELSEWHERE).find((f) => CI_ELSEWHERE[f] === "keys");
    const rig = makeRig([keysFile]);
    const codes = shards.map((k) => runStep(rig, KEY_STEPS[1], { shard: shardValue(k) }).code);
    expect(codes.filter((c) => c !== 0)).toHaveLength(1);
  });

  it("the build job runs the build-toolchain scenarios, and fails when one fails", () => {
    const buildFiles = Object.keys(CI_ELSEWHERE).filter((f) => CI_ELSEWHERE[f] === "build");
    const ok = runStep(makeRig(), "Run build-toolchain scenarios");
    expect(ok.code).toBe(0);
    expect(ok.runs.map((r) => `${r.scenario}.mjs`).sort()).toEqual(buildFiles.sort());
    const bad = runStep(makeRig(buildFiles), "Run build-toolchain scenarios");
    expect(bad.code).not.toBe(0);
    expect(bad.out).toContain(`FAILED: ${buildFiles[0].replace(/\.mjs$/, "")}`);
  });
});
