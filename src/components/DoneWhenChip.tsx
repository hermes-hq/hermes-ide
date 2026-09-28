import "../styles/components/DoneWhenChip.css";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n/I18nProvider";
import { useDoneWhen } from "../doneWhen/store";
import { agentOwnsTerminal, runChecksNow, sendFailuresBack } from "../doneWhen/controller";
import { failedCommands, isPassed, type CheckRecord } from "../doneWhen/types";

type ChipState = "running" | "passed" | "failed" | "retrying" | "check_failed" | "error";

/** What the chip says about a session's latest result. */
export function chipState(last: CheckRecord | null, running: boolean): ChipState | null {
  if (running) return "running";
  if (!last) return null;
  const run = last.run;
  if (run.state === "passed") return "passed";
  if (run.state === "error") return "error";
  if (run.state !== "failed") return null;
  if (last.check_failed) return "check_failed";
  if (run.blocking && !run.final) return "retrying";
  return "failed";
}

/**
 * Done-When chip in a pane header (F27): "tests ✓" when the repository's
 * checks pass, what failed when they do not. Clicking it lists every check
 * with the end of the failing ones' output, and offers "Send failures
 * back" (pastes them into the agent's terminal, only while an agent runs
 * there) and "Run checks again".
 * Nothing renders until a check ran for the session.
 */
export function DoneWhenChip({ sessionId }: { sessionId: string }) {
  const { t } = useI18n();
  const { last, running, sentAt } = useDoneWhen(sessionId);
  const [open, setOpen] = useState(false);
  const [sending, setSending] = useState(false);
  // Whether an agent owns the terminal, asked each time the list opens or
  // shows a new result; null until answered.
  const [agentUp, setAgentUp] = useState<boolean | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    let current = true;
    setAgentUp(null);
    void agentOwnsTerminal(sessionId).then((up) => {
      if (current) setAgentUp(up);
    });
    return () => {
      current = false;
    };
  }, [open, last, sessionId]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const state = chipState(last, running);
  if (!state) return null;
  const run = last?.run ?? null;
  const total = run?.commands.length ?? 0;
  const failed = run ? failedCommands(run).length : 0;

  let label: string;
  switch (state) {
    case "running":
      label = t("doneWhen.chip.running");
      break;
    case "passed":
      label = t("doneWhen.chip.passed");
      break;
    case "retrying":
      label = t("doneWhen.chip.retrying", { attempt: run?.attempt ?? 1, max: run?.max_attempts ?? 3 });
      break;
    case "check_failed":
      label = t("doneWhen.chip.checkFailed");
      break;
    case "error":
      label = t("doneWhen.chip.error");
      break;
    default:
      label = t("doneWhen.chip.failed", { failed, total });
  }
  const title = run?.source ? t("doneWhen.chip.title", { path: run.source.path }) : label;
  const failing = run?.state === "failed" && !(run.blocking && !run.final);
  const canSend = failing && agentUp === true;

  const onSend = async () => {
    setSending(true);
    try {
      if ((await sendFailuresBack(sessionId)) === "no_agent") setAgentUp(false);
    } catch (e) {
      console.warn("[done-when] could not send the failures back:", e);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="done-when" ref={rootRef}>
      <button
        type="button"
        className="done-when-chip"
        data-state={state}
        title={title}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={(e) => {
          e.stopPropagation();
          if (last) setOpen((o) => !o);
        }}
      >
        {label}
      </button>
      {open && last && run && (
        <div className="done-when-popover" role="dialog" aria-label={title} onMouseDown={(e) => e.stopPropagation()}>
          <div className="done-when-popover-title">{title}</div>
          {run.state === "error" && <div className="done-when-error">{run.error}</div>}
          <ul className="done-when-commands">
            {run.commands.map((c, i) => {
              const ok = isPassed(c);
              const how = ok
                ? t("doneWhen.popover.ok")
                : c.timed_out
                  ? t("doneWhen.popover.timedOut")
                  : t("doneWhen.popover.exit", { code: c.exit_code ?? "?" });
              return (
                <li key={i} className="done-when-command" data-ok={ok ? "true" : "false"}>
                  <div className="done-when-command-line">
                    <code>{c.command}</code>
                    <span className="done-when-command-result">{how}</span>
                  </div>
                  {!ok && c.output_tail.trim() && <pre className="done-when-output">{c.output_tail.trimEnd()}</pre>}
                </li>
              );
            })}
          </ul>
          {last.hook && run.state === "failed" && (
            <div className="done-when-note">{t("doneWhen.popover.hookNote", { max: run.max_attempts ?? 3 })}</div>
          )}
          {failing && agentUp === false && (
            <div className="done-when-note done-when-note-no-agent">{t("doneWhen.popover.noAgent")}</div>
          )}
          <div className="done-when-actions">
            {canSend && (
              <button type="button" className="done-when-send" disabled={sending} onClick={() => void onSend()}>
                {sentAt ? t("doneWhen.popover.sent") : t("doneWhen.popover.sendBack")}
              </button>
            )}
            <button
              type="button"
              className="done-when-rerun"
              disabled={running}
              onClick={() => void runChecksNow(sessionId, "manual")}
            >
              {t("doneWhen.popover.rerun")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
