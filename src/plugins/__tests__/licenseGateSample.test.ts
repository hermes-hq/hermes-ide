// @vitest-environment jsdom
/**
 * F36 — the sample plugin (docs/examples/plugins/license-gate) runs against
 * the real PluginRuntime and plugin API v2: its bundle is executed exactly
 * as the loader would (it registers itself on window.__hermesPlugins), then
 * activated and driven with session events and diffs.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import manifest from "../../../docs/examples/plugins/license-gate/hermes-plugin.json";
import { PluginRuntime, type PluginModule } from "../PluginRuntime";
import type { PluginManifest } from "../types";
import { _resetPluginIdentityForTests } from "../identity";
import { identityInvoke } from "./identityMock";
import { _resetSessionEventStoreForTest, dispatchSessionEvent } from "../../agent/contract/sessionEventStore";
import { _resetInboxForTest, listInboxItems } from "../../agent/contract/inbox";
import { _resetReviewChecksForTest, listReviewChecks, reviewInputFromPatch, runReviewChecks } from "../../agent/contract/reviewChecks";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import { invoke } from "@tauri-apps/api/core";
const mockInvoke = vi.mocked(invoke);

const SAMPLE = "../../../docs/examples/plugins/license-gate/index.js";
const FEATURE = "---\nslug: search-index\ntrack: Full\nphase: implement\ngate: none\n---\n";

const patchAdding = (file: string, ...lines: string[]) =>
	[`diff --git a/${file} b/${file}`, "new file mode 100644", "--- /dev/null", `+++ b/${file}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`), ""].join("\n");

let features: { slug: string; text: string | null; error: string | null }[] = [];

beforeAll(async () => {
	await import(/* @vite-ignore */ SAMPLE);
});

beforeEach(() => {
	mockInvoke.mockReset();
	mockInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
		if (cmd === "plugin_read_feature_tracks") return features;
		return identityInvoke(cmd, args);
	});
	features = [{ slug: "search-index", text: FEATURE, error: null }];
	_resetPluginIdentityForTests();
	_resetSessionEventStoreForTest();
	_resetInboxForTest(() => 1);
	_resetReviewChecksForTest();
});

