# Hermes IDE — v1.0 Agent Mode Master Plan

> **Status: DRAFT — awaiting user sign-off.**
> No code is written against this document until the user approves and we agree on milestone ordering.
> This supersedes `v1-agent-stabilization-plan.md` and `v1-claude-agent-from-scratch.md`.

---

## 0. The mandate

Build the best agent-IDE chat surface that exists. Conductor, Cursor's chat panel, Claude.ai, and Continue are the *floor*; we exceed each on a measurable axis. Claude only, agent-mode only for v1.0. The terminal mode stays as a separate concern — it's not the focus.

The discipline that makes this real:

- **Every behavior is specified before it's coded.**
- **Every behavior has a test before the code.** Integration tests against the real `claude` binary are the gate, not unit tests against mocks.
- **No "I think it works."** `npm run preflight` is the only `READY` signal.
- **The user's bug reports become tests, then fixes — not the other way round.**

---

## 1. The headline architectural shift (LOCKED)

**We stop being a subprocess wrapper and become an IDE that hosts a Claude runtime in-process via `@anthropic-ai/claude-agent-sdk`.** No more raw `tokio::process::Command::new("claude")`. No more `--input-format stream-json` over stdin. The SDK owns the spawn lifecycle; we own everything the user sees.

Three concrete consequences for the user:

1. **A real `Stop` button** — `query.interrupt()` actually cancels mid-stream.
2. **Instant model swap, no respawn dance** — `query.setModel()` and `query.setMcpServers()` mutate the live session. The fork-empty-stdin bug class is gone — we never fork.
3. **File checkpointing as a first-class feature** — `query.rewindFiles({ userMessageId })` lets us expose "undo this edit" on every `FileToolBlock`. No competitor has this.

Four integration planes we now use as a peer to Claude:

1. **In-process MCP server** via `createSdkMcpServer()` — JS handlers share memory with the Tauri webview's IDE state. Resources expose live state on demand (`hermes://project/state`, `hermes://git/status`, `hermes://session/memory`, `hermes://session/transcript`). Tools let Claude drive the IDE (`hermes__open_file`, `hermes__show_diff`, `hermes__attach_project`).
2. **`SessionStart` hook with `additionalContext`** — invisible per-session orientation. Claude knows its model · permission · effort · cwd · branch · open file on every spawn and after every compaction. No transcript pollution.
3. **`canUseTool` callback** — permission UX rendered in our own React modal. Slides up from the bottom of the conversation, shows file path + diff + `[Approve / Approve All / Deny / Edit]`.
4. **Settings injection at spawn time** — `--settings <literal-json>` composes hooks, status line, file-suggestion backend per-spawn. No files written to disk.

The headline mental model: **Claude is a coworker that runs inside Hermes**, with native access to the IDE state, full ability to act on it, and a first-class undo on its actions. Conductor scrapes a TUI; Cursor relays through extensions; we co-host.

---

## 2. The four pillars of the v1.0 agent surface

Every feature lives in one of these. Treat them as the architecture root.

### Pillar A — The Hermes MCP server (`hermes://`) — IN-PROCESS

Built with the SDK's `createSdkMcpServer()` factory. Lives in the Tauri webview's JS context. Tool handlers are plain JS functions; resource handlers return live snapshots from the React state / Tauri IPC. Zero serialization across processes.

**What it exposes:**

*Resources (Claude reads on demand, no token cost when unused):*
- `hermes://project/state` — `{ cwd, branch, dirty, openFile, selection, openTabs[], recentEdits[] }`
- `hermes://git/status` — output of `git status --short` (or structured equivalent)
- `hermes://git/diff` — current uncommitted diff
- `hermes://git/log` — last 20 commits
- `hermes://projects` — `[ { id, name, path, branch, attachedAt } ]` for all projects attached to this session
- `hermes://session/memory` — user-pinned facts, notes, links (scoped per session)
- `hermes://session/pins` — pinned files for the session
- `hermes://session/transcript` — past turns as JSONL (Claude can search its own prior conversation — effectively infinite memory across compactions)

*Tools (Claude calls when it wants to act on the IDE):*
- `hermes__open_file(path, line?)` — opens a tab, optionally jumps to line
- `hermes__show_diff(path, original, proposed)` — renders our native diff viewer with `[Apply / Reject / Modify]`. Approval flow lives in the IDE, not in chat.
- `hermes__reveal_in_explorer(path)` — Finder/Explorer reveal
- `hermes__run_in_terminal(sessionId?, command)` — runs in a PTY pane (terminal mode)
- `hermes__attach_project(path)`, `hermes__detach_project(projectId)`
- `hermes__pin_file(path)`, `hermes__unpin_file(path)`
- `hermes__remember(key, value)` — session memory write

*Prompts (slash-callable from the composer via `/mcp__hermes__*`):*
- `/mcp__hermes__diff_active_file` — generate a diff against HEAD for the currently-open file
- `/mcp__hermes__summarize_session` — structured handoff summary
- `/mcp__hermes__explain_selection` — uses current editor selection

**Spawn-time wiring:**
SDK's `query()` accepts `mcpServers: { hermes: createSdkMcpServer({ tools, resources, prompts }) }`. No `--mcp-config` flag, no subprocess, no socket. We also pass `allowedTools: ["mcp__hermes__*"]` so Claude can call them without per-tool approval friction.

