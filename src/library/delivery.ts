// ─── How a library persona reaches each agent ─────────────────────────
//
// Vendor-neutral by construction: every agent gets the persona. Where its
// CLI has a proven flag for the system prompt (agents.json
// `terminal.system_prompt`, today Claude Code's --append-system-prompt) the
// persona goes there and the task stays the first prompt. Every other agent
// gets the persona as the start of its first prompt. An agent that takes no
// first prompt on its launch line gets both on the clipboard (Hermes never
// types for the person). The Agent view takes it as its first message.

import { getAgent } from "../catalog/agentCatalog";

export type PersonaDelivery = "system" | "first-message" | "clipboard";

export function personaDelivery(agentId: string, mode: "terminal" | "agent"): PersonaDelivery {
  if (mode === "agent") return "first-message";
  const terminal = getAgent(agentId)?.terminal;
  if (terminal?.system_prompt?.length) return "system";
  if (terminal?.initial_prompt?.length) return "first-message";
  return "clipboard";
}

/** How long a paste the agent folds into a placeholder (catalog `paste_fold`), or null. */
export function pasteFold(agentId: string | null | undefined): { chars: number; lines: number } | null {
  if (!agentId) return null;
  return getAgent(agentId)?.terminal.paste_fold ?? null;
}

/** The CLI flag a persona travels in ("--append-system-prompt"), when there is one. */
export function systemPromptFlag(agentId: string): string | null {
  const args = getAgent(agentId)?.terminal.system_prompt;
  return args?.find((a) => a.startsWith("-")) ?? null;
}

/** What an agent with no task yet is asked to do after taking the persona. */
export const PERSONA_ONLY_TAIL = 'Reply "ready" and wait for my task.';

/**
 * The first prompt for an agent that gets the persona in it: the persona,
 * then the task (or, with no task, an instruction to wait for one).
 */
export function withPersona(personaText: string, task: string): string {
  const persona = personaText.trim();
  const rest = task.trim() || PERSONA_ONLY_TAIL;
  return persona ? `${persona}\n\n${rest}` : rest;
}

/** A library entry picked in the launcher. */
export interface LibraryLaunchPick {
  id: string;
  version: string;
  title: string;
}

/** The persona picked in the launcher, rendered for pasting (hodios `pasteText`). */
export interface LibraryLaunchPersona extends LibraryLaunchPick {
  text: string;
}

/** What one agent of a launch is started with. */
export function launchPrompts(
  agentId: string,
  mode: "terminal" | "agent",
  task: string,
  persona: LibraryLaunchPersona | null | undefined,
): { firstPrompt: string; systemPrompt: string | null } {
  if (!persona?.text.trim()) return { firstPrompt: task, systemPrompt: null };
  if (personaDelivery(agentId, mode) === "system") {
    // The role is in place before the first word; with no task the agent just opens.
    return { firstPrompt: task.trim(), systemPrompt: persona.text.trim() };
  }
  return { firstPrompt: withPersona(persona.text, task), systemPrompt: null };
}
