import { useState, useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { SessionData, MemoryFact } from "../state/SessionContext";

// ─── Context State (the versioned execution contract) ────────────────

export interface ContextPin {
  id: number;
  session_id: string | null;
  project_id: string | null;
  kind: string;
  target: string;
  label: string | null;
  priority: number;
  created_at: number;
}

export interface RealmContextInfo {
  realm_id: string;
  realm_name: string;
  path: string;
  languages: string[];
  frameworks: string[];
  architecture_pattern: string | null;
  architecture_layers: string[];
  conventions: string[];
  scan_status: string;
}

export interface ErrorResolution {
  fingerprint: string;
  resolution: string;
  occurrence_count: number;
}

export interface ContextState {
  pinnedItems: ContextPin[];
  memoryFacts: MemoryFact[];
  persistedMemory: { key: string; value: string; source: string }[];
  realms: RealmContextInfo[];
  workspacePaths: string[];
  workingDirectory: string;
  agent: string | null;
  model: string | null;
  errorResolutions: ErrorResolution[];
  filesTouched: string[];
  recentErrors: string[];
}

export type ContextLifecycleState = 'clean' | 'dirty' | 'applying' | 'apply_failed';

export interface ContextManager {
  context: ContextState;
  currentVersion: number;
  injectedVersion: number;
  lastInjectedAt: number | null;
  lifecycle: ContextLifecycleState;
  lastError: string | null;
  injectedContent: string | null;
  applyContext: () => Promise<void>;
  formatContext: () => string;
}

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
      lines.push(`- [${pin.kind}] ${pin.label || pin.target}`);
    }
    lines.push("");
  }

  // Memory
  const allMemory = [
    ...ctx.memoryFacts.map((f) => ({ key: f.key, value: f.value })),
    ...ctx.persistedMemory.map((m) => ({ key: m.key, value: m.value })),
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

// ─── Backend apply result type ───────────────────────────────────────

interface ApplyContextResult {
  version: number;
  content: string;
  file_path: string;
  nudge_sent: boolean;
  nudge_error: string | null;
  estimated_tokens: number;
}

// ─── Hook ────────────────────────────────────────────────────────────

export function useContextState(session: SessionData | null, executionMode?: string): ContextManager {
  const [context, setContext] = useState<ContextState>(emptyContext);
  const [currentVersion, setCurrentVersion] = useState(0);
  const [injectedVersion, setInjectedVersion] = useState(0);
  const [lastInjectedAt, setLastInjectedAt] = useState<number | null>(null);
  const [lifecycle, setLifecycle] = useState<ContextLifecycleState>('clean');
  const [lastError, setLastError] = useState<string | null>(null);
  const [injectedContent, setInjectedContent] = useState<string | null>(null);

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

      // Fetch pins
      try {
        const pins = await invoke("get_context_pins", { sessionId: session.id, projectId: null }) as ContextPin[];
        initial.pinnedItems = pins;
      } catch (err) { console.warn("[useContextState] Failed to load pins:", err); }

      // Fetch error resolutions
      try {
        const patterns = await invoke("get_error_resolutions", { projectId: session.working_directory, limit: 10 }) as {
          fingerprint: string; resolution: string | null; occurrence_count: number;
        }[];
        initial.errorResolutions = patterns
          .filter((p) => p.resolution)
          .map((p) => ({ fingerprint: p.fingerprint, resolution: p.resolution!, occurrence_count: p.occurrence_count }));
      } catch (err) { console.warn("[useContextState] Failed to load error resolutions:", err); }

      // Fetch realm context
      try {
        const ctx = await invoke("assemble_session_context", { sessionId: session.id, tokenBudget: 4000 }) as {
          realms: RealmContextInfo[];
        };
        initial.realms = ctx.realms;
      } catch (err) { console.warn("[useContextState] Failed to assemble session context:", err); }

      // Fetch persisted memory
      try {
        const entries = await invoke("get_all_memory", { scope: "global", scopeId: "global" }) as {
          key: string; value: string; source: string;
        }[];
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
  }, [
    session?.working_directory,
    session?.workspace_paths,
    session?.detected_agent,
    session?.metrics.memory_facts,
    session?.metrics.files_touched,
    session?.metrics.recent_errors,
  ]);

  // ── Listen for realm changes ──
  useEffect(() => {
    if (!session) return;
    let unlisten: (() => void) | null = null;
    listen(`session-realms-updated-${session.id}`, () => {
      invoke("assemble_session_context", { sessionId: session.id, tokenBudget: 4000 })
        .then((ctx) => {
          const context = ctx as { realms: RealmContextInfo[] };
          setContext((prev) => ({ ...prev, realms: context.realms }));
        })
        .catch((err) => console.warn("[useContextState] Failed to refresh realms:", err));
    }).then((u) => { unlisten = u; });
    return () => { unlisten?.(); };
  }, [session?.id]);

  // ── Listen for pin changes (backend now emits this event) ──
  useEffect(() => {
    if (!session) return;
    let unlisten: (() => void) | null = null;
    listen(`context-pins-changed-${session.id}`, () => {
      invoke("get_context_pins", { sessionId: session.id, projectId: null })
        .then((pins) => {
          setContext((prev) => ({ ...prev, pinnedItems: pins as ContextPin[] }));
        })
        .catch((err) => console.warn("[useContextState] Failed to refresh pins:", err));
    }).then((u) => { unlisten = u; });
    return () => { unlisten?.(); };
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
      const result = await invoke("apply_context", {
        sessionId: sess.id,
        executionMode: liveMode,
      }) as ApplyContextResult;

      setInjectedVersion(result.version);
      setInjectedContent(result.content);
      setLastInjectedAt(Date.now());

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

  return {
    context,
    currentVersion,
    injectedVersion,
    lastInjectedAt,
    lifecycle,
    lastError,
    injectedContent,
    applyContext,
    formatContext: formatContextPreview,
  };
}