### Pillar B — Hooks + permission UX via the SDK

We don't run an HTTP server. The SDK accepts `hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>>` directly — JS callback functions. Same surface as the HTTP-hook approach but in-process:

```ts
const result = query({
  prompt: userInput,
  options: {
    mcpServers: { hermes: createSdkMcpServer({ /* … */ }) },
    allowedTools: ["mcp__hermes__*"],
    hooks: {
      SessionStart: [{
        matcher: "startup|resume|compact",
        hooks: [async () => ({
          hookSpecificOutput: {
            hookEventName: "SessionStart",
            additionalContext: ideStateDigest(), // ≤500 tokens
          },
        })],
      }],
      // PreToolUse permission UX is handled by canUseTool below — cleaner.
      PostToolUse: [{ matcher: ".*", hooks: [recordTurnMetrics] }],
    },
    canUseTool: async (toolName, input) => {
      const decision = await showPermissionModal({ toolName, input });
      return decision.approved
        ? { behavior: "allow", updatedInput: decision.modified ?? input }
        : { behavior: "deny", message: "User declined", interrupt: false };
    },
  },
});
```

**What each integration does for the user:**

- `SessionStart` returns `additionalContext` — Claude knows model/perm/effort/cwd/branch/openFile on every spawn. **Invisible to the transcript.** Re-injected after compaction so post-compact Claude isn't suddenly amnesic.
- `canUseTool` — renders our permission modal, returns the user's decision. The modal shows file path + diff preview + `[Approve / Approve All / Deny / Edit]`. The "Edit" path lets the user tweak the tool input before approving (e.g., correct a path).
- `PostToolUse` — records duration, tokens, cost into per-session telemetry; refreshes git/file state so the next MCP resource read is fresh.

### Pillar C — The agent control plane

The thing that owns the lifecycle of the Claude subprocess and the per-session refs. Our `SessionContext` already has the bones; this pillar formalizes them.

**Per-session truth (refs in `SessionContext`):**

```ts
interface AgentSessionTracking {
  claudeUuid: string | undefined;       // canonical session id from init
  model: string | undefined;            // current --model
  permissionMode: string | undefined;   // current --permission-mode
  effort: string | undefined;           // current --effort
  addDirs: string[];                    // current --add-dir set
  pendingFlags: { model?, perm?, effort? }; // queued chip changes
  initListenerUnlisten: () => void;     // tauri listener cleanup
  attachedProjects: ProjectAttachment[];// joined view
  pendingProjects: { add: string[]; remove: string[] }; // queued attach/detach
}
```

**Lifecycle events the control plane emits:**

```
agent.spawnRequested(sessionId, shape, args)
agent.spawnReturned(sessionId, claudeUuid)
agent.initReceived(sessionId, init)
agent.toolStarted(sessionId, toolName, toolUseId, ts)
agent.toolEnded(sessionId, toolUseId, durationMs, ok)
agent.streamStarted(sessionId, messageId)
agent.streamEnded(sessionId, messageId, stopReason)
agent.subprocessExited(sessionId, code, signal)
agent.respawnTriggered(sessionId, reason)  // why: 'auto-resume' | 'fork' | 'crash-recovery' | 'flag-change'
agent.flagsApplied(sessionId, applied)
agent.failureSurfaced(sessionId, kind, detail)
```

A single subscriber (the AgentSessionView) maps these to UI state. Multiple subscribers (telemetry, status bar, dev-tools console log) can also listen.

**The four spawn shapes — locked in:**

| Shape | Trigger | Argv |
|---|---|---|
| `INITIAL` | First spawn for a new session | `--session-id <new>` (+ baseline flags + addDirs + mcp + settings hooks) |
| `RESUME` | Between-turn continuation | `--resume <canonical>` (no `--session-id`) |
| `FORK` | User-driven flag change | `--session-id <new> --resume <prior> --fork-session` (+ new flags) |
| `RESTORE` | App restart / workspace restore | `--session-id <new>` with `--add-dir` from saved `workspace_paths` |

The control plane chooses the shape. The composer never thinks about shape — it only queues flags.

### Pillar D — The conversation surface

The visible conversation. Every UI affordance lives here. Specified per-component below.

---

## 3. Component-by-component spec (every visible thing)

### 3.1 Masthead

```
┌──────────────────────────────────────────────────────────────────────┐
│ ●  AGENT · sonnet · my-project · +2 paths · MCP·hermes      14:32 [≡]│
└──────────────────────────────────────────────────────────────────────┘
```

**States:**

| State | LED | Text |
|---|---|---|
| idle (post-init) | green, no pulse | `READY` |
| pre-init (first message not yet sent) | grey, no pulse | `READY` |
| user message sent, awaiting Claude | brass, slow pulse | `AWAITING CLAUDE · 4s` |
| streaming text | brass, fast pulse | `THINKING · 12s` |
| tool running | yellow, respiration | `RUNNING Bash · 47s` |
| rate limited | yellow, no pulse | `RATE LIMIT · resets 14:45` |
| subprocess crashed | red, no pulse | `CRASHED — code 137 [retry]` |

