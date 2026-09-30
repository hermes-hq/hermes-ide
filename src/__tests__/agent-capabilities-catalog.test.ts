/**
 * The catalog's capabilities blocks (2.0 launch contract): facts from the
 * verified capability matrix, in the shape the backend reads
 * (src-tauri/src/agent_catalog.rs). The backend's own tests run the error
 * signatures against the matrix's verbatim outputs; these check the data.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { AGENT_CATALOG } from "../catalog/agentCatalog";
import { validateSavedWorkspace } from "../types/session";

const agents = AGENT_CATALOG.agents;

describe("agent capabilities in the catalog", () => {
	it("every agent with a command has a capabilities block; the Custom agent has none", () => {
		for (const a of agents) {
			if (a.custom) expect(a.capabilities, a.id).toBeUndefined();
			else expect(a.capabilities, a.id).toBeDefined();
		}
	});

	it("only Claude Code, Codex and Antigravity are verified on a real install", () => {
		const verified = agents.filter((a) => a.capabilities?.verified_on_real_install).map((a) => a.id);
		expect(verified.sort()).toEqual(["antigravity", "claude", "codex"]);
	});

	it("flags carry their placeholder; a profile folder carries {slug}; an agent with profiles can sign in", () => {
		for (const a of agents) {
			const c = a.capabilities;
			if (!c) continue;
			if (c.model.flag) expect(c.model.flag.join(" "), a.id).toContain("{model}");
			if (c.effort?.flag) expect(c.effort.flag.join(" "), a.id).toContain("{effort}");
			if (c.effort) expect(c.effort.flag !== null || !!c.effort.env, `${a.id}: an effort needs a flag or a variable`).toBe(true);
			if (c.accounts.profile_dir) {
				expect(c.accounts.profile_dir, a.id).toContain("{slug}");
				expect(c.accounts.profile_env, a.id).not.toBeNull();
			}
		}
		const claude = agents.find((a) => a.id === "claude")!.capabilities!;
		expect(claude.accounts).toMatchObject({ profile_env: "CLAUDE_CONFIG_DIR", profile_dir: ".claude-{slug}", login: ["claude", "auth", "login"] });
		expect(agents.find((a) => a.id === "codex")!.capabilities!.accounts.profile_env).toBe("CODEX_HOME");
		expect(agents.find((a) => a.id === "antigravity")!.capabilities!.accounts.profile_env).toBeNull();
	});

	it("every error signature is a valid pattern and names what went wrong", () => {
		for (const a of agents) {
			for (const s of a.capabilities?.error_signatures ?? []) {
				expect(() => new RegExp(s.pattern, "m"), `${a.id}: ${s.pattern}`).not.toThrow();
			}
		}
		const claude = agents.find((a) => a.id === "claude")!.capabilities!.error_signatures;
		const line = "There's an issue with the selected model (not-a-model). It may not exist or you may not have access to it.";
		expect(claude.find((s) => new RegExp(s.pattern, "m").test(line))?.reason).toBe("model");
	});

	it("only Antigravity is marked as falling back to another model without a word", () => {
		expect(agents.filter((a) => a.capabilities?.model.silent_fallback).map((a) => a.id)).toEqual(["antigravity"]);
	});
});

describe("saved workspaces keep a terminal agent's launch choice", () => {
	const base = { id: "s", label: "S", description: "", color: "#000", group: null, working_directory: "/w", ai_provider: "claude", auto_approve: false, permission_mode: "default", custom_prefix: "", custom_suffix: "", project_ids: [] };
	it("passes a well-formed choice through and drops a malformed one", () => {
		const ok = validateSavedWorkspace({ version: 2, sessions: [{ ...base, agent_launch: { modelId: "opus", effort: "high", accountId: "work" } }], layout: null, focused_pane_id: null, active_session_id: null });
		expect(ok?.sessions[0].agent_launch).toEqual({ modelId: "opus", effort: "high", accountId: "work" });
		const bad = validateSavedWorkspace({ version: 2, sessions: [{ ...base, agent_launch: { modelId: 5 } }], layout: null, focused_pane_id: null, active_session_id: null });
		expect(bad?.sessions[0].agent_launch).toBeUndefined();
		const arr = validateSavedWorkspace({ version: 2, sessions: [{ ...base, agent_launch: [] }], layout: null, focused_pane_id: null, active_session_id: null });
		expect(arr?.sessions[0].agent_launch).toBeUndefined();
	});
});