async function startSample(v2 = true, permissions?: string[]) {
	const exports = window.__hermesPlugins?.["example.license-gate"];
	if (!exports) throw new Error("the sample bundle did not register itself");
	const module: PluginModule = {
		manifest: { ...(manifest as PluginManifest), ...(permissions ? { permissions: permissions as PluginManifest["permissions"] } : {}) },
		activate: exports.activate,
	};
	const runtime = new PluginRuntime(
		{
			onPanelToggle: vi.fn(),
			onPanelShow: vi.fn(),
			onPanelHide: vi.fn(),
			onToast: vi.fn(),
			onStatusBarUpdate: vi.fn(),
			onSessionWorkingDirectory: (id) => (id.startsWith("s") ? "/work/repo" : null),
		},
		{ pluginApiV2: v2 },
	);
	runtime.register(module);
	await runtime.activateStartupPlugins();
	return runtime;
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe("License Gate sample plugin", () => {
	it("declares API v2 and the four v2 permissions", () => {
		expect(manifest.apiVersion).toBe(2);
		expect([...manifest.permissions].sort()).toEqual(["features.read", "inbox.raise", "review.checks", "sessions.read"]);
	});

	it("registers the License scan check", async () => {
		const runtime = await startSample();
		expect(runtime.getAllPlugins()[0]).toMatchObject({ status: "active", apiVersion: 2 });
		expect(listReviewChecks().map((c) => [c.key, c.title])).toEqual([["example.license-gate/license-scan", "License scan"]]);
	});

	it("fails on a copyleft license, raises a gate naming the feature track, and counts the turns since the last scan", async () => {
		await startSample();
		dispatchSessionEvent("s1", { type: "turn_start", at: 1, n: 1 });
		dispatchSessionEvent("s1", { type: "turn_end", at: 2, n: 1 });
		dispatchSessionEvent("s1", { type: "turn_start", at: 3, n: 2 });
		dispatchSessionEvent("s1", { type: "turn_end", at: 4, n: 2 });
		await flush();
		const patch = patchAdding("vendor/copyleft.js", "// SPDX-License-Identifier: GPL-3.0-only", "module.exports = 1;", "/* LGPL-2.1+ */");
		const [run] = await runReviewChecks(reviewInputFromPatch("s1", 2, patch));
		expect(run).toMatchObject({ key: "example.license-gate/license-scan", outcome: "fail", summary: "2 copyleft licenses found (2 turns since the last scan)" });
		expect(run.findings).toEqual([
			{ file: "vendor/copyleft.js", line: 1, message: "GPL-3.0-only: needs a license review before this lands" },
			{ file: "vendor/copyleft.js", line: 3, message: "LGPL-2.1: needs a license review before this lands" },
		]);
		expect(listInboxItems()).toEqual([
			expect.objectContaining({
				kind: "gate",
				sessionId: "s1",
				source: "plugin:example.license-gate",
				detail: "License review: GPL-3.0-only in vendor/copyleft.js (feature search-index, implement)",
			}),
		]);
	});

	it("passes a clean diff, and a clean scan settles the gate it raised for that session", async () => {
		await startSample();
		await runReviewChecks(reviewInputFromPatch("s1", 1, patchAdding("LICENSE", "GNU AFFERO GENERAL PUBLIC LICENSE")));
		await runReviewChecks(reviewInputFromPatch("s2", 1, patchAdding("COPYING", "AGPL-3.0-or-later")));
		expect(listInboxItems().map((i) => [i.sessionId, i.detail])).toEqual([
			["s1", "License review: AGPL license text in LICENSE (feature search-index, implement)"],
			["s2", "License review: AGPL-3.0-or-later in COPYING (feature search-index, implement)"],
		]);
		const [clean] = await runReviewChecks(reviewInputFromPatch("s1", 2, patchAdding("src/ok.ts", "// SPDX-License-Identifier: MIT")));
		expect(clean).toMatchObject({ outcome: "pass", summary: "No copyleft license in 1 changed file" });
		expect(listInboxItems().map((i) => i.sessionId)).toEqual(["s2"]);
	});

	it("still gates when the feature tracks cannot be read, it just says less", async () => {
		await startSample();
		features = [];
		await runReviewChecks(reviewInputFromPatch("s1", 1, patchAdding("a.c", "/* SPDX-License-Identifier: GPL-2.0 */")));
		expect(listInboxItems()[0].detail).toBe("License review: GPL-2.0 in a.c");
	});

	it("ignores deleted files and binary files", async () => {
		await startSample();
		const patch = [
			"diff --git a/old.c b/old.c",
			"deleted file mode 100644",
			"--- a/old.c",
			"+++ /dev/null",
			"@@ -1 +0,0 @@",
			"-// GPL-3.0",
			"diff --git a/x.bin b/x.bin",
			"Binary files a/x.bin and b/x.bin differ",
		].join("\n");
		const [run] = await runReviewChecks(reviewInputFromPatch("s1", 1, patch));
		expect(run.outcome).toBe("pass");
		expect(listInboxItems()).toEqual([]);
	});

	it("is refused, and registers nothing, when API v2 is not turned on", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const runtime = await startSample(false);
		expect(runtime.getAllPlugins()[0]).toMatchObject({ status: "error" });
		expect(listReviewChecks()).toEqual([]);
	});

	it("negative control: without inbox.raise its failed scan is an error and no gate appears", async () => {
		await startSample(true, ["sessions.read", "features.read", "review.checks"]);
		const [run] = await runReviewChecks(reviewInputFromPatch("s1", 1, patchAdding("a.c", "GPL-3.0")));
		expect(run.outcome).toBe("error");
		expect(run.summary).toMatch(/inbox.raise/);
		expect(listInboxItems()).toEqual([]);
	});
});