**Sub-spec — "+N paths" indicator:**
Hover reveals a popover with the full list of attached project paths. Click → opens the projects sidebar. Pulses brass for 2s after a project attach/detach.

**Sub-spec — `MCP·hermes` lozenge:**
Reflects `init.mcp_servers` status. Green when our MCP server is `connected`, red+pulse when `failed`, hidden when no MCP server is configured for that session.

### 3.2 Conversation column

Centered. Max-width 920px (current). Each turn:

- Time gutter (left): `HH:MM:SS` only on the first message of the turn.
- User prompt: italic JetBrains Mono, brass left-rule.
- Assistant body: regular JetBrains Mono, full GFM markdown via `MarkdownBody`.
- Tool blocks: family-distinct visual (file/exec/search/web/generic — already shipped, keep).
- Colophon (right-aligned, dim): `2.4s · 312 out · $0.07`. Click to expand to model · stop reason · cache · full token breakdown.

**Inter-turn rhythm:** 1px hairline + 18px top padding on each user message after the first.

**Empty state:** brass LED + `[ AWAITING FIRST SIGNAL ]` (already shipped, keep).

**Streaming cue:** the brass block heartbeat cursor at the end of the streaming text (already shipped, keep).

**Raw view:** every assistant message has a hover-revealed `RAW` button that flips to a `<pre>` of literal markdown source with copy button (already shipped).

**Mermaid:** rendered SVG with a `source ↔ diagram` toggle (already shipped).

### 3.3 Composer (chatbox)

```
┌─ [ ❯  Message…                                                ]      [⛶][−] ┐
│                                                                              │
│ ✨Builder │ Claude · sonnet ▾ │ default ▾ │ medium ▾ │ +1path ▾  │ ⌘↵ SEND │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Hard rules:**
- Single row of chips. Never wraps. Below ~720px, chips collapse into a `⋯` menu past a threshold.
- Model chip shows the **family alias** (`sonnet`, `opus`, `haiku`) — full id only in tooltip.
- Pending state on chips: brass `•` glyph next to the value, cleared on the next init that confirms.
- Send button is the only colored button. Brass.
- `❯` glyph at the top-left of the slate, brightens on focus.
- Brass focus ring on the slate.

**Slash commands:**
- `/` opens a dropdown of available slash commands (from `init.slash_commands`) plus our MCP-prompts (`/mcp__hermes__*`).
- Tab to accept, Enter to insert, Esc to dismiss.

**Image paste / drop:**
- Already wired — keep.

**Pending-flags chip indicator:**
- Each chip with `pendingFlags[sessionId][flagName]` set shows the `•` until init confirms.

### 3.4 Right sidebar — Context Panel

Today the Context Panel is hidden behind a toggle. **For agent mode, it's always visible** as a 280-px-wide right sidebar with three sections:

```
┌─ CONTEXT ──────────────┐
│                        │
│ ▾ PROJECTS             │
│   ✓ ira-site (main)    │
│   + add project…       │
│                        │
│ ▾ SESSION MEMORY       │
│   📌 prefer rg over… ✕ │
│   📌 follow .editorco… │
│   + remember…          │
│                        │
│ ▾ PINNED FILES         │
│   📄 src/auth.ts       │
│   📄 src/router.tsx    │
│   + pin file…          │
│                        │
│ ▾ COST & TOKENS        │
│   $0.42 · 12,341 in   │
│         · 4,202 out   │
│   ━━━━━━━╴╴╴╴╴╴ 14%   │
│                        │
└────────────────────────┘
```

**Spec:**

- **Projects section** — `attachedProjects` list with toggle-detach checkboxes. `+ add project…` opens the project picker.
- **Session memory** — list of pinned facts. Each is `{key, value, ts}`. Add via input. Remove via ✕. Stored per-session, exposed to Claude via `hermes://session/memory`.
- **Pinned files** — files Claude should always have access to. Exposed via `hermes://session/pins` (planned new resource) or just `--add-dir <parent>`.
- **Cost & tokens** — per-session `metrics.token_usage`. Sparkline of recent turns. Progress bar against any `--max-budget-usd` set.

The current `ContextPanel` has most of this; we're rewiring it to ALWAYS render in agent mode and surfacing it through the MCP server so Claude can read the same data.

### 3.5 Left sidebar — Sessions list

(Existing, mostly OK — minor tightening.)

```
┌─ SESSIONS ─────────────┐
│ + new session          │
│                        │
│ ● ira-site             │
│   sonnet · 14h ago     │
│                        │
│ ○ h-ide                │
│   opus · 2 days ago    │
│                        │
│ ○ playground           │
│   haiku · 5 days ago   │
└────────────────────────┘
```

- Single row per session. Color band, name, current model, last-turn relative timestamp.
- Filled circle = currently focused. Hollow = open in another pane.
- Right-click: Rename, Convert to terminal, Close.
- Drag to reorder. Drag onto pane = focus there.

### 3.6 Session creator

```
┌─ NEW SESSION ─────────────────────┐
│                                   │
│ Project        [ ▾ select ]       │
│                                   │
│ Model          ( sonnet / opus ▾) │
│ Permission     ( default ▾ )      │
│ Effort         ( medium ▾ )       │
│                                   │
│ ▸ Advanced (max-budget, channels) │
│                                   │
│            [   Create   ]         │
└───────────────────────────────────┘
```

