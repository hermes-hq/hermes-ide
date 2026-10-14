import "../styles/components/SessionActionsBar.css";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useI18n } from "../i18n/I18nProvider";
import { Button } from "./ui/Button";
import { Chip } from "./ui/Chip";
import { lazyView } from "../utils/lazyView";
import { useSessionEvents } from "../agent/contract/sessionEventStore";
import { useSessionStatus } from "../agent/status/attentionStore";
import { contextGauge } from "../utils/contextGauge";
import {
  builtinCommands,
  chipsFor,
  contextChip,
  type SessionActionId,
  type SessionCommand,
} from "../sessionActions/catalog";
import { commandDescription, commandLabel, actionLabel } from "../sessionActions/text";
import { usePinnedActions } from "../sessionActions/pins";
import { stateChipFor, takesCommands, type StateChip } from "../sessionActions/state";
import { useBarLayout, type BarLayout } from "../sessionActions/layout";
import { commandCount } from "../sessionActions/sections";
import { knownDiscovered } from "../sessionActions/discovery";
import { onSessionCommandRequest } from "../sessionActions/requests";
import { registerSessionAgent } from "../sessionActions/init";
import { startCommandMessages } from "../sessionActions/messages";
import { actionIcon, resumeIcon, signInIcon } from "../sessionActions/icons";
import type { RunOutcome } from "../sessionActions/run";
import type { CommandSend } from "../sessionActions/recent";

// The Commands list (and its strings) loads the first time it opens.
const SessionCommandsPopover = lazyView("SessionCommandsPopover", () => import("./SessionCommandsPopover").then((m) => m.SessionCommandsPopover));

/** How long an outcome notice stays (ms). */
const NOTICE_MS = 5000;

/** What the composer (Agent view) does instead of a command for some actions. */
export type ActionOverride = { hidden: true } | { pressed: boolean; onPress: () => void };

export interface SessionActionsRowProps {
  sessionId: string;
  agentId: string | null;
  agentName: string;
  surface: "terminal" | "agent";
  /** The session's folder (the person's own commands are read there). */
  cwd: string | null;
  /** Leading controls (the terminal's Prompts button), given the bar's form. */
  leading?: (layout: BarLayout) => ReactNode;
  /** Runs one command the way this surface sends it. */
  run: (cmd: SessionCommand, via: CommandSend["via"]) => Promise<RunOutcome>;
  /** Whether a command may run now (the agent waits). Default: from the session's status. */
  ready?: boolean;
  /** Agent view: actions the composer itself offers (model: its own chip; plan: its permission mode). */
  actionOverride?: (action: SessionActionId) => ActionOverride | undefined;
  /** Agent view: the live slash commands the agent reported. */
  liveCommands?: readonly SessionCommand[];
  /** A short pane: the collapsed form, whatever the width. */
  forceCollapsed?: boolean;
  onSignIn?: () => void;
  onResume?: () => void;
  className?: string;
}

interface Notice {
  text: string;
  tone: "info" | "warn";
}

/**
 * The session's action row: the pinned actions as chips (stable order, never
 * reordered by use), the context gauge, at most one state chip (Sign in,
 * Resume, Usage) and the Commands list. Shared by the terminal pane's bar
 * and the Agent view's composer; each passes how it sends a command.
 */
