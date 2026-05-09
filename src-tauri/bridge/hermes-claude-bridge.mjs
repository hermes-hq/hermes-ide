#!/usr/bin/env node
/**
 * Hermes Claude Bridge.
 *
 * Drop-in replacement for `claude --print --output-format stream-json
 * --input-format stream-json` powered by `@anthropic-ai/claude-agent-sdk`.
 *
 * **Why a bridge?** The SDK only runs in Node (process, child_process, streams
 * — none available in a Tauri webview).  We want the SDK's superpowers
 * (`interrupt()`, `setModel()`, `setMcpServers()`, `rewindFiles()`,
 * `canUseTool`, in-process MCP via `createSdkMcpServer()`) without rewriting
 * Hermes.  This bridge runs as a per-session Node subprocess — Rust spawns
 * it the same way it used to spawn `claude` — and translates between the
 * Hermes wire format on stdio and the SDK's in-process API.
 *
 * **Wire contract (intentionally compatible with the previous `claude`
 * stream-json invocation so the Rust agent crate doesn't need to change):**
 *
 *   stdin  : newline-delimited JSON.  Two shapes:
 *     1. SDK user message   — { type: "user", message: {...}, uuid?, ... }
 *        (forwarded to the SDK's prompt iterator unchanged)
 *     2. Bridge control op  — { type: "_hermes_control", op: <verb>, ... }
 *        (interpreted by the bridge, NOT forwarded; verbs include
 *         "interrupt", "setModel", "setPermissionMode", "setMaxThinkingTokens".
 *         The Rust side issues these to drive mid-session state changes.)
 *
 *   stdout : newline-delimited JSON SDKMessage stream — assistant /
 *            user / system(init) / result / partial-message events,
 *            shaped exactly like the old `claude` stdout so the existing
 *            messageStore reducer consumes them unchanged.
 *
 *   stderr : free-form bridge / SDK errors.  Rust forwards to the
 *            `agent-stderr-{sessionId}` Tauri channel.
 *
 *   exit code 0  on clean completion (all input processed, query exhausted).
 *   exit code 1  on bridge error (SDK init, malformed flags).
 *   exit code 2  on signal (SIGINT during processing).
 *
 * **CLI flags (subset of `claude`'s flags that we use):**
 *
 *   --session-id <uuid>           required
 *   --resume <uuid>               optional (mutually exclusive with --session-id when --fork-session is unset)
 *   --fork-session                optional flag
 *   --model <id|alias>            optional
 *   --permission-mode <mode>      optional
 *   --effort <level>              optional
 *   --add-dir <path>              optional, repeatable
 *   --include-partial-messages    optional (forwarded to SDK)
 *   --include-hook-events         optional (forwarded to SDK)
 *   --max-budget-usd <n>          optional
 *   --max-turns <n>               optional
 *   --working-dir <path>          required (set as `cwd` on SDK options)
 *   --hermes-app-id <id>          optional, for the SDK User-Agent header
 *
 * Anything we don't recognize: ignored with a stderr warning.
 *
 * **Stability note:** the bridge's wire contract is purely internal to
 * Hermes.  The Rust agent crate and this file move together.  Outside
 * consumers must not depend on this format.
 */