**Hard rules:**
- One screen.
- Keyboard navigation: Tab through fields, Enter to create.
- "Advanced" reveals: max-budget-usd, channels, custom system prompt.

### 3.7 Failure surfaces

**`No conversation found`:**
```
┌────────────────────────────────────────┐
│ ⚠ Conversation not found               │
│ Claude couldn't resume session         │
│ <uuid>. Probably persisted under a     │
│ different id, or the store rotated.    │
│                                        │
│ [ Start fresh from here ]  [ Details ▾]│
└────────────────────────────────────────┘
```
"Start fresh from here" spawns a NEW initial session (no `--resume`), preserving the prior conversation transcript in the UI but starting Claude clean.

**`Session ID already in use`:**
Auto-recover with a new uuid. No user-visible notice (just dev-log).

**Subprocess crash (non-zero or signal):**
```
┌────────────────────────────────────────┐
│ ✕ Process exited with code 137         │
│ stderr:                                │
│ <exact stderr lines>                   │
│                                        │
│ [ Retry ] [ Start fresh ] [ Copy log ] │
└────────────────────────────────────────┘
```

**Rate limit:**
Top banner across the conversation column with countdown to reset. Submits queue, retried automatically when the window opens.

**Claude not on PATH:**
Splash-screen with platform-specific install instructions and a "Recheck" button.

### 3.8 Activity surfaces

The masthead ticker + the heartbeat cursor are the only "alive" cues. Both already exist.

**Per-tool indicators (inside the conversation):**
- Exec tool block: bar respires while running, solidifies green/red on completion (already shipped).
- File tool block: violet stripe respires while running (already shipped).
- Other tool blocks: get the same respiration treatment.

---

## 4. The full feature inventory (terminal → agent parity)

From the audit, here's what the agent surface MUST support, with priority. Items already done in v1 are marked ✅; the rest land via the milestones in §6.

### 4.1 Must-have parity (HIGH severity gaps)

| Feature | Status today | Plan |
|---|---|---|
| Context Panel always visible | hidden by default in agent mode | M5 — rewire to always-visible right sidebar in agent mode |
| Memory facts (CLAUDE.md memory) | hidden | M5 — sidebar section + MCP resource `hermes://session/memory` |
| Pinned files | hidden | M5 — sidebar section + MCP resource `hermes://session/pins` |
| Token metrics per-session | only global in status bar | M5 — sidebar section + cost-tracking against `--max-budget-usd` |
| Provider Actions Bar in agent | hidden by design | leave hidden; the composer is the agent input. ✅ |
| Execution-mode cycle button | hidden by design | leave hidden in agent mode. ✅ |

### 4.2 Already-working parity (KEEP)

| Feature | Status |
|---|---|
| Project attach/detach via ProjectPicker | working |
| Workspace paths in `session.workspace_paths` | working |
| Git Panel (toggle) | working |
| Scope bar (project pills) | working |
| File explorer / file preview | working |
| Search panel | working |
| Worktree branch isolation | working |
| Session description / group / color | working |
| Channels (Telegram) | working |
| Workspace restore on launch | working |
| Long-running task notification | working |
| Session list sidebar | working |
| Activity bar tab order | working |

### 4.3 Now-broken behavior to fix

| Item | Failure mode | Plan |
|---|---|---|
| Chip overflow on narrow window | "low" wraps below | M3 — composer one-row guarantee |
| Model display showing full id | `claude-haiku-4-5-20251001` cluttering | M3 — `compactModel()` |
| Restoring scrollback into agent session | silent no-op | M9 — gracefully reject `restoreFromId` for agent restores; warn user |
| Auto-attach project on cwd change | partially works in agent | M5 — verify with integration test, fix if broken |
| Workspace restore for agent sessions | spawns without `--resume` from prior Claude id | M2 — persist `claudeUuid` in saved workspace JSON, attempt resume on restore |

### 4.4 New features (the moves nobody else has)

| Feature | Why it matters |
|---|---|
| Hermes MCP server | Claude has first-class access to IDE state without polluting messages |
| `SessionStart` hook with IDE digest | Claude is *oriented* every session start, post-compaction |
| Native permission UX via `canUseTool` / `defer` | Permission prompts render in our React, not as a Claude prompt |
| `rewindFiles()` checkpointing | Undo-an-edit affordance after Claude makes a change you don't like |
| Mid-session `setMcpServers()` | Hot-attach a new MCP server without respawning |
| Structured-output-driven side panels | "Suggest 5 commit messages" → typed array → native UI list |
| Cost dashboard with `--max-budget-usd` | Soft + hard cap on spend, per-session |

---

## 5. Test coverage for every behavior

### 5.1 Spec-line → test-name map

Every behavior in §3 maps to a test. The columns: spec, test name, level (unit / frontend-component / e2e-real-claude), gate.

