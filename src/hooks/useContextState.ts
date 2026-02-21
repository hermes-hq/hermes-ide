import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { listen } from "@tauri-apps/api/event";
import { SessionData } from "../state/SessionContext";
import { getContextPins, getErrorResolutions, applyContext as apiApplyContext } from "../api/context";
import { assembleSessionContext } from "../api/realms";
import { getAllMemory } from "../api/memory";

// ─── Re-export shared types for backward compatibility ──────────────
export type {
  ContextPin, RealmContextInfo, ErrorResolution,
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
    errorResolutions: [],
    filesTouched: [],
    recentErrors: [],
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
    for (const realm of ctx.realms) {
      lines.push(`### ${realm.realm_name} (${realm.path})`);
      if (realm.languages.length > 0) lines.push(`- Languages: ${realm.languages.join(", ")}`);
      if (realm.frameworks.length > 0) lines.push(`- Frameworks: ${realm.frameworks.join(", ")}`);
      if (realm.architecture_pattern) lines.push(`- Architecture: ${realm.architecture_pattern}`);
      if (realm.conventions.length > 0) lines.push(`- Conventions: ${realm.conventions.join("; ")}`);
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

  // Error Resolutions
  if (ctx.errorResolutions.length > 0) {
    lines.push("## Known Error Resolutions");
    for (const er of ctx.errorResolutions) {
      lines.push(`- "${er.fingerprint}" -> ${er.resolution} (seen ${er.occurrence_count}x)`);
    }
    lines.push("");
  }

  // Workspace
  lines.push("## Workspace");
  lines.push(`- Dir: ${ctx.workingDirectory}`);
  for (const p of ctx.workspacePaths) {
    lines.push(`- + ${p}`);
  }
  if (ctx.filesTouched.length > 0) {
    lines.push(`- Files touched: ${ctx.filesTouched.join(", ")}`);
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

  const prevContextJson = useRef<string>("");
  const versionRef = useRef(0);
  const lifecycleRef = useRef<ContextLifecycleState>('clean');

  // Keep lifecycle ref in sync
  useEffect(() => {
    lifecycleRef.current = lifecycle;
  }, [lifecycle]);

  // ── Load initial state from backend ──
  useEffect(() => {
    if (!session) return;

    const load = async () => {
      const initial = emptyContext();
      initial.workingDirectory = session.working_directory;
      initial.workspacePaths = session.workspace_paths;
      initial.agent = session.detected_agent?.name ?? null;
      initial.model = session.detected_agent?.model ?? null;
      initial.memoryFacts = session.metrics.memory_facts;
      initial.filesTouched = session.metrics.files_touched;
      initial.recentErrors = session.metrics.recent_errors;

      // Fetch pins (session + project-scoped)
      try {
        initial.pinnedItems = await getContextPins(session.id, null);
      } catch (err) { console.warn("[useContextState] Failed to load pins:", err); }

      // Fetch error resolutions
      try {
        const patterns = await getErrorResolutions(session.working_directory, 10);
        initial.errorResolutions = patterns
          .filter((p) => p.resolution)
          .map((p) => ({ fingerprint: p.fingerprint, resolution: p.resolution!, occurrence_count: p.occurrence_count }));
      } catch (err) { console.warn("[useContextState] Failed to load error resolutions:", err); }

      // Fetch realm context (includes token budget and estimated tokens)
      try {
        const ctx = await assembleSessionContext(session.id, DEFAULT_TOKEN_BUDGET);
        initial.realms = ctx.realms;
        if (ctx.token_budget) setTokenBudget(ctx.token_budget);
        if (ctx.estimated_tokens) setEstimatedTokens(ctx.estimated_tokens);
      } catch (err) { console.warn("[useContextState] Failed to assemble session context:", err); }

      // Fetch persisted memory (global + project-scoped via backend merge)
      try {
        const entries = await getAllMemory("global", "global");
        initial.persistedMemory = entries;
      } catch (err) { console.warn("[useContextState] Failed to load persisted memory:", err); }

      setContext(initial);
      // Reset versions on session change
      versionRef.current = 0;
      setCurrentVersion(0);
      setInjectedVersion(0);
      setLastInjectedAt(null);
      setLifecycle('clean');
      setLastError(null);
      setInjectedContent(null);
      prevContextJson.current = JSON.stringify(initial);
    };

    load();
  }, [session?.id]);

  // ── Keep context in sync with live session data (reactive updates) ──
  // Serialize relevant session fields to a stable string so the effect only fires
  // when the actual values change, not on every SESSION_UPDATED event (which
  // creates new array/object references even when values are identical).
  const sessionSyncKey = useMemo(() => {
    if (!session) return "";
    return JSON.stringify({
      wd: session.working_directory,
      wp: session.workspace_paths,
      agent: session.detected_agent?.name ?? null,
      model: session.detected_agent?.model ?? null,
      mf: session.metrics.memory_facts,
      ft: session.metrics.files_touched,
      re: session.metrics.recent_errors,
    });
  }, [session]);

  useEffect(() => {
    if (!session) return;
    setContext((prev) => ({
      ...prev,
      workingDirectory: session.working_directory,
      workspacePaths: session.workspace_paths,
      agent: session.detected_agent?.name ?? null,
      model: session.detected_agent?.model ?? null,
      memoryFacts: session.metrics.memory_facts,
      filesTouched: session.metrics.files_touched,
      recentErrors: session.metrics.recent_errors,
    }));
  }, [sessionSyncKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Listen for realm changes ──
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    listen(`session-realms-updated-${session.id}`, () => {
      if (cancelled) return;
      assembleSessionContext(session.id, DEFAULT_TOKEN_BUDGET)
        .then((ctx) => {
          if (!cancelled) {
            setContext((prev) => ({ ...prev, realms: ctx.realms }));
            if (ctx.token_budget) setTokenBudget(ctx.token_budget);
            if (ctx.estimated_tokens) setEstimatedTokens(ctx.estimated_tokens);
          }
        })
        .catch((err) => console.warn("[useContextState] Failed to refresh realms:", err));
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
      getContextPins(session.id, null)
        .then((pins) => {
          if (!cancelled) setContext((prev) => ({ ...prev, pinnedItems: pins }));
        })
        .catch((err) => console.warn("[useContextState] Failed to refresh pins:", err));
    }).then((u) => {
      if (cancelled) { u(); } else { unlisten = u; }
    });
    return () => { cancelled = true; unlisten?.(); };
  }, [session?.id]);

  // ── Auto-increment version when context changes → mark dirty ──
  useEffect(() => {
    const json = JSON.stringify(context);
    if (json !== prevContextJson.current) {
      prevContextJson.current = json;
      versionRef.current += 1;
      setCurrentVersion(versionRef.current);
      // Mark dirty if we've already had at least one state load
      if (versionRef.current > 0) {
        setLifecycle((prev) => prev === 'applying' ? prev : 'dirty');
      }
    }
  }, [context]);

  // ── Apply: inject current context to AI agent (async, backend-authoritative) ──
  const sessionRef = useRef(session);
  sessionRef.current = session;

  const liveMode = executionMode || "manual";

  const applyContext = useCallback(async () => {
    const sess = sessionRef.current;
    if (!sess) return;

    // Guard: prevent double-apply
    if (lifecycleRef.current === 'applying') return;

    setLifecycle('applying');
    setLastError(null);

    try {
      const result = await apiApplyContext(sess.id, liveMode);

      setInjectedVersion(result.version);
      setInjectedContent(result.content);
      setLastInjectedAt(Date.now());
      setTokenBudget(result.token_budget);
      setEstimatedTokens(result.estimated_tokens);

      // Sync currentVersion to match backend version
      versionRef.current = result.version;
      setCurrentVersion(result.version);

      setLifecycle('clean');

      // If nudge had a warning but file was written, show non-fatal info
      if (result.nudge_error && !result.nudge_sent) {
        setLastError(`Context file updated but agent not notified: ${result.nudge_error}`);
      }
    } catch (err) {
      setLifecycle('apply_failed');
      setLastError(err instanceof Error ? err.message : String(err));
    }
  }, [liveMode]);

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
    formatContext: formatContextPreview,
    copyToClipboard,
  };
}
