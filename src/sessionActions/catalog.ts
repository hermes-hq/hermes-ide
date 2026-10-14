// ─── Session actions: what an agent offers ─────────────────────────────
//
// One source of truth: the agent catalog (src/catalog/agents.json) lists the
// cross-agent actions (`actions`: compact, context, model, plan, ...) and,
// per agent, its built-in commands (`agents[].commands`), each mapped to an
// action where it is one. Everything here is pure: the action bar, the
// Commands list and the command palette read the same answers.
//
// An action an agent lacks is hidden for it, never greyed. A destructive
// command (a new chat, exit, sign out, or one the catalog flags) is never a
// chip and always asks first.

import { AGENT_CATALOG, getAgent, type AgentCommandSpec, type CommandCategory, type SessionActionId } from "../catalog/agentCatalog";

export type { SessionActionId, CommandCategory };

/** Every action, in the vocabulary's order (the order chips appear in). */
export const ACTION_IDS: readonly SessionActionId[] = AGENT_CATALOG.actions.map((a) => a.id);

/** The actions pinned as chips until the person changes them. */
export const DEFAULT_PINNED: readonly SessionActionId[] = ["context", "model", "plan", "review"];

const ACTION_SPECS = new Map(AGENT_CATALOG.actions.map((a) => [a.id, a]));

export function isActionId(value: unknown): value is SessionActionId {
  return typeof value === "string" && ACTION_SPECS.has(value as SessionActionId);
}

/** Whether an action ends or replaces something the person has. */
export function isDestructiveAction(id: SessionActionId): boolean {
  return ACTION_SPECS.get(id)?.destructive === true;
}

/** Where a command came from: the agent's own, the person's files, or the Library. */
export type CommandSource = "builtin" | "user" | "library";

/** A command ready to show and run. */
export interface SessionCommand {
  /** Unique within the agent: what is typed ("/compact", "$review"). */
  text: string;
  action?: SessionActionId;
  /** i18n key prefix of a catalog command without an action ("agentCommand.claude.memory"). */
  messageKey?: string;
  /** English fallback label and description (catalog, or the file a command came from). */
  label: string;
  description: string;
  category: CommandCategory;
  /** Ends or replaces something: never a chip, asks first. */
  destructive: boolean;
  /** The catalog's own consequence line (English) and its i18n key; without one, the action's is used. */
  consequence?: string;
  consequenceKey?: string;
  aliases: readonly string[];
  source: CommandSource;
  /** "project" or "user" for discovered commands. */
  scope?: "project" | "user";
  kind?: "command" | "skill";
  argumentHint?: string;
}

/** The catalog id of the agent a session runs: the one Hermes started, else the one it recognised. */
export function agentIdOf(session: { ai_provider?: string | null; detected_agent?: { name: string } | null }): string | null {
  if (session.ai_provider) return session.ai_provider;
  const name = session.detected_agent?.name?.toLowerCase().trim();
  if (!name) return null;
  const byName: Record<string, string> = {
    claude: "claude",
    "claude code": "claude",
    "claude-code": "claude",
    codex: "codex",
    aider: "aider",
    gemini: "gemini",
    copilot: "copilot",
    "github-copilot": "copilot",
    kiro: "kiro",
  };
  return byName[name] ?? (getAgent(name) ? name : null);
}

/** "/context show" → "context-show"; "/frontend:component" → "frontend-component". */
export function commandSlug(text: string): string {
  return text.replace(/^[/$]/, "").replace(/[\s:.]+/g, "-").toLowerCase();
}

function fromSpec(agentId: string, spec: AgentCommandSpec): SessionCommand {
  const action = spec.action;
  const destructive = !!spec.destructive || (action ? isDestructiveAction(action) : false);
  return {
    text: spec.id,
    action,
    messageKey: action ? undefined : `agentCommand.${agentId}.${commandSlug(spec.id)}`,
    label: spec.label ?? "",
    description: spec.description ?? "",
    category: action && !spec.category ? (ACTION_SPECS.get(action)?.category ?? "session") : (spec.category ?? "session"),
    destructive,
    consequence: spec.destructive?.consequence,
    consequenceKey: spec.destructive ? `agentCommand.${agentId}.${commandSlug(spec.id)}.consequence` : undefined,
    aliases: spec.aliases ?? [],
    source: "builtin",
  };
}