| Spec § | Behavior | Test name | Level | Milestone gate |
|---|---|---|---|---|
| 3.1 | Masthead state is `THINKING` while streaming | `derive-activity.test.ts::reports thinking while streaming` | unit | M1 ✅ |
| 3.1 | Masthead `+N paths` reflects attached projects | `masthead-paths.test.tsx::renders +N when paths > 0` | component | M5 |
| 3.1 | MCP lozenge shows `failed` on init | `masthead-mcp.test.tsx::renders red lozenge on mcp_servers failed` | component | M4 |
| 3.2 | Inter-turn hairline appears between turns | `agent-marginalia.test.tsx::renders hairline above each user message after the first` | component | M1 ✅ |
| 3.2 | Streaming cursor shown at end of streaming text | `agent-marginalia.test.tsx::renders cursor on isStreamingTail` | component | M1 ✅ |
| 3.2 | Empty state shows brass LED + AWAITING FIRST SIGNAL | `empty-state.test.tsx` | component | M1 ✅ |
| 3.3 | Composer never wraps to a 2nd row | `composer-layout.test.tsx::chips fit in a single row at 720/900/1200px` | component | M3 |
| 3.3 | Model chip shows family alias, not full id | `composer-layout.test.tsx::compactModel('claude-haiku-4-5-20251001') === 'haiku'` | unit | M3 |
| 3.3 | Pending dot shown after chip click | `deferred-fork.test.ts::queue marks chip pending` | unit | M1 ✅ |
| 3.3 | Submit drains pending and applies via fork | `deferred-fork.test.ts::submit applies queued flags via fork` | unit | M1 ✅ |
| 3.4 | Context Panel always visible in agent mode | `agent-context-panel.test.tsx::context panel renders for mode=agent without manual toggle` | component | M5 |
| 3.4 | Memory pin/unpin round-trips | `session-memory.test.ts::pin/unpin roundtrip` | unit | M5 |
| 3.4 | Cost & tokens per session | `cost-panel.test.tsx::renders accumulated cost from result events` | component | M5 |
| 3.5 | Session list shows model + last-turn relative time | `session-list.test.tsx::renders model and last-turn delta` | component | M6 |
| 3.6 | Session creator one-screen, Tab/Enter | `session-creator-keyboard.test.tsx` | component | M7 |
| 3.7 | "No conversation found" surfaces with Start-Fresh CTA | `failure-no-conversation.test.tsx` | component | M8 |
| 3.7 | Subprocess crash shows stderr + retry | `failure-crash.test.tsx` | component | M8 |
| 3.7 | Rate limit banner with countdown | `failure-rate-limit.test.tsx` | component | M8 |
| 4.4 | MCP server registers under `~/.claude/ide/<port>.lock` | `e2e_hermes_mcp_handshake.rs` | e2e | M4 |
| 4.4 | MCP `hermes://project/state` returns live IDE state | `e2e_hermes_mcp_resource.rs` | e2e | M4 |
| 4.4 | MCP `hermes__open_file` opens a tab in the IDE | `e2e_hermes_mcp_open_file.rs` | e2e | M4 |
| 4.4 | `SessionStart` hook injects IDE digest | `e2e_session_start_hook.rs::additionalContext lands in claude` | e2e | M4 |
| 4.4 | `--add-dir` grants Claude access to attached project | `e2e_add_dir_grants_extra_project_access` | e2e | M1 ✅ |

(That's a representative sample. The full plan has ~80 test entries — we don't ship a milestone until every test in its column passes against the real `claude` binary.)

### 5.2 The preflight contract

```
npm run preflight
  ├─ tsc --noEmit                            ← types
  ├─ vitest run                              ← frontend tests
  ├─ cd src-tauri && cargo test --lib        ← rust unit
  └─ cargo test --lib agent::e2e_tests:: -- --ignored --nocapture --test-threads 1
                                             ← real-claude e2e
```

Preflight is the only `READY` signal. If any of the four legs fails, we don't ship. The user's bug reports become tests in column 4 before the fix.

---

## 6. Sequencing — milestones, parallel-agent execution, gates

The work is split into 12 milestones. Some are blockers; most can run in parallel once foundations land.

```
M1  ─┬─ M2 (workspace persistence) ──────────────┐
     ├─ M3 (composer one-row + compact)          │
     ├─ M4 (MCP + hooks bridge)                  ├─ M9 (failure surfaces)
     ├─ M5 (context panel + memory + cost)       │      │
     ├─ M6 (session list redesign)               ├──────┴── M11 (visual / aesthetic)
     ├─ M7 (session creator one-screen)          │
     ├─ M8 (project attach UI integration)       │
     └─ M10 (cost / max-budget)                  ┘
                                                 ↓
                                              M12 (release)
```

Parallel agents pick up M2…M10 once M1 is green. Each agent owns its milestone end-to-end: tests written, code written, preflight green, doc updated.

### M1 — Foundation lockdown (sequential)

**Goal:** lock down what's already working. Don't ship anything new. Don't regress what's there.

**Pre-conditions:** none.

**Deliverables:**
- All current preflight green (already so).
- Update `package.json` `preflight` script to also run `cargo test --lib` (Rust units).
- Document the four spawn shapes in `agent/mod.rs` doc-comments (already so).
- Document the deferred-fork queue and per-session refs in `SessionContext.tsx` (mostly done; finish it).

**Gate:** preflight green.

### M2 — Workspace persistence + crash recovery

**Goal:** Reopening the app picks up exactly where you left off, including Claude's session id for `--resume`.

**Pre-conditions:** M1.

