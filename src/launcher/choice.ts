// ─── Launch choices: the pure rules the launcher applies while editing ─
//
// The launcher (⌘N) opens pre-set to the person's usual FULL combination
// for the repository, so a task and Enter launch it. The capability
// commands (src-tauri/src/agent_caps, src/agent/capabilities) keep that
// history and the presets and decide the usual combination and when to
// offer "Save as preset?". What is here is what the launcher does on its
// own: comparing combinations, naming presets, the efforts a model takes,
// a fresh choice for an agent and switching agent.
//
// "The same combination" is comboKey from the capability module (one
// definition for both sides).

import { comboKey } from "../agent/capabilities/choice";
import type { AgentCapabilities, LaunchChoice, ModelOption } from "../agent/capabilities/types";

/** Presets with a ⌘1–⌘4 shortcut. */
export const PRESET_SHORTCUTS = 4;

export function sameCombo(a: LaunchChoice, b: LaunchChoice): boolean {
  return comboKey(a) === comboKey(b);
}

/** A choice as it is remembered: a new worktree's branch comes from each task, so it is left out. */
export function rememberedForm(choice: LaunchChoice): LaunchChoice {
  const out: LaunchChoice = { ...choice, where: choice.where.kind === "new-worktree" ? { ...choice.where, branch: "" } : choice.where };
  if (choice.alsoOn) out.alsoOn = rememberedForm(choice.alsoOn);
  return out;
}

/** A preset name the list does not have yet: "Claude Code · opus", then "Claude Code · opus 2". */
export function uniquePresetName(base: string, presets: readonly { name: string }[]): string {
  const name = base.trim() || "Preset";
  const taken = new Set(presets.map((p) => p.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  for (let n = 2; n < 100; n++) if (!taken.has(`${name} ${n}`.toLowerCase())) return `${name} ${n}`;
  return `${name} ${Date.now().toString(36)}`;
}

export function modelOf(caps: AgentCapabilities | undefined, modelId: string): ModelOption | undefined {
  return caps?.models.find((m) => m.id === modelId);
}

/** The efforts the launcher offers for a model ([] = the effort chip is disabled). */
export function effortsFor(caps: AgentCapabilities | undefined, modelId: string): string[] {
  const listed = modelOf(caps, modelId);
  if (listed) return listed.efforts;
  // A typed model name gets the default's efforts (as the capability rules do).
  if (caps?.acceptsTypedModel || caps?.modelSource === "free-text") return caps.models.find((m) => m.id === "default")?.efforts ?? [];
  return [];
}

/** The catalog defaults for an agent: its active account, the given approval mode, the default model. */
export function defaultChoice(agentId: string, caps: AgentCapabilities | undefined, approvalModeId: string): LaunchChoice {
  const approval =
    caps && caps.approvalModes.length > 0 && !caps.approvalModes.some((m) => m.id === approvalModeId)
      ? (caps.approvalModes.find((m) => m.id === caps.defaultApprovalModeId) ?? caps.approvalModes[0]).id
      : approvalModeId;
  return {
    agentId,
    accountId: caps ? (caps.activeAccountId ?? caps.accounts[0]?.id ?? "default") : "default",
    approvalModeId: approval,
    modelId: "default",
    effort: null,
    extraArgs: "",
    prefix: "",
    channels: [],
    where: { kind: "new-worktree", baseBranch: "", branch: "" },
    trackAsFeature: false,
  };
}

/** Switching agent keeps what is not about the agent (where, feature tracking, a different second agent). */
export function switchAgent(choice: LaunchChoice, agentId: string, fresh: LaunchChoice): LaunchChoice {
  const next: LaunchChoice = { ...fresh, agentId, where: choice.where, trackAsFeature: choice.trackAsFeature };
  if (choice.alsoOn && choice.alsoOn.agentId !== agentId) next.alsoOn = choice.alsoOn;
  else delete next.alsoOn;
  return next;
}
