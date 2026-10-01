/**
 * The launcher's own rules, without the UI (the usual combination, the
 * history and the presets are the capability commands' job, tested on the
 * Rust side and through the UI test's fake):
 *   - what each agent is started with for a choice (approval flags, extra
 *     args, prefix, channels; model, effort and account as agentLaunch);
 *   - the choice checked while it is edited, and a stored one against
 *     today's capabilities;
 *   - preset names, switching agent, the remembered form of a choice.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async (cmd: string) => Promise.reject(new Error(`command ${cmd} not found`))) }));

import type { LaunchChoice } from "../agent/capabilities/types";
import { reconcileChoice } from "../agent/capabilities/choice";
import { effortsFor, rememberedForm, sameCombo, switchAgent, uniquePresetName, withoutDanger } from "../launcher/choice";
import { isDraftWorthKeeping } from "../launcher/draft";
import { capabilityBackend, sessionLaunchFor, validateChoice } from "../launcher/backend";
import type { DoctorRow } from "../api/doctor";
import { fakeCapabilities } from "./fakes/capabilityCommands";

const base: LaunchChoice = {
  agentId: "claude",
  accountId: "default",
  approvalModeId: "acceptEdits",
  modelId: "default",
  effort: null,
  extraArgs: "",
  prefix: "",
  channels: [],
  where: { kind: "new-worktree", baseBranch: "", branch: "" },
  trackAsFeature: false,
};
const c = (over: Partial<LaunchChoice>): LaunchChoice => ({ ...base, ...over });

function row(id: string, over: Partial<DoctorRow> = {}): DoctorRow {
  return { id, name: id, installed: true, version: "1.0.0", min_version: null, version_ok: null, signed_in: "yes", signals: "exact", resume: true, retired: false, retired_note: null, beta: false, ...over };
}

describe("choices", () => {
  it("remembers a choice without the task's branch; that branch does not make another combination", () => {
    const one = c({ where: { kind: "new-worktree", baseBranch: "develop", branch: "hermes/a" }, alsoOn: c({ agentId: "codex", where: { kind: "new-worktree", baseBranch: "", branch: "hermes/a-codex" } }) });
    expect(rememberedForm(one).where).toEqual({ kind: "new-worktree", baseBranch: "develop", branch: "" });
    expect(rememberedForm(one).alsoOn?.where).toEqual({ kind: "new-worktree", baseBranch: "", branch: "" });
    expect(sameCombo(one, c({ ...one, where: { kind: "new-worktree", baseBranch: "develop", branch: "hermes/b" } }))).toBe(true);
    expect(sameCombo(one, c({ ...one, where: { kind: "new-worktree", baseBranch: "main", branch: "hermes/a" } }))).toBe(false);
  });
  it("names presets uniquely", () => {
    expect(uniquePresetName("Claude · opus", [])).toBe("Claude · opus");
    expect(uniquePresetName("Claude · opus", [{ name: "claude · OPUS" }])).toBe("Claude · opus 2");
  });
  it("switching agent keeps where, feature tracking and a different second agent", () => {
    const withAlso = c({ trackAsFeature: true, where: { kind: "current-checkout" }, alsoOn: c({ agentId: "codex" }) });
    const next = switchAgent(withAlso, "gemini", c({ agentId: "gemini", approvalModeId: "default" }));
    expect(next).toMatchObject({ agentId: "gemini", approvalModeId: "default", trackAsFeature: true, where: { kind: "current-checkout" } });
    expect(next.alsoOn?.agentId).toBe("codex");
    expect(switchAgent(withAlso, "codex", c({ agentId: "codex" })).alsoOn).toBeUndefined();
  });
});

describe("launch lines", () => {
  it("maps the approval mode to the catalog's modes and the model, effort and account to agentLaunch", () => {
    const launch = sessionLaunchFor(c({ approvalModeId: "plan", modelId: "opus", effort: "low", accountId: "work", extraArgs: " --verbose ", prefix: "caffeinate -i", channels: ["plugin:a", " "] }), fakeCapabilities("claude", row("claude")));
    expect(launch).toEqual({
      permissionMode: "plan",
      customPrefix: "caffeinate -i",
      customSuffix: "--verbose",
      channels: ["plugin:a"],
      agentCommand: undefined,
      agentLaunch: { modelId: "opus", effort: "low", accountId: "work", purpose: "agent" },
    });
    expect(sessionLaunchFor(c({}), undefined).agentLaunch).toEqual({ modelId: null, effort: null, accountId: null, purpose: "agent" });
    expect(sessionLaunchFor(c({ agentId: "codex", channels: ["plugin:a"] }), undefined).channels).toEqual([]);
    expect(capabilityBackend.sessionLaunch).toBe(sessionLaunchFor);
  });
  it("an approval mode the catalog does not know travels as its flags; a Custom agent's text is its command", () => {
    const caps = { ...fakeCapabilities("claude", row("claude")), approvalModes: [{ id: "yolo", label: "Yolo", flag: ["--yolo"], note: "", danger: true }] };
    expect(sessionLaunchFor(c({ approvalModeId: "yolo", extraArgs: "--x" }), caps)).toMatchObject({ permissionMode: "default", customSuffix: "--yolo --x" });
    expect(sessionLaunchFor(c({ agentId: "custom", extraArgs: "my-agent -x" }), undefined)).toMatchObject({ customSuffix: "", agentCommand: "my-agent -x" });
  });
});

describe("checks", () => {
  const caps = fakeCapabilities("claude", row("claude"));
  it("validates approval, account, model and effort against the capabilities", () => {
    expect(validateChoice(c({ modelId: "opus", effort: "max" }), caps)).toEqual({ ok: true });
    expect(validateChoice(c({ approvalModeId: "yolo" }), caps)).toMatchObject({ ok: false, field: "approval" });
    expect(validateChoice(c({ accountId: "nobody" }), caps)).toMatchObject({ ok: false, field: "account" });
    expect(validateChoice(c({ modelId: "gpt-9" }), caps)).toMatchObject({ ok: false, field: "model" });
    expect(validateChoice(c({ modelId: "haiku", effort: "high" }), caps)).toMatchObject({ ok: false, field: "effort" });
    expect(effortsFor(caps, "haiku")).toEqual([]);
    expect(effortsFor(fakeCapabilities("opencode", row("opencode")), "anything/typed")).toEqual([]);
  });
  it("a typed model is taken, but never one that reads as a flag (validate_launch refuses it)", () => {
    const oc = fakeCapabilities("opencode", row("opencode"));
    const typed = (modelId: string) => validateChoice(c({ agentId: "opencode", approvalModeId: oc.defaultApprovalModeId ?? "default", modelId }), oc);
    expect(typed("anthropic/typed-model")).toEqual({ ok: true });
    expect(typed("--dangerously-skip-permissions")).toMatchObject({ ok: false, field: "model" });
    expect(typed(" -m")).toMatchObject({ ok: false, field: "model" });
  });
  it("a stored choice the agent can no longer do falls back and says so", () => {
    const codex = fakeCapabilities("codex", row("codex"));
    const r = reconcileChoice(c({ agentId: "codex", approvalModeId: "plan", modelId: "gpt-4-retired", effort: "ultra" }), codex);
    expect(r.choice).toMatchObject({ approvalModeId: "auto", modelId: "default", effort: "high" });
    expect(r.issues.map((i) => i.field).sort()).toEqual(["approval", "effort", "model"]);
    expect(r.launchable).toBe(true);
    expect(reconcileChoice(c({}), fakeCapabilities("claude", row("claude", { installed: false }))).launchable).toBe(false);
  });
});

describe("Skip all is never a starting choice", () => {
  const modes = (ids: string[], danger: string[]) => ({ approvalModes: ids.map((id) => ({ id, label: id, flag: [], note: "", danger: danger.includes(id) })) }) as unknown as import("../agent/capabilities/types").AgentCapabilities;
  const caps = { claude: modes(["default", "acceptEdits", "plan", "bypassPermissions"], ["bypassPermissions"]), codex: modes(["auto", "bypassPermissions"], ["bypassPermissions"]) };
  const safe = (id: string) => (id === "codex" ? "auto" : "acceptEdits");

  it("replaces a dangerous mode by the agent's safety default, for the second agent too, and says so", () => {
    const usual = c({ approvalModeId: "bypassPermissions", modelId: "opus", alsoOn: c({ agentId: "codex", approvalModeId: "bypassPermissions" }) });
    const out = withoutDanger(usual, caps, safe);
    expect(out.dropped).toBe(true);
    expect(out.choice.approvalModeId).toBe("acceptEdits");
    expect(out.choice.modelId).toBe("opus");
    expect(out.choice.alsoOn?.approvalModeId).toBe("auto");
    expect(usual.approvalModeId).toBe("bypassPermissions");
  });

  it("leaves every other mode, and an agent it knows nothing about, as they are", () => {
    const plan = c({ approvalModeId: "plan" });
    expect(withoutDanger(plan, caps, safe)).toEqual({ choice: plan, dropped: false });
    const unknown = c({ agentId: "gemini", approvalModeId: "bypassPermissions" });
    expect(withoutDanger(unknown, caps, safe).dropped).toBe(false);
  });
});

describe("what counts as a draft", () => {
  const none = { task: "", touched: false, expanded: false, branchEdited: false, checksEdited: false, restored: false };
  it("an untouched sheet is not one; any typing, choice, option or a restored draft is", () => {
    expect(isDraftWorthKeeping(none)).toBe(false);
    expect(isDraftWorthKeeping({ ...none, task: "  " })).toBe(false);
    for (const over of [{ task: "x" }, { touched: true }, { expanded: true }, { branchEdited: true }, { checksEdited: true }, { restored: true }]) {
      expect(isDraftWorthKeeping({ ...none, ...over })).toBe(true);
    }
  });
});