**Deliverables:**
- Persist `claudeUuid` per session into `SavedWorkspace` JSON.
- On workspace restore, spawn with `--resume <persisted-uuid>` in `RESTORE` shape; if Claude can't find it, fall back to fresh `INITIAL`.
- Persist `model`, `permissionMode`, `effort`, `addDirs` per session.
- New tests:
  - `e2e_workspace_restore_resumes_prior_uuid`
  - `workspace-saved-shape.test.ts::v2 schema includes claudeUuid`
  - `workspace-restore-fallback.test.ts::falls back to fresh on resume failure`

**Gate:** preflight + above tests.

### M3 — Composer one-row guarantee

**Goal:** chips never wrap; model chip shows alias.

**Pre-conditions:** M1.

**Deliverables:**
- `compactModel()` helper (already done; under-test it).
- `composer-layout.test.tsx`:
  - 720px width: all chips visible OR overflow `⋯` menu, no wrap.
  - 1200px width: all chips visible, no overflow menu.
- CSS: `flex-wrap: nowrap`, `overflow: hidden`, max-width per chip.
- `⋯` menu component for chips that don't fit.

**Gate:** preflight + new tests.

### M4 — Hermes MCP server + Hook bridge

**Goal:** Claude has first-class IDE awareness via MCP + `SessionStart` hook, without polluting messages.

**Pre-conditions:** M1.

**Deliverables:**
- New crate `src-tauri/src/mcp/` — Hermes MCP server stdio binary (or in-process behind a stdio adapter).
- New module `src-tauri/src/hook_bridge/` — HTTP server bound to 127.0.0.1, fresh token, hook endpoints.
- `--mcp-config` and `--settings` composed at spawn time in `build_spawn_args` (extend it).
- IDE state shared between Tauri main process, MCP server, and hook bridge via a `tokio::sync::watch::Receiver<IdeState>`.
- Resources: `hermes://project/state`, `hermes://git/status`, `hermes://projects`, `hermes://session/memory`, `hermes://session/pins`.
- Tools: `hermes__open_file`, `hermes__show_diff`, `hermes__attach_project`, `hermes__pin_file`.
- New tests:
  - `e2e_hermes_mcp_handshake` — claude lists `hermes` in `init.mcp_servers` as connected.
  - `e2e_hermes_mcp_resource` — claude can read `hermes://project/state` and the JSON matches the live state.
  - `e2e_hermes_mcp_open_file` — claude calls `hermes__open_file`, IDE responds, file opens.
  - `e2e_session_start_hook` — `additionalContext` from `SessionStart` lands in claude (verify by asking claude to repeat it).
  - `e2e_pretooluse_defer` — `PreToolUse` returning `defer` does NOT auto-execute the tool.

**Gate:** preflight + above e2e.

### M5 — Context Panel + Session memory + Cost & tokens

**Goal:** the right-sidebar context panel is always visible in agent mode and integrates with the MCP server.

**Pre-conditions:** M4 (depends on `hermes://session/memory`).

**Deliverables:**
- `ContextPanel` is always rendered in agent mode (no toggle).
- Memory pin/unpin UI → writes to per-session memory store → exposed via `hermes://session/memory`.
- Pinned files UI → writes to per-session pins → exposed via `hermes://session/pins`.
- Cost & tokens section: aggregates `metrics.token_usage` from result events, shows sparkline, shows `--max-budget-usd` progress.
- New tests:
  - `agent-context-panel.test.tsx::always rendered in agent mode`
  - `session-memory.test.ts::pin/unpin roundtrip`
  - `cost-panel.test.tsx::sparkline reflects last 10 turns`

**Gate:** preflight + above tests.

### M6 — Session list redesign

**Goal:** sessions sidebar is dense, dragable, easy to scan.

**Pre-conditions:** M1.

**Deliverables:**
- Single-row layout per session.
- Right-click menu: Rename / Convert / Close.
- Drag-to-reorder.
- Last-turn relative timestamp ("14h ago", "3d ago").
- New tests:
  - `session-list.test.tsx::single row, all metadata`
  - `session-list-reorder.test.tsx::drag reorders persists`

**Gate:** preflight + above tests.

### M7 — Session creator one-screen

**Goal:** create-session flow is one screen, fully keyboard navigable.

**Pre-conditions:** M1.

**Deliverables:**
- Single screen with project / model / permission / effort selects.
- Advanced expand: max-budget, channels, custom prompt.
- Keyboard: Tab through, Enter creates.
- New tests:
  - `session-creator-keyboard.test.tsx`

**Gate:** preflight + above tests.

### M8 — Project attach UI integration

**Goal:** attach/detach projects works end-to-end through the Context Panel and reaches Claude on the next message.

**Pre-conditions:** M4, M5.

**Deliverables:**
- Project picker UI in Context Panel.
- Attach updates `session.workspace_paths` AND triggers an immediate re-snapshot of MCP `hermes://project/state`.
- Detach mirrors.
- Frontend integration test: attach → submit → IPC call carries new `addDirs` AND `hermes://project/state` reflects new path.
- New tests:
  - `attach-project-flow.test.tsx`
  - `e2e_attach_project_propagates_to_mcp_resource`

**Gate:** preflight + above tests.

### M9 — Failure surfaces

**Goal:** every error has a clean UI with a recovery action.

**Pre-conditions:** M1.

