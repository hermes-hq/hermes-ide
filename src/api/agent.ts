import { invoke } from "@tauri-apps/api/core";

/** Why an agent could not run. `spawn_failed` and `busy` come from the spawn
 *  commands; the others are read from the agent's output and exit (see
 *  src/agent/agentErrors.ts). */
export type AgentErrorKind = "spawn_failed" | "signed_out" | "exited" | "busy" | "protocol";

/** A rejected spawn / restart command. `message` is the backend's text, so
 *  code that only reads `err.message` keeps working. */
export class AgentCommandError extends Error {
  readonly kind: AgentErrorKind;
  constructor(kind: AgentErrorKind, message: string) {
    super(message);
    this.name = "AgentCommandError";
    this.kind = kind;
  }
}

const COMMAND_ERROR_KINDS: ReadonlySet<string> = new Set(["spawn_failed", "busy"]);

/** Normalise whatever `invoke` rejected with: the typed `{ kind, message }`
 *  object the spawn commands return, a plain string, or an Error. Anything
 *  untyped counts as a failure to start. */
export function toAgentCommandError(raw: unknown): AgentCommandError {
  if (raw instanceof AgentCommandError) return raw;
  if (raw && typeof raw === "object" && !(raw instanceof Error)) {
    const { kind, message } = raw as { kind?: unknown; message?: unknown };
    if (typeof kind === "string" && COMMAND_ERROR_KINDS.has(kind) && typeof message === "string") {
      return new AgentCommandError(kind as AgentErrorKind, message);
    }
  }
  const message = raw instanceof Error ? raw.message : typeof raw === "string" ? raw : JSON.stringify(raw);
  return new AgentCommandError("spawn_failed", message);
}

type SpawnOptions = {
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
};

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
export function spawnAgentSession(opts: SpawnOptions): Promise<string> {
  return invoke<string>("spawn_agent_session", opts).catch((err: unknown) => {
    throw toAgentCommandError(err);
  });
}

/** Stop the session's agent process (if any) and start a new one, holding the
 *  session's spawn lock. Restarts that overlap start one process between them:
 *  a plain restart that waited for another returns the process that one
 *  started. A `fork` (new model / permission mode / effort) always restarts.
 *  Rejects with an {@link AgentCommandError}. */
export function restartAgentSession(opts: SpawnOptions): Promise<string> {
  return invoke<string>("restart_agent_session", opts).catch((err: unknown) => {
    throw toAgentCommandError(err);
  });
}

/** The earlier conversation of a Claude session, read back from Claude's own
 *  transcript as Agent-view events (oldest first); empty when there is none. */
export function getAgentHistory(workingDir: string, claudeSessionId: string): Promise<unknown[]> {
  return invoke<unknown[]>("agent_history", { workingDir, claudeSessionId });
}

/** Send one JSON event (typically a user message) to the agent's stdin. */
export function sendAgentInput(sessionId: string, payload: unknown): Promise<void> {
  return invoke("send_agent_input", { sessionId, payload });
}

/** Soft interrupt — asks the bridge (politely) to call `query.interrupt()`
 *  without killing the process.  Bridge keeps running, ready for the
 *  next user message.  Use this from the user-facing Stop button. */
export function softInterruptAgent(sessionId: string): Promise<void> {
  return sendAgentInput(sessionId, { type: "_hermes_control", op: "interrupt" });
}

/** Force stop (CHAOS-10): the agent ignored the soft interrupt, so its
 *  process is stopped (SIGINT, then SIGKILL). The conversation stays: the
 *  next message resumes it in a new process. */
export function forceStopAgent(sessionId: string): Promise<void> {
  return invoke("force_stop_agent", { sessionId });
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
