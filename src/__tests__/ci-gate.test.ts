import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
// @ts-expect-error — plain ESM script without type declarations
import { evaluateGate } from "../../scripts/ci-gate.mjs";

type Needs = Record<string, { result: string; outputs?: Record<string, string> }>;

const SCRIPT = fileURLToPath(new URL("../../scripts/ci-gate.mjs", import.meta.url));

function changes(outputs: Partial<Record<"frontend" | "rust" | "ci", "true" | "false">>) {
	return { result: "success", outputs: { frontend: "false", rust: "false", ci: "false", ...outputs } };
}

function allJobs(result: string): Needs {
	return {
		frontend: { result },
		"rust-fmt": { result },
		"rust-clippy": { result },
		"rust-test": { result },
		"e2e-app": { result },
		acceptance: { result },
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
		needs["e2e-app"] = { result: "success" };
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

		for (const result of ["skipped", "cancelled"]) {
			const needs = { changes: changes({ rust: "true" }), ...allJobs("success") } as Needs;
			needs.acceptance = { result };
			const { ok, lines } = evaluateGate(needs);
			expect(ok, result).toBe(false);
			expect(lines.join("\n")).toMatch(/acceptance: /);
		}
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
