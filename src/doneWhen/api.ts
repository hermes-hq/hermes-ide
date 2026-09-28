// ─── Done-When (F27): backend commands ───────────────────────────────

import { invoke } from "@tauri-apps/api/core";
import type { RunOutcome } from "./types";

/** Where a run Hermes starts comes from (the agent's own hook and `hi check`
 *  at a terminal report by themselves). `land` is for the Land sheet (F22). */
export type RunTrigger = "turn_end" | "manual" | "land";

/** Run a session's checks in its folder now. At a turn end the backend skips
 *  it when the agent's Stop hook checks it already ("hook"). */
export function runDoneWhen(sessionId: string, trigger: RunTrigger, turn: number | null = null): Promise<RunOutcome> {
  return invoke<RunOutcome>("done_when_run", { sessionId, trigger, turn });
}
