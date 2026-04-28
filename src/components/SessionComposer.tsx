import "../styles/components/SessionComposer.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSession, useComposer } from "../state/SessionContext";
import { submitToPty } from "../utils/submitToPty";
import { focusTerminal } from "../terminal/TerminalPool";
import { isActionMod, isMac } from "../utils/platform";
import { listSessionFiles, savePastedImage, readImageBytes, invalidateClaudeCapabilitiesCache, writeToSession } from "../api/sessions";
import { copyImageOnlyToClipboard } from "../api/clipboard";
import { effortFillForLevel } from "../utils/effortFill";
import { getActiveMention, replaceMention } from "../utils/mentions";
import { getActiveSlashCommand, replaceSlashCommand } from "../utils/slashCommands";
import { fuzzyRank } from "../utils/fuzzy";
import { MentionsDropdown } from "./MentionsDropdown";
import { SlashCommandsDropdown, type SlashCommandItem } from "./SlashCommandsDropdown";
import { ModelPicker } from "./ModelPicker";
import { EffortPicker } from "./EffortPicker";
import { useClaudeCommands } from "../hooks/useClaudeCommands";
import { useClaudeCapabilities } from "../hooks/useClaudeCapabilities";
import { getCurrentWebview } from "@tauri-apps/api/webview";

let composerTextarea: HTMLTextAreaElement | null = null;

/** Live composer textarea, if mounted. */
export function getComposerTextarea(): HTMLTextAreaElement | null {
  return composerTextarea;
}

const MIN_HEIGHT = 60;
const DEFAULT_HEIGHT = 120;
const MENTION_RESULT_CAP = 8;
const SLASH_RESULT_CAP = 12;
const MAX_PASTED_IMAGE_BYTES = 20 * 1024 * 1024;

/** Map a `detected_agent.provider` value to a normalized provider id. */
function normalizeProvider(provider: string | null | undefined): string | null {
  if (!provider) return null;
  const lower = provider.toLowerCase();
  if (lower === "anthropic" || lower === "claude") return "claude";
  return lower;
}

