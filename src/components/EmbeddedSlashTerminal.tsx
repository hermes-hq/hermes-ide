/**
 * Inline xterm that runs a slash command's CLI in a one-shot PTY.
 *
 * Mount path: the composer renders this above its textarea when the
 * user clicks "Open terminal" on a CLI-only slash command (`/mcp`,
 * `/agents`, etc.).  This component:
 *
 *   1. Calls `spawn_inline_pty(command, args, cwd)` Rust IPC.
 *   2. Listens on `inline-pty-output-{id}` for output chunks, writes
 *      them to xterm.
 *   3. Forwards xterm key events back via `write_inline_pty`.
 *   4. Resizes the PTY to match the terminal box dimensions.
 *   5. On `inline-pty-exit-{id}` (or unmount) kills the child and
 *      tears the xterm down.
 *
 * Visual: a 280px-tall card that sits between the message timeline
 * and the composer.  Header bar carries the command label, an
 * `Expand` button (TBD — opens in a separate pane), and a `Close`
 * button.  Esc inside the terminal closes the panel.
 */
import "../styles/components/EmbeddedSlashTerminal.css";
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

interface Props {
  /** The slash command including the leading slash, e.g. `/mcp`. */
  command: string;
  /** cwd to spawn the PTY in.  Falls back to home if undefined. */
  cwd: string | null | undefined;
  /** Called when the user closes the terminal — banner is dismissed
   *  and the composer regains focus. */
  onClose: () => void;
}

export function EmbeddedSlashTerminal({ command, cwd, onClose }: Props) {
  const [phase, setPhase] = useState<"booting" | "running" | "exited" | "error">("booting");
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const ptyIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    let cancelled = false;
    let unOutput: UnlistenFn | undefined;
    let unExit: UnlistenFn | undefined;

    // Strip the leading slash so we pass `mcp` not `/mcp` as argv to
    // claude.  The bare verb is what the CLI expects.
    const argList = command.replace(/^\//, "").split(/\s+/).filter(Boolean);

    const xterm = new Terminal({
      fontFamily: 'JetBrains Mono, Menlo, monospace',
      fontSize: 12,
      lineHeight: 1.3,
      theme: { background: "#0d1218" },
      cursorBlink: true,
      convertEol: true,
      scrollback: 4000,
    });
    const fit = new FitAddon();
    xterm.loadAddon(fit);
    xterm.open(containerRef.current);
    xtermRef.current = xterm;
    fitRef.current = fit;
    fit.fit();

    // Wire keystrokes from xterm back to the PTY.
    xterm.onData((data) => {
      const id = ptyIdRef.current;
      if (!id) return;
      invoke("write_inline_pty", { ptyId: id, data }).catch(() => {});
    });

    // Container resize → PTY resize so the child re-renders the TUI
    // at the right dimensions.  Debounced via rAF.
    let resizeRaf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(resizeRaf);
      resizeRaf = requestAnimationFrame(() => {
        try {
          fit.fit();
        } catch { /* xterm not mounted yet */ }
        const id = ptyIdRef.current;
        if (id && xterm.rows && xterm.cols) {
          invoke("resize_inline_pty", {
            ptyId: id,
            rows: xterm.rows,
            cols: xterm.cols,
          }).catch(() => {});
        }
      });
    });
    ro.observe(containerRef.current);

    // Close on Esc — common terminal-modal expectation.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && (phase === "exited" || phase === "error")) {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);

    (async () => {
      try {
        const ptyId = await invoke<string>("spawn_inline_pty", {
          command: "claude",
          args: argList,
          cwd: cwd ?? null,
          rows: xterm.rows ?? 24,
          cols: xterm.cols ?? 80,
        });
        if (cancelled) {
          await invoke("kill_inline_pty", { ptyId });
          return;
        }
        ptyIdRef.current = ptyId;
        setPhase("running");

        unOutput = await listen<string>(`inline-pty-output-${ptyId}`, (msg) => {
          xterm.write(msg.payload);
        });
        unExit = await listen<{ code: number | null }>(
          `inline-pty-exit-${ptyId}`,
          (msg) => {
            setExitCode(msg.payload?.code ?? null);
            setPhase("exited");
          },
        );
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        setErrorMsg(m);
        setPhase("error");
      }
    })();

    return () => {
      cancelled = true;
      window.removeEventListener("keydown", onKey);
      ro.disconnect();
      cancelAnimationFrame(resizeRaf);
      unOutput?.();
      unExit?.();
      const id = ptyIdRef.current;
      if (id) {
        invoke("kill_inline_pty", { ptyId: id }).catch(() => {});
      }
      try { xterm.dispose(); } catch { /* already gone */ }
    };
  }, [command, cwd]);

  const subtitle =
    phase === "booting" ? "spawning…" :
    phase === "running" ? "running" :
    phase === "exited"  ? `exited${exitCode !== null ? ` (code ${exitCode})` : ""}` :
    `error${errorMsg ? ` — ${errorMsg}` : ""}`;

  return (
    <div className="ipty-card" data-phase={phase}>
      <header className="ipty-card-header">
        <span className="ipty-card-icon" aria-hidden="true">▣</span>
        <code className="ipty-card-cmd">claude {command.replace(/^\//, "")}</code>
        <span className="ipty-card-status" aria-live="polite">{subtitle}</span>
        <button
          type="button"
          className="ipty-card-close"
          onClick={onClose}
          aria-label="Close embedded terminal"
          title="Close (Esc)"
        >
          ✕
        </button>
      </header>
      <div ref={containerRef} className="ipty-card-body" />
      {phase === "exited" && (
        <div className="ipty-card-footer">
          press Esc to close, or run another /command from the composer
        </div>
      )}
      {phase === "error" && (
        <div className="ipty-card-footer ipty-card-footer-error">
          couldn't spawn claude — {errorMsg ?? "unknown error"}
        </div>
      )}
    </div>
  );
}