**Deliverables:**
- "No conversation found" → Start-Fresh CTA.
- Subprocess crash → stderr + Retry / Start-Fresh / Copy-Log.
- Rate limit banner with countdown, queued retries.
- "claude not on PATH" splash with install link.
- New tests for each.

**Gate:** preflight + above tests.

### M10 — Cost / max-budget

**Goal:** track spend per session, soft + hard cap.

**Pre-conditions:** M5.

**Deliverables:**
- `--max-budget-usd` flag plumbed.
- Cost meter in Context Panel.
- Soft warning at 80% of budget.
- Hard stop at 100% (Claude returns `error_max_budget_usd`); UI surfaces and offers "Increase budget" or "Start fresh".
- New tests:
  - `e2e_max_budget_usd_caps_run`
  - `cost-progress.test.tsx::warns at 80%`

**Gate:** preflight + above tests.

### M11 — Visual / aesthetic pass

**Goal:** the whole agent surface feels intentional. Workshop palette consistent everywhere.

**Pre-conditions:** M2-M10.

**Deliverables:**
- Color, motion, typography pass.
- Visual regression baseline (Playwright if it'll fly; otherwise structured screenshots committed as fixtures).
- New tests: visual baseline lock.

**Gate:** preflight + visual baseline.

### M12 — Release

**Goal:** v1.0 released.

**Pre-conditions:** all of M1-M11.

**Deliverables:**
- README, CLAUDE.md updates.
- Release notes (user-facing, no internal jargon).
- Version bump.
- One commit, no push until user says.

**Gate:** preflight + manual smoke through every milestone's checklist.

---

## 7. Parallel-agent execution plan

Each milestone is a self-contained unit owned by one agent. Once M1 lands:

```
Agent A → M2 (workspace persistence)
Agent B → M3 (composer)
Agent C → M4 (MCP + hooks) — biggest unit, needs careful spec; could split into M4a (MCP server) + M4b (hook bridge) for two agents
Agent D → M6 (session list)
Agent E → M7 (session creator)
Agent F → M9 (failure surfaces)
```

Agents B, D, E, F have no inter-deps and can all run concurrently after M1.
Agent A has no deps but writes to the workspace JSON schema; later milestones must not break that schema.
Agent C is the heaviest but unblocks M5 and M8.

After M4 lands:
```
Agent G → M5 (context panel)
Agent H → M8 (project attach UI)
Agent I → M10 (cost)
```

Then M11 (visual) and M12 (release) sequentially.

**Each agent is briefed with:**
- The milestone's spec section above.
- The test names it must add.
- The gate it must hit.
- "Don't touch anything outside your milestone."
- "preflight green or it's not done."

---

## 8. Decisions (LOCKED — user signed off "best for users without dev/cost constraints")

The user explicitly chose maximum-quality outcomes regardless of implementation cost. The locked answers below are non-negotiable inputs to every milestone.

| # | Decision | Locked answer | Implication |
|---|---|---|---|
| Q1 | Adopt the Claude Agent SDK? | **YES — adopt fully.** Replace raw `tokio::process::Command::new("claude")` + stream-json with `@anthropic-ai/claude-agent-sdk`'s `query()`. | Unlocks `interrupt()`, `setModel()`, `setMcpServers()`, `rewindFiles()` (= file checkpointing), `canUseTool` (= permission UX in our React). Eliminates the fork-empty-stdin class of bugs entirely — we stop forking subprocesses. |
| Q2 | MCP server transport | **In-process via `createSdkMcpServer()`.** | No subprocess, no socket, no auth token. JS handlers share memory with the Tauri webview's IDE state. Zero IPC latency. |
| Q3 | Bundle the `claude` binary? | **YES — bundle.** SDK's optional dep ships the binary; we include it. | Zero-install. User downloads Hermes, opens it, works. |
| Q4 | Bypass-permission confirmation | **YES — explicit confirm modal.** Type "bypass" to confirm. Red chip stays red afterwards so it's never invisible. | Friction proportional to risk. No accidental "Claude can do anything" toggles. |
| Q5 | Idle subprocess timeout | **20 minutes.** SDK's `query()` lifecycle handles teardown; auto-respawn on next message is invisible. | Frees memory; no zombie procs. |
| Q6 | Mid-conversation IDE→Claude orientation | **YES — inject `[system: model X · perm Y · effort Z · cwd … · branch …]` via `SessionStart` hook on every spawn AND after every compaction.** | Claude self-reports its own model wrong. We fix that with hook-injected `additionalContext`, invisible to the transcript. |
| Q7 | Project-attach apply timing | **EAGER via `setMcpServers()`.** | Click "attach" → Claude has access *that second*. Mid-conversation, no fork, no respawn. Only possible because of Q1. |
| Q8 | Cost meter | **Always-on lozenge in masthead** (`$0.42 · 12k tokens`). Soft warn at 80% of `--max-budget-usd` if user opted into a cap. Hard cap is opt-in per session. | Real-time visibility is the feature; surprise budget kills are not. |
| Q9 | Publish as Claude Code plugin | **v1.0: IDE-only. v1.1: ALSO publish the same MCP server as a plugin** so users running claude outside Hermes still get our IDE-aware tools. | Network effect once Hermes is stable. |
| Q10 | Migration / rename | **Preserve every UI convention from v0.6.** | No muscle-memory break. Workspace restore handles schema bump silently. |

## 8.1 Implicit decisions also locked (user delegated "best UX")

Locked now so no agent has to ask:

| # | Decision | Detail |
|---|---|---|
| I1 | **Permission UX** | Native React modal, not chat-string. Slides up from bottom of conversation. `[Approve · Approve All · Deny · Edit]`. Built on `canUseTool`. |
| I2 | **File checkpointing** | Every `FileToolBlock` exposes "Undo this edit" on hover. Calls `rewindFiles({ userMessageId })`. Cmd+Z keyboard shortcut from anywhere in the conversation reverts the latest tool-driven file change. |
| I3 | **Live tool stdout** | Bash blocks render stdout as it streams (we already receive partial messages; render them progressively). |
| I4 | **Conversation forking** | Right-click any user message → "Fork from here" → spawns a sibling conversation in a new pane via SDK's `resumeSessionAt`. |
| I5 | **History search** | New MCP resource `hermes://session/transcript` — Claude can read its own past turns. Effectively infinite memory across compactions. |
| I6 | **@-mention autocomplete** | Pulls files from all attached projects via Settings `fileSuggestion`. Inline file path inserted on select. |
| I7 | **Slash dropdown** | Single dropdown shows built-ins + our MCP prompts (`/mcp__hermes__diff_active_file`, `/mcp__hermes__summarize_session`, etc.). |
| I8 | **Always-visible Context Panel in agent mode** | 280px right sidebar. Sections: Projects · Memory · Pinned Files · Cost & Tokens. No discoverability gap. |
| I9 | **Crash recovery** | App restart shows partial transcript + `[Resume from here]` CTA wiring `--resume <claudeUuid>`. |
| I10 | **Streaming markdown render** | Assistant prose renders progressively as bytes arrive, not in one block at turn end. |
| I11 | **Cost dashboard** | Click masthead cost lozenge → per-session sparkline of cost-per-turn + per-model breakdown. |
| I12 | **Inline image rendering** | Paste/drop image → preview thumbnail in the user message after submit (not just an attachment chip). |
| I13 | **Conversation export** | Right-click session → "Export as Markdown" / "Export as JSON". |
| I14 | **Right-click everywhere** | Files (reveal/open/diff), tool blocks (re-run/copy/inspect), messages (fork-from-here/copy-as-markdown). |
| I15 | **Inline diff acceptance** | When Claude proposes an edit via `hermes__show_diff`, we render a native diff viewer with `[Apply · Reject · Modify]` — the entire approval happens without sending a chat message. |

---

## 9. Risks, known issues, and what we're explicitly not doing

### Risks
- **MCP server stability** — first-time Claude users may hit the 60s connect timeout. Mitigation: surface MCP `failed` status prominently; offer "Continue without MCP" CTA.
- **Hook URL allowlisting** — `allowedHttpHookUrls` is a security boundary. If a user has a managed `settings.json` from their employer, our hook URLs may be blocked. Mitigation: detect this on startup, warn if our hook bridge is unreachable.
- **`--bare` mode + our hooks** — in `--bare`, hooks don't load. If we ever invoke a sub-task with `--bare` for hermeticity, we lose the IDE-state injection. Mitigation: explicitly pass `--settings <our-block>` alongside `--bare`.
- **Workspace restore + claude session deletion** — Claude prunes old sessions on its own schedule. Persisted `claudeUuid` may be invalid on restore. Already handled (fall back to fresh `INITIAL`).

### Known issues we're inheriting
- The Aptabase analytics noise in dev (`window.__TAURI_IPC__ is not a function`) is pre-existing and unrelated. Ignore.
- Vite "Could not Fast Refresh" warnings during dev are HMR limitations on hooks/exports. Ignore.

### Explicitly NOT in v1
- Multi-provider agent mode (Aider, Codex, Gemini). Claude only.
- Mobile/web companion via Remote Control.
- Visual regression tests via Playwright (out of scope unless trivially in M11).
- Cloud-hosted ultrareview integration in agent mode (terminal mode only for now).

---

## 10. The discipline contract (what changes about how we work)

Going forward:

1. **Plan first, code second.** This document is the entry point. New behavior gets a spec section before a test, before code.
2. **Tests precede implementation.** TDD for every milestone. The test must initially fail; the code makes it pass; the test stays green forever.
3. **Preflight is the `READY` gate.** Nothing labeled "ready to test" goes to the user without preflight passing in the same shell session. If preflight is red, the milestone is incomplete.
4. **User bug reports become tests, then fixes.** When the user finds a bug, the FIRST commit is a test that reproduces it. The second commit is the fix.
5. **Parallel agents communicate through tests, not chat.** When two agents share a contract (e.g., `SessionContext` shape), the contract is asserted by a test in a shared file. If you change the contract, you change the test, and the other agent's preflight catches the regression.
6. **The user gets one summary per milestone.** Not a stream-of-consciousness running update. One message: what shipped, what tests pass, what's next.

---

## 11. What I will not do until this plan is approved

- No code changes.
- No new milestones added.
- No "small fixes" between now and your sign-off.

When you approve (or revise), I split the work, brief the agents, and execute M1 first. Only when M1's preflight is green do M2-M10 launch in parallel.