import { query, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { argv, exit, stdin, stdout, stderr } from "node:process";
import { createInterface } from "node:readline";
import { readFileSync, existsSync } from "node:fs";
import { z } from "zod";
import {
  createCanUseToolHandler,
  buildPermissionOptions,
} from "./canUseToolHelpers.mjs";

// ─── 1. Parse CLI args ──────────────────────────────────────────────

const flags = parseFlags(argv.slice(2));

// Session identity rule (matches the Rust spawn shapes):
//   - INITIAL spawn  → --session-id <new>
//   - RESUME spawn   → --resume <prior>     (no --session-id)
//   - FORK spawn     → --session-id <new> + --resume <prior> + --fork-session
// The bridge MUST have at least one of (--session-id, --resume) to know which.
if (!flags.sessionId && !flags.resume) {
  stderr.write("[hermes-bridge] need --session-id or --resume\n");
  exit(1);
}
if (!flags.workingDir) {
  stderr.write("[hermes-bridge] missing required --working-dir\n");
  exit(1);
}

// ─── 2. AsyncIterable of user inputs from stdin ─────────────────────

let pendingResolve = null;
const inputBuffer = [];
let inputClosed = false;
let aborted = false;
const abortController = new AbortController();

/** Map of pending canUseTool requests keyed by request id.  When the
 *  host sends back a `_hermes_perm_response` with the matching id, the
 *  promise is resolved and the SDK callback returns. */
const permPending = new Map();
let permIdSeq = 0;

const rl = createInterface({ input: stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    stderr.write(`[hermes-bridge] ignoring malformed stdin line: ${line.slice(0, 200)}\n`);
    return;
  }
  // Bridge control ops short-circuit and don't reach the SDK input stream.
  if (parsed && parsed.type === "_hermes_control") {
    handleControl(parsed).catch((err) => {
      stderr.write(`[hermes-bridge] control op '${parsed.op}' failed: ${err}\n`);
    });
    return;
  }
  // Permission decision from the host — resolves the canUseTool callback
  // promise that's currently awaiting this id.  See `canUseTool` below.
  if (parsed && parsed.type === "_hermes_perm_response" && typeof parsed.id === "string") {
    const pending = permPending.get(parsed.id);
    if (pending) {
      permPending.delete(parsed.id);
      pending.resolve(parsed.decision);
    }
    return;
  }
  // Anything else: forward to the SDK as a user input.
  pushInput(parsed);
});
rl.on("close", () => {
  inputClosed = true;
  if (pendingResolve) {
    const r = pendingResolve;
    pendingResolve = null;
    r();
  }
});

function pushInput(msg) {
  inputBuffer.push(msg);
  if (pendingResolve) {
    const r = pendingResolve;
    pendingResolve = null;
    r();
  }
}

async function* userInputIterator() {
  let yieldedFirst = false;
  while (true) {
    if (aborted) return;
    if (inputBuffer.length > 0) {
      // Hold back the first yield until init has been processed by our
      // for-await loop so liveRuntime.reportedModel is populated before
      // the SDK invokes UserPromptSubmit.  Capped at 2s so a slow init
      // doesn't deadlock the user.
      if (!yieldedFirst) {
        const sleep = new Promise((r) => setTimeout(r, 2000));
        await Promise.race([initSeen.promise, sleep]);
        yieldedFirst = true;
      }
      const next = inputBuffer.shift();
      // Normalize to the SDKUserMessage shape the SDK expects.  Old Hermes
      // envelopes lack `parent_tool_use_id`; the SDK wants null, not absent.
      // session_id falls back to whatever Rust gave us; the SDK fills it
      // in from the active session if absent.
      yield {
        type: "user",
        message: next.message,
        parent_tool_use_id: next.parent_tool_use_id ?? null,
        uuid: next.uuid,
        ...(next.session_id || flags.sessionId
          ? { session_id: next.session_id ?? flags.sessionId }
          : {}),
      };
      continue;
    }
    if (inputClosed) return;
    await new Promise((resolve) => { pendingResolve = resolve; });
  }
}

// ─── 2.5 Hermes MCP server + SessionStart hook ──────────────────────
//
// The bridge exposes a tiny in-process MCP server named "hermes" that
// gives Claude first-class access to IDE state — without polluting any
// user message.  Tools read from a shared JSON file at
// `--hermes-state-path` that Rust writes when the user changes the
// active file, attaches a project, etc.  Stale-by-up-to-one-write is
// fine; the file is the same one whose content is the SessionStart hook
// digest, so Claude sees consistent values across the two.
//
// **Design:** tools instead of resources because `createSdkMcpServer()`
// exposes a tool-only ergonomic API.  Functionally equivalent — Claude
// just calls `mcp__hermes__get_project_state` instead of reading a
// resource URL.

function readIdeState() {
  if (!flags.hermesStatePath) return null;
  if (!existsSync(flags.hermesStatePath)) return null;
  try {
    return JSON.parse(readFileSync(flags.hermesStatePath, "utf8"));
  } catch (err) {
    stderr.write(`[hermes-bridge] failed to read ide state: ${err}\n`);
    return null;
  }
}

/** Build the MCP server.  Empty tool list when `--hermes-state-path` is
 *  unset (so older callers that don't pass the flag get a no-op MCP
 *  server, kept for forward-compat tests). */
