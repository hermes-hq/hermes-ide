import { useState, useCallback, useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { SessionData } from "../state/SessionContext";
import { getContextPins, applyContext as apiApplyContext } from "../api/context";
import { assembleSessionContext } from "../api/projects";
import { getAllMemory } from "../api/memory";
import { structuralEqual, structuralClone } from "../utils/structuralEqual";

// ─── Re-export shared types for backward compatibility ──────────────
export type {
  ContextPin, ProjectContextInfo,
  ContextState, ContextLifecycleState, ContextManager, ApplyContextResult,
} from "../types/context";

import type {
  ContextState, ContextLifecycleState, ContextManager,
} from "../types/context";

/** Default token budget used when no project config overrides it */
export const DEFAULT_TOKEN_BUDGET = 4000;

function emptyContext(): ContextState {
  return {
    pinnedItems: [],
    memoryFacts: [],
    persistedMemory: [],
    realms: [],
    workspacePaths: [],
    workingDirectory: "",
    agent: null,
    model: null,
  };
}

/** Format ContextState as markdown for AI injection — exported for testing */
export function formatContextMarkdown(ctx: ContextState, version: number, executionMode: string): string {
  const lines: string[] = [];
  lines.push(`# Session Context (v${version})`);
  lines.push("");

  // Execution Mode (always shown — affects behavior regardless of agent)
  lines.push(`- Mode: ${executionMode}`);

  // Agent
  if (ctx.agent) {
    lines.push(`- Provider: ${ctx.agent}${ctx.model ? ` (${ctx.model})` : ""}`);
  }
  lines.push("");

  // Projects
  if (ctx.realms.length > 0) {
    lines.push("## Projects");
    for (const project of ctx.realms) {
      lines.push(`### ${project.realm_name} (${project.path})`);
      if (project.languages.length > 0) lines.push(`- Languages: ${project.languages.join(", ")}`);
      if (project.frameworks.length > 0) lines.push(`- Frameworks: ${project.frameworks.join(", ")}`);
      if (project.architecture_pattern) lines.push(`- Architecture: ${project.architecture_pattern}`);
      if (project.conventions.length > 0) lines.push(`- Conventions: ${project.conventions.join("; ")}`);
    }
    lines.push("");
  }

  // Pinned Context
  if (ctx.pinnedItems.length > 0) {
    lines.push("## Pinned Context");
    for (const pin of ctx.pinnedItems) {
      const scope = pin.session_id === null ? " (project)" : "";
      lines.push(`- [${pin.kind}] ${pin.label || pin.target}${scope}`);
    }
    lines.push("");
  }

  // Memory — persistedMemory (user-saved, authoritative) takes precedence over
  // memoryFacts (ephemeral session-level facts) when the same key exists in both.
  const allMemory = [
    ...ctx.persistedMemory.map((m) => ({ key: m.key, value: m.value })),
    ...ctx.memoryFacts.map((f) => ({ key: f.key, value: f.value })),
  ];
  if (allMemory.length > 0) {
    lines.push("## Memory");
    const seen = new Set<string>();
    for (const m of allMemory) {
      if (!seen.has(m.key)) {
        seen.add(m.key);
        lines.push(`- ${m.key} = ${m.value}`);
      }
    }
    lines.push("");
  }

  // Workspace
  lines.push("## Workspace");
  lines.push(`- Dir: ${ctx.workingDirectory}`);
  for (const p of ctx.workspacePaths) {
    lines.push(`- + ${p}`);
  }
  return lines.join("\n");
}

// Backward-compat alias — existing tests import `formatContext`
export const formatContext = formatContextMarkdown;

// ─── Hook ────────────────────────────────────────────────────────────

export function useContextState(session: SessionData | null, executionMode?: string): ContextManager {
  const [context, setContext] = useState<ContextState>(emptyContext);
  const [currentVersion, setCurrentVersion] = useState(0);
  const [injectedVersion, setInjectedVersion] = useState(0);
  const [lastInjectedAt, setLastInjectedAt] = useState<number | null>(null);
  const [lifecycle, setLifecycle] = useState<ContextLifecycleState>('clean');
  const [lastError, setLastError] = useState<string | null>(null);
  const [injectedContent, setInjectedContent] = useState<string | null>(null);
  const [tokenBudget, setTokenBudget] = useState(DEFAULT_TOKEN_BUDGET);
  const [estimatedTokens, setEstimatedTokens] = useState(0);

  const prevContextRef = useRef<ContextState>(emptyContext());
  const contextRef = useRef(context);
  contextRef.current = context;
  const versionRef = useRef(0);
  const lifecycleRef = useRef<ContextLifecycleState>('clean');

  // Keep lifecycle ref in sync — this is a SECONDARY sync.
  // The PRIMARY sync happens synchronously in applyContext() to prevent race conditions.
  // This effect ensures the ref stays correct for reads outside of applyContext.
  useEffect(() => {
    lifecycleRef.current = lifecycle;
  }, [lifecycle]);

  // ── Load initial state from backend ──
  // Track whether initial load has completed for this session
  const initialLoadDone = useRef(false);

  useEffect(() => {
    if (!session) return;
    initialLoadDone.current = false;
    const load = async () => {
      const initial = emptyContext();
      // Use sessionRef for fresh data — the closed-over `session` may be stale
      // if SESSION_UPDATED events fired during the async fetches above.
      const latestInit = sessionRef.current ?? session;
      initial.workingDirectory = latestInit.working_directory;
      initial.workspacePaths = latestInit.workspace_paths;
      initial.agent = latestInit.detected_agent?.name ?? null;
      initial.model = latestInit.detected_agent?.model ?? null;
      initial.memoryFacts = latestInit.metrics.memory_facts;

      // Fetch pins (session + project-scoped)
      try {
        initial.pinnedItems = await getContextPins(session.id, null);
      } catch (err) { console.warn("[useContextState] Failed to load pins:", err); }

      // Fetch project context (includes token budget and estimated tokens)
      try {
        const ctx = await assembleSessionContext(session.id, DEFAULT_TOKEN_BUDGET);
        initial.realms = ctx.realms;
        if (ctx.token_budget != null) setTokenBudget(ctx.token_budget);
        if (ctx.estimated_tokens != null) setEstimatedTokens(ctx.estimated_tokens);
      } catch (err) { console.warn("[useContextState] Failed to assemble session context:", err); }

      // Fetch persisted memory (global + project-scoped via backend merge)
      try {
        const entries = await getAllMemory("global", "global");
        initial.persistedMemory = entries;
      } catch (err) { console.warn("[useContextState] Failed to load persisted memory:", err); }

      // Set prevContextRef BEFORE setContext so the version-tracking effect
      // sees structuralEqual(initial, initial) → true → no version bump.
      // This prevents the initial load from marking the context dirty.
      prevContextRef.current = structuralClone(initial);
      setContext(initial);
      // Reset versions on session change — initial load is NOT a user change
      versionRef.current = 0;
      setCurrentVersion(0);
      setInjectedVersion(0);
      setLastInjectedAt(null);
      setLifecycle('clean');
      setLastError(null);
      setInjectedContent(null);
      initialLoadDone.current = true;
      // Also reset the sync key so the session sync effect doesn't re-apply
      // the same data that was just loaded
      // Use sessionRef for fresh data — prevents sync key mismatch when
      // SESSION_UPDATED events updated the session during async load.
      const latest = sessionRef.current ?? session;
      prevSyncKeyRef.current = JSON.stringify({
        wd: latest.working_directory,
        wp: latest.workspace_paths,
        agent: latest.detected_agent?.name ?? null,
        model: latest.detected_agent?.model ?? null,
        mf: latest.metrics.memory_facts,
      });
    };

    load();
  }, [session?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Keep context in sync with live session data (reactive updates) ──
  // We use a ref to track the previous serialized key so the effect only
  // triggers setContext when session fields actually change — not on every
  // SESSION_UPDATED event (which creates new object references even when
  // values are identical).
  const prevSyncKeyRef = useRef("");

  useEffect(() => {
    if (!session) return;
    // GUARD: Do NOT sync before initial load completes — the initial load
    // sets prevSyncKeyRef and prevContextRef atomically. If the sync effect
    // fires before that, it creates a context change from emptyContext() →
    // session data, which triggers a phantom version bump → dirty → injection.
    if (!initialLoadDone.current) {
      return;
    }
    const key = JSON.stringify({
      wd: session.working_directory,
      wp: session.workspace_paths,
      agent: session.detected_agent?.name ?? null,
      model: session.detected_agent?.model ?? null,
      mf: session.metrics.memory_facts,
    });
    if (key === prevSyncKeyRef.current) {
      return; // no real change — skip
    }
    prevSyncKeyRef.current = key;
    setContext((prev) => ({
      ...prev,
      workingDirectory: session.working_directory,
      workspacePaths: session.workspace_paths,
      agent: session.detected_agent?.name ?? null,
      model: session.detected_agent?.model ?? null,
      memoryFacts: session.metrics.memory_facts,
    }));
  }, [session]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Listen for project changes ──
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    listen(`session-realms-updated-${session.id}`, () => {
      if (cancelled) return;
      // GUARD: Ignore project events before initial load completes — the initial
      // load fetches project data. If an event fires first, it creates a
      // context change from emptyContext → project data → phantom version bump → dirty.
      if (!initialLoadDone.current) {
        return;
      }
      assembleSessionContext(session.id, DEFAULT_TOKEN_BUDGET)
        .then((ctx) => {
          if (!cancelled) {
            setContext((prev) => {
              if (structuralEqual(prev.realms, ctx.realms)) return prev; // no-op if unchanged
              return { ...prev, realms: ctx.realms };
            });
            if (ctx.token_budget != null) setTokenBudget(ctx.token_budget);
            if (ctx.estimated_tokens != null) setEstimatedTokens(ctx.estimated_tokens);
          }
        })
        .catch((err) => console.warn("[useContextState] Failed to refresh projects:", err));
    }).then((u) => {
      if (cancelled) { u(); } else { unlisten = u; }
    });
    return () => { cancelled = true; unlisten?.(); };
  }, [session?.id]);

  // ── Listen for pin changes (backend now emits this event) ──
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    listen(`context-pins-changed-${session.id}`, () => {
      if (cancelled) return;
      // GUARD: Ignore pin events before initial load — same reason as project guard.
      if (!initialLoadDone.current) {
        return;
      }
      getContextPins(session.id, null)
        .then((pins) => {
          if (!cancelled) setContext((prev) => {
            if (structuralEqual(prev.pinnedItems, pins)) return prev;
            return { ...prev, pinnedItems: pins };
          });
        })
        .catch((err) => console.warn("[useContextState] Failed to refresh pins:", err));
    }).then((u) => {
      if (cancelled) { u(); } else { unlisten = u; }
    });
    return () => { cancelled = true; unlisten?.(); };
  }, [session?.id]);

  // ── Auto-increment version when context changes → mark dirty ──
  useEffect(() => {
    const isEqual = structuralEqual(context, prevContextRef.current);
    if (isEqual) {
      return;
    }
    prevContextRef.current = structuralClone(context);
    versionRef.current += 1;
    setCurrentVersion(versionRef.current);
    // Mark dirty if we've already had at least one state load
    if (versionRef.current > 0) {
      setLifecycle((prev) => {
        const next = prev === 'applying' ? prev : 'dirty';
        return next;
      });
    }
  }, [context]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Apply: inject current context to AI agent (async, backend-authoritative) ──
  const sessionRef = useRef(session);
  sessionRef.current = session;

  const liveMode = executionMode || "manual";

  const applyContext = useCallback(async () => {
    const sess = sessionRef.current;
    if (!sess) return;

    // Guard: prevent double-apply
    if (lifecycleRef.current === 'applying') {
      return;
    }

    // CRITICAL: Update ref SYNCHRONOUSLY before any async work.
    // The useEffect-based sync (lifecycle → lifecycleRef) only runs after the
    // NEXT render, creating a race window where concurrent callers both read
    // 'clean' and both proceed. This synchronous write closes that window.
    lifecycleRef.current = 'applying';
    setLifecycle('applying');
    setLastError(null);

    try {
      const APPLY_TIMEOUT_MS = 15_000;
      const result = await Promise.race([
        apiApplyContext(sess.id, liveMode),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Context apply timed out after 15s')), APPLY_TIMEOUT_MS)
        ),
      ]);

      setInjectedVersion(result.version);
      setInjectedContent(result.content);
      setLastInjectedAt(Date.now());
      setTokenBudget(result.token_budget);
      setEstimatedTokens(result.estimated_tokens);

      // Sync currentVersion to match backend version
      versionRef.current = result.version;
      setCurrentVersion(result.version);

      lifecycleRef.current = 'clean';
      setLifecycle('clean');

      // Absorb any context drift that occurred during the async apply window.
      // Without this, metrics changes triggered by the AI's response to the nudge
      // would be detected as new changes and re-mark the context dirty.
      prevContextRef.current = structuralClone(contextRef.current);

      // If nudge had a warning but file was written, show non-fatal info
      if (result.nudge_error && !result.nudge_sent) {
        setLastError(`Context file updated but agent not notified: ${result.nudge_error}`);
      }
    } catch (err) {
      lifecycleRef.current = 'apply_failed';
      setLifecycle('apply_failed');
      setLastError(err instanceof Error ? err.message : String(err));
    }
  }, [liveMode]);

  // ── Acknowledge injection (startup command already handled context) ──
  const acknowledgeInjection = useCallback(() => {
    // Mark context as clean WITHOUT calling the backend API.
    // The backend startup command already includes $HERMES_CONTEXT, so the
    // first auto-apply trigger is redundant. This updates version tracking
    // to prevent the redundant nudge.
    const ver = versionRef.current;
    setInjectedVersion(ver);
    lifecycleRef.current = 'clean';
    setLifecycle('clean');
    prevContextRef.current = structuralClone(contextRef.current);
  }, [session?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Format context for preview ──
  const formatContextPreview = useCallback(() => {
    return formatContextMarkdown(context, currentVersion, liveMode);
  }, [context, currentVersion, liveMode]);

  // ── Copy context to clipboard ──
  const copyToClipboard = useCallback(async () => {
    const text = formatContextPreview();
    if (text) await navigator.clipboard.writeText(text);
  }, [formatContextPreview]);

  return {
    context,
    currentVersion,
    injectedVersion,
    lastInjectedAt,
    lifecycle,
    lastError,
    injectedContent,
    tokenBudget,
    estimatedTokens,
    applyContext,
    acknowledgeInjection,
    formatContext: formatContextPreview,
    copyToClipboard,
  };
}
