// ─── Test fake: the capability commands, in memory ────────────────────
//
// Answers the Tauri commands of src-tauri/src/agent_caps the way they
// answer in the app (get_agent_capabilities, validate_launch,
// preview_launch, get_usual_launch_choice, remember_launch_choice,
// get_remembered_launch_choice, dismiss_preset_suggestion and the preset
// commands), so the launcher's tests run its production path
// (capabilityBackend) against a typed, synthetic set of agents.
//
// The rules copied from the Rust side, on purpose including what the
// launcher must cope with:
//   - remember_launch_choice says suggestPreset every time a combination
//     reaches 3 launches in a repository until it is a preset or was
//     dismissed (the backend does not remember that it was offered);
//   - the usual combination is the one launched most often in the
//     repository in the last 60 days (tie: the latest; when nothing is that
//     recent, the most launched ever), else the same across repositories,
//     else the catalog default for the first installed agent (a launch's
//     `at` is its time in ms);
//   - a stored choice comes back checked (reconcileChoice).
//
// Test-only: the app never falls back to these lists.

import { comboKey, reconcileChoice } from "../../agent/capabilities/choice";
import type {
  AgentCapabilities,
  ApprovalModeOption,
  CheckedPreset,
  LaunchChoice,
  LaunchPreset,
  LaunchValidation,
  ModelOption,
} from "../../agent/capabilities/types";
import { getAgent, getAvailableModes, listAgents } from "../../catalog/agentCatalog";
import { safetyDefaultMode } from "../../catalog/agentSafety";
import type { DoctorRow } from "../../api/doctor";
import { defaultChoice, rememberedForm } from "../../launcher/choice";
import { validateChoice } from "../../launcher/backend";

export const SUGGEST_AFTER = 3;
/** How far back "recent" reaches for the usual combination (choice.rs RECENT_MS). */
const RECENT_MS = 60 * 24 * 60 * 60 * 1000;

export interface FakeLaunch {
  repo: string;
  choice: LaunchChoice;
  at: number;
}

const CL = ["low", "medium", "high", "xhigh", "max"];
const model = (id: string, efforts: string[]): ModelOption => ({ id, label: id, efforts, available: true });

/** Synthetic model lists (what a fake CLI would report). */
const MODELS: Record<string, { source: AgentCapabilities["modelSource"]; list: ModelOption[] }> = {
  claude: { source: "aliases", list: [model("default", CL), model("opus", CL), model("sonnet", CL), model("haiku", [])] },
  codex: { source: "aliases", list: [model("default", ["low", "medium", "high"]), model("gpt-fake-terra", [...CL, "ultra"]), model("gpt-fake-luna", CL)] },
  gemini: { source: "aliases", list: [model("default", []), model("gemini-fake-pro", [])] },
  opencode: { source: "free-text", list: [model("default", [])] },
};

/** Model and effort flags per agent, for the preview line. */
const FLAGS: Record<string, { model?: (id: string) => string[]; effort?: (e: string) => string[] }> = {
  claude: { model: (m) => ["--model", m], effort: (e) => ["--effort", e] },
  codex: { model: (m) => ["-m", m], effort: (e) => ["-c", `model_reasoning_effort=${e}`] },
  gemini: { model: (m) => ["-m", m] },
  opencode: { model: (m) => ["--model", m] },
};

function approvalModesFor(agentId: string): ApprovalModeOption[] {
  const agent = getAgent(agentId);
  if (!agent) return [];
  return getAvailableModes(agentId).map((id) => ({ id, label: id, flag: [...(agent.terminal.permission_flags[id] ?? [])], note: "", danger: id === "bypassPermissions" }));
}

