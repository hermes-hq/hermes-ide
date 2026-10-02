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

/**
 * A choice as the launch history keeps it (the usual combination, what was
 * last launched with an agent): its remembered form, except that "current
 * checkout" is never carried over to the next task, which would then edit
 * the project folder without anyone asking for it again. A preset keeps it:
 * that is an explicit choice.
 */
export function historyForm(choice: LaunchChoice): LaunchChoice {
  const out = rememberedForm(choice);
  const isolate = (c: LaunchChoice): LaunchChoice => (c.where.kind === "current-checkout" ? { ...c, where: { kind: "new-worktree", baseBranch: "", branch: "" } } : c);
  const main = isolate(out);
  if (main.alsoOn) main.alsoOn = isolate(main.alsoOn);
  return main;
}

/** A preset name the list does not have yet: "Claude Code · opus", then "Claude Code · opus 2". */
export function uniquePresetName(base: string, presets: readonly { name: string }[]): string {
  const name = base.trim() || "Preset";
  const taken = new Set(presets.map((p) => p.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  for (let n = 2; n < 100; n++) if (!taken.has(`${name} ${n}`.toLowerCase())) return `${name} ${n}`;
  return `${name} ${Date.now().toString(36)}`;
}

/** The preset already called `name` (letter case and surrounding spaces ignored), other than `exceptId`. */
export function presetNamed<P extends { id: string; name: string }>(name: string, presets: readonly P[], exceptId?: string): P | null {
  const want = name.trim().toLowerCase();
  if (!want) return null;
  return presets.find((p) => p.id !== exceptId && p.name.trim().toLowerCase() === want) ?? null;
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

/**
 * A starting choice without a dangerous approval mode (Skip all): the usual
 * combination, what was last launched with an agent and the Settings
 * default never put the launcher in it by themselves. A dangerous mode is
 * replaced by `safe(agentId)` (the agent's safety default), for the second
 * agent too. Presets and the person's own clicks keep it: those are
 * explicit choices. `dropped`: something was replaced.
 */
export function withoutDanger(
  choice: LaunchChoice,
  caps: Readonly<Record<string, AgentCapabilities | undefined>>,
  safe: (agentId: string) => string,
): { choice: LaunchChoice; dropped: boolean } {
  const isDanger = (c: LaunchChoice) => !!caps[c.agentId]?.approvalModes.find((m) => m.id === c.approvalModeId)?.danger;
  let dropped = false;
  const fix = (c: LaunchChoice): LaunchChoice => {
    if (!isDanger(c)) return c;
    dropped = true;
    return { ...c, approvalModeId: safe(c.agentId) };
  };
  const main = fix(choice);
  const out: LaunchChoice = main === choice ? { ...choice } : main;
  if (choice.alsoOn) out.alsoOn = fix(choice.alsoOn);
  return { choice: dropped ? out : choice, dropped };
}