const builtinCache = new Map<string, readonly SessionCommand[]>();

/** The agent's built-in commands, in catalog order ([] for an unknown agent or the Custom agent). */
export function builtinCommands(agentId: string | null | undefined): readonly SessionCommand[] {
  if (!agentId) return [];
  let cached = builtinCache.get(agentId);
  if (!cached) {
    cached = (getAgent(agentId)?.commands ?? []).map((spec) => fromSpec(agentId, spec));
    builtinCache.set(agentId, cached);
  }
  return cached;
}

/** The command that performs `action` for the agent, or undefined when it has none. */
export function commandForAction(agentId: string | null | undefined, action: SessionActionId): SessionCommand | undefined {
  return builtinCommands(agentId).find((c) => c.action === action);
}

/** One chip of the bar: an action the agent has, pinned, and safe to be a chip. */
export interface ChipSpec {
  action: SessionActionId;
  command: SessionCommand;
}

/**
 * The chips for an agent, in the vocabulary's order whatever order they were
 * pinned in (never reordered by use): pinned actions the agent maps to a
 * command that is not destructive. `context` is not here: its chip shows the
 * gauge and is placed by the bar.
 */
export function chipsFor(agentId: string | null | undefined, pinned: readonly SessionActionId[], skip: ReadonlySet<SessionActionId> = new Set()): ChipSpec[] {
  const want = new Set(pinned);
  const out: ChipSpec[] = [];
  for (const action of ACTION_IDS) {
    if (action === "context" || !want.has(action) || skip.has(action)) continue;
    const command = commandForAction(agentId, action);
    if (!command || command.destructive) continue;
    out.push({ action, command });
  }
  return out;
}

/** The context chip's state: hidden, the gauge, or the gauge offering Compact. */
export const COMPACT_SUGGEST_PERCENT = 75;

export interface ContextChip {
  percent: number;
  /** At or above COMPACT_SUGGEST_PERCENT: amber, and a click compacts. */
  high: boolean;
  /** What a click runs: compact when high (if the agent can), else the agent's context command; none: a plain readout. */
  runs?: SessionCommand;
}

export function contextChip(agentId: string | null | undefined, percent: number | null): ContextChip | null {
  if (percent === null || !Number.isFinite(percent)) return null;
  const high = percent >= COMPACT_SUGGEST_PERCENT;
  const compact = commandForAction(agentId, "compact");
  const context = commandForAction(agentId, "context");
  const runs = high ? (compact ?? context) : context;
  return { percent, high, runs: runs && !runs.destructive ? runs : undefined };
}

/** Whether `typed` (a word the person submitted at the prompt) names one of these commands, and which. */
export function matchTypedCommand(typed: string, commands: readonly SessionCommand[]): SessionCommand | undefined {
  const word = typed.trim();
  if (!/^[/$][\w:.-]+( [\w:.-]+)?$/.test(word)) return undefined;
  const lower = word.toLowerCase();
  return commands.find((c) => c.text.toLowerCase() === lower || c.aliases.some((a) => a.toLowerCase() === lower));
}

/** Catalog English for every command without an action, as i18n messages (the base the language packs translate). */
export function catalogCommandMessages(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const agent of AGENT_CATALOG.agents) {
    for (const spec of agent.commands ?? []) {
      if (spec.action && !spec.destructive) continue;
      const key = `agentCommand.${agent.id}.${commandSlug(spec.id)}`;
      if (!spec.action) {
        out[`${key}.label`] = spec.label ?? spec.id;
        out[`${key}.description`] = spec.description ?? "";
      }
      if (spec.destructive) out[`${key}.consequence`] = spec.destructive.consequence;
    }
  }
  return out;
}
