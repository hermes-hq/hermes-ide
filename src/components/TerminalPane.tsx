import "../styles/components/TerminalPane.css";
import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import { detectProject } from "../api/projects";
import {
  attach, detach, has, showGhostText, clearGhostText,
  subscribeSuggestions, setSessionPhase, setSessionCwd,
  getHistoryProvider, refitActive, acceptSuggestionAtIndex,
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

  // Handle resize when container size changes (debounced).
  // Uses double-rAF to ensure CSS layout has settled before measuring.
  useEffect(() => {
    if (!viewportRef.current) return;
    let resizeTimer: ReturnType<typeof setTimeout>;

    const doRefit = () => {
      // Double-rAF: first frame triggers layout, second frame measures it.
      // This is necessary because percentage-based CSS heights may not resolve
      // within the same frame that triggered the ResizeObserver.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          refitActive();
        });
      });
    };

    const observer = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(doRefit, 100);
    });
    observer.observe(viewportRef.current);

    // Fallback: also listen for window resize events.
    // ResizeObserver can miss some cases (e.g. window restore from minimized).
    const onWindowResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(doRefit, 100);
    };
    window.addEventListener("resize", onWindowResize);

    return () => {
      clearTimeout(resizeTimer);
      observer.disconnect();
      window.removeEventListener("resize", onWindowResize);
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

  const handleSuggestionAccept = useCallback((index: number) => {
    acceptSuggestionAtIndex(sessionId, index);
  }, [sessionId]);

  const showLoading = !ready && (phase === "creating" || phase === "initializing");
  const phaseLabel = phase === "creating" ? "Spawning shell..." :
                     phase === "initializing" ? "Starting shell..." :
                     phase === "error" ? "Session error" : "";

  // Convert hex color to rgba with very low opacity for background tint
  const tintStyle = useMemo(() => {
    if (!color) return undefined;
    const r = parseInt(color.slice(1, 3), 16);
    const g = parseInt(color.slice(3, 5), 16);
    const b = parseInt(color.slice(5, 7), 16);
    return isNaN(r) ? undefined : { background: `rgba(${r},${g},${b},0.06)` };
  }, [color]);

  return (
    <div className="terminal-pane-wrapper">
      {showLoading && (
        <div className="terminal-loading">
          <div className="loading-spinner" style={{ borderTopColor: color || undefined }} />
          <span className="terminal-loading-text">{phaseLabel || "Connecting..."}</span>
        </div>
      )}
      <div className="terminal-viewport" ref={viewportRef} />
      {tintStyle && <div className="terminal-bg-tint" style={tintStyle} />}
      {suggestionState && (
        <SuggestionOverlay
          state={suggestionState}
          onAccept={handleSuggestionAccept}
        />
      )}
    </div>
  );
}