export function SessionActionsRow({
  sessionId,
  agentId,
  agentName,
  surface,
  cwd,
  leading,
  run,
  ready: readyProp,
  actionOverride,
  liveCommands,
  forceCollapsed = false,
  onSignIn,
  onResume,
  className,
}: SessionActionsRowProps) {
  const { t } = useI18n();
  const status = useSessionStatus(sessionId);
  const events = useSessionEvents(sessionId);
  const pinned = usePinnedActions();
  const rowRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [confirmText, setConfirmText] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => startCommandMessages(), []);
  useEffect(() => (agentId ? registerSessionAgent(sessionId, agentId, cwd) : undefined), [sessionId, agentId, cwd]);
  useEffect(() => () => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
  }, []);

  const ready = readyProp ?? takesCommands(status.kind);
  const waitHint = t("sessionActions.availableWhenWaiting", { agent: agentName });

  const builtin = builtinCommands(agentId);
  const skip = useMemo(() => {
    const s = new Set<SessionActionId>();
    for (const a of pinned) {
      const o = actionOverride?.(a);
      if (o && "hidden" in o) s.add(a);
    }
    return s;
  }, [actionOverride, pinned]);
  const chips = useMemo(() => chipsFor(agentId, pinned, skip), [agentId, pinned, skip]);
  const gauge = contextGauge(events.context);
  const context = pinned.includes("context") ? contextChip(agentId, gauge ? gauge.percent : null) : null;
  const state: StateChip | null = stateChipFor({
    agentId,
    surface,
    status: status.kind,
    rejection: events.rejection?.reason ?? null,
    limited: events.limit !== null,
    helperEnded: !!onResume,
    canSignIn: !!onSignIn,
  });
  const count = commandCount(builtin, knownDiscovered(agentId ?? "", cwd), liveCommands);

  const show = useCallback((text: string, tone: Notice["tone"] = "info") => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    setNotice({ text, tone });
    noticeTimer.current = setTimeout(() => setNotice(null), NOTICE_MS);
  }, []);

  const execute = useCallback(
    async (cmd: SessionCommand, via: CommandSend["via"]) => {
      if (!ready) {
        show(waitHint, "warn");
        return;
      }
      const outcome = await run(cmd, via);
      switch (outcome) {
        case "sent":
          setNotice(null);
          break;
        case "draft":
          show(t("sessionActions.notice.draft"), "warn");
          break;
        case "busy":
          show(waitHint, "warn");
          break;
        case "no_agent":
          show(t("sessionActions.notice.noAgent", { agent: agentName }), "warn");
          break;
        default:
          show(t("sessionActions.notice.failed"), "warn");
      }
    },
    [ready, run, show, t, waitHint, agentName],
  );

  // The command palette hands its pick to this bar (same rules as a click).
  useEffect(
    () =>
      onSessionCommandRequest(sessionId, (text) => {
        const cmd = [...builtin, ...(liveCommands ?? []), ...knownDiscovered(agentId ?? "", cwd)].find((c) => c.text === text);
        if (!cmd) return;
        if (cmd.destructive) {
          setConfirmText(cmd.text);
          setOpen(true);
          return;
        }
        void execute(cmd, "palette");
      }),
    [sessionId, builtin, liveCommands, agentId, cwd, execute],
  );

  const signature = [
    pinned.join(","),
    chips.map((c) => commandLabel(c.command, t)).join("|"),
    context ? (context.high ? "hi" : "ctx") : "",
    state?.kind ?? "",
    notice?.text ?? "",
  ].join("/");
  const layout = useBarLayout(rowRef, signature, forceCollapsed);
  const iconsOnly = layout !== "full";

  const closePopover = useCallback((returnFocus: boolean) => {
    setOpen(false);
    setConfirmText(null);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  const chipTitle = (cmd: SessionCommand) => (ready ? `${commandLabel(cmd, t)} (${cmd.text}) — ${commandDescription(cmd, t)}` : waitHint);

  const contextNode = context ? (
    (() => {
      const label = context.high
        ? t("sessionActions.compactPercent", { percent: context.percent })
        : t("sessionActions.contextPercent", { percent: context.percent });
      const title = context.runs
        ? `${label} — ${commandDescription(context.runs, t)}${ready ? "" : ` · ${waitHint}`}`
        : label;
      const body = (
        <>
          {actionIcon(context.high ? "compact" : "context")}
          {(!iconsOnly || context.high) && <span className="sab-chip-label">{label}</span>}
          {iconsOnly && !context.high && <span className="sab-chip-label">{context.percent}%</span>}
        </>
      );
      return context.runs ? (
        <span className="sab-chip-wrap" title={title}>
          <Chip
            size="sm"
            tone={context.high ? "warning" : "neutral"}
            className="sab-chip sab-context"
            data-session-action={context.high ? "compact" : "context"}
            data-percent={context.percent}
            aria-label={label}
            disabled={!ready}
            onClick={() => void execute(context.runs as SessionCommand, "chip")}
          >
            {body}
          </Chip>
        </span>
      ) : (
        <Chip size="sm" tone={context.high ? "warning" : "neutral"} className="sab-chip sab-context" data-percent={context.percent} title={title} aria-label={label}>
          {body}
        </Chip>
      );
    })()
  ) : null;

  const chipNodes = chips.map(({ action, command }) => {
    const override = actionOverride?.(action);
    const label = actionLabel(action, t);
    if (override && "pressed" in override) {
      return (
        <span className="sab-chip-wrap" key={action} title={commandDescription(command, t)}>
          <Chip
            size="sm"
            className="sab-chip"
            selected={override.pressed}
            onToggle={() => override.onPress()}
            buttonAttrs={{ "data-session-action": action, "aria-label": label } as Record<string, string>}
          >
            {actionIcon(action)}
            {!iconsOnly && <span className="sab-chip-label">{label}</span>}
          </Chip>
        </span>
      );
    }
    return (
      <span className="sab-chip-wrap" key={action} title={chipTitle(command)}>
        <Chip
          size="sm"
          className="sab-chip"
          data-session-action={action}
          aria-label={label}
          disabled={!ready}
          onClick={() => void execute(command, "chip")}
        >
          {actionIcon(action)}
          {!iconsOnly && <span className="sab-chip-label">{label}</span>}
        </Chip>
      </span>
    );
  });

  const stateNode = state ? (
    (() => {
      if (state.kind === "sign_in") {
        const label = t("sessionActions.state.signIn");
        return (
          <Chip size="sm" className="sab-chip sab-state" data-session-state="sign_in" title={t("sessionActions.state.signInTitle", { agent: agentName })} aria-label={label} onClick={() => onSignIn?.()}>
            {signInIcon()}
            <span className="sab-chip-label">{label}</span>
          </Chip>
        );
      }
      if (state.kind === "resume") {
        const label = t("sessionActions.state.resume");
        return (
          <Chip size="sm" className="sab-chip sab-state" data-session-state="resume" title={t("sessionActions.state.resumeTitle", { agent: agentName })} aria-label={label} onClick={() => onResume?.()}>
            {resumeIcon()}
            <span className="sab-chip-label">{label}</span>
          </Chip>
        );
      }
      const label = t("sessionActions.state.usage");
      return (
        <span className="sab-chip-wrap" title={ready ? t("sessionActions.state.usageTitle", { agent: agentName }) : waitHint}>
          <Chip size="sm" tone="warning" className="sab-chip sab-state" data-session-state="usage" aria-label={label} disabled={!ready} onClick={() => void execute(state.command, "chip")}>
            {actionIcon("usage")}
            <span className="sab-chip-label">{label}</span>
          </Chip>
        </span>
      );
    })()
  ) : null;

  const commandsLabel = t("sessionActions.commands");
  const commandsTitle = t("sessionActions.commandsTitle", { agent: agentName, count });
  const trigger = count > 0 && (
    <Button
      ref={triggerRef}
      size="sm"
      variant="quiet"
      className="sab-commands"
      data-session-commands=""
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-label={commandsTitle}
      title={commandsTitle}
      // Not the pane's press-to-focus-the-terminal: the list takes the keyboard.
      onMouseDown={(e) => e.stopPropagation()}
      onClick={() => (open ? closePopover(false) : setOpen(true))}
    >
      <span className="sab-slash" aria-hidden="true">/</span> <span>{layout === "collapsed" ? count : commandsLabel}</span>
    </Button>
  );

  return (
    <div
      ref={rowRef}
      className={["session-actions-row", className].filter(Boolean).join(" ")}
      data-layout={layout}
      data-session-actions={sessionId}
      role="toolbar"
      aria-label={t("sessionActions.toolbarLabel", { agent: agentName })}
    >
      {leading?.(layout)}
      {layout !== "collapsed" && (contextNode || chipNodes.length > 0) && (
        <div className="sab-chips">
          {contextNode}
          {chipNodes}
        </div>
      )}
      <div className="sab-spacer" />
      {notice && (
        <span className={`sab-notice sab-notice-${notice.tone}`} role="status" title={notice.text} data-session-notice="">
          {notice.text}
        </span>
      )}
      {stateNode}
      {trigger}
      {open && triggerRef.current && (
        <Suspense fallback={null}>
        <SessionCommandsPopover
          anchorRef={triggerRef}
          sessionId={sessionId}
          agentId={agentId}
          agentName={agentName}
          cwd={cwd}
          surface={surface}
          liveCommands={liveCommands}
          ready={ready}
          waitHint={waitHint}
          initialConfirm={confirmText}
          onRun={(cmd) => {
            closePopover(true);
            void execute(cmd, "list");
          }}
          onClose={closePopover}
        />
        </Suspense>
      )}
    </div>
  );
}