/** An agent's capabilities as the fake reports them (one account: the default profile). */
export function fakeCapabilities(agentId: string, doctor: DoctorRow | undefined): AgentCapabilities {
  const models = MODELS[agentId] ?? { source: "aliases" as const, list: [model("default", [])] };
  const signedIn = doctor ? doctor.signed_in !== "no" : true;
  return {
    agentId,
    agentName: getAgent(agentId)?.name ?? agentId,
    cliVersion: doctor?.version ?? null,
    installed: doctor?.installed ?? false,
    verifiedOnRealInstall: false,
    accounts: [{ id: "default", label: "default", detail: "", signedIn, signInState: signedIn ? "signed-in" : "signed-out" }],
    activeAccountId: "default",
    canAddAccount: false,
    models: models.list.map((x) => ({ ...x, efforts: [...x.efforts] })),
    modelSource: models.source,
    acceptsTypedModel: models.source === "free-text",
    approvalModes: approvalModesFor(agentId),
    statusSource: doctor?.signals === "exact" ? "exact" : "guessed",
    defaultApprovalModeId: safetyDefaultMode(agentId),
  };
}

const quote = (w: string) => (/^[A-Za-z0-9_./:=@%+,~-]+$/.test(w) ? w : `"${w.replace(/(["\\$`])/g, "\\$1")}"`);

/** "Hermes will run", as preview_launch builds it. */
export function fakePreview(choice: LaunchChoice, task: string, caps: AgentCapabilities | undefined): string {
  const agent = getAgent(choice.agentId);
  if (!agent) return "";
  if (agent.custom) return choice.extraArgs.trim() || "…";
  const words: string[] = [];
  const account = caps?.accounts.find((a) => a.id === choice.accountId);
  if (account?.profileEnv) words.push(`${account.profileEnv.name}=${quote(account.profileEnv.value)}`);
  if (choice.prefix.trim()) words.push(choice.prefix.trim());
  words.push(agent.terminal.argv.join(" "));
  const perm = caps?.approvalModes.find((m) => m.id === choice.approvalModeId)?.flag ?? [];
  if (perm.length) words.push(perm.map(quote).join(" "));
  const line = task.trim().split(/\r?\n/)[0]?.trim() ?? "";
  if (line && agent.terminal.initial_prompt) words.push(agent.terminal.initial_prompt.map((w) => (w === "{prompt}" ? quote(line) : w)).join(" "));
  if (choice.agentId === "claude") for (const c of choice.channels) if (c.trim()) words.push(`--channels ${quote(c.trim())}`);
  const recipe = FLAGS[choice.agentId] ?? {};
  if (choice.modelId !== "default" && recipe.model) words.push(recipe.model(choice.modelId).join(" "));
  if (choice.effort && recipe.effort) words.push(recipe.effort(choice.effort).join(" "));
  if (choice.extraArgs.trim()) words.push(choice.extraArgs.trim());
  return words.join(" ");
}

function mostFrequent(entries: readonly FakeLaunch[]) {
  const tally = new Map<string, { count: number; last: number; choice: LaunchChoice }>();
  for (const e of entries) {
    const key = comboKey(e.choice);
    const t = tally.get(key);
    if (!t) tally.set(key, { count: 1, last: e.at, choice: e.choice });
    else {
      t.count++;
      if (e.at >= t.last) Object.assign(t, { last: e.at, choice: e.choice });
    }
  }
  let best: { count: number; last: number; choice: LaunchChoice } | null = null;
  for (const t of tally.values()) if (!best || t.count > best.count || (t.count === best.count && t.last > best.last)) best = t;
  return best;
}

export interface FakeCapabilityCommands {
  history: FakeLaunch[];
  presets: LaunchPreset[];
  dismissed: string[];
  /** Agents whose get_agent_capabilities rejects (with this message). */
  failing: Map<string, string>;
  /** Per-agent overrides of the reported capabilities. */
  override: Map<string, (caps: AgentCapabilities) => AgentCapabilities>;
  /** The command's answer, or undefined when it is not a capability command. */
  handle(cmd: string, args: Record<string, unknown>): { value: unknown } | undefined;
  calls: { cmd: string; args: Record<string, unknown> }[];
}

