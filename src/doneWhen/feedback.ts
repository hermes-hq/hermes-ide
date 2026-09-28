// ─── Done-When (F27): the text "Send failures back" hands an agent ────
//
// The same shape the Stop hook feeds Claude (src-tauri/hi/src/done_when.rs,
// Report::feedback): which checks failed and the end of their output. It is
// addressed to the agent, so it is plain English whatever the UI language.

import { failedCommands, type CheckRun } from "./types";

/** Longest text sent back to an agent. */
export const FEEDBACK_CAP = 6000;

function tail(text: string, max: number): string {
  return text.length <= max ? text : `…${text.slice(text.length - max)}`;
}

export function failureFeedback(run: CheckRun): string {
  const from = run.source ? ` (from ${run.source.path})` : "";
  let out = `Hermes Done-When checks failed${from}. Fix what these checks report, then finish again.\n`;
  const failed = failedCommands(run);
  const per = Math.min(3000, Math.max(400, Math.floor(FEEDBACK_CAP / Math.max(1, failed.length))));
  for (const c of failed) {
    const how = c.timed_out ? "timed out" : c.exit_code === null ? "did not run" : `exit ${c.exit_code}`;
    out += `\n$ ${c.command} (${how})\n`;
    const t = c.output_tail.trimEnd();
    if (t) out += `${tail(t, per)}\n`;
  }
  return out.length <= FEEDBACK_CAP ? out : `${out.slice(0, FEEDBACK_CAP)}…`;
}

/**
 * The bytes written to the agent's terminal: a bracketed paste (so a
 * multi-line text arrives as one message, as the prompt composer sends it)
 * followed by Enter. Control characters from command output are dropped so
 * the paste cannot end early or drive the terminal.
 */
export function sendBackPayload(run: CheckRun): string {
  const clean = failureFeedback(run).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
  return `\x1b[200~${clean.trimEnd()}\x1b[201~\r`;
}