function buildHermesMcpServer() {
  const tools = [
    tool(
      "get_project_state",
      "Returns the current Hermes IDE state: cwd, current git branch, the active editor file (if any), the user's selection, and the list of attached project paths. Use this to orient yourself to what the user is working on without asking.",
      {},
      async () => {
        const state = readIdeState() ?? { cwd: flags.workingDir };
        return {
          content: [{ type: "text", text: JSON.stringify(state, null, 2) }],
        };
      },
    ),
    tool(
      "list_projects",
      "Returns the list of project paths currently attached to this session. These directories are also passed to Claude Code as --add-dir so file tools can read/edit there.",
      {},
      async () => {
        const state = readIdeState() ?? {};
        const paths = state.attachedPaths ?? [];
        return {
          content: [{ type: "text", text: JSON.stringify(paths, null, 2) }],
        };
      },
    ),
    tool(
      "get_session_memory",
      "Returns user-pinned facts/notes the user attached to this Hermes session. These are short reminders the user wants Claude to keep in mind for the whole session (e.g. 'prefer rg over grep'). May be empty.",
      {},
      async () => {
        const state = readIdeState() ?? {};
        const memory = state.memory ?? [];
        return {
          content: [{ type: "text", text: JSON.stringify(memory, null, 2) }],
        };
      },
    ),
    tool(
      "open_file",
      "Open a file in the Hermes IDE — focuses or opens a tab for the given path. Optionally jumps to a 1-indexed line. Use this when you want to *show* the user a file, not when you want to read its contents (use Read for that).",
      { path: z.string(), line: z.number().int().positive().optional() },
      async ({ path, line }) => {
        // The bridge can't reach into the React webview directly, so we
        // emit a side-channel event that Rust forwards to the frontend.
        // Format mirrors the SDKMessage envelope so the existing Tauri
        // event pipeline can carry it without a new IPC.
        const evt = {
          type: "_hermes_event",
          subtype: "open_file",
          path,
          ...(line !== undefined ? { line } : {}),
          uuid: globalThis.crypto?.randomUUID?.() ?? `evt-${Date.now()}`,
          session_id: flags.sessionId ?? undefined,
        };
        stdout.write(JSON.stringify(evt) + "\n");
        return { content: [{ type: "text", text: `opened ${path}${line ? ` at line ${line}` : ""}` }] };
      },
    ),
  ];
  return createSdkMcpServer({
    name: "hermes",
    version: "1.0.0",
    tools,
  });
}

// Live runtime — populated from the SDK's init event so we always know
// the *actual* model/permission Claude is running under, not just what
// flags we passed.  Read by both SessionStart and UserPromptSubmit hooks
// so Claude can answer "what model are you?" correctly.
const liveRuntime = {
  model: flags.model ?? null,
  permissionMode: flags.permissionMode ?? null,
  effort: flags.effort ?? null,
  cwd: flags.workingDir,
  // Filled in once the first init event arrives.
  reportedModel: null,
  reportedPermissionMode: null,
};

// Resolves the first time the for-await loop sees an init event.  Hooks
// await it so they don't race ahead of the SDK's internal init: by the
// time UserPromptSubmit returns its `additionalContext`, the runtime
// line carries the actually-loaded model, not "(account default)".
const initSeen = (() => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
})();

function buildRuntimeLine(hookInput) {
  const m = liveRuntime.reportedModel ?? liveRuntime.model ?? "(account default)";
  // Prefer the hook input's permission_mode — it's always available and
  // always current, vs. our reportedPermissionMode which is only set
  // after we read an init event.
  const p =
    (hookInput && typeof hookInput.permission_mode === "string"
      ? hookInput.permission_mode
      : null)
    ?? liveRuntime.reportedPermissionMode
    ?? liveRuntime.permissionMode
    ?? "default";
  const e = liveRuntime.effort ?? "auto";
  return `Hermes IDE runtime: model=${m}, permission_mode=${p}, effort=${e}. When asked about model/permission/effort, answer with these exact values — they are ground truth.`;
}

/** Build the per-turn IDE digest re-injected via UserPromptSubmit so
 *  Claude's orientation never goes stale across `--resume`.  The
 *  agent-mode equivalent of the old Terminal-mode `$HERMES` env that
 *  was visible to every command.
 *
 *  Why this exists separately from `sessionStartHook()`: SessionStart
 *  fires once per spawn, but its `additionalContext` is not always
 *  faithfully re-surfaced to the model after a `--resume` — the
 *  visible bug was Claude saying "Hermes hasn't mentioned any attached
 *  project paths" while the runtime line came through fine (because
 *  UserPromptSubmit injects it every turn).  Re-injecting attached
 *  paths via UserPromptSubmit too guarantees Claude is oriented on
 *  every user message regardless of resume / compaction. */
