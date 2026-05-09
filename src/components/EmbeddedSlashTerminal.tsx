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
import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

interface SlashCommandSpec {
  kind: "slash";
  /** The slash command including the leading slash, e.g. `/mcp`. */
  command: string;
}

interface ShellSpec {
  kind: "shell";
  /** Optional shell binary override.  Defaults to $SHELL or zsh. */
  binary?: string;
}

export type EmbeddedTerminalSpec = SlashCommandSpec | ShellSpec;

interface Props {
  /** What to spawn in the PTY: a one-shot `claude /<cmd>` invocation,
   *  or the user's interactive shell for ad-hoc use. */
  spec: EmbeddedTerminalSpec;
  /** cwd to spawn the PTY in.  Falls back to home if undefined. */
  cwd: string | null | undefined;
  /** Called when the user closes the terminal — banner is dismissed
   *  and the composer regains focus. */
  onClose: () => void;
}

export function EmbeddedSlashTerminal({ spec, cwd, onClose }: Props) {
  // Resolve the binary + args + display label up front from the spec.
  //
  // Slash mode: `claude` interactive REPL (no args).  We then write
  //   the slash command to stdin after spawn so the user lands
  //   directly in the command's TUI.  Calling `claude mcp` (positional
  //   arg) gives the CLI-FLAG interface, which just prints usage —
  //   only the in-REPL `/mcp` triggers the actual interactive TUI
  //   the user expects.
  //
  // Shell mode: spawn the user's default shell with `-i` so they see
  //   their prompt + history.
  const isSlash = spec.kind === "slash";
  const { spawnBinary, spawnArgs, displayLabel, autoInput } = useMemo(() => {
    if (isSlash) {
      // The command needs to be sent INTO claude's REPL, not as argv.
      // We retain the raw `/cmd` as autoInput and pipe it after spawn.
      return {
        spawnBinary: "claude",
        spawnArgs: [] as string[],
        displayLabel: `claude → ${spec.command}`,
        autoInput: `${spec.command}\r`,
      };
    }
    const shellSpec = spec as { binary?: string };
    const bin =
      shellSpec.binary?.trim() ||
      (typeof navigator !== "undefined" && navigator.platform.includes("Win")
        ? "powershell.exe"
        : "/bin/zsh");
    return {
      spawnBinary: bin,
      spawnArgs: ["-i"],
      displayLabel: bin.split("/").pop() ?? bin,
      autoInput: null as string | null,
    };
  }, [isSlash, spec]);
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
          command: spawnBinary,
          args: spawnArgs,
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

        // Slash mode: hold the command until we see Claude's REPL
        // prompt marker (`❯ ` — the chevron + space at the input
        // line).  Auto-typing earlier would fire mid-trust-prompt
        // (the "Yes, I trust this folder" gate) and get interpreted
        // as confirming that, leaving the slash text in the chat
        // box.  Only stream output to xterm; once the marker is
        // detected, send the input ONCE and stop watching.
        let autoInputSent = autoInput === null;
        let bootBuf = "";
        const PROMPT_RE = /❯\s|^>\s/m; // ❯ space, or ">" space
        unOutput = await listen<string>(`inline-pty-output-${ptyId}`, (msg) => {
          xterm.write(msg.payload);
          if (autoInputSent) return;
          bootBuf += msg.payload;
          // Cap the boot buffer so we don't grow forever if the
          // marker never appears.
          if (bootBuf.length > 16_000) bootBuf = bootBuf.slice(-8000);
          if (PROMPT_RE.test(bootBuf)) {
            autoInputSent = true;
            // Small breath after the prompt renders so the input
            // line is fully drawn before we stuff data.
            setTimeout(() => {
              if (cancelled) return;
              invoke("write_inline_pty", { ptyId, data: autoInput! }).catch(() => {});
            }, 180);
          }
        });

        // Safety fallback: if we never see the marker (claude version
        // changed, theme rewrote it, etc.), still send after 6 s so
        // the feature degrades gracefully instead of hanging silent.
        if (autoInput) {
          setTimeout(() => {
            if (cancelled || autoInputSent) return;
            autoInputSent = true;
            invoke("write_inline_pty", { ptyId, data: autoInput }).catch(() => {});
          }, 6000);
        }
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spawnBinary, autoInput, cwd]);

  const subtitle =
    phase === "booting" ? "spawning…" :
    phase === "running" ? "running" :
    phase === "exited"  ? `exited${exitCode !== null ? ` (code ${exitCode})` : ""}` :
    `error${errorMsg ? ` — ${errorMsg}` : ""}`;

  return (
    <div className="ipty-card" data-phase={phase}>
      <header className="ipty-card-header">
        <span className="ipty-card-icon" aria-hidden="true">▣</span>
        <code className="ipty-card-cmd">{displayLabel}</code>
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
