import "../styles/components/TerminalPane.css";
import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { detectProject } from "../api/projects";
import {
  attach, detach, has, showGhostText, clearGhostText,
  subscribeSuggestions, setSessionPhase, setSessionCwd,
  getHistoryProvider,
} from "../terminal/TerminalPool";
import { useExecutionMode, useAutonomousSettings, useSession } from "../state/SessionContext";
import { SuggestionOverlay, type SuggestionState } from "../terminal/intelligence/SuggestionOverlay";
import { detectProjectContext, invalidateContext } from "../terminal/intelligence/contextAnalyzer";
import { loadHistory } from "../terminal/intelligence/historyProvider";
import { detectShellEnvironment } from "../terminal/intelligence/shellEnvironment";
import "@xterm/xterm/css/xterm.css";

interface TerminalPaneProps {
  sessionId: string;
  phase: string;
  color: string;
}

import type { CommandPredictionEvent } from "../types";

export function TerminalPane({ sessionId, phase, color }: TerminalPaneProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const mode = useExecutionMode(sessionId);
  const autoSettings = useAutonomousSettings();
  const { dispatch } = useSession();
  const [suggestionState, setSuggestionState] = useState<SuggestionState | null>(null);

  // Attach/detach terminal from pool
  useEffect(() => {
    if (!viewportRef.current) return;

    // Wait for terminal to be in pool (it's created async in SessionContext)
    const tryAttach = () => {
      if (has(sessionId) && viewportRef.current) {
        attach(sessionId, viewportRef.current);
        setReady(true);
        return true;
      }
      return false;
    };

    if (!tryAttach()) {
      // Poll briefly if terminal hasn't been created yet
      let attached = false;
      const interval = setInterval(() => {
        if (tryAttach()) {
          attached = true;
          clearInterval(interval);
        }
      }, 50);
      const timeout = setTimeout(() => {
        clearInterval(interval);
        setReady(true); // Show anyway after timeout
      }, 3000);
      return () => {
        clearInterval(interval);
        clearTimeout(timeout);
        if (attached) detach(sessionId);
      };
    }

    return () => { detach(sessionId); };
  }, [sessionId]);

  // Handle resize when container size changes (debounced)
  useEffect(() => {
    if (!viewportRef.current) return;
    let resizeTimer: ReturnType<typeof setTimeout>;
    const observer = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (has(sessionId) && viewportRef.current) {
          attach(sessionId, viewportRef.current);
        }
      }, 100);
    });
    observer.observe(viewportRef.current);
    return () => {
      clearTimeout(resizeTimer);
      observer.disconnect();
    };
  }, [sessionId]);

  // Sync phase to TerminalPool for intelligence gating
  useEffect(() => {
    setSessionPhase(sessionId, phase);
  }, [sessionId, phase]);

  // Subscribe to suggestion state from TerminalPool
  useEffect(() => {
    const unsub = subscribeSuggestions(sessionId, (state) => {
      setSuggestionState(state);
    });
    return unsub;
  }, [sessionId]);

  // Initialize shell environment detection and history loading
  useEffect(() => {
    detectShellEnvironment(sessionId).then((env) => {
      const provider = getHistoryProvider(sessionId);
      if (provider) {
        loadHistory(provider, sessionId, env.shellType).catch((err) => console.warn("[TerminalPane] Failed to load shell history:", err));
      }
    });
  }, [sessionId]);

  // Listen for CWD changes and auto-detect project
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    listen<string>(`cwd-changed-${sessionId}`, (event) => {
      if (cancelled) return;
      const newCwd = event.payload;
      setSessionCwd(sessionId, newCwd);
      invalidateContext(newCwd);
      detectProject(newCwd).catch((err) => console.warn("[TerminalPane] Failed to detect project:", err));
      detectProjectContext(newCwd).catch((err) => console.warn("[TerminalPane] Failed to detect project context:", err));
    }).then((u) => {
      if (cancelled) { u(); } else { unlisten = u; }
    });
    return () => { cancelled = true; unlisten?.(); };
  }, [sessionId]);

  // Listen for command predictions — ghost text in assisted mode, auto-execute in autonomous mode
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    listen<CommandPredictionEvent>(`command-prediction-${sessionId}`, (event) => {
      const predictions = event.payload.predictions;
      if (predictions.length === 0 || phase !== "idle") return;

      if (mode === "assisted") {
        showGhostText(sessionId, predictions[0].next_command);
      } else if (mode === "autonomous" && predictions[0].frequency >= autoSettings.commandMinFrequency) {
        dispatch({
          type: "SHOW_AUTO_TOAST",
          command: predictions[0].next_command,
          reason: "prediction",
          sessionId,
        });
      }
    }).then((u) => {
      if (cancelled) { u(); } else { unlisten = u; }
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [sessionId, mode, phase, dispatch, autoSettings.commandMinFrequency]);

  // Clear ghost text when phase changes to busy
  useEffect(() => {
    if (phase === "busy") {
      clearGhostText(sessionId);
    }
  }, [phase, sessionId]);

  const showLoading = !ready && (phase === "creating" || phase === "initializing");
  const phaseLabel = phase === "creating" ? "Spawning shell..." :
                     phase === "initializing" ? "Starting shell..." :
                     phase === "error" ? "Session error" : "";

  return (
    <div className="terminal-pane-wrapper">
      {showLoading && (
        <div className="terminal-loading">
          <div className="loading-spinner" style={{ borderTopColor: color }} />
          <span className="terminal-loading-text">{phaseLabel || "Connecting..."}</span>
        </div>
      )}
      <div className="terminal-viewport" ref={viewportRef} />
      {suggestionState && (
        <SuggestionOverlay state={suggestionState} />
      )}
      <div className="terminal-color-accent" style={{ background: color }} />
    </div>
  );
}