function buildOrientationDigest(hookInput) {
  const state = readIdeState();
  const lines = [buildRuntimeLine(hookInput)];
  if (Array.isArray(state?.attachedPaths) && state.attachedPaths.length > 0) {
    lines.push(
      `Hermes attached project paths (${state.attachedPaths.length}): ${state.attachedPaths.join(", ")}. ` +
      `These are real directories the user has attached to this session — your file tools have read/write access to all of them in addition to cwd.  Treat them as part of "the project."`,
    );
  } else {
    lines.push(`Hermes attached project paths: (none beyond cwd)`);
  }
  if (state?.cwd) lines.push(`Hermes session cwd: ${state.cwd}`);
  return lines.join("\n");
}

/** Compose the SessionStart hook callback.  Claude calls this on
 *  startup, resume, and after every compaction.  We return a small
 *  digest of IDE state as `additionalContext` — invisible to the
 *  transcript, refreshed on every entry. */
function sessionStartHook() {
  return async (input) => {
    const state = readIdeState();
    const lines = ["You are running inside Hermes IDE.  IDE state:"];
    lines.push(`- cwd: ${state?.cwd ?? flags.workingDir}`);
    if (state?.branch) lines.push(`- git branch: ${state.branch}`);
    if (state?.dirty) lines.push(`- working tree: dirty`);
    if (state?.activeFile) lines.push(`- active file: ${state.activeFile}`);
    if (Array.isArray(state?.attachedPaths) && state.attachedPaths.length > 0) {
      lines.push(`- attached project paths: ${state.attachedPaths.join(", ")}`);
    }
    if (Array.isArray(state?.memory) && state.memory.length > 0) {
      lines.push(`- session memory: ${state.memory.map((m) => m.text ?? m).slice(0, 5).join(" | ")}`);
    }
    lines.push(`- ${buildRuntimeLine(input)}`);
    return {
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: lines.join("\n"),
      },
    };
  };
}

/** UserPromptSubmit hook — fires on every user message.  Re-injects the
 *  full IDE orientation digest (runtime line + attached project paths +
 *  cwd) so Claude is grounded in the current session state every turn.
 *  Invisible to the transcript.
 *
 *  Awaits the first init event with a short timeout so the FIRST user
 *  message also gets the actually-loaded model, not "(account default)". */
function userPromptSubmitHook() {
  return async (input) => {
    if (liveRuntime.reportedModel === null) {
      const sleep = new Promise((r) => setTimeout(r, 1500));
      await Promise.race([initSeen.promise, sleep]);
    }
    return {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: buildOrientationDigest(input),
      },
    };
  };
}

// ─── 3. Build SDK options from CLI flags ────────────────────────────

