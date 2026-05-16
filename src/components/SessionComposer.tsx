import "../styles/components/SessionComposer.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSession, useComposer } from "../state/SessionContext";
import type { AgentAttachment } from "../utils/submitToAgent";
import { isActionMod, isMac } from "../utils/platform";
import { readImageForAttachment } from "../api/agent";
import { getActiveSlashCommand, replaceSlashCommand } from "../utils/slashCommands";
import { classifySlashCommand, missingCliBuiltins } from "../utils/slashCommandKind";
import { fuzzyRank } from "../utils/fuzzy";
import { SlashCommandsDropdown, type SlashCommandItem } from "./SlashCommandsDropdown";
import { CliCommandBanner } from "./CliCommandBanner";
import { EmbeddedSlashTerminal } from "./EmbeddedSlashTerminal";
import { ModelPicker } from "./ModelPicker";
import { PermissionPicker, CLAUDE_PERMISSION_MODES } from "./PermissionPicker";
import { EffortPicker } from "./EffortPicker";
import { CLAUDE_MODEL_OPTIONS } from "../agent/modelOptions";

/** Claude's published `--effort` levels (verified via `claude --help`). */
const CLAUDE_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
import { useAgentInit } from "../agent/useAgentInit";
import { useAgentPrewarm } from "../agent/useAgentPrewarm";
import { mergeSlashCommands } from "../utils/prewarm";
import { getCurrentWebview } from "@tauri-apps/api/webview";

let composerTextarea: HTMLTextAreaElement | null = null;

/** Live composer textarea, if mounted. */
export function getComposerTextarea(): HTMLTextAreaElement | null {
  return composerTextarea;
}

const MIN_HEIGHT = 60;
const DEFAULT_HEIGHT = 120;
const SLASH_RESULT_CAP = 12;
const MAX_PASTED_IMAGE_BYTES = 20 * 1024 * 1024;

