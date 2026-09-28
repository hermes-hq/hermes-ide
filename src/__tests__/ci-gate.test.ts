import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error — plain ESM script without type declarations
import { evaluateGate, checkWorkflow } from "../../scripts/ci-gate.mjs";

type Needs = Record<string, { result: string; outputs?: Record<string, string> }>;

const SCRIPT = fileURLToPath(new URL("../../scripts/ci-gate.mjs", import.meta.url));

function changes(outputs: Partial<Record<"frontend" | "rust" | "ci" | "workflows" | "packaging", "true" | "false">>) {
	return {
		result: "success",
		outputs: { frontend: "false", rust: "false", ci: "false", workflows: "false", packaging: "false", ...outputs },
	};
}

function allJobs(result: string): Needs {
	return {
		frontend: { result },
		"rust-fmt": { result },
		"rust-clippy": { result },
		"rust-test": { result },
		"e2e-build": { result },
		"e2e-app": { result },
		"e2e-installers": { result },
		acceptance: { result },
		actionlint: { result },
		privacy: { result: "success" },
	};
}

describe("CI gate", () => {
	it("passes when every expected job succeeded", () => {
		const { ok } = evaluateGate({ changes: changes({ frontend: "true", rust: "true" }), ...allJobs("success") });
		expect(ok).toBe(true);
	});

	it("fails when any job was cancelled, even if nothing it checks changed", () => {
		const needs = { changes: changes({ frontend: "true" }), ...allJobs("skipped") } as Needs;
		needs.frontend = { result: "success" };
		needs["e2e-build"] = { result: "success" };
		needs["e2e-app"] = { result: "success" };
		needs["e2e-installers"] = { result: "success" };
		needs.acceptance = { result: "success" };
		needs["rust-test"] = { result: "cancelled" };
		const { ok, lines } = evaluateGate(needs);
		expect(ok).toBe(false);
		expect(lines.join("\n")).toMatch(/rust-test: cancelled/);
	});

	it("fails when an expected job was skipped", () => {
		const needs = { changes: changes({ rust: "true" }), ...allJobs("success") } as Needs;
		needs["rust-clippy"] = { result: "skipped" };
		const { ok, lines } = evaluateGate(needs);
		expect(ok).toBe(false);
		expect(lines.join("\n")).toMatch(/rust-clippy: skipped, but its inputs changed/);
	});

	it("fails when a real-app runner failed or the acceptance ledger was not checked", () => {
		const failedRunner = { changes: changes({ frontend: "true" }), ...allJobs("success") } as Needs;
		failedRunner["e2e-app"] = { result: "failure" };
		expect(evaluateGate(failedRunner).ok).toBe(false);

		// A failed test-app build leaves its shards skipped: both fail the gate.
		const failedBuild = { changes: changes({ frontend: "true" }), ...allJobs("success") } as Needs;
		failedBuild["e2e-build"] = { result: "failure" };
		failedBuild["e2e-app"] = { result: "skipped" };
		const { ok, lines } = evaluateGate(failedBuild);
		expect(ok).toBe(false);
		expect(lines.join("\n")).toMatch(/e2e-build: failure/);
		expect(lines.join("\n")).toMatch(/e2e-app: skipped, but its inputs changed/);

		for (const result of ["skipped", "cancelled"]) {
			const needs = { changes: changes({ rust: "true" }), ...allJobs("success") } as Needs;
			needs.acceptance = { result };
			const { ok, lines } = evaluateGate(needs);
			expect(ok, result).toBe(false);
			expect(lines.join("\n")).toMatch(/acceptance: /);
		}
	});

	it("the installer jobs are expected only when something that goes into an installer changed", () => {
		const frontendOnly = { changes: changes({ frontend: "true" }), ...allJobs("success") } as Needs;
		frontendOnly["e2e-installers"] = { result: "skipped" };
		for (const job of ["rust-fmt", "rust-clippy", "rust-test", "actionlint"]) frontendOnly[job] = { result: "skipped" };
		expect(evaluateGate(frontendOnly).ok).toBe(true);

		const packaging = { changes: changes({ rust: "true", packaging: "true" }), ...allJobs("success") } as Needs;
		packaging["e2e-installers"] = { result: "skipped" };
		const { ok, lines } = evaluateGate(packaging);
		expect(ok).toBe(false);
		expect(lines.join("\n")).toMatch(/e2e-installers: skipped, but its inputs changed/);
	});

	it("fails when a job failed", () => {
		const needs = { changes: changes({ frontend: "true", rust: "true" }), ...allJobs("success") } as Needs;
		needs.frontend = { result: "failure" };
		expect(evaluateGate(needs).ok).toBe(false);
	});

	it("passes a docs-only change where every job was skipped", () => {
		const { ok } = evaluateGate({ changes: changes({}), ...allJobs("skipped") });
		expect(ok).toBe(true);
	});

	it("a workflow change makes every job expected", () => {
		const needs = { changes: changes({ ci: "true" }), ...allJobs("success") } as Needs;
		needs.frontend = { result: "skipped" };
		expect(evaluateGate(needs).ok).toBe(false);
	});

	it("fails when change detection did not succeed", () => {
		const { ok } = evaluateGate({ changes: { result: "cancelled" }, ...allJobs("skipped") });
		expect(ok).toBe(false);
	});

	it("fails when given no results or no change detection", () => {
		expect(evaluateGate({}).ok).toBe(false);
		expect(evaluateGate(allJobs("success")).ok).toBe(false);
	});

	it("a job the gate does not know about must succeed", () => {
		const base = { changes: changes({}), ...allJobs("skipped") };
		expect(evaluateGate({ ...base, "new-job": { result: "skipped" } }).ok).toBe(false);
		expect(evaluateGate({ ...base, "new-job": { result: "success" } }).ok).toBe(true);
	});

	it("fails when the privacy check failed or was skipped, even on a docs-only change", () => {
		for (const result of ["failure", "skipped", "cancelled"]) {
			const needs = { changes: changes({}), ...allJobs("skipped"), privacy: { result } };
			const { ok, lines } = evaluateGate(needs);
			expect(ok, result).toBe(false);
			expect(lines.join("\n")).toMatch(/privacy: /);
		}
	});

	it("fails when a required job is missing from gate.needs", () => {
		const needs = { changes: changes({}), ...allJobs("skipped") } as Needs;
		delete needs.privacy;
		delete needs["rust-test"];
		const { ok, lines } = evaluateGate(needs);
		expect(ok).toBe(false);
		expect(lines.join("\n")).toMatch(/privacy: missing from gate.needs/);
		expect(lines.join("\n")).toMatch(/rust-test: missing from gate.needs/);
	});

	it("the CLI exits non-zero on a cancelled job and zero on success", () => {
		const bad = { changes: changes({ rust: "true" }), ...allJobs("success"), "rust-test": { result: "cancelled" } };
		const failRun = spawnSync(process.execPath, [SCRIPT], { input: JSON.stringify(bad), encoding: "utf8" });
		expect(failRun.status).toBe(1);
		expect(failRun.stdout).toContain("gate: FAIL");

		const good = { changes: changes({ rust: "true" }), ...allJobs("success") };
		const passRun = spawnSync(process.execPath, [SCRIPT], { input: JSON.stringify(good), encoding: "utf8" });
		expect(passRun.status).toBe(0);
		expect(passRun.stdout).toContain("gate: PASS");
	});
});