const sdkOptions = {
  cwd: flags.workingDir,
  abortController,
  // The first run uses `--session-id`; resumed runs use `--resume`.  The SDK
  // treats `forkSession` orthogonally — same semantics as the CLI flag.
  ...(flags.resume ? { resume: flags.resume } : { sessionId: flags.sessionId }),
  ...(flags.forkSession ? { forkSession: true } : {}),
  ...(flags.model ? { model: flags.model } : {}),
  // bypassPermissions also requires allowDangerouslySkipPermissions: true.
  // See buildPermissionOptions() in canUseToolHelpers.mjs.
  ...buildPermissionOptions(flags),
  ...(flags.effort ? { effort: flags.effort } : {}),
  ...(flags.addDir.length > 0 ? { additionalDirectories: flags.addDir } : {}),
  includePartialMessages: !!flags.includePartialMessages,
  includeHookEvents: !!flags.includeHookEvents,
  ...(flags.maxBudgetUsd != null ? { maxBudgetUsd: flags.maxBudgetUsd } : {}),
  ...(flags.maxTurns != null ? { maxTurns: flags.maxTurns } : {}),
  // Hermes MCP server — gives Claude first-class IDE access.  Wired
  // unconditionally; tools no-op gracefully when no `--hermes-state-path`
  // was passed (back-compat with tests / external callers).
  mcpServers: { hermes: buildHermesMcpServer() },
  // Auto-allow only tools that have NO interactive UI to render —
  //   * mcp__hermes__*  : our IDE-context MCP tools, never destructive
  //   * TodoWrite       : produces a side-panel UI, no permission UX
  //
  // AskUserQuestion / ExitPlanMode / EnterPlanMode are intentionally
  // routed through `canUseTool` so the bridge fires a perm-request the
  // host turns into a native card.  The host's allow/deny response IS
  // the user's answer/decision.  Auto-allowing these would cause Claude
  // to execute the tool with empty `answers` (the previous bug).
  allowedTools: [
    "mcp__hermes__*",
    "TodoWrite",
  ],
  // Inject IDE state on session start, resume, and after compactions.
  // Invisible to the transcript; the user never sees this in the chat.
  // UserPromptSubmit re-injects the runtime line on every turn so the
  // model+permission Claude reports never drifts from reality.
  hooks: {
    SessionStart: [
      { matcher: "startup|resume|compact", hooks: [sessionStartHook()] },
    ],
    UserPromptSubmit: [
      { matcher: ".*", hooks: [userPromptSubmitHook()] },
    ],
  },
  // canUseTool — forwards permission requests to the host (Hermes
  // frontend) via a `_hermes_perm_request` envelope on stdout.  Awaits
  // a matching `_hermes_perm_response` on stdin.  The user's decision
  // (allow / deny / edit input / approve-all) round-trips through
  // Hermes' native React modal — no chat-string permission prompts.
  // Skipped under bypassPermissions; the SDK auto-allows there.
  //
  // Honours the SDK's abort signal (3rd-arg `options.signal`) so a
  // mid-prompt abort settles the pending request with a deny instead
  // of hanging until SIGTERM.  See createCanUseToolHandler().
  canUseTool: createCanUseToolHandler({
    stdout,
    permPending,
    idGen: () => `perm-${++permIdSeq}-${Date.now()}`,
  }),
  // Forward bridge stderr-by-line so SDK panics surface to Rust.
  stderr: (data) => stderr.write(data),
  env: {
    ...process.env,
    CLAUDE_AGENT_SDK_CLIENT_APP: flags.hermesAppId ?? "hermes-ide/v1",
  },
};

// ─── 4. Drive the SDK and pump messages to stdout ───────────────────

let queryHandle;

async function main() {
  try {
    queryHandle = query({
      prompt: userInputIterator(),
      options: sdkOptions,
    });
  } catch (err) {
    stderr.write(`[hermes-bridge] query() init failed: ${err && err.stack ? err.stack : err}\n`);
    exit(1);
  }

  try {
    let canonicalSessionId = flags.sessionId; // populated on init
    for await (const message of queryHandle) {
      if (aborted) break;
      // Latch the canonical session id and live runtime info from each
      // init event — these drive the SessionStart / UserPromptSubmit
      // hooks that keep Claude oriented to its actual model + perm.
      if (
        message
        && message.type === "system"
        && (message.subtype === "init" || message.subtype === "session_started")
      ) {
        if (message.session_id) canonicalSessionId = message.session_id;
        // Detect drift in the runtime values vs. what the host UI is
        // currently showing.  When Claude flips permission_mode via
        // EnterPlanMode/ExitPlanMode, or when the user runs `/model`,
        // the SDK reports the new value here — we fan it out to the
        // host so the picker chips update.  Skip the emit when nothing
        // actually changed (avoids respawn ping-pong).
        const before = {
          model: liveRuntime.reportedModel,
          permissionMode: liveRuntime.reportedPermissionMode,
        };
        if (typeof message.model === "string") {
          liveRuntime.reportedModel = message.model;
        }
        if (typeof message.permissionMode === "string") {
          liveRuntime.reportedPermissionMode = message.permissionMode;
        }
        const changed =
          liveRuntime.reportedModel !== before.model
          || liveRuntime.reportedPermissionMode !== before.permissionMode;
        if (changed) {
          stdout.write(JSON.stringify({
            type: "_hermes_state_changed",
            session_id: canonicalSessionId,
            ...(liveRuntime.reportedModel
              ? { model: liveRuntime.reportedModel }
              : {}),
            ...(liveRuntime.reportedPermissionMode
              ? { permissionMode: liveRuntime.reportedPermissionMode }
              : {}),
            uuid: globalThis.crypto?.randomUUID?.() ?? `evt-${Date.now()}`,
          }) + "\n");
        }
        // Unblock any UserPromptSubmit hook waiting for the first init.
        initSeen.resolve();

        // Fire-and-forget — fetch the SDK's accountInfo and emit it to
        // stdout as a hermes-side event the Usage panel can consume.
        // We only ask once per session; if it fails, the panel just
        // shows what it already has from rate_limit events.
        if (!liveRuntime.accountFetched) {
          liveRuntime.accountFetched = true;
          (async () => {
            try {
              const info = await queryHandle.accountInfo();
              const evt = {
                type: "_hermes_event",
                subtype: "account_info",
                info,
                uuid: globalThis.crypto?.randomUUID?.() ?? `evt-${Date.now()}`,
                session_id: canonicalSessionId,
              };
              stdout.write(JSON.stringify(evt) + "\n");
            } catch (err) {
              stderr.write(`[hermes-bridge] accountInfo() failed: ${err}\n`);
            }
          })();
        }
      }
      const stamped = { ...message };
      if (!stamped.session_id && canonicalSessionId) {
        stamped.session_id = canonicalSessionId;
      }
      stdout.write(JSON.stringify(stamped) + "\n");
    }
  } catch (err) {
    stderr.write(`[hermes-bridge] query iteration error: ${err && err.stack ? err.stack : err}\n`);
    exit(1);
  }

  exit(0);
}

