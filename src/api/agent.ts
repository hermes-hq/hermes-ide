import { invoke } from "@tauri-apps/api/core";

export interface ClaudeCliInfo {
  version: string;
  path: string;
}

/** Spawn a Claude agent subprocess for this session. Returns the Claude session UUID.
 *
 *  `permissionMode` accepts Claude's published values: "default", "acceptEdits",
 *  "plan", "bypassPermissions". Anything else is dropped server-side.
 *
 *  `fork` controls how a `priorUuid` is treated:
 *    - false (default): plain `--resume` — Claude reloads the session and
 *      keeps the original model/permission mode (new flags are ignored).
 *      Use this for between-turn auto-respawn where nothing has changed.
 *    - true: branches a fresh session from the prior history via
 *      `--session-id <new> --resume <prior> --fork-session`. Required when
 *      the user has actually changed `model` or `permissionMode` mid-
 *      conversation — that's the only flag combination Claude honors. */
export function spawnAgentSession(opts: {
  sessionId: string;
  workingDir: string;
  priorUuid?: string;
  model?: string;
  permissionMode?: string;
  /** Real Claude CLI flag verified via `claude --help`. Levels: low,
   *  medium, high, xhigh, max.  Anything else is dropped server-side. */
  effort?: string;
  /** Extra directories to grant tool access to via `--add-dir`.  Used
   *  for projects the user attaches via the Context Panel — Claude can
   *  read / edit files in any of these in addition to the primary cwd. */
  addDirs?: string[];
  fork?: boolean;
}): Promise<string> {
  return invoke<string>("spawn_agent_session", opts);
}

/** Send one JSON event (typically a user message) to the agent's stdin. */
export function sendAgentInput(sessionId: string, payload: unknown): Promise<void> {
  return invoke("send_agent_input", { sessionId, payload });
}

/** Interrupt the in-flight turn without tearing down the subprocess.
 *  Hard path — sends SIGINT.  Used when the bridge has gone unresponsive. */
export function interruptAgent(sessionId: string): Promise<void> {
  return invoke("interrupt_agent", { sessionId });
}

/** Soft interrupt — asks the bridge (politely) to call `query.interrupt()`
 *  without killing the process.  Bridge keeps running, ready for the
 *  next user message.  Use this from the user-facing Stop button. */
export function softInterruptAgent(sessionId: string): Promise<void> {
  return sendAgentInput(sessionId, { type: "_hermes_control", op: "interrupt" });
}

/**
 * Live-flip the bridge's permission mode without a respawn.  Mirrors the
 * SDK's runtime `setPermissionMode` so a chip flip takes effect on the
 * NEXT canUseTool call from the in-flight turn — not on the next user
 * message.  Best-effort: if the bridge has exited between turns, this
 * is a no-op (the next spawn picks up the queued flag instead).
 */
export async function setAgentPermissionMode(
  sessionId: string,
  mode: string,
): Promise<void> {
  return sendAgentInput(sessionId, { type: "_hermes_control", op: "setPermissionMode", mode });
}

/** Graceful shutdown: drop stdin, wait briefly, kill if still alive. */
export function closeAgentSession(sessionId: string): Promise<void> {
  return invoke("close_agent_session", { sessionId });
}

/** Check whether `claude` is installed and return version + resolved path. */
export function checkClaudeCli(): Promise<ClaudeCliInfo> {
  return invoke<ClaudeCliInfo>("check_claude_cli");
}

/**
 * Read an image file from disk for a composer attachment.
 *
 * The Rust side validates the extension (png/jpg/jpeg/gif/webp/bmp only)
 * and rejects files larger than 20 MB.  Returns the raw bytes; the caller
 * is responsible for base64-encoding before sending to the agent.
 */
export function readImageForAttachment(path: string): Promise<number[]> {
  return invoke<number[]>("read_image_for_attachment", { path });
}

/** Hermes IDE state pushed to the bridge's MCP tools.  Anything Claude
 *  should know about IDE state without polluting the user transcript goes
 *  here — `mcp__hermes__get_project_state` returns it on demand. */
export interface HermesIdeState {
  cwd?: string;
  branch?: string;
  dirty?: boolean;
  activeFile?: string;
  selection?: string;
  attachedPaths?: string[];
  memory?: Array<{ key?: string; text: string; ts?: number }>;
  pinnedFiles?: string[];
  [key: string]: unknown;
}

/** Update the Hermes IDE state file the bridge's MCP tools read.  Cheap;
 *  call freely (on every project attach/detach, on active-file change).
 *  No respawn — Claude sees the new value on its next tool call. */
export function updateHermesState(sessionId: string, state: HermesIdeState): Promise<void> {
  return invoke("update_hermes_state", { sessionId, state });
}