// A workflow shaped like ci.yml, with every job the gate knows about.
function workflow(overrides: { gateNeeds?: string; jobs?: Record<string, string> } = {}) {
	const jobs: Record<string, string> = {
		changes: `
    runs-on: ubuntu-24.04
    outputs:
      frontend: \${{ steps.filter.outputs.frontend }}
      rust: \${{ steps.filter.outputs.rust }}
      ci: \${{ steps.filter.outputs.ci }}
      workflows: \${{ steps.filter.outputs.workflows }}
      packaging: \${{ steps.filter.outputs.packaging }}
    steps:
      - uses: actions/checkout@v6
        if: github.event_name == 'pull_request'`,
		actionlint: `
    needs: changes
    if: needs.changes.outputs.workflows == 'true'`,
		frontend: `
    needs: changes
    if: needs.changes.outputs.frontend == 'true' || needs.changes.outputs.ci == 'true'`,
		"rust-fmt": `
    needs: changes
    if: needs.changes.outputs.rust == 'true' || needs.changes.outputs.ci == 'true'`,
		"rust-clippy": `
    needs: changes
    if: needs.changes.outputs.rust == 'true' || needs.changes.outputs.ci == 'true'`,
		"rust-test": `
    needs: changes
    if: needs.changes.outputs.rust == 'true' || needs.changes.outputs.ci == 'true' # comment`,
		"e2e-build": `
    needs: changes
    if: needs.changes.outputs.frontend == 'true' || needs.changes.outputs.rust == 'true' || needs.changes.outputs.ci == 'true'`,
		"e2e-installers": `
    needs: changes
    if: needs.changes.outputs.packaging == 'true'`,
		"e2e-app": `
    needs: [changes, e2e-build]
    if: needs.changes.outputs.frontend == 'true' || needs.changes.outputs.rust == 'true' || needs.changes.outputs.ci == 'true'`,
		acceptance: `
    needs: [changes, e2e-app, e2e-installers]
    if: >-
      always()
      && needs.changes.result == 'success'
      && (needs.changes.outputs.frontend == 'true'
          || needs.changes.outputs.rust == 'true'
          || needs.changes.outputs.ci == 'true')`,
		privacy: `
    runs-on: ubuntu-24.04`,
		"rust-audit": `
    needs: changes
    if: github.event_name == 'push'`,
		...overrides.jobs,
	};
	const gateNeeds =
		overrides.gateNeeds ?? "changes, actionlint, frontend, rust-fmt, rust-clippy, rust-test, e2e-build, e2e-app, e2e-installers, acceptance, privacy";
	const body = Object.entries(jobs)
		.filter(([, text]) => text !== "")
		.map(([id, text]) => `  ${id}:${text}\n`)
		.join("\n");
	return `name: CI\non:\n  pull_request:\njobs:\n${body}\n  gate:\n    if: always()\n    needs: [${gateNeeds}]\n`;
}

