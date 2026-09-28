/**
 * F36 — plugin API v2, exercised through the real PluginRuntime: which
 * plugins get which API, the deprecation of v1, the normalised agent events,
 * the inbox, the read-only feature tracks and review checks, and what a
 * plugin leaves behind when it is deactivated (nothing).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PluginRuntime, type PluginModule } from "../PluginRuntime";
import type { HermesPluginAPI, PluginAPICallbacks } from "../PluginAPI";
import { _resetPluginIdentityForTests } from "../identity";
import { identityInvoke, tokenFor } from "./identityMock";
import { resolvePluginApi, MAX_PLUGIN_INBOX_ITEMS, MAX_PLUGIN_INBOX_DETAIL, type PluginSessionEvent, type PluginStatusChange } from "../apiV2";
import { _resetSessionEventStoreForTest, dispatchSessionEvent, getSessionEventSnapshot } from "../../agent/contract/sessionEventStore";
import { _resetInboxForTest, listInboxItems, raiseInboxItem } from "../../agent/contract/inbox";
import { _resetReviewChecksForTest, listReviewChecks, reviewInputFromPatch, runReviewChecks } from "../../agent/contract/reviewChecks";
import type { PluginPermission } from "../types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import { invoke } from "@tauri-apps/api/core";
const mockInvoke = vi.mocked(invoke);

const FEATURE_MD = "---\nslug: search-index\ntrack: Full\nphase: plan\ngate: waiting\ndone_when:\n  - npm test\n---\nIndex the docs.\n";
const featureFiles = [
	{ slug: "broken", text: "---\nslug: broken\ntrack: Huge\n---\n", error: null },
	{ slug: "search-index", text: FEATURE_MD, error: null },
	{ slug: "too-big", text: null, error: "feature.md is larger than 64 KB" },
];

function callbacks(): PluginAPICallbacks {
	return {
		onPanelToggle: vi.fn(),
		onPanelShow: vi.fn(),
		onPanelHide: vi.fn(),
		onToast: vi.fn(),
		onStatusBarUpdate: vi.fn(),
		onSessionWorkingDirectory: (id) => (id === "s1" ? "/work/repo" : null),
	};
}

function plugin(id: string, opts: { apiVersion?: unknown; permissions?: PluginPermission[] } = {}) {
	const holder: { api: HermesPluginAPI | null } = { api: null };
	const module: PluginModule = {
		manifest: {
			id,
			name: id,
			version: "1.0.0",
			description: "",
			author: "test",
			activationEvents: [{ type: "onStartup" }],
			contributes: {},
			permissions: opts.permissions ?? ["sessions.read", "inbox.raise", "features.read", "review.checks"],
			...(opts.apiVersion === undefined ? {} : { apiVersion: opts.apiVersion as number }),
		},
		activate: (api) => {
			holder.api = api;
		},
	};
	return { module, holder };
}

async function start(v2: boolean, ...plugins: PluginModule[]) {
	const runtime = new PluginRuntime(callbacks(), { pluginApiV2: v2 });
	for (const p of plugins) runtime.register(p);
	await runtime.activateStartupPlugins();
	return runtime;
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

beforeEach(() => {
	mockInvoke.mockReset();
	mockInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
		if (cmd === "plugin_read_feature_tracks") return featureFiles;
		return identityInvoke(cmd, args);
	});
	_resetPluginIdentityForTests();
	_resetSessionEventStoreForTest();
	_resetInboxForTest(() => 1000);
	_resetReviewChecksForTest();
});

afterEach(() => vi.restoreAllMocks());

describe("resolvePluginApi", () => {
	it("flag off: v1 for everyone, no deprecation, v2 and unknown versions refused", () => {
		expect(resolvePluginApi(undefined, false)).toEqual({ ok: true, version: 1, deprecated: false });
		expect(resolvePluginApi(1, false)).toEqual({ ok: true, version: 1, deprecated: false });
		expect(resolvePluginApi(2, false)).toMatchObject({ ok: false, reason: "needs-flag" });
		expect(resolvePluginApi(3, false)).toMatchObject({ ok: false, reason: "unsupported" });
	});

	it("flag on: v1 works and is deprecated (except built-ins), v2 works, others refused", () => {
		expect(resolvePluginApi(undefined, true)).toEqual({ ok: true, version: 1, deprecated: true });
		expect(resolvePluginApi(undefined, true, true)).toEqual({ ok: true, version: 1, deprecated: false });
		expect(resolvePluginApi(2, true)).toEqual({ ok: true, version: 2, deprecated: false });
		for (const bad of [3, 0, "2", 1.5]) expect(resolvePluginApi(bad, true)).toMatchObject({ ok: false, reason: "unsupported" });
	});
});

describe("PluginRuntime and API versions", () => {
	it("a v1 plugin keeps working with v2 on, with one deprecation warning and no v2 namespaces", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const v1 = plugin("old.plugin");
		const runtime = await start(true, v1.module);
		expect(runtime.getAllPlugins()[0]).toMatchObject({ status: "active", apiVersion: 1, error: null });
		const api = v1.holder.api!;
		expect(api.apiVersion).toBe(1);
		expect(api.inbox).toBeUndefined();
		expect(api.features).toBeUndefined();
		expect(api.review).toBeUndefined();
		expect(api.agents.onEvent).toBeUndefined();
		expect(typeof api.agents.watchTranscript).toBe("function");
		const deprecations = warn.mock.calls.filter((c) => String(c[0]).includes("plugin API v1, which is deprecated"));
		expect(deprecations).toHaveLength(1);
		expect(String(deprecations[0][0])).toContain("2.2");
	});

	it("with the flag off a v1 plugin is not warned about, and a v2 plugin is refused before it runs", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		const v1 = plugin("old.plugin");
		const v2 = plugin("new.plugin", { apiVersion: 2 });
		const runtime = await start(false, v1.module, v2.module);
		const [a, b] = runtime.getAllPlugins();
		expect(a).toMatchObject({ status: "active", apiVersion: 1 });
		expect(b).toMatchObject({ status: "error", apiVersion: null });
		expect(b.error).toMatch(/needs plugin API v2/);
		expect(v2.holder.api).toBeNull();
		expect(warn.mock.calls.some((c) => String(c[0]).includes("deprecated"))).toBe(false);
		// Refused before a token was minted for it.
		expect(mockInvoke.mock.calls.some(([cmd, args]) => cmd === "issue_plugin_token" && (args as { pluginId: string }).pluginId === "new.plugin")).toBe(false);
	});

	it("a built-in plugin is never reported as deprecated", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const builtin = plugin("hermes.builtin");
		const runtime = new PluginRuntime(callbacks(), { pluginApiV2: true });
		runtime.register(builtin.module, { builtin: true });
		await runtime.activateStartupPlugins();
		expect(builtin.holder.api?.apiVersion).toBe(1);
		expect(warn.mock.calls.some((c) => String(c[0]).includes("deprecated"))).toBe(false);
	});

	it("a plugin asking for an API this Hermes does not know is refused", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const p = plugin("future.plugin", { apiVersion: 3 });
		const runtime = await start(true, p.module);
		expect(runtime.getAllPlugins()[0].error).toMatch(/needs plugin API 3; this version of Hermes supports v1 and v2/);
	});

	it("v2 still offers watchTranscript but warns once that it is deprecated", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		mockInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
			if (cmd === "start_transcript_watcher") throw new Error("no transcript");
			return identityInvoke(cmd, args);
		});
		const p = plugin("new.plugin", { apiVersion: 2 });
		await start(true, p.module);
		await p.holder.api!.agents.watchTranscript("s1", () => {});
		await p.holder.api!.agents.watchTranscript("s1", () => {});
		expect(warn.mock.calls.filter((c) => String(c[0]).includes("watchTranscript is deprecated"))).toHaveLength(1);
	});
});

describe("agents: the same events for every agent", () => {
	it("onEvent delivers every session's events as frozen copies, after the store has them", async () => {
		const p = plugin("obs", { apiVersion: 2, permissions: ["sessions.read"] });
		await start(true, p.module);
		const seen: PluginSessionEvent[] = [];
		p.holder.api!.agents.onEvent!((e) => {
			// Delivered outside dispatch: the store already holds the event.
			const events = getSessionEventSnapshot(e.sessionId).events;
			expect(events[events.length - 1]).toMatchObject({ type: e.event.type });
			seen.push(e);
		});
		dispatchSessionEvent("claude-1", { type: "turn_start", at: 1, n: 1, source: "hook:claude" });
		dispatchSessionEvent("codex-1", { type: "status", at: 2, status: { kind: "needs_approval", confidence: "signal", detail: "rm -rf build" } });
		expect(seen).toHaveLength(0);
		await flush();
		expect(seen).toEqual([
			{ sessionId: "claude-1", event: { type: "turn_start", at: 1, n: 1, source: "hook:claude" } },
			{ sessionId: "codex-1", event: { type: "status", at: 2, status: { kind: "needs_approval", confidence: "signal", detail: "rm -rf build" } } },
		]);
		expect(Object.isFrozen(seen[1].event)).toBe(true);
		expect(() => {
			(seen[1].event as { at: number }).at = 5;
		}).toThrow();
		expect(getSessionEventSnapshot("codex-1").events[0].at).toBe(2);
	});

	it("onStatusChange reports transitions only, with the previous status", async () => {
		const p = plugin("obs", { apiVersion: 2, permissions: ["sessions.read"] });
		await start(true, p.module);
		const seen: PluginStatusChange[] = [];
		p.holder.api!.agents.onStatusChange!((c) => seen.push(c));
		const working = { kind: "working", confidence: "exact", detail: "" } as const;
		dispatchSessionEvent("s1", { type: "status", at: 1, status: working });
		dispatchSessionEvent("s1", { type: "turn_end", at: 2, n: 1 });
		dispatchSessionEvent("s1", { type: "status", at: 3, status: working });
		dispatchSessionEvent("s1", { type: "exit", at: 4, code: 0, signal: null });
		await flush();
		expect(seen.map((c) => [c.previous.kind, c.status.kind])).toEqual([
			["idle", "working"],
			["working", "exited"],
		]);
	});

	it("getStatus is the store's snapshot, detached from it", async () => {
		const p = plugin("obs", { apiVersion: 2, permissions: ["sessions.read"] });
		await start(true, p.module);
		dispatchSessionEvent("s1", { type: "identity", at: 1, vendorSessionId: "v1", model: "m", permissionMode: null });
		const state = p.holder.api!.agents.getStatus!("s1");
		expect(state).toMatchObject({ sessionId: "s1", version: 1, identity: { vendorSessionId: "v1", model: "m" }, status: { kind: "idle" } });
		expect(Object.isFrozen(state.identity)).toBe(true);
		expect(p.holder.api!.agents.getStatus!("never").version).toBe(0);
	});

	it("a listener that throws hurts nobody", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const a = plugin("a", { apiVersion: 2, permissions: ["sessions.read"] });
		const b = plugin("b", { apiVersion: 2, permissions: ["sessions.read"] });
		await start(true, a.module, b.module);
		const got: string[] = [];
		a.holder.api!.agents.onEvent!(() => {
			throw new Error("plugin bug");
		});
		b.holder.api!.agents.onEvent!((e) => got.push(e.sessionId));
		expect(() => dispatchSessionEvent("s1", { type: "attention", at: 1, detail: "x" })).not.toThrow();
		await flush();
		expect(got).toEqual(["s1"]);
	});

	it("needs sessions.read", async () => {
		const p = plugin("np", { apiVersion: 2, permissions: ["inbox.raise"] });
		await start(true, p.module);
		expect(() => p.holder.api!.agents.onEvent!(() => {})).toThrow(/sessions.read/);
		expect(() => p.holder.api!.agents.getStatus!("s1")).toThrow(/sessions.read/);
	});
});

describe("inbox", () => {
	it("raise stamps the plugin as source, ignores a claimed source and dedupes", async () => {
		const p = plugin("acme.gate", { apiVersion: 2 });
		await start(true, p.module);
		const inbox = p.holder.api!.inbox!;
		const item = inbox.raise({ kind: "gate", sessionId: "s1", detail: "  Approve   the plan  ", source: "status" } as never);
		expect(item).toMatchObject({ kind: "gate", sessionId: "s1", detail: "Approve the plan", source: "plugin:acme.gate", createdAt: 1000 });
		expect(inbox.raise({ kind: "gate", sessionId: "s1", detail: "Approve the plan" }).id).toBe(item.id);
		expect(listInboxItems()).toHaveLength(1);
		const workspace = inbox.raise({ kind: "error", detail: "x".repeat(500) });
		expect(workspace.sessionId).toBeNull();
		expect(workspace.detail).toHaveLength(MAX_PLUGIN_INBOX_DETAIL);
	});

	it("validates what it is given", async () => {
		const p = plugin("acme.gate", { apiVersion: 2 });
		await start(true, p.module);
		const inbox = p.holder.api!.inbox!;
		expect(() => inbox.raise({ kind: "urgent", detail: "x" } as never)).toThrow(/unknown inbox kind/);
		expect(() => inbox.raise({ kind: "gate", detail: "  " })).toThrow(/detail/);
		expect(() => inbox.raise({ kind: "gate", detail: "x", sessionId: 42 } as never)).toThrow(/sessionId/);
		expect(() => inbox.raise(null as never)).toThrow();
		expect(listInboxItems()).toHaveLength(0);
	});

	it("a plugin sees and resolves only its own items", async () => {
		const a = plugin("a", { apiVersion: 2 });
		const b = plugin("b", { apiVersion: 2 });
		await start(true, a.module, b.module);
		const system = raiseInboxItem({ kind: "blocked", sessionId: "s1", detail: "Bash: ls", source: "status" });
		const mine = a.holder.api!.inbox!.raise({ kind: "gate", detail: "a's gate" });
		const theirs = b.holder.api!.inbox!.raise({ kind: "gate", detail: "b's gate" });
		expect(a.holder.api!.inbox!.list().map((i) => i.id)).toEqual([mine.id]);
		expect(a.holder.api!.inbox!.resolve(theirs.id)).toBe(false);
		expect(a.holder.api!.inbox!.resolve(system.id)).toBe(false);
		expect(a.holder.api!.inbox!.resolve("inbox-999")).toBe(false);
		expect(a.holder.api!.inbox!.resolve(mine.id)).toBe(true);
		expect(listInboxItems().map((i) => i.id)).toEqual([system.id, theirs.id]);
	});

	it("caps the open items of one plugin", async () => {
		const p = plugin("spammy", { apiVersion: 2 });
		await start(true, p.module);
		for (let i = 0; i < MAX_PLUGIN_INBOX_ITEMS; i++) p.holder.api!.inbox!.raise({ kind: "ready", detail: `item ${i}` });
		expect(() => p.holder.api!.inbox!.raise({ kind: "ready", detail: "one more" })).toThrow(/20 open inbox items/);
		// The same item again is not "one more".
		expect(p.holder.api!.inbox!.raise({ kind: "ready", detail: "item 3" }).detail).toBe("item 3");
	});

	it("needs inbox.raise", async () => {
		const p = plugin("np", { apiVersion: 2, permissions: ["sessions.read"] });
		await start(true, p.module);
		expect(() => p.holder.api!.inbox!.raise({ kind: "gate", detail: "x" })).toThrow(/inbox.raise/);
		expect(() => p.holder.api!.inbox!.list()).toThrow(/inbox.raise/);
		expect(listInboxItems()).toHaveLength(0);
	});
});

describe("features (read-only)", () => {
	it("lists the tracks of the session's repository through the token-bound command", async () => {
		const p = plugin("reader", { apiVersion: 2 });
		await start(true, p.module);
		const tracks = await p.holder.api!.features!.list("s1");
		const call = mockInvoke.mock.calls.find(([cmd]) => cmd === "plugin_read_feature_tracks");
		expect(call?.[1]).toEqual({ directory: "/work/repo", pluginToken: tokenFor("reader") });
		expect(tracks.map((t) => [t.slug, t.ok])).toEqual([
			["broken", false],
			["search-index", true],
			["too-big", false],
		]);
		const good = tracks[1];
		if (!good.ok) throw new Error("expected a readable track");
		expect(good.meta).toMatchObject({ slug: "search-index", track: "Full", phase: "plan", gate: "waiting", doneWhen: ["npm test"] });
		expect(good.body.trim()).toBe("Index the docs.");
		expect(tracks[0]).toMatchObject({ ok: false, line: 3 });
		expect(tracks[2]).toMatchObject({ ok: false, error: "feature.md is larger than 64 KB", line: null });
		expect(Object.isFrozen(good.meta)).toBe(true);
		expect(await p.holder.api!.features!.get("s1", "search-index")).toEqual(good);
		expect(await p.holder.api!.features!.get("s1", "nope")).toBeNull();
	});

	it("refuses an unknown session and a plugin without features.read", async () => {
		const p = plugin("reader", { apiVersion: 2 });
		const np = plugin("np", { apiVersion: 2, permissions: ["sessions.read"] });
		await start(true, p.module, np.module);
		await expect(p.holder.api!.features!.list("ghost")).rejects.toThrow(/no session/);
		await expect(np.holder.api!.features!.list("s1")).rejects.toThrow(/features.read/);
		expect(mockInvoke.mock.calls.some(([cmd]) => cmd === "plugin_read_feature_tracks")).toBe(false);
	});

	it("offers no way to write", async () => {
		const p = plugin("reader", { apiVersion: 2 });
		await start(true, p.module);
		expect(Object.keys(p.holder.api!.features!).sort()).toEqual(["get", "list"]);
	});
});

describe("review checks", () => {
	it("registers under the plugin, runs over a diff and goes away with the plugin", async () => {
		const p = plugin("acme.lint", { apiVersion: 2 });
		const runtime = await start(true, p.module);
		const offered: unknown[] = [];
		p.holder.api!.review!.registerCheck({
			id: "size",
			title: "Size budget",
			run(input) {
				offered.push(this);
				const added = input.files.reduce((n, f) => n + f.added.length, 0);
				return { outcome: added > 1 ? "warn" : "pass", summary: `${added} lines`, findings: [] };
			},
		});
		expect(listReviewChecks().map((c) => [c.key, c.owner, c.title])).toEqual([["acme.lint/size", "plugin:acme.lint", "Size budget"]]);
		const patch = "--- a/x\n+++ b/x\n@@ -1 +1,2 @@\n-a\n+b\n+c\n";
		const [run] = await runReviewChecks(reviewInputFromPatch("s1", 2, patch));
		expect(run).toMatchObject({ key: "acme.lint/size", outcome: "warn", summary: "2 lines" });
		expect(offered).toHaveLength(1);

		await runtime.deactivate("acme.lint");
		expect(listReviewChecks()).toEqual([]);
	});

	it("needs review.checks and a valid definition", async () => {
		const np = plugin("np", { apiVersion: 2, permissions: ["sessions.read"] });
		const p = plugin("p", { apiVersion: 2 });
		await start(true, np.module, p.module);
		expect(() => np.holder.api!.review!.registerCheck({ id: "x", title: "X", run: () => ({ outcome: "pass", summary: "", findings: [] }) })).toThrow(/review.checks/);
		expect(() => p.holder.api!.review!.registerCheck({ id: "X!", title: "X", run: () => ({ outcome: "pass", summary: "", findings: [] }) })).toThrow(/lowercase/);
		expect(listReviewChecks()).toEqual([]);
	});
});

describe("deactivation leaves nothing behind", () => {
	it("event listeners stop, inbox items are resolved, checks are removed", async () => {
		const p = plugin("acme.all", { apiVersion: 2 });
		const other = plugin("other", { apiVersion: 2 });
		const runtime = await start(true, p.module, other.module);
		const seen: string[] = [];
		p.holder.api!.agents.onEvent!((e) => seen.push(e.event.type));
		p.holder.api!.inbox!.raise({ kind: "gate", sessionId: "s1", detail: "mine" });
		const kept = other.holder.api!.inbox!.raise({ kind: "gate", sessionId: "s1", detail: "theirs" });
		p.holder.api!.review!.registerCheck({ id: "c", title: "C", run: () => ({ outcome: "pass", summary: "", findings: [] }) });

		await runtime.deactivate("acme.all");
		dispatchSessionEvent("s1", { type: "attention", at: 1, detail: "x" });
		await flush();
		expect(seen).toEqual([]);
		expect(listInboxItems().map((i) => i.id)).toEqual([kept.id]);
		expect(listReviewChecks()).toEqual([]);
	});

	it("a plugin whose activate() throws leaves nothing behind either", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const module: PluginModule = {
			manifest: {
				id: "crashy",
				name: "crashy",
				version: "1",
				description: "",
				author: "t",
				apiVersion: 2,
				activationEvents: [{ type: "onStartup" }],
				contributes: {},
				permissions: ["inbox.raise", "review.checks"],
			},
			activate(api) {
				api.inbox!.raise({ kind: "gate", detail: "half-started" });
				api.review!.registerCheck({ id: "c", title: "C", run: () => ({ outcome: "pass", summary: "", findings: [] }) });
				throw new Error("activation failed");
			},
		};
		const runtime = await start(true, module);
		expect(runtime.getAllPlugins()[0]).toMatchObject({ status: "error", error: "activation failed" });
		expect(listInboxItems()).toEqual([]);
		expect(listReviewChecks()).toEqual([]);
	});
});