function blobToBytes(blob: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const buf = reader.result as ArrayBuffer;
      resolve(new Uint8Array(buf));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

function bytesToBase64(bytes: Uint8Array | number[]): string {
  // Build the binary string in chunks so we don't blow the call-stack with
  // String.fromCharCode(...largeArray).  64 KB chunks comfortably stay
  // under the V8 spread-arg limit.
  const arr = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  const CHUNK = 0x8000;
  let bin = "";
  for (let i = 0; i < arr.length; i += CHUNK) {
    bin += String.fromCharCode(...arr.subarray(i, i + CHUNK));
  }
  return btoa(bin);
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

function mimeFromExt(ext: string): string {
  return `image/${ext === "jpg" ? "jpeg" : ext}`;
}

interface PendingImage {
  id: string;
  /** Filename for the pill label; absolute path when dropped, generated for paste. */
  label: string;
  /** Base64-encoded image bytes (no data: prefix). */
  base64: string;
  /** MIME type. */
  mediaType: string;
}

export function SessionComposer() {
  const { state, dispatch, switchAgentModel, switchAgentPermissionMode, switchAgentEffort, submitAgentMessage } = useSession();
  const sessionId = state.activeSessionId;
  const session = sessionId ? state.sessions[sessionId] : null;
  // Composer is Agent-mode only.  Other modes get nothing — terminal mode
  // is back to pure xterm input in v1.0.0.
  const isAgentMode = session?.mode === "agent";
  const composerSessionId = isAgentMode && sessionId ? sessionId : null;
  const { draft, height, expanded } = useComposer(composerSessionId ?? "");
  const init = useAgentInit(composerSessionId);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const agentChipRef = useRef<HTMLButtonElement | null>(null);
  const inFlightRef = useRef(false);
  const [draggingHeight, setDraggingHeight] = useState<number | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [pendingModel, setPendingModel] = useState<string | null>(null);
  const [modelSwitchError, setModelSwitchError] = useState<string | null>(null);
  const permChipRef = useRef<HTMLButtonElement | null>(null);
  const [permPickerOpen, setPermPickerOpen] = useState(false);
  const [pendingPerm, setPendingPerm] = useState<string | null>(null);
  const [permSwitchError, setPermSwitchError] = useState<string | null>(null);
  const effortChipRef = useRef<HTMLButtonElement | null>(null);
  const [effortPickerOpen, setEffortPickerOpen] = useState(false);
  const [pendingEffort, setPendingEffort] = useState<string | null>(null);
  const [activeEffort, setActiveEffort] = useState<string | null>(null);
  const [effortSwitchError, setEffortSwitchError] = useState<string | null>(null);

  // Pre-warm: read slash commands directly from .claude/commands/*.md
  // so the dropdown is populated the moment the session opens, before
  // the SDK init event lands.  Once init arrives, init.slash_commands
  // wins (it includes built-ins + plugin commands the static read can't see).
  const prewarm = useAgentPrewarm(init?.cwd);

  // ─── Slash commands sourced from init OR static prewarm ─────────────
  // Each item is classified `native` (run via stream-json prompt) or
  // `cli` (must run in an embedded `claude /<cmd>` PTY).  The dropdown
  // surfaces the kind as a badge so the user knows up-front whether
  // accepting the item will send a chat message or pop a terminal.
  const slashCommandsFromInit = useMemo<SlashCommandItem[]>(() => {
    // Two-source merge:
    //   1. Live: whatever the SDK reports in `init.slash_commands`.
    //      This is the only truly version-matched source — picks up
    //      every plugin / skill / user command the user has installed.
    //   2. Curated: the well-known Claude Code CLI-only built-ins
    //      (`/mcp`, `/agents`, `/login`, etc.) that the SDK omits
    //      because they don't work over stream-json.  The binary
    //      doesn't expose an enumeration API, so Conductor and other
    //      clients curate the same list — see CLAUDE_CLI_BUILTINS in
    //      slashCommandKind.ts.
    //   The merge is deduped: if the SDK does report a name, it
    //   wins (we trust the SDK's description over ours).
    const raw = init?.slash_commands;
    let items: SlashCommandItem[];
    if (Array.isArray(raw)) {
      items = raw
        .map((entry): SlashCommandItem | null => {
          if (typeof entry === "string") {
            const command = entry.startsWith("/") ? entry : `/${entry}`;
            return { command, label: "", description: "", source: "builtin" };
          }
          if (entry && typeof entry === "object") {
            const command = typeof entry.command === "string"
              ? (entry.command.startsWith("/") ? entry.command : `/${entry.command}`)
              : null;
            if (!command) return null;
            const description = typeof entry.description === "string" ? entry.description : "";
            return { command, label: "", description, source: "builtin" };
          }
          return null;
        })
        .filter((c): c is SlashCommandItem => c !== null);
    } else {
      const merged = mergeSlashCommands(prewarm.slashCommands, undefined);
      items = merged.map((cmd) => ({
        command: cmd.startsWith("/") ? cmd : `/${cmd}`,
        label: "",
        description: "",
        source: "builtin" as const,
      }));
    }
    // Append curated CLI built-ins that the SDK didn't include.
    // These are interactive-only by definition — mark them `cli`
    // explicitly so the classifier doesn't get tripped up by their
    // descriptions (which don't carry a CLI hint phrase).
    for (const builtin of missingCliBuiltins(items)) {
      items.push({
        command: builtin.command,
        label: "",
        description: builtin.description,
        source: "builtin",
        kind: "cli",
      });
    }
    // Items already marked (catalog) keep their kind.  Everything
    // else runs through the classifier.
    return items.map((it) => ({ ...it, kind: it.kind ?? classifySlashCommand(it) }));
  }, [init, prewarm.slashCommands]);

  // ─── Active slash overlay state ─────────────────────────────────────
  const [slash, setSlash] = useState<{ start: number; end: number; query: string } | null>(null);
  const [highlightIdx, setHighlightIdx] = useState(0);
  /** Slash command the user picked that needs an embedded PTY (e.g.
   *  `/mcp`, `/agents`).  When set, the composer renders a banner
   *  offering "Open terminal" instead of attempting to send the
   *  command as a stream-json prompt (which silently no-ops for
   *  these CLI-only commands). */
  const [pendingCliCommand, setPendingCliCommand] = useState<string | null>(null);
  /** What's running in the embedded terminal pane, if anything.
   *  - `{ kind: "slash", command: "/mcp" }` — opened from the banner
   *    after picking a CLI slash command.
   *  - `{ kind: "shell" }` — opened from the composer's terminal
   *    button for ad-hoc shell access (Conductor-style "Terminal" tab).
   *  Closing the embedded terminal sets this back to null. */
  type EmbeddedTerminalState =
    | { kind: "slash"; command: string }
    | { kind: "shell" };
  const [activeTerminal, setActiveTerminal] = useState<EmbeddedTerminalState | null>(null);

  const rankedCommands = useMemo<SlashCommandItem[] | null>(() => {
    if (!slash || !isAgentMode) return null;
    if (slashCommandsFromInit.length === 0) return [];
    const ranked = fuzzyRank(
      slashCommandsFromInit,
      slash.query,
      (c) => c.command.slice(1),
      SLASH_RESULT_CAP,
    );
    return ranked.map((r) => r.item);
  }, [slash, isAgentMode, slashCommandsFromInit]);

  useEffect(() => {
    setHighlightIdx(0);
  }, [slash?.query]);

  useEffect(() => {
    composerTextarea = textareaRef.current;
    return () => {
      if (composerTextarea === textareaRef.current) composerTextarea = null;
    };
  }, []);

  const refreshOverlay = useCallback((value: string, caret: number) => {
    if (!isAgentMode) {
      setSlash(null);
      return;
    }
    setSlash(getActiveSlashCommand(value, caret));
  }, [isAgentMode]);

  const closeOverlay = useCallback(() => { setSlash(null); }, []);

  const acceptSlash = useCallback((idx: number) => {
    if (!composerSessionId || !slash || !rankedCommands) return;
    const pick = rankedCommands[idx];
    if (!pick) return;

    // CLI-only commands DON'T go into the chat draft — they need
    // an embedded terminal.  Surface a banner above the composer
    // instead so the user knows where the command will run.  The
    // user can still cancel and type normally.
    if (pick.kind === "cli") {
      // Clear the partially-typed `/foo` from the draft so the
      // composer is ready for the next message after the terminal
      // run finishes.
      const stripped = draft.slice(0, slash.start) + draft.slice(slash.end);
      dispatch({ type: "SET_COMPOSER_DRAFT", sessionId: composerSessionId, draft: stripped });
      setPendingCliCommand(pick.command);
      setSlash(null);
      requestAnimationFrame(() => textareaRef.current?.focus());
      return;
    }

    const { text: newDraft, caret: newCaret } = replaceSlashCommand(draft, slash, pick.command);
    dispatch({ type: "SET_COMPOSER_DRAFT", sessionId: composerSessionId, draft: newDraft });
    setSlash(null);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        el.selectionStart = el.selectionEnd = newCaret;
      }
    });
  }, [composerSessionId, slash, rankedCommands, draft, dispatch]);

  const handleSubmit = useCallback(async () => {
    if (!composerSessionId) return;
    if (inFlightRef.current) return;
    if (!draft.trim() && pendingImages.length === 0) return;

    // Pre-submit routing: if the draft starts with a slash command
    // whose first token classifies as `cli` (built-in interactive
    // verb the SDK can't drive over stream-json), route to the
    // embedded terminal banner instead of sending it as a chat
    // message.  We pass the FULL command (including any trailing
    // arguments) to the embedded PTY — `/remote-control random`,
    // `/agents create foo`, etc. are valid invocations that need
    // their args preserved.  Earlier versions required `!/\s/` here,
    // which routed `/<cli-verb> <args>` to Claude as a native
    // prompt; Claude then rejected it with "isn't available in this
    // environment" since interactive slash commands aren't usable in
    // stream-json mode.
    const trimmed = draft.trim();
    if (trimmed.startsWith("/")) {
      const firstToken = trimmed.split(/\s+/, 1)[0]!;
      const kind = classifySlashCommand({ command: firstToken });
      if (kind === "cli") {
        dispatch({ type: "SET_COMPOSER_DRAFT", sessionId: composerSessionId, draft: "" });
        setPendingCliCommand(trimmed);
        return;
      }
    }

    inFlightRef.current = true;
    try {
      const attachments: AgentAttachment[] = pendingImages.map((img) => ({
        kind: "image",
        mediaType: img.mediaType,
        base64: img.base64,
      }));
      // Use SessionContext's submitAgentMessage so the subprocess is
      // auto-respawned with `--resume <uuid>` if it has exited between
      // turns.  Claude's `--print` mode is one-shot per spawn; this is the
      // bridge that makes multi-turn conversations feel continuous.
      await submitAgentMessage(composerSessionId, draft, attachments);
      dispatch({ type: "SET_COMPOSER_DRAFT", sessionId: composerSessionId, draft: "" });
      setPendingImages([]);
      closeOverlay();
    } catch (err) {
      console.error("[SessionComposer] Failed to submit:", err);
    } finally {
      inFlightRef.current = false;
    }
  }, [draft, composerSessionId, pendingImages, dispatch, closeOverlay, submitAgentMessage]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (slash && rankedCommands && rankedCommands.length > 0) {
      if (e.key === "ArrowDown") { e.preventDefault(); setHighlightIdx((i) => Math.min(i + 1, rankedCommands.length - 1)); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setHighlightIdx((i) => Math.max(i - 1, 0)); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); acceptSlash(highlightIdx); return; }
      if (e.key === "Escape") { e.preventDefault(); setSlash(null); return; }
    }

    if (isActionMod(e.nativeEvent) && e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      void handleSubmit();
      return;
    }
    // Plain Enter sends; Shift+Enter inserts a newline.  This matches
    // the chat-app convention (Claude.ai, ChatGPT, Cursor, Slack,
    // Discord) that the agent composer competes with.  Cmd/Ctrl+Enter
    // above remains as a compat path for users who learned the older
    // binding.
    //
    // Skip the send when:
    //   - any modifier other than Shift is held (Shift is reserved for
    //     newline; Cmd/Ctrl is handled above; Alt is the wildcard for
    //     OS-level shortcuts we don't want to swallow)
    //   - an IME composition is in progress — the Enter is committing
    //     a codepoint (CJK, dead-keys, voice dictation), not the
    //     message.  Both `isComposingRef.current` and the native
    //     `isComposing` flag are checked; WebKit doesn't always set
    //     the native flag in the right places.
    if (e.key === "Enter" && !e.shiftKey && !e.altKey) {
      const native = e.nativeEvent as KeyboardEvent | undefined;
      const composing = isComposingRef.current || native?.isComposing === true;
      if (!composing) {
        e.preventDefault();
        e.stopPropagation();
        void handleSubmit();
        return;
      }
    }
    if (e.key === "Escape") {
      e.preventDefault();
      if (!composerSessionId) return;
      // Esc with empty draft → collapse the composer back to its icon.
      if (draft.length === 0) {
        dispatch({ type: "SET_COMPOSER_EXPANDED", sessionId: composerSessionId, expanded: false });
      }
      return;
    }
    if (e.key === "Tab" && !e.shiftKey) {
      if (!composerSessionId) return;
      e.preventDefault();
      const el = e.currentTarget;
      const start = el.selectionStart;
      const end = el.selectionEnd;
      const newDraft = draft.slice(0, start) + "\t" + draft.slice(end);
      dispatch({ type: "SET_COMPOSER_DRAFT", sessionId: composerSessionId, draft: newDraft });
      requestAnimationFrame(() => {
        el.selectionStart = el.selectionEnd = start + 1;
      });
      return;
    }
  }, [slash, rankedCommands, highlightIdx, acceptSlash, handleSubmit, composerSessionId, draft, dispatch]);

  // AGENT-18 (revised in 1.1.13): while an IME composition is in progress
  // (CJK input, dead-keys on macOS for accented characters, voice
  // dictation), the slash-command overlay's rank/refresh is the heavy
  // path we want to skip on each partial codepoint.  The earlier
  // implementation also skipped the *draft dispatch* — that turned out
  // to leave users stuck unable to type at all if `compositionend`
  // never fired (WebKit doesn't always fire it on focus loss / unusual
  // key sequences, and it doesn't fire on US-International / Brazilian
  // Portuguese dead-keys consistently).  We now ALWAYS dispatch the
  // draft so the controlled textarea can never desync from React's
  // value, and only the overlay refresh is skipped during composition.
  const isComposingRef = useRef(false);
  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    if (!composerSessionId) return;
    const value = e.target.value;
    dispatch({ type: "SET_COMPOSER_DRAFT", sessionId: composerSessionId, draft: value });
    // Belt + suspenders: prefer the native `isComposing` flag where the browser
    // exposes it; fall back to our ref otherwise.
    const composing =
      isComposingRef.current ||
      (e.nativeEvent as InputEvent | undefined)?.isComposing === true;
    // Skip the slash-overlay refresh on transient composition codepoints
    // — `handleCompositionEnd` does a final refresh once the composition
    // commits.  Dispatching the draft itself is cheap and must always run.
    if (!composing) {
      refreshOverlay(value, e.target.selectionStart);
    }
  }, [composerSessionId, dispatch, refreshOverlay]);

  const handleCompositionStart = useCallback(() => {
    isComposingRef.current = true;
  }, []);

  const handleCompositionEnd = useCallback((e: React.CompositionEvent<HTMLTextAreaElement>) => {
    isComposingRef.current = false;
    if (!composerSessionId) return;
    const target = e.currentTarget;
    const value = target.value;
    dispatch({ type: "SET_COMPOSER_DRAFT", sessionId: composerSessionId, draft: value });
    refreshOverlay(value, target.selectionStart);
  }, [composerSessionId, dispatch, refreshOverlay]);

  // Defensive reset: if focus leaves the textarea, clear the
  // composition flag.  WebKit (the engine Tauri uses on macOS) does not
  // always fire `compositionend` when a composition is interrupted by
  // focus loss — without this reset, a stranded `true` would block
  // every subsequent keystroke after the user came back to the field.
  const handleBlur = useCallback(() => {
    isComposingRef.current = false;
  }, []);

  const handleSelect = useCallback((e: React.SyntheticEvent<HTMLTextAreaElement>) => {
    refreshOverlay(e.currentTarget.value, e.currentTarget.selectionStart);
  }, [refreshOverlay]);

  const handlePaste = useCallback(async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (!composerSessionId) return;
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
        const base64 = bytesToBase64(bytes);
        setPendingImages((prev) => [...prev, {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          label: `pasted.${ext}`,
          base64,
          mediaType: mimeFromExt(ext),
        }]);
      } catch (err) {
        console.error("[SessionComposer] Failed to read pasted image:", err);
      }
      return;
    }
  }, [composerSessionId]);

  const removePendingImage = useCallback((id: string) => {
    setPendingImages((prev) => prev.filter((p) => p.id !== id));
  }, []);

  // ─── Attach-by-button ─────────────────────────────────────
  // Hidden <input type="file"> reached via ref.  Mirrors the paste
  // flow (blobToBytes → base64 → setPendingImages) so the attached
  // image lives in the same pendingImages stack and renders in the
  // existing attachment row.
  const fileInputRef = useRef<HTMLInputElement>(null);
  const openFilePicker = useCallback(() => {
    fileInputRef.current?.click();
  }, []);
  const handleFileInputChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!composerSessionId) return;
    const files = Array.from(e.target.files ?? []);
    e.target.value = ""; // allow re-selecting the same file
    for (const file of files) {
      const ext = extFromMime(file.type);
      if (!ext) {
        console.warn(`[SessionComposer] Unsupported file type: ${file.type}`);
        continue;
      }
      if (file.size > MAX_PASTED_IMAGE_BYTES) {
        console.warn(`[SessionComposer] File too large (${file.size} > ${MAX_PASTED_IMAGE_BYTES}): ${file.name}`);
        continue;
      }
      try {
        const bytes = await blobToBytes(file);
        const base64 = bytesToBase64(bytes);
        setPendingImages((prev) => [...prev, {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          label: file.name || `attached.${ext}`,
          base64,
          mediaType: mimeFromExt(ext),
        }]);
      } catch (err) {
        console.error(`[SessionComposer] Failed to read attached file ${file.name}:`, err);
      }
    }
  }, [composerSessionId]);

  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    if (!composerSessionId) return;
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
        dispatch({ type: "SET_COMPOSER_HEIGHT", sessionId: composerSessionId, height: latestHeight });
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [height, composerSessionId, dispatch]);

  const openPromptBuilder = useCallback(() => {
    dispatch({ type: "OPEN_COMPOSER" });
  }, [dispatch]);

  // ─── Model swap ─────────────────────────────────────────────────────
  // Claude's stream-json subprocess takes the model as a spawn-time flag;
  // there's no /model slash command at runtime.  switchAgentModel tears
  // down + respawns with `--model <id>` and `--resume <prior-uuid>`, so
  // the user can swap models mid-conversation without losing context.
  const handleModelSelect = useCallback(async (modelId: string) => {
    setModelPickerOpen(false);
    if (!composerSessionId) return;
    const target = modelId === "" || modelId.toLowerCase() === "default" ? null : modelId;
    setPendingModel(target);
    setModelSwitchError(null);
    try {
      const ok = await switchAgentModel(composerSessionId, target);
      if (!ok) setModelSwitchError("Model switch failed — keeping current model.");
    } catch (err) {
      console.error("[SessionComposer] switchAgentModel rejected:", err);
      setModelSwitchError(err instanceof Error ? err.message : String(err));
    }
  }, [composerSessionId, switchAgentModel]);

  // Drop the optimistic indicator once the next init event reports the
  // requested model — that's confirmation the new subprocess is up.
  useEffect(() => {
    if (!pendingModel) return;
    const detected = init?.model?.toLowerCase() ?? "";
    if (detected.includes(pendingModel.toLowerCase())) {
      setPendingModel(null);
    }
  }, [pendingModel, init?.model]);

  // Reset pending state on session switch.
  useEffect(() => {
    setPendingModel(null);
    setModelSwitchError(null);
  }, [composerSessionId]);

  // Auto-clear the error toast after a few seconds so it doesn't linger.
  useEffect(() => {
    if (!modelSwitchError) return;
    const id = setTimeout(() => setModelSwitchError(null), 4000);
    return () => clearTimeout(id);
  }, [modelSwitchError]);

  // ─── Permission-mode swap ────────────────────────────────────────────
  // Claude's `--permission-mode` is the closest equivalent to the "effort"
  // chip Conductor exposes — it's a real spawn-time flag controlling how
  // aggressively the agent acts (default → asks before edits, acceptEdits
  // → auto-approves edits, plan → no execution, bypassPermissions → all
  // permissions auto-approved).  Same teardown+respawn-with-resume path
  // as the model picker keeps the conversation alive across the swap.
  const handlePermSelect = useCallback(async (mode: string) => {
    setPermPickerOpen(false);
    if (!composerSessionId) return;
    setPendingPerm(mode);
    setPermSwitchError(null);
    try {
      const ok = await switchAgentPermissionMode(composerSessionId, mode);
      if (!ok) setPermSwitchError("Permission swap failed — keeping current mode.");
    } catch (err) {
      console.error("[SessionComposer] switchAgentPermissionMode rejected:", err);
      setPermSwitchError(err instanceof Error ? err.message : String(err));
    }
  }, [composerSessionId, switchAgentPermissionMode]);

  // Once Claude reports the new mode in its init event, drop the optimistic
  // pending indicator.
  useEffect(() => {
    if (!pendingPerm) return;
    if (init?.permissionMode === pendingPerm) {
      setPendingPerm(null);
    }
  }, [pendingPerm, init?.permissionMode]);

  useEffect(() => {
    setPendingPerm(null);
    setPermSwitchError(null);
  }, [composerSessionId]);

  useEffect(() => {
    if (!permSwitchError) return;
    const id = setTimeout(() => setPermSwitchError(null), 4000);
    return () => clearTimeout(id);
  }, [permSwitchError]);

  // ─── Effort swap (real `--effort` flag) ─────────────────────────────
  // Verified against `claude --help`: levels are low / medium / high /
  // xhigh / max.  Same fork-on-respawn mechanic as the model and
  // permission-mode pickers — switchAgentEffort respawns Claude with
  // `--fork-session --resume <prior> --effort <level>`.
  const handleEffortSelect = useCallback(async (level: string) => {
    setEffortPickerOpen(false);
    if (!composerSessionId) return;
    setPendingEffort(level);
    setEffortSwitchError(null);
    try {
      const ok = await switchAgentEffort(composerSessionId, level);
      if (!ok) setEffortSwitchError("Effort swap failed — keeping current level.");
      else setActiveEffort(level);
    } catch (err) {
      console.error("[SessionComposer] switchAgentEffort rejected:", err);
      setEffortSwitchError(err instanceof Error ? err.message : String(err));
    } finally {
      // Effort isn't reliably reported in the init event, so we just clear
      // the pending dot after a short window — the chip then shows the
      // user-selected level as the source of truth.
      setTimeout(() => setPendingEffort(null), 1500);
    }
  }, [composerSessionId, switchAgentEffort]);

  useEffect(() => {
    setPendingEffort(null);
    setActiveEffort(null);
    setEffortSwitchError(null);
  }, [composerSessionId]);

  useEffect(() => {
    if (!effortSwitchError) return;
    const id = setTimeout(() => setEffortSwitchError(null), 4000);
    return () => clearTimeout(id);
  }, [effortSwitchError]);

  // ─── OS file drag-drop into composer ────────────────────────────────
  // Listens to Tauri's webview drag events and turns image drops into
  // attachment pills.  Non-image drops are ignored here (SplitPane handles
  // those for the terminal pane); we rejected raw file-path inserts in
  // Agent mode because the agent receives image bytes via JSON, not paths.
  useEffect(() => {
    if (!composerSessionId) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;

    const isOverComposer = (x: number, y: number): boolean => {
      const el = wrapperRef.current;
      if (!el) return false;
      const r = el.getBoundingClientRect();
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

          const imageExts = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);
          const imagePaths: string[] = [];
          for (const p of paths) {
            const ext = p.split(".").pop()?.toLowerCase() ?? "";
            if (imageExts.has(ext)) imagePaths.push(p);
          }

          if (imagePaths.length > 0) {
            void (async () => {
              for (const p of imagePaths) {
                try {
                  const bytes = await readImageForAttachment(p);
                  const ext = p.split(".").pop()?.toLowerCase() ?? "png";
                  const base64 = bytesToBase64(bytes);
                  const filename = p.split("/").pop() ?? p;
                  setPendingImages((prev) => [...prev, {
                    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                    label: filename,
                    base64,
                    mediaType: mimeFromExt(ext),
                  }]);
                } catch (err) {
                  console.error("[SessionComposer] could not read dropped image:", err);
                }
              }
            })();
          }
        }
      })
      .then((fn) => { if (cancelled) fn(); else unlisten = fn; })
      .catch((err) => console.error("[SessionComposer] drag-drop subscribe failed:", err));

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [composerSessionId]);

  // Auto-focus when expanded.
  useEffect(() => {
    if (!expanded) return;
    const el = textareaRef.current;
    if (!el) return;
    const id = requestAnimationFrame(() => el.focus());
    return () => cancelAnimationFrame(id);
  }, [expanded]);

  // External "expand and focus" trigger fired by Cmd+Shift+J.
  useEffect(() => {
    if (!composerSessionId) return;
    const handler = (ev: Event) => {
      const detail = (ev as CustomEvent).detail as { sessionId?: string } | undefined;
      if (detail?.sessionId && detail.sessionId !== composerSessionId) return;
      dispatch({ type: "SET_COMPOSER_EXPANDED", sessionId: composerSessionId, expanded: true });
      requestAnimationFrame(() => textareaRef.current?.focus());
    };
    window.addEventListener("hermes:expand-composer", handler);
    return () => window.removeEventListener("hermes:expand-composer", handler);
  }, [composerSessionId, dispatch]);

  if (!composerSessionId) {
    return null;
  }

  if (!expanded) {
    // Wrap the FAB in a properly-sized container so it has its own
    // positioning context.  Without this wrapper, `position: absolute`
    // on the FAB falls back to a positioned ancestor up the tree (often
    // the entire pane) and the pill ends up clipped against the status
    // bar.  The wrapper carries enough vertical room for the 36px pill
    // plus comfortable margin above the status bar.
    return (
      <div className="session-composer-collapsed">
        <button
          type="button"
          className="session-composer-fab"
          onClick={() => dispatch({ type: "SET_COMPOSER_EXPANDED", sessionId: composerSessionId, expanded: true })}
          title={`Open composer (${isMac ? "⌘⇧J" : "Ctrl+Shift+J"})`}
          aria-label="Open composer"
        >
          <svg className="session-composer-fab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
          <span className="session-composer-fab-label">Compose</span>
          <span className="session-composer-fab-kbd" aria-hidden="true">
            <kbd>{isMac ? "⌘" : "Ctrl"}</kbd><kbd>⇧</kbd><kbd>J</kbd>
          </span>
        </button>
      </div>
    );
  }

  const effectiveHeight = maximized
    ? Math.floor(window.innerHeight * 0.7)
    : (draggingHeight ?? (height || DEFAULT_HEIGHT));

  const minimizeComposer = () => {
    setMaximized(false);
    dispatch({ type: "SET_COMPOSER_EXPANDED", sessionId: composerSessionId, expanded: false });
  };
  const toggleMaximize = () => {
    setMaximized((m) => !m);
  };
  const isConnecting = !init && (session?.phase === "creating" || session?.phase === "initializing");
  const sessionLabel = session?.label ?? "";
  const showSlash = slash !== null && rankedCommands !== null;

  const placeholder = sessionLabel
    ? `Message ${sessionLabel}…  (/ for commands)`
    : "Type a message…";

  const liveModel = init?.model ?? null;

  /** Compact display for the chip — collapse Claude's full model id
   *  (`claude-haiku-4-5-20251001`) down to its family alias (`haiku`)
   *  so the composer footer fits on one row even on narrow windows.
   *  Falls through unchanged for anything that doesn't match the
   *  `claude-<family>-…` shape. */
  const compactModel = (m: string | null): string | null => {
    if (!m) return m;
    const lower = m.toLowerCase();
    const match = /^claude-(opus|haiku|sonnet)-/.exec(lower);
    return match ? match[1] : m;
  };

  return (
    <div
      ref={wrapperRef}
      className={`session-composer session-composer-claude ${isDragOver ? "session-composer-drag-over" : ""}`}
      // When the embedded terminal OR the CLI banner is mounted,
      // let the wrapper grow naturally — the user-set composer height
      // applies only to the textarea card.  Otherwise the extra
      // chrome overflows the fixed-height wrapper and clips the
      // textarea below.
      style={(activeTerminal || pendingCliCommand) ? undefined : { height: effectiveHeight }}
      // Data flag drives a min-height bump in CSS so a pasted image
      // can't squash the textarea below readable size — see
      // .session-composer[data-has-attachments="true"] in SessionComposer.css
      data-has-attachments={pendingImages.length > 0 ? "true" : undefined}
    >
      <div
        className="session-composer-resize-handle"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize composer"
        onMouseDown={handleResizeMouseDown}
      />
      {pendingCliCommand && !activeTerminal && (
        <CliCommandBanner
          command={pendingCliCommand}
          onOpenTerminal={() => {
            setActiveTerminal({ kind: "slash", command: pendingCliCommand });
            setPendingCliCommand(null);
          }}
          onCancel={() => setPendingCliCommand(null)}
        />
      )}
      {activeTerminal && (
        <EmbeddedSlashTerminal
          spec={activeTerminal}
          // cwd fallback chain: SDK init wins (it's the canonical
          // session cwd), then the session's working_directory which
          // we have on record from session creation, then a final
          // null which lets the PTY inherit the parent process —
          // which is rarely correct (the dev binary's launch dir is
          // not where the user expects claude to run).
          cwd={init?.cwd ?? session?.working_directory ?? null}
          onClose={() => setActiveTerminal(null)}
        />
      )}
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
              No commands available yet — Claude will publish them once it's ready.
            </div>
          </div>
        )}
        {pendingImages.length > 0 && (
          <div className="session-composer-attachments" aria-label="Attached images">
            {pendingImages.map((img) => {
              const dataUrl = `data:${img.mediaType};base64,${img.base64}`;
              return (
                <div key={img.id} className="session-composer-attachment" title={img.label}>
                  <img src={dataUrl} alt={img.label} />
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
          onCompositionStart={handleCompositionStart}
          onCompositionEnd={handleCompositionEnd}
          onBlur={handleBlur}
          placeholder={placeholder}
          aria-label="Compose agent message"
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
            {/* Ad-hoc shell terminal — opens the same embedded PTY
                the slash-CLI banner uses, but spawns the user's
                default shell instead of `claude /<cmd>`.  Lets the
                user run any command (git, npm, ls, etc.) without
                leaving the agent surface.  Toggles open/closed. */}
            <button
              type="button"
              className="session-composer-terminal-btn"
              onClick={() => {
                setActiveTerminal((cur) =>
                  cur && cur.kind === "shell" ? null : { kind: "shell" },
                );
              }}
              title="Toggle inline shell terminal"
              aria-label="Toggle inline shell terminal"
              aria-pressed={activeTerminal?.kind === "shell"}
            >
              ›_ Terminal
            </button>
            {/* Attach-by-button — explicit affordance for the same
                image-attachment flow that paste/drop already use.  The
                hidden <input type="file"> sits outside the row so it
                doesn't affect layout; the visible button calls .click()
                on it. */}
            <button
              type="button"
              className="session-composer-attach-btn"
              onClick={openFilePicker}
              title="Attach image (PNG, JPG, GIF, WebP, BMP)"
              aria-label="Attach image"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
              </svg>
              <span className="session-composer-attach-label">Attach</span>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp,image/bmp"
              multiple
              onChange={handleFileInputChange}
              style={{ display: "none" }}
              aria-hidden="true"
              tabIndex={-1}
            />
            {/* Model picker.  Click → opens ModelPicker → switchAgentModel
                respawns the Claude subprocess with the new --model flag and
                `--resume <prior-uuid>` so the conversation is preserved.
                A "•" decoration on the chip shows that a swap is in flight
                until the next init event confirms the new model. */}
            {(liveModel || pendingModel) && (
              <div className="session-composer-agent-wrap">
                <button
                  ref={agentChipRef}
                  type="button"
                  className={`session-composer-agent session-composer-agent-clickable composer-chip composer-chip-model${pendingModel ? " session-composer-agent-pending" : ""}`}
                  onClick={() => setModelPickerOpen((o) => !o)}
                  // Full id in the tooltip so the user can still see it without
                  // the long string blowing out the row.
                  title={`Switch model — current: ${pendingModel ?? liveModel ?? ""}`}
                  aria-label={`Switch model (current: ${pendingModel ?? liveModel ?? ""})`}
                  aria-expanded={modelPickerOpen}
                  aria-haspopup="menu"
                >
                  <span className="composer-chip-dot" aria-hidden="true" />
                  <span className="composer-chip-value">{compactModel(pendingModel ?? liveModel)}</span>
                  {pendingModel && (
                    <span className="session-composer-agent-pending-dot" aria-hidden="true">•</span>
                  )}
                  <span className="composer-chip-caret" aria-hidden="true">▾</span>
                </button>
                {modelPickerOpen && (
                  <ModelPicker
                    anchorEl={agentChipRef.current}
                    options={CLAUDE_MODEL_OPTIONS}
                    currentModel={pendingModel ?? liveModel}
                    onSelect={(m) => void handleModelSelect(m)}
                    onClose={() => setModelPickerOpen(false)}
                  />
                )}
              </div>
            )}
            {modelSwitchError && (
              <span
                className="session-composer-perm-chip session-composer-perm-chip-danger"
                title={modelSwitchError}
              >
                model swap failed
              </span>
            )}
            {/* Permission-mode picker.  Click → opens the PermissionPicker
                → switchAgentPermissionMode respawns Claude with the chosen
                `--permission-mode` flag (and `--resume <prior-uuid>` so the
                conversation stays alive).  This is the Claude-shaped
                equivalent of Conductor's "effort" chip — it's a real lever
                that controls how aggressively the agent acts. */}
            {(liveModel || pendingModel) && (() => {
              const activePerm = pendingPerm ?? init?.permissionMode ?? "default";
              const meta = CLAUDE_PERMISSION_MODES.find((p) => p.id === activePerm)
                ?? CLAUDE_PERMISSION_MODES[0];
              const isDanger = meta.tone === "danger";
              return (
                <div className="session-composer-perm-wrap">
                  <button
                    ref={permChipRef}
                    type="button"
                    className={`session-composer-perm-chip-btn composer-chip composer-chip-perms${pendingPerm ? " session-composer-perm-chip-btn-pending" : ""}${isDanger ? " session-composer-perm-chip-btn-danger composer-chip-danger" : ""}`}
                    onClick={() => setPermPickerOpen((o) => !o)}
                    title={`Permission mode: ${meta.label} — click to switch`}
                    aria-label={`Permission mode: ${meta.label}`}
                    aria-haspopup="menu"
                    aria-expanded={permPickerOpen}
                  >
                    <span className="composer-chip-dot" aria-hidden="true" />
                    <span className="composer-chip-value">{meta.label}</span>
                    {pendingPerm && (
                      <span className="session-composer-agent-pending-dot" aria-hidden="true">•</span>
                    )}
                    <span className="composer-chip-caret" aria-hidden="true">▾</span>
                  </button>
                  {permPickerOpen && (
                    <PermissionPicker
                      anchorEl={permChipRef.current}
                      current={activePerm}
                      onSelect={(m) => void handlePermSelect(m)}
                      onClose={() => setPermPickerOpen(false)}
                    />
                  )}
                </div>
              );
            })()}
            {permSwitchError && (
              <span
                className="session-composer-perm-chip session-composer-perm-chip-danger"
                title={permSwitchError}
              >
                permission swap failed
              </span>
            )}

            {/* Effort chip — Claude's real `--effort` flag.  Same respawn-
                with-fork pattern as model/permission swaps.  Defaults to a
                neutral "Effort" label until the user picks one; click to
                cycle/pick. */}
            {(liveModel || pendingModel) && (() => {
              const effortLabel = pendingEffort ?? activeEffort ?? "Effort";
              return (
                <div className="session-composer-perm-wrap">
                  <button
                    ref={effortChipRef}
                    type="button"
                    className={`session-composer-perm-chip-btn composer-chip composer-chip-effort${pendingEffort ? " session-composer-perm-chip-btn-pending" : ""}`}
                    onClick={() => setEffortPickerOpen((o) => !o)}
                    title="Thinking effort — respawns Claude with --effort"
                    aria-label={`Effort: ${effortLabel}`}
                    aria-haspopup="menu"
                    aria-expanded={effortPickerOpen}
                  >
                    <span className="composer-chip-dot" aria-hidden="true" />
                    <span className="composer-chip-value">{effortLabel}</span>
                    {pendingEffort && (
                      <span className="session-composer-agent-pending-dot" aria-hidden="true">•</span>
                    )}
                    <span className="composer-chip-caret" aria-hidden="true">▾</span>
                  </button>
                  {effortPickerOpen && (
                    <EffortPicker
                      anchorEl={effortChipRef.current}
                      levels={[...CLAUDE_EFFORT_LEVELS]}
                      current={activeEffort}
                      pending={pendingEffort}
                      onSelect={(l) => void handleEffortSelect(l)}
                      onClose={() => setEffortPickerOpen(false)}
                    />
                  )}
                </div>
              );
            })()}
            {effortSwitchError && (
              <span
                className="session-composer-perm-chip session-composer-perm-chip-danger"
                title={effortSwitchError}
              >
                effort swap failed
              </span>
            )}
            {isConnecting && (
              <>
                <span className="session-composer-status-dot" aria-hidden="true" />
                <span>connecting…</span>
              </>
            )}
          </div>
          <button
            type="button"
            className="session-composer-send-btn"
            onClick={() => void handleSubmit()}
            disabled={!draft.trim() && pendingImages.length === 0}
            title={`Send (Enter · Shift+Enter for newline)`}
            aria-label="Send message"
          >
            <span className="session-composer-send-label">Send</span>
            <svg
              className="session-composer-send-arrow"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M5 12h14" />
              <path d="M13 6l6 6-6 6" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