async function handleControl(op) {
  if (!queryHandle) return; // ops before query() init: ignore
  switch (op.op) {
    case "interrupt":
      await queryHandle.interrupt();
      return;
    case "setModel":
      await queryHandle.setModel(op.model ?? undefined);
      return;
    case "setPermissionMode":
      await queryHandle.setPermissionMode(op.mode);
      return;
    case "setMaxThinkingTokens":
      // SDK marks `setMaxThinkingTokens` as deprecated in favour of the
      // `thinking` option on `query()`.  But the streaming Query interface
      // exposes no live `setThinking` (and `applyFlagSettings` only takes
      // `Settings` keys, not `thinking`), so the deprecated method is
      // currently the only mid-session path.  Migrate when the SDK adds a
      // live setter (track via a future SDK changelog entry).
      await queryHandle.setMaxThinkingTokens(op.tokens ?? null);
      return;
    case "setMcpServers":
      // op.servers : Record<string, McpServerConfig>
      await queryHandle.setMcpServers(op.servers ?? {});
      return;
    default:
      stderr.write(`[hermes-bridge] unknown control op: ${op.op}\n`);
  }
}

process.on("SIGINT", () => {
  aborted = true;
  abortController.abort();
  exit(2);
});
process.on("SIGTERM", () => {
  aborted = true;
  abortController.abort();
  exit(2);
});

main();

// ─── helpers ────────────────────────────────────────────────────────

function parseFlags(args) {
  const out = {
    sessionId: undefined,
    workingDir: undefined,
    resume: undefined,
    forkSession: false,
    model: undefined,
    permissionMode: undefined,
    effort: undefined,
    addDir: [],
    includePartialMessages: false,
    includeHookEvents: false,
    maxBudgetUsd: undefined,
    maxTurns: undefined,
    hermesAppId: undefined,
    hermesStatePath: undefined,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = () => args[++i];
    switch (a) {
      case "--session-id":            out.sessionId = next(); break;
      case "--working-dir":           out.workingDir = next(); break;
      case "--resume":                out.resume = next(); break;
      case "--fork-session":          out.forkSession = true; break;
      case "--model":                 out.model = next(); break;
      case "--permission-mode":       out.permissionMode = next(); break;
      case "--effort":                out.effort = next(); break;
      case "--add-dir":               out.addDir.push(next()); break;
      case "--include-partial-messages": out.includePartialMessages = true; break;
      case "--include-hook-events":   out.includeHookEvents = true; break;
      case "--max-budget-usd":        out.maxBudgetUsd = Number(next()); break;
      case "--max-turns":             out.maxTurns = Number(next()); break;
      case "--hermes-app-id":         out.hermesAppId = next(); break;
      case "--hermes-state-path":     out.hermesStatePath = next(); break;
      // Quietly accept legacy claude flags Rust may still pass:
      case "--print":
      case "--output-format":
      case "--input-format":
      case "--verbose":
        // values for --output-format / --input-format come right after them
        if (a === "--output-format" || a === "--input-format") next();
        break;
      default:
        stderr.write(`[hermes-bridge] ignoring unknown flag: ${a}\n`);
    }
  }
  return out;
}