describe("CI gate: workflow and gate agree", () => {
	it("accepts a workflow whose jobs and skip rules match the gate", () => {
		const { ok, lines } = checkWorkflow(workflow());
		expect(lines.filter((l: string) => l.startsWith("FAIL"))).toEqual([]);
		expect(ok).toBe(true);
	});

	it("fails when a job is added to the workflow but not to gate.needs", () => {
		const { ok, lines } = checkWorkflow(workflow({ jobs: { "new-job": "\n    runs-on: ubuntu-24.04" } }));
		expect(ok).toBe(false);
		expect(lines.join("\n")).toMatch(/new-job: not in gate.needs/);
	});

	it("fails when a gated job skips on fewer changes than the gate expects", () => {
		const narrower = "\n    needs: changes\n    if: needs.changes.outputs.rust == 'true'";
		const { ok, lines } = checkWorkflow(workflow({ jobs: { "rust-test": narrower } }));
		expect(ok).toBe(false);
		expect(lines.join("\n")).toMatch(/rust-test: runs when rust changed, but ci-gate.mjs expects rust\/ci/);
	});

	it("fails when a gated job has a condition the gate cannot model", () => {
		const odd = "\n    needs: changes\n    if: github.event_name == 'push' && needs.changes.outputs.rust == 'true'";
		const { ok, lines } = checkWorkflow(workflow({ jobs: { "rust-fmt": odd } }));
		expect(ok).toBe(false);
		expect(lines.join("\n")).toMatch(/rust-fmt: .*not a plain OR/);
	});

	it("fails when an always-required job gains a condition", () => {
		const { ok, lines } = checkWorkflow(workflow({ jobs: { privacy: "\n    if: github.event_name == 'push'" } }));
		expect(ok).toBe(false);
		expect(lines.join("\n")).toMatch(/privacy: has `if:/);
	});

	it("fails when gate.needs names a job that does not exist, or a known job is removed", () => {
		const extra = checkWorkflow(workflow({ gateNeeds: "changes, actionlint, frontend, rust-fmt, rust-clippy, rust-test, e2e-build, e2e-app, e2e-installers, acceptance, privacy, ghost" }));
		expect(extra.ok).toBe(false);
		expect(extra.lines.join("\n")).toMatch(/ghost/);

		const removed = checkWorkflow(workflow({ jobs: { actionlint: "" } }));
		expect(removed.ok).toBe(false);
		expect(removed.lines.join("\n")).toMatch(/actionlint: listed in ci-gate.mjs but not a job/);
	});

	it("fails when a trigger is not an output of the changes job", () => {
		const changesWithout = `
    outputs:
      frontend: x
      rust: x
      ci: x`;
		const { ok, lines } = checkWorkflow(workflow({ jobs: { changes: changesWithout } }));
		expect(ok).toBe(false);
		expect(lines.join("\n")).toMatch(/actionlint: trigger `workflows` is not an output/);
	});

	it("fails when an ungated job is put in the gate, or the gate does not always run", () => {
		const gated = checkWorkflow(
			workflow({ gateNeeds: "changes, actionlint, frontend, rust-fmt, rust-clippy, rust-test, e2e-build, e2e-app, e2e-installers, acceptance, privacy, rust-audit" }),
		);
		expect(gated.ok).toBe(false);
		expect(gated.lines.join("\n")).toMatch(/rust-audit: listed as UNGATED/);

		const notAlways = checkWorkflow(workflow().replace("    if: always()\n    needs: [", "    needs: ["));
		expect(notAlways.ok).toBe(false);
		expect(notAlways.lines.join("\n")).toMatch(/gate: must have `if: always\(\)`/);
	});

	it("the CLI's --workflow mode exits non-zero on a drifted workflow and zero on a matching one", () => {
		const dir = mkdtempSync(join(tmpdir(), "ci-gate-"));
		const good = join(dir, "good.yml");
		const bad = join(dir, "bad.yml");
		writeFileSync(good, workflow());
		writeFileSync(bad, workflow({ jobs: { "new-job": "\n    runs-on: ubuntu-24.04" } }));

		const passRun = spawnSync(process.execPath, [SCRIPT, "--workflow", good], { encoding: "utf8" });
		expect(passRun.status).toBe(0);
		expect(passRun.stdout).toContain("workflow: gate and jobs agree");

		const failRun = spawnSync(process.execPath, [SCRIPT, "--workflow", bad], { encoding: "utf8" });
		expect(failRun.status).toBe(1);
		expect(failRun.stdout).toContain("new-job: not in gate.needs");
	});
});