export function fakeCapabilityCommands(doctor: () => DoctorRow[]): FakeCapabilityCommands {
  let clock = 1_000;
  let ids = 0;
  const row = (id: string) => doctor().find((r) => r.id === id);
  const self: FakeCapabilityCommands = {
    history: [],
    presets: [],
    dismissed: [],
    failing: new Map(),
    override: new Map(),
    calls: [],
    handle(cmd, args) {
      const caps = (agentId: string) => {
        const base = fakeCapabilities(agentId, row(agentId));
        return self.override.get(agentId)?.(base) ?? base;
      };
      const check = (c: LaunchChoice) => reconcileChoice(c, caps(c.agentId), c.alsoOn ? caps(c.alsoOn.agentId) : null);
      const checkedPreset = (p: LaunchPreset): CheckedPreset => {
        const r = check(p.choice);
        return { ...p, issues: r.issues, launchable: r.launchable, effective: r.choice };
      };
      const choice = args.choice as LaunchChoice;
      switch (cmd) {
        case "get_agent_capabilities": {
          self.calls.push({ cmd, args });
          const id = String(args.agentId);
          const failure = self.failing.get(id);
          if (failure !== undefined) throw new Error(failure);
          if (!getAgent(id) || getAgent(id)?.custom) throw new Error(`Unknown agent "${id}"`);
          return { value: caps(id) };
        }
        case "validate_launch":
          return { value: validateChoice(choice, caps(choice.agentId)) satisfies LaunchValidation };
        case "preview_launch":
          return { value: fakePreview(choice, String(args.task ?? ""), caps(choice.agentId)) };
        case "get_usual_launch_choice": {
          const repo = (args.repo as string | null) ?? null;
          const now = Math.max(clock, ...self.history.map((e) => e.at));
          const usual = (entries: FakeLaunch[]) => mostFrequent(entries.filter((e) => now - e.at <= RECENT_MS)) ?? mostFrequent(entries);
          const inRepo = repo ? usual(self.history.filter((e) => e.repo === repo)) : null;
          const pick = inRepo ?? usual(self.history);
          if (pick) return { value: { ...check(pick.choice), source: inRepo ? "repo" : "global", count: pick.count, lastUsedAt: pick.last } };
          const first = listAgents().find((a) => !a.custom && row(a.id)?.installed)?.id ?? "claude";
          const c = caps(first);
          return { value: { ...check(defaultChoice(first, c, c.defaultApprovalModeId ?? "default")), source: "catalog", count: 0, lastUsedAt: null } };
        }
        case "remember_launch_choice": {
          self.calls.push({ cmd, args });
          const stored = rememberedForm(choice);
          const repo = String(args.repo ?? "");
          self.history.push({ repo, choice: stored, at: ++clock });
          const key = comboKey(stored);
          const count = self.history.filter((e) => e.repo === repo && comboKey(e.choice) === key).length;
          const suggestPreset = count >= SUGGEST_AFTER && !self.presets.some((p) => comboKey(p.choice) === key) && !self.dismissed.includes(key);
          return { value: { count, suggestPreset } };
        }
        case "get_remembered_launch_choice": {
          for (let i = self.history.length - 1; i >= 0; i--) {
            const c = self.history[i].choice;
            if (c.agentId === args.agentId && (args.accountId == null || c.accountId === args.accountId)) return { value: check(c) };
          }
          return { value: null };
        }
        case "dismiss_preset_suggestion": {
          self.calls.push({ cmd, args });
          const key = comboKey(rememberedForm(choice));
          if (!self.dismissed.includes(key)) self.dismissed.push(key);
          return { value: null };
        }
        case "list_launch_presets":
          return { value: self.presets.map(checkedPreset) };
        case "save_launch_preset": {
          const preset = { id: `p${++ids}`, name: String(args.name).trim(), choice: rememberedForm(choice) };
          self.presets.push(preset);
          return { value: checkedPreset(preset) };
        }
        case "rename_launch_preset": {
          const p = self.presets.find((x) => x.id === args.id);
          if (p && String(args.name).trim()) p.name = String(args.name).trim();
          return { value: p ? checkedPreset(p) : null };
        }
        case "delete_launch_preset":
          self.presets = self.presets.filter((p) => p.id !== args.id);
          return { value: null };
        default:
          return undefined;
      }
    },
  };
  return self;
}

