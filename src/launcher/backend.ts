// ─── What the launcher asks of the rest of Hermes ─────────────────────
//
// The launcher talks to one interface, LauncherBackend: an agent's
// capabilities (accounts, models, efforts, approval modes) as the INSTALLED
// CLI reports them, the launch check, the "Hermes will run" line, the usual
// combination, the presets, and how a choice becomes a session. In the app
// it is always capabilityBackend, the capability commands (Rust agent_caps,
// src/agent/capabilities/api.ts): one definition of what each agent offers.
// When they fail the launcher says so; it never falls back to a list of its
// own. Tests pass a fake through TaskLauncher's `backend` prop or answer the
// same commands.

import {
  agentLaunchOptions,
  deleteLaunchPreset,
  dismissPresetSuggestion,
  getAgentCapabilities,
  getRememberedLaunchChoice,
  getUsualLaunchChoice,
  listLaunchPresets,
  previewLaunch,
  rememberLaunchChoice,
  renameLaunchPreset,
  saveLaunchPreset,
  validateLaunch,
} from "../agent/capabilities";
import type {
  AgentCapabilities,
  AgentLaunchOptions,
  CheckedChoice,
  CheckedPreset,
  LaunchChoice,
  LaunchValidation,
  RememberResult,
  UsualLaunchChoice,
} from "../agent/capabilities/types";
import { getAgent, sanitizeCommandFragment } from "../catalog/agentCatalog";
import { safetyDefaultMode } from "../catalog/agentSafety";
import type { PermissionMode } from "../types/session";
import { takesChannels } from "../agent/providers/launchQuirks";
import { modelOf } from "./choice";

/** How a choice becomes a session (CreateSessionOpts fields). */
export interface SessionLaunch {
  permissionMode: PermissionMode;
  /** The Settings prefix (caffeinate -i, wsl …). */
  customPrefix: string;
  /** Extra arguments after everything else. */
  customSuffix: string;
  channels: string[];
  /** Custom agent only: the command. */
  agentCommand?: string;
  /** Model, effort and account (the launch helper builds their flags). */
  agentLaunch?: AgentLaunchOptions;
}

export interface LauncherBackend {
  /** `refresh`: asked of the CLI again, not answered from the cache (Check again). */
  capabilities(agentId: string, accountId?: string | null, refresh?: boolean): Promise<AgentCapabilities>;
  validate(choice: LaunchChoice): Promise<LaunchValidation>;
  preview(choice: LaunchChoice, task: string): Promise<string>;
  usual(repo: string | null): Promise<UsualLaunchChoice>;
  remember(choice: LaunchChoice, repo: string): Promise<RememberResult>;
  /** What was last launched with this agent (and account), checked; null when nothing was. */
  remembered(agentId: string, accountId?: string | null): Promise<CheckedChoice | null>;
  /** "Save as preset?" was offered (or dismissed): never offered again for this combination. */
  dismissSuggestion(choice: LaunchChoice, repo: string): Promise<void>;
  listPresets(): Promise<CheckedPreset[]>;
  savePreset(name: string, choice: LaunchChoice): Promise<CheckedPreset>;
  renamePreset(id: string, name: string): Promise<void>;
  deletePreset(id: string): Promise<void>;
  sessionLaunch(choice: LaunchChoice, caps: AgentCapabilities | undefined): SessionLaunch;
}

/** The catalog permission mode for an approval mode id, when it is one. */
function catalogMode(agentId: string, approvalModeId: string): PermissionMode | null {
  const flags = getAgent(agentId)?.terminal.permission_flags ?? {};
  return approvalModeId in flags ? (approvalModeId as PermissionMode) : null;
}

/** Everything but the model, effort and account (those travel as agentLaunch). */
export function sessionLaunchFor(choice: LaunchChoice, caps: AgentCapabilities | undefined): SessionLaunch {
  const mode = catalogMode(choice.agentId, choice.approvalModeId);
  const approval = caps?.approvalModes.find((a) => a.id === choice.approvalModeId);
  const custom = getAgent(choice.agentId)?.custom === true;
  const words: string[] = [];
  // An approval mode the catalog does not know travels as its flags.
  if (!mode && approval) words.push(...approval.flag);
  const typed = sanitizeCommandFragment(choice.extraArgs);
  return {
    permissionMode: mode ?? "default",
    customPrefix: sanitizeCommandFragment(choice.prefix),
    customSuffix: [words.join(" "), custom ? "" : typed].filter(Boolean).join(" "),
    channels: takesChannels(choice.agentId) ? choice.channels.map((c) => c.trim()).filter(Boolean) : [],
    agentCommand: custom ? typed : undefined,
    agentLaunch: agentLaunchOptions(choice),
  };
}

/** The approval mode an agent starts in by default: Hermes's safety default. */
export function safetyDefault(agentId: string): string {
  return safetyDefaultMode(agentId);
}

/** Checks a choice against the agent's capabilities while the person edits it (the same rules as validate_launch). */
export function validateChoice(choice: LaunchChoice, caps: AgentCapabilities | undefined): LaunchValidation {
  if (!caps) return { ok: true };
  if (caps.approvalModes.length > 0 && !caps.approvalModes.some((a) => a.id === choice.approvalModeId)) {
    return { ok: false, field: "approval", message: choice.approvalModeId };
  }
  const account = caps.accounts.find((a) => a.id === choice.accountId);
  if (caps.accounts.length > 0 && !account) return { ok: false, field: "account", message: choice.accountId };
  const m = modelOf(caps, choice.modelId);
  // A typed model that reads as a flag ("--yolo") is never passed (as validate_launch refuses it).
  const typed = !m && (caps.acceptsTypedModel || caps.modelSource === "free-text") && choice.modelId.trim() !== "" && !choice.modelId.trim().startsWith("-");
  if (choice.modelId !== "default" && !typed && (!m || !m.available)) return { ok: false, field: "model", message: choice.modelId };
  if (choice.effort) {
    const efforts = m?.efforts ?? caps.models.find((x) => x.id === "default")?.efforts ?? [];
    if (!efforts.includes(choice.effort)) return { ok: false, field: "effort", message: choice.effort };
  }
  return { ok: true };
}

export const capabilityBackend: LauncherBackend = {
  capabilities: (agentId, accountId, refresh) => getAgentCapabilities(agentId, accountId ?? null, refresh ?? false),
  validate: validateLaunch,
  preview: previewLaunch,
  usual: getUsualLaunchChoice,
  remember: (choice, repo) => rememberLaunchChoice(choice, repo),
  remembered: (agentId, accountId) => getRememberedLaunchChoice(agentId, accountId ?? null),
  dismissSuggestion: (choice, repo) => dismissPresetSuggestion(choice, repo),
  listPresets: listLaunchPresets,
  savePreset: saveLaunchPreset,
  renamePreset: async (id, name) => {
    await renameLaunchPreset(id, name);
  },
  deletePreset: deleteLaunchPreset,
  sessionLaunch: sessionLaunchFor,
};
