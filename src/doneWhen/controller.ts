// ─── Done-When (F27): when checks run and where their results go ──────
//
// Started once at boot when the feature is on (main.tsx). It
//   - runs a session's checks when its turn ends (a `turn_end` SessionEvent
//     from any source), unless the agent's own Stop hook checks it — the
//     backend decides and answers "hook";
//   - keeps every result that arrives on DONE_WHEN_EVENT (runs Hermes asked
//     for, and the Stop hook's own reports) in the store the chip reads,
//     attached to the session's turn;
//   - raises one `error` inbox item while a session is `check_failed`, and
//     resolves it once its checks pass.
//
// "Send failures back" is a person's click (sendFailuresBack); Hermes never
// writes to a terminal on its own.

import type { ListenFn } from "../agent/contract/channel";
import { getSessionEventSnapshot, tapSessionEvents } from "../agent/contract/sessionEventStore";
import { listInboxItems, raiseInboxItem, resolveInboxItem } from "../agent/contract/inbox";
import { translate } from "../i18n/registry";
import { writeToSession } from "../api/sessions";
import { runDoneWhen, type RunTrigger } from "./api";
import { sendBackPayload } from "./feedback";
import { forgetDoneWhen, getDoneWhenSnapshot, markDoneWhenSent, recordDoneWhen, setDoneWhenRunning } from "./store";
import { DONE_WHEN_EVENT, failedCommands, parseCheckRecord, type CheckRecord, type RunOutcome } from "./types";

/** Inbox items this feature raises carry this source. */
export const DONE_WHEN_INBOX_SOURCE = "checks";
/** Show "checking…" only for a run that takes longer than this, so a turn
 *  end the Stop hook handles does not flash the chip. */
const RUNNING_AFTER_MS = 150;

type Unlisten = () => void;

export interface DoneWhenDeps {
  listen: ListenFn;
  run?: (sessionId: string, trigger: RunTrigger, turn: number | null) => Promise<RunOutcome>;
  write?: (sessionId: string, base64: string) => Promise<void>;
  now?: () => number;
}

let deps: Required<DoneWhenDeps> | null = null;
let started: Promise<Unlisten> | null = null;

/** The turn a result belongs to when the report did not say: the one in
 *  progress, else the last that ended. */
function currentTurn(sessionId: string): number | null {
  const snap = getSessionEventSnapshot(sessionId);
  if (snap.turn.current !== null) return snap.turn.current;
  for (let i = snap.events.length - 1; i >= 0; i--) {
    const e = snap.events[i];
    if (e.type === "turn_end" || e.type === "turn_failed" || e.type === "turn_interrupted") return e.n;
  }
  return null;
}

/** Keep a result and keep the inbox in step with it. */
export function acceptDoneWhenRecord(payload: unknown): CheckRecord | null {
  const parsed = parseCheckRecord(payload);
  if (!parsed) {
    console.warn("[done-when] dropped a malformed result", payload);
    return null;
  }
  const record = parsed.turn === null ? { ...parsed, turn: currentTurn(parsed.session_id) } : parsed;
  recordDoneWhen(record);
  const open = listInboxItems().filter((i) => i.sessionId === record.session_id && i.source === DONE_WHEN_INBOX_SOURCE);
  if (record.check_failed) {
    const commands = failedCommands(record.run).map((c) => c.command).join(", ") || record.run.error || "";
    const item = raiseInboxItem({
      kind: "error",
      sessionId: record.session_id,
      detail: translate("doneWhen.inboxFailed", { commands }),
      source: DONE_WHEN_INBOX_SOURCE,
    });
    for (const other of open) if (other.id !== item.id) resolveInboxItem(other.id);
  } else if (record.run.state === "passed") {
    for (const item of open) resolveInboxItem(item.id);
  }
  return record;
}

/** Run a session's checks now (turn end, a person's request, before Land). */
export async function runChecksNow(
  sessionId: string,
  trigger: RunTrigger,
  turn: number | null = null,
): Promise<CheckRecord | null> {
  const run = deps?.run ?? runDoneWhen;
  const timer = setTimeout(() => setDoneWhenRunning(sessionId, true), RUNNING_AFTER_MS);
  try {
    const outcome = await run(sessionId, trigger, turn);
    // The backend also emits the record; taking it here as well covers a
    // lost event, and taking the same record twice changes nothing.
    return outcome.record ? acceptDoneWhenRecord(outcome.record) : null;
  } catch (e) {
    console.warn(`[done-when] checks for ${sessionId} did not run:`, e);
    return null;
  } finally {
    clearTimeout(timer);
    setDoneWhenRunning(sessionId, false);
  }
}

function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** A person clicked "Send failures back": paste the failures into the
 *  agent's terminal as one message. False when there is nothing to send. */
export async function sendFailuresBack(sessionId: string): Promise<boolean> {
  const last = getDoneWhenSnapshot(sessionId).last;
  if (!last || last.run.state !== "failed") return false;
  const write = deps?.write ?? writeToSession;
  await write(sessionId, utf8ToBase64(sendBackPayload(last.run)));
  markDoneWhenSent(sessionId, (deps?.now ?? Date.now)());
  return true;
}

/** Attach once; later calls return the same subscription. */
export function startDoneWhen(input: DoneWhenDeps): Promise<Unlisten> {
  if (started) return started;
  deps = {
    listen: input.listen,
    run: input.run ?? runDoneWhen,
    write: input.write ?? writeToSession,
    now: input.now ?? Date.now,
  };
  const untap = tapSessionEvents((sessionId, event) => {
    if (event.type !== "turn_end") return;
    void runChecksNow(sessionId, "turn_end", event.n);
  });
  started = Promise.all([
    input.listen<unknown>(DONE_WHEN_EVENT, (msg) => {
      acceptDoneWhenRecord(msg.payload);
    }),
    input.listen<unknown>("session-removed", (msg) => {
      if (typeof msg.payload !== "string") return;
      forgetDoneWhen(msg.payload);
      for (const item of listInboxItems()) {
        if (item.sessionId === msg.payload && item.source === DONE_WHEN_INBOX_SOURCE) resolveInboxItem(item.id);
      }
    }),
  ]).then((unlistens) => () => {
    untap();
    for (const u of unlistens) u();
  });
  return started;
}

export function _resetDoneWhenControllerForTest(): void {
  deps = null;
  started = null;
}
