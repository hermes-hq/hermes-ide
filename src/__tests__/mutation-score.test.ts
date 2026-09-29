import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error — plain ESM script without type declarations
import { mergeOutcomes, scoreOutcomes } from "../../scripts/mutation-score.mjs";

const SCRIPT = fileURLToPath(new URL("../../scripts/mutation-score.mjs", import.meta.url));

// Same shape as cargo-mutants' mutants.out/outcomes.json.
function mutant(summary: string, name: string) {
	return {
		scenario: { Mutant: { name, package: "hermes-ide", file: "src/lib.rs", replacement: "true", genre: "FnValue" } },
		summary,
	};
}

function outcomes(...rows: ReturnType<typeof mutant>[]) {
	return { outcomes: [{ scenario: "Baseline", summary: "Success" }, ...rows] };
}

describe("mutation score", () => {
	it("scores the shards of one night together (cargo-mutants --shard k/n)", () => {
		const r = scoreOutcomes(
			mergeOutcomes([outcomes(mutant("CaughtMutant", "a"), mutant("MissedMutant", "b")), outcomes(mutant("CaughtMutant", "c"), mutant("Timeout", "d")), {}]),
			80,
		);
		expect(r.counts).toEqual({ caught: 2, missed: 1, timeout: 1, unviable: 0 });
		expect(r.percent).toBe(75);
		expect(r.ok).toBe(false);
	});

	it("counts caught and timed-out mutants as killed and leaves unviable ones out", () => {
		const r = scoreOutcomes(
			outcomes(
				mutant("CaughtMutant", "a"),
				mutant("CaughtMutant", "b"),
				mutant("CaughtMutant", "c"),
				mutant("Timeout", "d"),
				mutant("MissedMutant", "src/lib.rs:9:5: replace f -> bool with true"),
				mutant("Unviable", "e"),
			),
			80,
		);
		expect(r.counts).toEqual({ caught: 3, missed: 1, timeout: 1, unviable: 1 });
		expect(r.viable).toBe(5);
		expect(r.killed).toBe(4);
		expect(r.percent).toBe(80);
		expect(r.ok).toBe(true);
		expect(r.missed).toEqual(["src/lib.rs:9:5: replace f -> bool with true"]);
	});

	it("fails below the minimum", () => {
		const r = scoreOutcomes(outcomes(mutant("CaughtMutant", "a"), mutant("MissedMutant", "b"), mutant("MissedMutant", "c")), 80);
		expect(r.percent).toBe(33.3);
		expect(r.ok).toBe(false);
	});

	it("passes when there were no viable mutants", () => {
		expect(scoreOutcomes(outcomes(mutant("Unviable", "a")), 80).ok).toBe(true);
		expect(scoreOutcomes({ outcomes: [] }, 80).ok).toBe(true);
	});

	it("the CLI prints missed mutants and exits non-zero under the minimum", () => {
		const dir = mkdtempSync(join(tmpdir(), "mutation-score-"));
		try {
			const file = join(dir, "outcomes.json");
			writeFileSync(file, JSON.stringify(outcomes(mutant("CaughtMutant", "a"), mutant("MissedMutant", "missed-one"))));
			const fail = spawnSync(process.execPath, [SCRIPT, "--min", "80", file], { encoding: "utf8" });
			expect(fail.status).toBe(1);
			expect(fail.stdout).toContain("MISSED missed-one");
			expect(fail.stdout).toMatch(/mutation score: 50% .* FAIL/);

			const pass = spawnSync(process.execPath, [SCRIPT, file, "--min", "50"], { encoding: "utf8" });
			expect(pass.status).toBe(0);
			expect(pass.stdout).toMatch(/PASS/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