/** Wrap a path in single quotes if it contains shell-special characters. */
function shellQuote(path: string): string {
  if (!/[\s"'\\$`#&|;<>(){}*?!~]/.test(path)) return path;
  return "'" + path.replaceAll("'", "'\\''") + "'";
}

function blobToBytes(blob: Blob): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const buf = reader.result as ArrayBuffer;
      resolve(Array.from(new Uint8Array(buf)));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

function extFromMime(type: string): string | null {
  switch (type) {
    case "image/png":  return "png";
    case "image/jpeg": return "jpg";
    case "image/gif":  return "gif";
    case "image/webp": return "webp";
    case "image/bmp":  return "bmp";
    default: return null;
  }
}

export function SessionComposer() {
  const { state, dispatch } = useSession();
  const sessionId = state.activeSessionId;
  const { draft, height, expanded } = useComposer(sessionId ?? "");
  const session = sessionId ? state.sessions[sessionId] : null;
  const cwd = session?.working_directory ?? "";
  const detectedAgent = session?.detected_agent ?? null;
  const aiProvider = session?.ai_provider ?? null;
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const agentChipRef = useRef<HTMLButtonElement | null>(null);
  const inFlightRef = useRef(false);
  const [draggingHeight, setDraggingHeight] = useState<number | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [effortPickerOpen, setEffortPickerOpen] = useState(false);
  const effortChipRef = useRef<HTMLButtonElement | null>(null);
  // Maximize: when true, the composer expands to ~70% of the viewport height,
  // overriding the user's saved height. Local state — purely visual, no need
  // to persist across reloads.
  const [maximized, setMaximized] = useState(false);
  // Pasted images attached to the next submission. Each entry is the file
  // saved to disk + a data: URL for the thumbnail. On submit we re-write
  // the image to the OS clipboard and send Ctrl+V to the PTY so Claude Code
  // grabs it via its native paste handler (text-only inserts wouldn't carry
  // the actual image).
  const [pendingImages, setPendingImages] = useState<{ id: string; path: string; dataUrl: string }[]>([]);
  // Optimistic model — shown in the chip immediately after the user picks,
  // until detection from Claude's output catches up.
  const [pendingModel, setPendingModel] = useState<string | null>(null);
  // Optimistic effort — the level the user just clicked to.  We keep it
  // until the next discovery refresh confirms `effort_current` matches, then
  // clear it.  Without this, two rapid clicks would compute `next` from a
  // stale `effort_current` (the IPC cache + watcher debounce window) and
  // re-send the same level.
  const [pendingEffort, setPendingEffort] = useState<string | null>(null);

  // Resolve provider key. Prefer detected_agent (parsed from terminal output,
  // more reliable), fall back to user-selected ai_provider for sessions where
  // detection hasn't fired yet.
  const provKey = useMemo(
    () => normalizeProvider(detectedAgent?.provider) ?? normalizeProvider(aiProvider),
    [detectedAgent?.provider, aiProvider],
  );
  const isClaude = provKey === "claude";

  // ─── Claude live capability snapshot (models, effort, builtins) ────
  const capabilities = useClaudeCapabilities(isClaude ? sessionId : null);

  // ─── Project file index for @-mentions ────────────────────
  const [files, setFiles] = useState<string[]>([]);
  useEffect(() => {
    if (!sessionId) { setFiles([]); return; }
    let cancelled = false;
    listSessionFiles(sessionId)
      .then((list) => { if (!cancelled) setFiles(list); })
      .catch((err) => { console.error("[SessionComposer] list_session_files failed:", err); });
    return () => { cancelled = true; };
  }, [sessionId, cwd]);

  // ─── Claude slash commands (built-in + user + project, live-updating) ──
  // The Rust IPC merges all three sources and resolves overrides
  // (project > user > builtin). No frontend fallback — if the list is
  // empty, the dropdown shows a polite empty state.
  const claudeCommands = useClaudeCommands(isClaude ? sessionId : null);

  const allSlashCommands = useMemo<SlashCommandItem[]>(() => {
    if (!isClaude) return [];
    return claudeCommands.map((c) => ({
      command: c.command,
      label: "",
      description: c.description,
      source: c.source,
    }));
  }, [isClaude, claudeCommands]);

  // ─── Active mention / slash state ────────────────────────
  const [mention, setMention] = useState<{ start: number; end: number; query: string } | null>(null);
  const [slash, setSlash] = useState<{ start: number; end: number; query: string } | null>(null);
  const [highlightIdx, setHighlightIdx] = useState(0);

  const rankedFiles = useMemo(() => {
    if (!mention) return null;
    return fuzzyRank(files, mention.query, (s) => s, MENTION_RESULT_CAP);
  }, [mention, files]);

  // The dropdown should render whenever a slash overlay is active in a
  // Claude session, even if the list is empty — we show a friendly
  // "no commands available" hint instead of silently hiding it.
  const rankedCommands = useMemo<SlashCommandItem[] | null>(() => {
    if (!slash || !isClaude) return null;
    if (allSlashCommands.length === 0) return [];
    const ranked = fuzzyRank(allSlashCommands, slash.query, (c) => c.command.slice(1) + " " + c.label, SLASH_RESULT_CAP);
    return ranked.map((r) => r.item);
  }, [slash, isClaude, allSlashCommands]);

  useEffect(() => {
    setHighlightIdx(0);
  }, [mention?.query, slash?.query]);

  useEffect(() => {
    composerTextarea = textareaRef.current;
    return () => {
      if (composerTextarea === textareaRef.current) composerTextarea = null;
    };
  }, []);

  // Recompute mention/slash from caret. Slash takes priority because @ inside
  // a `/` command would be unusual, and mention only triggers when there's
  // whitespace before `@`.
  const refreshOverlay = useCallback((value: string, caret: number) => {
    if (isClaude) {
      const s = getActiveSlashCommand(value, caret);
      if (s) {
        setSlash(s);
        setMention(null);
        return;
      }
    }
    setSlash(null);
    setMention(getActiveMention(value, caret));
  }, [isClaude]);

  const closeOverlay = useCallback(() => { setSlash(null); setMention(null); }, []);

  const acceptMention = useCallback((idx: number) => {
    if (!sessionId || !mention || !rankedFiles) return;
    const pick = rankedFiles[idx];
    if (!pick) return;
    const { text: newDraft, caret: newCaret } = replaceMention(draft, mention, shellQuote(pick.item));
    dispatch({ type: "SET_COMPOSER_DRAFT", sessionId, draft: newDraft });
    setMention(null);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        el.selectionStart = el.selectionEnd = newCaret;
      }
    });
  }, [sessionId, mention, rankedFiles, draft, dispatch]);

  const acceptSlash = useCallback((idx: number) => {
    if (!sessionId || !slash || !rankedCommands) return;
    const pick = rankedCommands[idx];
    if (!pick) return;
    const { text: newDraft, caret: newCaret } = replaceSlashCommand(draft, slash, pick.command);
    dispatch({ type: "SET_COMPOSER_DRAFT", sessionId, draft: newDraft });
    setSlash(null);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        el.selectionStart = el.selectionEnd = newCaret;
      }
    });
  }, [sessionId, slash, rankedCommands, draft, dispatch]);

  const handleSubmit = useCallback(async () => {
    if (!sessionId) return;
    if (inFlightRef.current) return;
    // Allow submission with images even if the text draft is empty.
    if (!draft.trim() && pendingImages.length === 0) return;
    inFlightRef.current = true;
    try {
      // Helper — write raw UTF-8 bytes to the PTY (base64-encoded as the IPC
      // expects). We bypass `submitToPty` here because its backspaces +
      // bracketed-paste wrapping would erase Claude's just-attached images
      // before the Enter is sent.
      const sendRaw = async (s: string) => {
        const enc = new TextEncoder().encode(s);
        const bin = Array.from(enc, (b) => String.fromCharCode(b)).join("");
        await writeToSession(sessionId, btoa(bin));
      };

      // 1. Attach images first by writing each to the OS clipboard and
      //    issuing a Ctrl+V (\x16) to the PTY. Claude Code's prompt handler
      //    grabs the image from the clipboard on each Ctrl+V.
      // We use copyImageOnlyToClipboard because the regular variant ALSO
      //    sets the path as text — and on macOS, set_text after set_image
      //    REPLACES the image with text, defeating the whole flow.
      console.info(`[Composer] submit start: ${pendingImages.length} image(s), draft=${draft.length} chars`);
      for (let i = 0; i < pendingImages.length; i++) {
        const img = pendingImages[i];
        console.info(`[Composer] image ${i + 1}/${pendingImages.length}: copying ${img.path} to clipboard…`);
        try {
          await copyImageOnlyToClipboard(img.path);
          console.info(`[Composer] image ${i + 1}: clipboard OK; sending Ctrl+V to PTY`);
        } catch (err) {
          console.error(`[Composer] image ${i + 1}: clipboard write FAILED`, err);
          throw err;
        }
        // Tiny pause so the OS clipboard write commits before Ctrl+V reads it.
        await new Promise((r) => setTimeout(r, 80));
        await sendRaw("\x16");
        console.info(`[Composer] image ${i + 1}: Ctrl+V sent, waiting 200ms for Claude to render attachment`);
        // Longer settle (200 ms) — the previous 120 ms wasn't always enough
        // for Claude's TUI to register the paste before the next byte arrives.
        await new Promise((r) => setTimeout(r, 200));
      }

      // 2. Send the text body (if any) inside bracketed paste so Claude
      //    treats multi-line content as one paste. NO trailing \r yet —
      //    we want the images and the text in the same prompt, then commit.
      if (draft.trim()) {
        console.info(`[Composer] sending text via bracketed paste (${draft.length} chars)`);
        await sendRaw("\x1b[200~" + draft + "\x1b[201~");
        await new Promise((r) => setTimeout(r, 50));
      }

      // 3. Commit the turn.
      console.info(`[Composer] committing turn with \\r`);
      await sendRaw("\r");
      console.info(`[Composer] submit complete`);

      dispatch({ type: "SET_COMPOSER_DRAFT", sessionId, draft: "" });
      setPendingImages([]);
      closeOverlay();
    } catch (err) {
      console.error("[SessionComposer] Failed to submit:", err);
    } finally {
      inFlightRef.current = false;
    }
  }, [draft, sessionId, pendingImages, dispatch, closeOverlay]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Slash dropdown nav (only when there are items to navigate)
    if (slash && rankedCommands && rankedCommands.length > 0) {
      if (e.key === "ArrowDown") { e.preventDefault(); setHighlightIdx((i) => Math.min(i + 1, rankedCommands.length - 1)); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setHighlightIdx((i) => Math.max(i - 1, 0)); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); acceptSlash(highlightIdx); return; }
      if (e.key === "Escape") { e.preventDefault(); setSlash(null); return; }
    }
    // Mention dropdown nav
    if (mention && rankedFiles && rankedFiles.length > 0) {
      if (e.key === "ArrowDown") { e.preventDefault(); setHighlightIdx((i) => Math.min(i + 1, rankedFiles.length - 1)); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setHighlightIdx((i) => Math.max(i - 1, 0)); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); acceptMention(highlightIdx); return; }
      if (e.key === "Escape") { e.preventDefault(); setMention(null); return; }
    }

    if (isActionMod(e.nativeEvent) && e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      void handleSubmit();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      if (!sessionId) return;
      // Esc with empty draft → collapse the composer back to its icon.
      // Esc with a non-empty draft → keep the composer open but blur to
      // the terminal so the user can resume typing in xterm without losing
      // their work-in-progress.
      if (draft.length === 0) {
        dispatch({ type: "SET_COMPOSER_EXPANDED", sessionId, expanded: false });
      }
      focusTerminal(sessionId);
      return;
    }
    if (e.key === "Tab" && !e.shiftKey) {
      if (!sessionId) return;
      e.preventDefault();
      const el = e.currentTarget;
      const start = el.selectionStart;
      const end = el.selectionEnd;
      const newDraft = draft.slice(0, start) + "\t" + draft.slice(end);
      dispatch({ type: "SET_COMPOSER_DRAFT", sessionId, draft: newDraft });
      requestAnimationFrame(() => {
        el.selectionStart = el.selectionEnd = start + 1;
      });
      return;
    }
  }, [slash, rankedCommands, mention, rankedFiles, highlightIdx, acceptSlash, acceptMention, handleSubmit, sessionId, draft, dispatch]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    if (!sessionId) return;
    const value = e.target.value;
    dispatch({ type: "SET_COMPOSER_DRAFT", sessionId, draft: value });
    refreshOverlay(value, e.target.selectionStart);
  }, [sessionId, dispatch, refreshOverlay]);

  const handleSelect = useCallback((e: React.SyntheticEvent<HTMLTextAreaElement>) => {
    refreshOverlay(e.currentTarget.value, e.currentTarget.selectionStart);
  }, [refreshOverlay]);

  const handlePaste = useCallback(async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (!sessionId) return;
    const items = e.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind !== "file") continue;
      const ext = extFromMime(item.type);
      if (!ext) continue;
      const blob = item.getAsFile();
      if (!blob) continue;
      if (blob.size > MAX_PASTED_IMAGE_BYTES) {
        console.warn("[SessionComposer] Pasted image too large; ignoring.");
        continue;
      }
      e.preventDefault();
      try {
        const bytes = await blobToBytes(blob);
        const path = await savePastedImage(sessionId, bytes, ext);
        // Build a data URL for the thumbnail preview without re-reading the file.
        const mime = `image/${ext === "jpg" ? "jpeg" : ext}`;
        const dataUrl = `data:${mime};base64,${btoa(String.fromCharCode(...bytes))}`;
        setPendingImages((prev) => [...prev, {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          path,
          dataUrl,
        }]);
      } catch (err) {
        console.error("[SessionComposer] Failed to save pasted image:", err);
      }
      return;
    }
  }, [sessionId]);

  const removePendingImage = useCallback((id: string) => {
    setPendingImages((prev) => prev.filter((p) => p.id !== id));
  }, []);

  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    if (!sessionId) return;
    e.preventDefault();
    e.stopPropagation();
    const startY = e.clientY;
    const startHeight = height;
    const maxHeight = Math.max(MIN_HEIGHT, Math.floor(window.innerHeight * 0.5));

    let latestHeight: number | null = null;
    const onMove = (ev: MouseEvent) => {
      const delta = startY - ev.clientY;
      const next = Math.min(maxHeight, Math.max(MIN_HEIGHT, startHeight + delta));
      latestHeight = next;
      setDraggingHeight(next);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      setDraggingHeight(null);
      if (latestHeight != null) {
        dispatch({ type: "SET_COMPOSER_HEIGHT", sessionId, height: latestHeight });
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [height, sessionId, dispatch]);

  const openPromptBuilder = useCallback(() => {
    dispatch({ type: "OPEN_COMPOSER" });
  }, [dispatch]);

  // Switch model directly from the chip — sends `/model <name>` to Claude
  // (or just `/model` for the "open Claude's picker" path which opens Claude's TUI).
  const handleModelSelect = useCallback((modelId: string) => {
    setModelPickerOpen(false);
    if (!sessionId) return;
    // Optimistically reflect the choice in the chip before detection catches up.
    if (modelId !== "" && modelId.toLowerCase() !== "default") {
      setPendingModel(modelId);
    } else {
      setPendingModel(null);
    }
    const cmd = modelId === "" ? "/model" : `/model ${modelId}`;
    submitToPty(sessionId, cmd).catch((err) => {
      console.error("[SessionComposer] /model send failed:", err);
    });
  }, [sessionId]);

  // Once detection sees the new model in Claude's output, clear the override.
  useEffect(() => {
    if (!pendingModel) return;
    const detected = detectedAgent?.model?.toLowerCase() ?? "";
    if (detected.includes(pendingModel.toLowerCase())) {
      setPendingModel(null);
    }
  }, [pendingModel, detectedAgent?.model]);

  // Reset optimistic state when the active session changes.
  useEffect(() => {
    setPendingModel(null);
  }, [sessionId]);

  // ─── Effort chip — cycle through discovered effort levels ────────
  // Reads the active level from `capabilities.effort_current` (sourced from
  // `~/.claude/settings.json` and re-fetched on file changes).  We layer an
  // optimistic `pendingEffort` on top so two rapid clicks cycle correctly
  // even before the watcher has fired.
  const effortLevels = capabilities?.effort_levels ?? [];
  const effortCurrentRaw = capabilities?.effort_current ?? null;
  const effortCurrent = pendingEffort ?? effortCurrentRaw;
  const effortIndex = useMemo(() => {
    if (effortLevels.length === 0 || !effortCurrent) return 0;
    const idx = effortLevels.findIndex((l) => l.toLowerCase() === effortCurrent.toLowerCase());
    return idx >= 0 ? idx : 0;
  }, [effortLevels, effortCurrent]);

  // Use the shared, tested helper so component and tests can't drift apart.
  const effortFill = useMemo(
    () => effortFillForLevel(effortCurrent ?? "", effortLevels),
    [effortCurrent, effortLevels],
  );

  // Once the underlying capability snapshot reports the new effort level,
  // drop the optimistic override so future external changes are reflected.
  useEffect(() => {
    if (!pendingEffort) return;
    if (effortCurrentRaw && effortCurrentRaw.toLowerCase() === pendingEffort.toLowerCase()) {
      setPendingEffort(null);
    }
  }, [pendingEffort, effortCurrentRaw]);

  // Reset optimistic effort when the session changes.
  useEffect(() => { setPendingEffort(null); }, [sessionId]);

  const handleEffortSelect = useCallback((level: string) => {
    setEffortPickerOpen(false);
    if (!sessionId) return;
    // Optimistically reflect the choice immediately, before Claude updates
    // settings.json — keeps the chip responsive.
    setPendingEffort(level);
    // Send `/effort <level>` via submitToPty (handles base64 + bracketed paste
    // + \r correctly). Goes to the PTY directly, NOT into the user's draft.
    submitToPty(sessionId, `/effort ${level}`)
      .then(() => {
        // Force the next discovery pass to actually re-read settings.json
        // even if the FS watcher debounce hasn't fired yet.  Without this
        // the IPC cache could keep returning the previous `effort_current`
        // for up to the cache TTL after the user-visible state changed.
        invalidateClaudeCapabilitiesCache().catch((err) => {
          console.warn("[SessionComposer] cache invalidate failed:", err);
        });
      })
      .catch((err) => {
        console.error("[SessionComposer] /effort send failed:", err);
        setPendingEffort(null);
      });
  }, [sessionId]);


  // ─── OS file drag-drop into composer ─────────────────────
  // Listens to Tauri's webview-level drag events. When the drop occurs over
  // the composer's bounding rect, we insert the file paths at the caret as
  // shell-quoted absolute paths. Drops outside this rect are ignored here
  // (SplitPane handles drops over a terminal pane separately).
  useEffect(() => {
    if (!sessionId) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;

    const isOverComposer = (x: number, y: number): boolean => {
      const el = wrapperRef.current;
      if (!el) return false;
      const r = el.getBoundingClientRect();
      // Tauri positions are physical pixels; need to divide by DPR.
      const dpr = window.devicePixelRatio || 1;
      const cx = x / dpr;
      const cy = y / dpr;
      return cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom;
    };

    getCurrentWebview()
      .onDragDropEvent((event) => {
        const payload = event.payload as {
          type: "enter" | "over" | "drop" | "leave";
          paths?: string[];
          position?: { x: number; y: number };
        };
        if (payload.type === "leave") {
          setIsDragOver(false);
          return;
        }
        const pos = payload.position;
        if (!pos) return;
        const over = isOverComposer(pos.x, pos.y);
        if (payload.type === "enter" || payload.type === "over") {
          setIsDragOver(over);
          return;
        }
        if (payload.type === "drop") {
          setIsDragOver(false);
          if (!over) return;
          const paths = payload.paths ?? [];
          if (paths.length === 0) return;

          // Split image paths from the rest. Images become attachment pills
          // (re-routed via clipboard + Ctrl+V on submit so Claude actually
          // sees the pixels). Non-image files are inserted as shell-quoted
          // paths into the draft text.
          const imageExts = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);
          const imagePaths: string[] = [];
          const otherPaths: string[] = [];
          for (const p of paths) {
            const ext = p.split(".").pop()?.toLowerCase() ?? "";
            if (imageExts.has(ext)) imagePaths.push(p);
            else otherPaths.push(p);
          }

          // Attach images as pills with real thumbnails. We read the bytes
          // from disk via a Rust IPC so the data: URL preview matches the
          // actual file. The clipboard+Ctrl+V submit flow handles delivery.
          if (imagePaths.length > 0) {
            (async () => {
              for (const p of imagePaths) {
                try {
                  const bytes = await readImageBytes(p);
                  const ext = p.split(".").pop()?.toLowerCase() ?? "png";
                  const mime = `image/${ext === "jpg" ? "jpeg" : ext}`;
                  const dataUrl = `data:${mime};base64,${btoa(String.fromCharCode(...bytes))}`;
                  setPendingImages((prev) => [...prev, {
                    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                    path: p,
                    dataUrl,
                  }]);
                } catch (err) {
                  console.error("[SessionComposer] could not read dropped image:", err);
                  // Fall back to filename-only pill if read fails.
                  setPendingImages((prev) => [...prev, {
                    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                    path: p,
                    dataUrl: "",
                  }]);
                }
              }
            })();
          }

          // Insert non-image paths as text in the textarea (existing behavior).
          if (otherPaths.length > 0) {
            const insert = otherPaths.map(shellQuote).join(" ");
            const el = textareaRef.current;
            const start = el?.selectionStart ?? draft.length;
            const end = el?.selectionEnd ?? draft.length;
            const needsLeadingSpace = start > 0 && !/\s$/.test(draft.slice(0, start));
            const piece = (needsLeadingSpace ? " " : "") + insert + " ";
            const newDraft = draft.slice(0, start) + piece + draft.slice(end);
            dispatch({ type: "SET_COMPOSER_DRAFT", sessionId, draft: newDraft });
            const newCaret = start + piece.length;
            requestAnimationFrame(() => {
              const t = textareaRef.current;
              if (t) {
                t.focus();
                t.selectionStart = t.selectionEnd = newCaret;
              }
            });
          }
        }
      })
      .then((fn) => { if (cancelled) fn(); else unlisten = fn; })
      .catch((err) => console.error("[SessionComposer] drag-drop subscribe failed:", err));

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [sessionId, draft, dispatch]);

  // Auto-focus the textarea when the composer is expanded — covers both
  // initial expand-on-click and Cmd+Shift+J expand-while-collapsed paths.
  useEffect(() => {
    if (!expanded) return;
    const el = textareaRef.current;
    if (!el) return;
    // Defer one frame so the element is fully painted before focusing.
    const id = requestAnimationFrame(() => el.focus());
    return () => cancelAnimationFrame(id);
  }, [expanded]);

  // Listen for an external "expand and focus" trigger fired by the
  // Cmd+Shift+J shortcut handler in App.tsx.  When this event arrives, we
  // expand (if collapsed) and focus the textarea.
  useEffect(() => {
    if (!sessionId) return;
    const handler = (ev: Event) => {
      const detail = (ev as CustomEvent).detail as { sessionId?: string } | undefined;
      if (detail?.sessionId && detail.sessionId !== sessionId) return;
      dispatch({ type: "SET_COMPOSER_EXPANDED", sessionId, expanded: true });
      requestAnimationFrame(() => textareaRef.current?.focus());
    };
    window.addEventListener("hermes:expand-composer", handler);
    return () => window.removeEventListener("hermes:expand-composer", handler);
  }, [sessionId, dispatch]);

  if (!sessionId) {
    return null;
  }

  // Collapsed: render only a small floating chat-icon button anchored to
  // the bottom-right of the terminal-and-timeline area.  Click to expand.
  if (!expanded) {
    return (
      <button
        type="button"
        className="session-composer-fab"
        onClick={() => dispatch({ type: "SET_COMPOSER_EXPANDED", sessionId, expanded: true })}
        title={`Open chat (${isMac ? "⌘⇧J" : "Ctrl+Shift+J"})`}
        aria-label="Open composer"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      </button>
    );
  }

  const effectiveHeight = maximized
    ? Math.floor(window.innerHeight * 0.7)
    : (draggingHeight ?? (height || DEFAULT_HEIGHT));

  const minimizeComposer = () => {
    setMaximized(false);
    dispatch({ type: "SET_COMPOSER_EXPANDED", sessionId, expanded: false });
  };
  const toggleMaximize = () => {
    setMaximized((m) => !m);
  };
  const isConnecting = session?.phase === "creating" || session?.phase === "initializing";
  const sessionLabel = session?.label ?? "";
  const showMentions = mention !== null && rankedFiles !== null;
  const showSlash = slash !== null && rankedCommands !== null;

  const placeholder = sessionLabel
    ? `Message ${sessionLabel}…  (@ for files${isClaude ? ", / for commands" : ""})`
    : "Type a message…";

  const showEffortChip = isClaude && effortLevels.length > 0;

  return (
    <div
      ref={wrapperRef}
      className={`session-composer ${isClaude ? "session-composer-claude" : ""} ${isDragOver ? "session-composer-drag-over" : ""}`}
      style={{ height: effectiveHeight }}
    >
      <div
        className="session-composer-resize-handle"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize composer"
        onMouseDown={handleResizeMouseDown}
      />
      <div className="session-composer-card">
        <div className="session-composer-window-controls">
          <button
            type="button"
            className="session-composer-window-btn"
            onClick={toggleMaximize}
            title={maximized ? "Restore" : "Maximize"}
            aria-label={maximized ? "Restore composer" : "Maximize composer"}
          >
            {maximized ? (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="4 14 10 14 10 20" />
                <polyline points="20 10 14 10 14 4" />
                <line x1="14" y1="10" x2="21" y2="3" />
                <line x1="3" y1="21" x2="10" y2="14" />
              </svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="15 3 21 3 21 9" />
                <polyline points="9 21 3 21 3 15" />
                <line x1="21" y1="3" x2="14" y2="10" />
                <line x1="3" y1="21" x2="10" y2="14" />
              </svg>
            )}
          </button>
          <button
            type="button"
            className="session-composer-window-btn"
            onClick={minimizeComposer}
            title="Minimize to icon"
            aria-label="Minimize composer"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
        </div>
        {showSlash && rankedCommands!.length > 0 && (
          <SlashCommandsDropdown
            items={rankedCommands!}
            highlightIdx={highlightIdx}
            onHighlight={setHighlightIdx}
            onSelect={acceptSlash}
            onClose={() => setSlash(null)}
          />
        )}
        {showSlash && rankedCommands!.length === 0 && (
          <div className="slash-dropdown" role="listbox" aria-label="Slash commands">
            <div className="slash-dropdown-empty">
              No commands available — type <code>/help</code> in your terminal to see Claude's full list.
            </div>
          </div>
        )}
        {showMentions && !showSlash && (
          <MentionsDropdown
            items={rankedFiles!.map((r) => r.item)}
            matches={rankedFiles!.map((r) => r.matches)}
            highlightIdx={highlightIdx}
            onHighlight={setHighlightIdx}
            onSelect={acceptMention}
            onClose={() => setMention(null)}
          />
        )}
        {pendingImages.length > 0 && (
          <div className="session-composer-attachments" aria-label="Attached images">
            {pendingImages.map((img) => {
              const filename = img.path.split("/").pop() ?? img.path;
              return (
                <div key={img.id} className="session-composer-attachment" title={img.path}>
                  {img.dataUrl ? (
                    <img src={img.dataUrl} alt={filename} />
                  ) : (
                    <div className="session-composer-attachment-placeholder">
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                        <circle cx="8.5" cy="8.5" r="1.5" />
                        <polyline points="21 15 16 10 5 21" />
                      </svg>
                      <span className="session-composer-attachment-name">{filename}</span>
                    </div>
                  )}
                  <button
                    type="button"
                    className="session-composer-attachment-remove"
                    onClick={() => removePendingImage(img.id)}
                    title="Remove image"
                    aria-label="Remove pasted image"
                  >×</button>
                </div>
              );
            })}
          </div>
        )}
        <textarea
          ref={textareaRef}
          className="session-composer-input"
          value={draft}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onSelect={handleSelect}
          onPaste={handlePaste}
          placeholder={placeholder}
          aria-label="Compose terminal input"
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
        />
        <div className="session-composer-footer">
          <div className="session-composer-status">
            <button
              type="button"
              className="session-composer-builder-btn"
              onClick={openPromptBuilder}
              title={`Open prompt builder (${isMac ? "⌘J" : "Ctrl+J"})`}
              aria-label="Open prompt builder"
            >
              ✨ Builder
            </button>
            {detectedAgent && (
              isClaude ? (
                <div className="session-composer-agent-wrap">
                  <button
                    ref={agentChipRef}
                    type="button"
                    className={`session-composer-agent session-composer-agent-clickable${pendingModel ? " session-composer-agent-pending" : ""}`}
                    onClick={() => setModelPickerOpen((o) => !o)}
                    title="Switch model"
                    aria-label="Switch model"
                    aria-expanded={modelPickerOpen}
                    aria-haspopup="menu"
                  >
                    <span className="session-composer-agent-name">{detectedAgent.name}</span>
                    {(pendingModel ?? detectedAgent.model) && (
                      <span className="session-composer-agent-model">
                        {pendingModel ?? detectedAgent.model}
                        {pendingModel && <span className="session-composer-agent-pending-dot" aria-hidden="true">•</span>}
                      </span>
                    )}
                    <span className="session-composer-agent-chevron" aria-hidden="true">▾</span>
                  </button>
                  {modelPickerOpen && (
                    <ModelPicker
                      anchorEl={agentChipRef.current}
                      options={capabilities?.models ?? []}
                      currentModel={pendingModel ?? detectedAgent.model}
                      onSelect={handleModelSelect}
                      onClose={() => setModelPickerOpen(false)}
                    />
                  )}
                </div>
              ) : (
                <span className="session-composer-agent" title={`${detectedAgent.name}${detectedAgent.model ? ` · ${detectedAgent.model}` : ""}`}>
                  <span className="session-composer-agent-name">{detectedAgent.name}</span>
                  {detectedAgent.model && (
                    <span className="session-composer-agent-model">{detectedAgent.model}</span>
                  )}
                </span>
              )
            )}
            {showEffortChip && (
              <div className="session-composer-effort-wrap">
                <button
                  ref={effortChipRef}
                  type="button"
                  className={`session-composer-effort-btn session-composer-effort-fill-${effortFill}`}
                  style={{ ["--effort-fill" as string]: effortFill }}
                  onClick={() => setEffortPickerOpen((o) => !o)}
                  title={`Thinking effort: ${effortCurrent ?? effortLevels[effortIndex]}`}
                  aria-label={`Thinking effort: ${effortCurrent ?? effortLevels[effortIndex]}`}
                  aria-haspopup="menu"
                  aria-expanded={effortPickerOpen}
                >
                  <span className="session-composer-effort-bars" aria-hidden="true">
                    <span /><span /><span />
                  </span>
                  <span>{effortCurrent ?? effortLevels[effortIndex]}</span>
                  <span className="session-composer-agent-chevron" aria-hidden="true">▾</span>
                </button>
                {effortPickerOpen && (
                  <EffortPicker
                    anchorEl={effortChipRef.current}
                    levels={effortLevels}
                    current={effortCurrentRaw}
                    pending={pendingEffort}
                    onSelect={handleEffortSelect}
                    onClose={() => setEffortPickerOpen(false)}
                  />
                )}
              </div>
            )}
            {session?.permission_mode && session.permission_mode !== "default" && (
              <span
                className={`session-composer-perm-chip${session.permission_mode === "bypassPermissions" ? " session-composer-perm-chip-danger" : ""}`}
                title={`Permission mode: ${session.permission_mode}`}
                aria-label={`Permission mode: ${session.permission_mode}`}
              >
                {session.permission_mode === "acceptEdits" ? "Accept Edits" :
                 session.permission_mode === "plan" ? "Plan" :
                 session.permission_mode === "auto" ? "Auto" :
                 session.permission_mode === "bypassPermissions" ? "Bypass" : session.permission_mode}
              </span>
            )}
            {isConnecting && (
              <>
                <span className="session-composer-status-dot" aria-hidden="true" />
                <span>connecting…</span>
              </>
            )}
            {!isConnecting && !detectedAgent && sessionLabel && (
              <span className="session-composer-target">→ {sessionLabel}</span>
            )}
          </div>
          <button
            type="button"
            className="session-composer-send-btn"
            onClick={() => void handleSubmit()}
            disabled={!draft.trim()}
            title={`Send (${isMac ? "⌘" : "Ctrl"}+Enter)`}
            aria-label="Send message"
          >
            <span className="session-composer-send-label">Send</span>
            <span className="session-composer-send-kbd" aria-hidden="true">
              <kbd>{isMac ? "⌘" : "Ctrl"}</kbd>
              <kbd>↵</kbd>
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
