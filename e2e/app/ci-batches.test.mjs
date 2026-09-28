// Behavioural tests for the real-app scenario steps in .github/workflows/ci.yml:
// the step scripts are taken from the workflow and run under bash the way
// GitHub runs them (`bash -e -o pipefail`), with `node` and `xvfb-run`
// replaced by stubs that record each batch and fail the ones a test picks.
// A failing batch must not stop later batches (each would otherwise report
// "no result" to the acceptance gate), and the step must still fail.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { REPO_ROOT } from "./harness.mjs";

const WORKFLOW = join(REPO_ROOT, ".github", "workflows", "ci.yml");

/** The `run: |` block of the step with this exact name, dedented. */
function stepScript(name) {
  const lines = readFileSync(WORKFLOW, "utf8").split("\n");
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

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Run a step script with stubbed tools; `failOn` names scenario files whose batch fails. */
function runStep(name, failOn = []) {
  const dir = mkdtempSync(join(tmpdir(), "ci-batches-"));
  dirs.push(dir);
  const calls = join(dir, "calls.log");
  const stub = (file, text) => {
    writeFileSync(join(dir, file), text);
    chmodSync(join(dir, file), 0o755);
  };
  stub(
    "node",
    `#!/bin/sh
echo "$*" >> "${calls}"
for f in $FAIL_ON; do
  case " $* " in *" $f "*) exit 1 ;; esac
done
exit 0
`,
  );
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
  const res = spawnSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", stepScript(name)], {
    env: { PATH: `${dir}:${process.env.PATH}`, REPEAT: "20", FAIL_ON: failOn.join(" ") },
    encoding: "utf8",
  });
  let batches = [];
  try {
    batches = readFileSync(calls, "utf8").trim().split("\n").filter(Boolean);
  } catch {
    batches = [];
  }
  return { code: res.status, batches, stderr: res.stderr };
}

const STEPS = ["Run scenarios (Linux, virtual display)", "Run scenarios"];

describe.skipIf(process.platform === "win32")("real-app scenario steps in ci.yml", () => {
  for (const step of STEPS) {
    describe(step, () => {
      it("runs every batch and passes when all pass", () => {
        const { code, batches, stderr } = runStep(step);
        expect(stderr).toBe("");
        expect(batches.length).toBeGreaterThanOrEqual(4);
        expect(batches[0]).toContain("--repeat 20 terminal-echo.mjs");
        expect(batches.at(-1)).toContain("F09-honest-isolation.mjs");
        expect(code).toBe(0);
      });

      it("keeps running later batches after the first batch fails, then fails the step", () => {
        const all = runStep(step).batches;
        const { code, batches } = runStep(step, ["terminal-echo.mjs"]);
        expect(batches).toEqual(all);
        expect(code).not.toBe(0);
      });

      it("fails the step when only a middle batch fails", () => {
        const all = runStep(step).batches;
        const { code, batches } = runStep(step, ["N01-bridge-safety.mjs"]);
        expect(batches).toEqual(all);
        expect(code).not.toBe(0);
      });

      it("fails the step when only the last batch fails", () => {
        const all = runStep(step).batches;
        const { code, batches } = runStep(step, ["F09-honest-isolation.mjs"]);
        expect(batches).toEqual(all);
        expect(code).not.toBe(0);
      });
    });
  }
});
