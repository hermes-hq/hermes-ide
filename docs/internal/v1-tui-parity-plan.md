# v1.0 TUI Parity Plan

> Status: **APPROVED — ready to implement.**
> Scope: bring the new Agent mode to feature parity with the Claude Code
> TUI for v1.0 release, with selective improvements where the TUI is
> weaker.  Read this alongside `v1-master-plan.md` (architecture) and
> `docs/adr/001-agent-mode.md` (mode split rationale).

---

## 0. Locked decisions (do not re-negotiate without sign-off)

1. **Right Context Panel: always-on**, 280px, agent-mode only.  Resizable [200, 480]px.  Persisted in saved_workspace JSON.
2. **All edits write directly to Claude config files** (`~/.claude.json`, `~/.claude/settings.json`, project / user `CLAUDE.md`).  TUI-compatible — same edits affect non-Hermes Claude sessions.
3. **v1.0 ships with M-context-panel-shell + M-interactive-tools + M-mcp + M-todos + M-memory + M-permissions.**  Anything else is post-1.0.
4. **ExitPlanMode**: Approve / Reject only.  No Modify (TUI parity).
5. **Permission Approve-all**: persists to `~/.claude/settings.json` `permissions.allow`.  TUI parity.
6. **Empty sections**: always render with `+ Add` CTA (discoverability).
7. **MCP add-dialog**: trust + status dot.  No probe-on-save.

---

## 1. Build order

```
M0 M-context-panel-shell             (foundation — must land first)
        │
        ├─► M1 M-interactive-tools   (P0 — split into M1a/M1b/M1c/M1d)
        ├─► M2 M-todos               (independent of sidebar — pinned chat panel)
        │
        └─► M3 M-mcp ──┬─► M4 M-memory ──┬─► M5 M-permissions
                       │                  │
                      (sidebar sections, parallel after M0)
```

---

## 2. Per-milestone spec + test catalogue

### M0. M-context-panel-shell  *(scaffold; ~200 LOC; 8 tests)*

The empty sidebar with section stubs.  Lands first; everything else fills it in.

**Spec**
- Renders 280px right sidebar only when active session.mode === "agent".
- Sections in fixed order (header rows render even when section is empty):
  1. MCP
  2. Memory
  3. Permissions
  4. Pinned Files (existing)
  5. Cost & Tokens (existing, expanded post-1.0)
- Resizable handle on the left edge.  Width persisted in saved_workspace JSON (`right_panel_width`).
- Width clamps to [200, 480]px.
- Each section has a collapse chevron; collapsed-state map persisted in same JSON.

**Tests**

| ID | Test | Level |
|---|---|---|
| cps-1 | sidebar renders only when active session.mode === "agent" | RTL |
| cps-2 | sidebar absent for terminal-mode sessions | RTL |
| cps-3 | section header order: MCP → Memory → Permissions → Pinned → Cost | snapshot |
| cps-4 | width persisted in saved_workspace.json (`right_panel_width`) | unit |
| cps-5 | width clamps to [200, 480]px on input | unit |
| cps-6 | collapse-all state persists; expand-all state persists | RTL |
| cps-7 | resize handle drag updates width with rAF throttling | RTL |
| cps-8 | mode flip (terminal → agent via Convert) makes sidebar appear without remount | RTL |

---

### M1. M-interactive-tools  *(largest; ~800 LOC across 4 sub-PRs; 40 tests)*

Surfaces three tool-driven interactions and one banner.  All share the same architectural seam: NDJSON control envelopes between bridge ⇄ frontend.

**Architectural seam (shared by all sub-features)**

The bridge already exposes `_hermes_control` envelopes for soft-interrupt.  Extend with two new event classes:

```jsonc
// bridge → frontend (stdout):
{ "type": "_hermes_perm_request", "id": "<uuid>", "toolName": "Bash", "input": {...} }

// frontend → bridge (stdin):
{ "type": "_hermes_perm_response", "id": "<uuid>",
  "decision": { "behavior": "allow" | "deny", "updatedInput"?: {...}, "message"?: "..." } }
```

For Claude tools that already return their result via `tool_result` (AskUserQuestion, ExitPlanMode), we send a normal `user` envelope with a `tool_result` block — no new envelope class needed.

#### M1a. AskUserQuestion native modal *(~250 LOC; 11 tests)*

**Spec**
- Detect `tool_use` with `name === "AskUserQuestion"`.
- Pause the conversation; render the question modal slide-up from bottom of conversation.
- Each question: radio (single-select) or checkbox grid (multi-select), with auto "Other" option.  Preview pane on the right when option has `preview` field.
- Submit composes a `user` envelope with a `tool_result` block referencing the `tool_use_id`.
- Esc cancels → tool_result with `{cancelled: true}`.
- Composer suppressed (read-only) until answered.

**Tests**

| ID | Test | Level |
|---|---|---|
| aq-1 | reducer: tool_use AskUserQuestion → state machine flips to "awaiting-answer" | unit |
| aq-2 | renders single-select as radio + auto Other option | RTL |
| aq-3 | renders multi-select as checkbox grid | RTL |
| aq-4 | "Other" reveals textarea; submit blocked until non-empty | RTL |
| aq-5 | preview pane renders mono-box for focused option | RTL |
| aq-6 | submit composes tool_result envelope with correct shape | unit |
| aq-7 | submitted envelope written to stdin via sendAgentInput | integration mock |
| aq-8 | composer is read-only while answer pending; restored after | RTL |
| aq-9 | Esc cancels → tool_result `{cancelled: true}` | RTL |
| aq-10 | answers serialize as `[{question, selected, notes?, preview?}]` per SDK spec | unit |
| aq-e2e-1 | real Claude: AskUserQuestion in plan mode → host responds → Claude continues | rust e2e |

#### M1b. ExitPlanMode plan card *(~150 LOC; 8 tests)*

**Spec**
- Detect `tool_use` with `name === "ExitPlanMode"`.
- Render `plan` field via MarkdownBody.
- Two buttons: **Approve** · **Reject (with feedback)**.
- Approve → tool_result `{accept: true}`.
- Reject → modal asks for free-text rejection note; tool_result `{accept: false, feedback: "..."}`.
- Composer disabled while plan card visible.
- "PLAN MODE" banner above card if `permissionMode === "plan"`.

**Tests**

| ID | Test | Level |
|---|---|---|
| ep-1 | reducer: tool_use ExitPlanMode → captures plan markdown | unit |
| ep-2 | renders plan via MarkdownBody | RTL |
| ep-3 | Approve / Reject buttons present; no Modify button (TUI parity) | RTL |
| ep-4 | Approve → tool_result `{accept: true}` | unit |
| ep-5 | Reject opens feedback note modal; submit → tool_result `{accept: false, feedback}` | RTL |
| ep-6 | composer disabled while plan card visible | RTL |
| ep-7 | "PLAN MODE" banner above card iff permissionMode=plan | RTL |
| ep-e2e-1 | real Claude: enter plan mode, ExitPlanMode arrives, approve → claude proceeds with edits | rust e2e |

#### M1c. canUseTool permission modal *(~350 LOC; 16 tests)*

**Spec**
- Bridge wires `canUseTool` callback in SDK config.
- Callback emits `_hermes_perm_request` to stdout, awaits `_hermes_perm_response` on stdin.
- Frontend modal: tool name, input (JSON pretty), diff preview if it's a Write/Edit tool.
- Buttons: **Approve · Approve all (toolName) · Deny · Edit input**.
- "Approve all" persists a `permissions.allow` rule to `~/.claude/settings.json` AND adds toolName to session ref so subsequent calls bypass the modal.
- "Deny" sends back `{behavior: "deny", message: "user declined"}`.
- "Edit" opens a JSON editor on the input; revalidate before approve.
- mode=`bypassPermissions`: modal NEVER renders.
- mode=`plan`: edit-tool requests render modal explaining "Plan mode — won't run".

**Tests**

| ID | Test | Level |
|---|---|---|
| pm-1 | bridge: SDK config includes canUseTool callback | unit |
| pm-2 | bridge: canUseTool writes _hermes_perm_request to stdout | unit |
| pm-3 | bridge: blocks until matching _hermes_perm_response arrives | unit |
| pm-4 | bridge: returns `{behavior:"allow", updatedInput}` on approve | unit |
| pm-5 | bridge: returns `{behavior:"deny", message}` on deny | unit |
| pm-6 | frontend: NDJSON _hermes_perm_request opens modal with toolName + input + diff (when applicable) | RTL |
| pm-7 | frontend: Approve / Approve all / Deny / Edit buttons present | RTL |
| pm-8 | "Approve all" writes a permissions.allow rule to ~/.claude/settings.json AND adds to session ref | rust unit + frontend |
| pm-9 | "Edit" opens JSON-editable form; revalidate before approve | RTL |
| pm-10 | response IPC writes _hermes_perm_response to bridge stdin | integration mock |
| pm-11 | modal stays open indefinitely (no auto-deny) on user idle | RTL |
| pm-12 | mode=bypassPermissions: modal NEVER renders; auto-allow | unit |
| pm-13 | mode=plan: edit-tool requests render plan-mode mock-allow | unit |
| pm-14 | session ref of approved-all tools survives respawn | unit |
| pm-e2e-1 | default mode: bash → modal → approve → claude runs cmd | rust e2e |
| pm-e2e-2 | deny path: bash → deny → claude continues with "user denied" tool_result | rust e2e |

#### M1d. Plan-mode banner *(~50 LOC; 4 tests)*

**Spec**
- Banner above composer.  Visible iff effective `permissionMode === "plan"`.
- Text: `PLAN MODE — no edits will execute.  Claude will describe its plan and ask before continuing.`
- Click opens permission picker chip dropdown.

**Tests**

| ID | Test | Level |
|---|---|---|
| pb-1 | renders iff permissionMode === "plan" | RTL |
| pb-2 | exact text snapshot | snapshot |
| pb-3 | click opens permission picker | RTL |
| pb-4 | re-evaluates after fork/respawn that swaps mode | RTL |

---

### M2. M-todos  *(~250 LOC; 11 tests)*

**Spec**
- Reducer: `TodoWrite` tool_use with `todos:[{content, status}]` lands in `state.todos`.
- Subsequent TodoWrite REPLACES (not appends).
- Empty `todos:[]` clears the panel.
- Pinned panel renders at bottom of conversation column when `todos.length > 0`.
- Each item: checkbox · content · status dot (pending grey / in_progress brass animated stripe / completed green check).
- Header: `TODOS · {n_done}/{n_total}`.  Collapse toggle persists in saved_workspace per session.
- TodoWrite tool block in conversation hidden once panel has content (no double render).

**Tests**

| ID | Test | Level |
|---|---|---|
| t-1 | reducer: TodoWrite → state.todos populated | unit |
| t-2 | reducer: subsequent TodoWrite REPLACES (not appends) | unit |
| t-3 | reducer: empty todos:[] clears panel | unit |
| t-4 | renders pinned panel when todos.length > 0 | RTL |
| t-5 | each item: checkbox + content + status dot | RTL |
| t-6 | in_progress item gets brass animated stripe | RTL |
| t-7 | header: `TODOS · {done}/{total}` | RTL |
| t-8 | collapse persists in saved_workspace per session | unit |
| t-9 | scroll: panel sticks to bottom; chat scroll unaffected | RTL |
| t-10 | hides when conversation has zero TodoWrite calls | RTL |
| t-11 | TodoWrite tool block hidden in conversation once panel has content | RTL |

---

### M3. M-mcp  *(~500 LOC; 17 tests; blocked by M0)*

**Spec**

*Sidebar section:*
- Lists `init.mcp_servers` with status dots (green=connected, red=failed, brass=connecting).
- Click server → expands to show its tools (filter `init.tools` by `mcp__<name>__*`).
- Failed server: hover/click reveals last error (new `get_mcp_last_error` IPC).
- Restart button per server → `restart_mcp_server` IPC → bridge respawns.

*Add-server dialog:*
- Fields: name · transport (stdio/sse/http) · command/url · args · headers · env.
- Validation: name unique; required fields per transport.
- Submit → `write_mcp_server` IPC → atomic write to `~/.claude.json`.
- After write, frontend triggers respawn so SDK picks up new server.

*Remove server:*
- Confirm dialog → `remove_mcp_server` IPC → atomic write.

**Tests**

| ID | Test | Level |
|---|---|---|
| mcp-1 | renders init.mcp_servers list with status dots | RTL |
| mcp-2 | empty state: "No MCP servers configured. + Add" CTA | RTL |
| mcp-3 | click server expands to show its tools | RTL |
| mcp-4 | failed server: hover reveals last error | RTL |
| mcp-5 | restart button → restart_mcp_server IPC | unit + integration mock |
| mcp-6 | section refreshes when new init event lands | RTL |
| mcp-7 | dialog fields: name / transport / command / args / url / headers / env | RTL |
| mcp-8 | unique-name validation; inline error on duplicate | unit |
| mcp-9 | transport=stdio: command + args; sse/http: url + headers | RTL |
| mcp-10 | submit POSTs to write_mcp_server IPC | unit |
| mcp-11 | rust IPC: read ~/.claude.json, merge new entry, write atomically | rust unit |
| mcp-12 | rust IPC: preserves all other JSON keys / formatting | rust unit |
| mcp-13 | rust IPC: file lock prevents concurrent writes | rust unit |
| mcp-14 | after write, respawn triggered | unit |
| mcp-15 | remove: confirm dialog; remove_mcp_server IPC deletes only that key | rust unit + RTL |
| mcp-16 | rust IPC: remove preserves other entries | rust unit |
| mcp-e2e-1 | real Claude: add a known-good MCP server via UI → next agent turn lists its tools in init.mcp_servers | rust e2e |

---

### M4. M-memory  *(~400 LOC; 9 tests; blocked by M0)*

**Spec**
- Lists `init.memory_paths` with relative path labels (user / project / dynamic).
- Click row → inline editor (textarea pre-populated with file contents).
- Save → `write_memory_file` IPC writes via `tokio::fs` (preserves trailing newline).
- Rust: refuses to write outside known memory_paths (path traversal guard).
- File missing → "Create now" CTA writes empty file.
- Dirty editor with unsaved changes prompts on close.
- "+ Add memory line" appends a one-liner to project CLAUDE.md (highest precedence).
- External mtime change while editing → conflict warning, options: reload / overwrite.

**Tests**

| ID | Test | Level |
|---|---|---|
| mem-1 | renders init.memory_paths with relative path labels (user / project / etc.) | RTL |
| mem-2 | click row opens inline editor pre-populated | RTL |
| mem-3 | save → write_memory_file IPC writes correctly | unit |
| mem-4 | rust: refuses writes outside known memory_paths | rust unit |
| mem-5 | file missing → "Create now" CTA writes empty file | RTL |
| mem-6 | dirty editor on close prompts | RTL |
| mem-7 | "+ Add memory line" appends to project CLAUDE.md | unit |
| mem-8 | external mtime change → conflict UI (reload / overwrite) | RTL |
| mem-e2e-1 | real Claude: edit user CLAUDE.md → next session start, claude recalls a sentinel value | rust e2e |

---

### M5. M-permissions  *(~400 LOC; 11 tests; blocked by M0)*

**Spec**
- Reads `~/.claude/settings.json` + project `.claude/settings.json` `permissions.allow|deny`.
- Two columns: allow / deny; source label per row (user / project).
- Add rule: dialog with pattern field + scope picker (user / project).
- Submit → `write_permission_rule` IPC → atomic JSON write.
- Remove → `remove_permission_rule` IPC.
- "Test pattern" input + tool dropdown → live verdict (allow / deny / no match).
- Effective union view: project deny shadows user allow per Claude precedence.
- Invalid pattern → inline error.
- Mtime check on save: external concurrent edit → conflict UI.

**Tests**

| ID | Test | Level |
|---|---|---|
| perm-1 | reads user + project settings.json permissions.allow|deny | unit |
| perm-2 | renders two columns + source labels | RTL |
| perm-3 | add rule dialog: pattern + scope picker | RTL |
| perm-4 | submit → atomic write merges rule into chosen file | rust unit |
| perm-5 | remove rule → atomic write removes rule | rust unit |
| perm-6 | test-pattern input → live verdict | unit |
| perm-7 | effective-union view: project deny shadows user allow | unit |
| perm-8 | invalid pattern (e.g. unclosed glob) inline error | unit |
| perm-9 | mtime mismatch on save → conflict UI | RTL |
| perm-e2e-1 | add deny rule for `Bash` → next turn modal/refusal on bash request | rust e2e |
| perm-e2e-2 | add allow rule `Bash(git status:*)` → that exact command bypasses modal | rust e2e |

---

## 3. Shared infra (built once, reused)

1. **`atomic_json_write`** Rust helper.  Read → mutate → write `<file>.tmp` → fs::rename.  Used by M3, M5.  Tested in `pty/commands.rs::tests`.
2. **`safe_memory_write`** Rust helper.  Path-canonicalize against allowlist of known memory_paths.  Used by M4.
3. **NDJSON control envelopes** (`_hermes_perm_request`, `_hermes_perm_response`).  Bridge ⇄ frontend.  Used by M1c.  Pattern reusable for any future "ask host before deciding" flow.
4. **Mtime watcher** (`tokio::sync::watch`).  Single watch per file, broadcasts `session-config-changed-{file}`.  Used by M4 + M5.
5. **`ContextPanelSection` shared layout component**.  Header + collapse + slot.  Used by every sidebar section.

---

## 4. Effort estimate (revised after lock decisions)

| Milestone | Days | Lines | Tests |
|---|---|---|---|
| M0 shell | 1 | 200 | 8 |
| M1a AskUserQuestion | 1.5 | 250 | 11 |
| M1b ExitPlanMode | 1 | 150 | 8 |
| M1c canUseTool | 2 | 350 | 16 |
| M1d Plan banner | 0.5 | 50 | 4 |
| M2 todos | 1 | 250 | 11 |
| M3 mcp | 2 | 500 | 17 |
| M4 memory | 1.5 | 400 | 9 |
| M5 permissions | 1.5 | 400 | 11 |
| **Total** | **12** | **2550** | **95** |

Plus 8 e2e tests already written for the multi-folder fix; this plan adds ~6 more real-Claude e2es.

---

## 5. Out of scope for v1.0 (deferred)

- M-cost details (lozenge expansion to per-model breakdown)
- M-agents-skills discovery panel
- M-subagent-thread (nested rendering for `Task`)
- M-modals for /init, /doctor, /release-notes
- M-slash-polish (descriptions, grouping, source filtering)
- File checkpointing / `rewindFiles()` undo (master plan I2)
- Conversation forking (master plan I4)
- @-mention autocomplete pulling from all attached projects (master plan I6)
- Vim mode

---

## 6. Discipline contract

- Plan first, code second.  This document is the entry point.
- Tests precede implementation.  Every test in §2 + §7 must initially fail; the code makes it pass; the test stays green forever.
- `npm run preflight` is the only `READY` signal.  Nothing labelled "ready to test" goes to the user without preflight passing in the same shell session.
- Each milestone is self-contained.  Tests added, code added, preflight green, this doc updated if a contract changed.
- User bug reports become tests in column 1, then fixes — never the other way round.
- **No milestone advances to "in_progress" until its full test list (happy + failure mode) is written and failing.**

---

## 7. Failure-mode / race / edge-case test catalogue

> The §2 catalogue covers happy paths.  This section pins every failure
> mode the implementation must survive *before it ships*.  These tests
> are written alongside the §2 tests and must fail first.

### 7.1 Cross-cutting infra (single-time tests, gate every milestone that uses them)

#### `atomic_json_write` Rust helper (used by M3, M5)

| ID | Test | Failure it catches |
|---|---|---|
| ajw-1 | concurrent writers: 50 spawned tasks each appending a unique key → final JSON has all 50 keys | lost-update race |
| ajw-2 | mid-write crash: `<file>.tmp` exists, parent file is the prior version, recovers cleanly on next write | partial write corruption |
| ajw-3 | symlink target: refuses to write through a symlink (security) | TOCTOU on symlink swap |
| ajw-4 | parent dir missing: creates with `0700` permissions | permission-too-open exposure |
| ajw-5 | invalid input JSON: error returns without touching the file | bad write erasing config |
| ajw-6 | preserves trailing newline + 2-space indent of the original | reformatting user's file |
| ajw-7 | preserves unrelated top-level keys (e.g. `mcpServers` write doesn't drop `theme`) | data loss |
| ajw-8 | file >1MB: succeeds without OOM | large config corruption |
| ajw-9 | read-only filesystem: returns clean error, doesn't leave stale `.tmp` | leftover lock file |

#### NDJSON control envelope (used by M1c)

| ID | Test | Failure it catches |
|---|---|---|
| ce-1 | malformed `_hermes_perm_response` JSON on stdin → bridge logs & ignores, doesn't crash | host injecting bad input |
| ce-2 | response with unknown id → ignored | stale modal response |
| ce-3 | duplicate response for same id → first wins, second ignored | double-click race |
| ce-4 | bridge stdin closed mid-await → canUseTool resolves with deny + diagnostic | host died |
| ce-5 | response delayed 30 min → still resolves; SDK waits | long human deliberation |
| ce-6 | request ID generation: 1k consecutive requests, all unique | collision |

#### Mtime watcher (used by M4, M5)

| ID | Test | Failure it catches |
|---|---|---|
| mw-1 | file replaced atomically (rename) → watcher fires once with new content | missed update |
| mw-2 | file deleted → watcher fires with `null`; UI shows missing-file CTA | dangling watcher |
| mw-3 | file truncated to empty → watcher fires; UI clears editor | empty-file silent skip |
| mw-4 | rapid-fire edits (5 writes in 100ms) → watcher debounces to 1-2 events, last value wins | thrash |
| mw-5 | un-watched on component unmount → no leaked tokio task | resource leak |

### 7.2 M0  M-context-panel-shell

| ID | Test | Failure it catches |
|---|---|---|
| cps-9 | no saved_workspace JSON → defaults to 280px, all sections expanded | first-launch crash |
| cps-10 | corrupt saved_workspace JSON (`right_panel_width: "wide"`) → falls back to default, logs once | corrupt config crash |
| cps-11 | drag handle below minimum: width clamps to 200, doesn't go negative | layout collapse |
| cps-12 | drag handle past viewport: width clamps to 480 OR (viewport - 320), whichever is smaller | covers conversation |
| cps-13 | rapid-fire drag (rAF storm): never blocks input, never leaves stale ghost cursor | stuck cursor |
| cps-14 | session deleted while open: sidebar gracefully unmounts, no zombie listeners | listener leak |
| cps-15 | resize during conversation auto-scroll: scroll position preserved | scroll jump |

### 7.3 M1a  AskUserQuestion

| ID | Test | Failure it catches |
|---|---|---|
| aq-12 | tool_use arrives twice (network duplicate): UI dedupes by tool_use_id | double prompt |
| aq-13 | tool_use with `questions: []` (empty): UI shows "no questions provided", auto-cancels | malformed input |
| aq-14 | tool_use with 5 questions: all render; submit collects all answers; tool_result has 5 entries | partial answers |
| aq-15 | user closes session while answer pending: tool_use marked stale, no tool_result sent | orphaned tool_use_id |
| aq-16 | bridge dies mid-await: UI renders error, retry CTA, conversation continues without leaks | hang on bridge crash |
| aq-17 | user submits empty multi-select with no "Other": validation blocks submit, inline error | empty answer accepted |
| aq-18 | "Other" textarea > 4000 chars: warns, allows, server-side truncation by SDK is fine | UI freeze on large input |
| aq-19 | rapid Tab/arrow nav: highlight follows correctly, never out of bounds | focus jump |
| aq-20 | a11y: every input has accessible name + role; Esc closes; Enter submits when valid | a11y regression |
| aq-21 | tool_result envelope schema strict-validates against SDK's expected shape (snapshot) | wire-format drift |

### 7.4 M1b  ExitPlanMode

| ID | Test | Failure it catches |
|---|---|---|
| ep-9 | plan markdown contains code fences with HTML: rendered safely (no XSS) | XSS injection |
| ep-10 | plan markdown is empty string: card shows "no plan provided" | blank UI |
| ep-11 | reject without feedback (user submits empty note): allowed, sends `feedback: ""` | over-strict validation |
| ep-12 | session converted to terminal mid-card: card removed cleanly, no zombie state | mode-flip leak |
| ep-13 | second ExitPlanMode arrives before first answered: queue or replace? **rule: replace + warn in stderr** | stuck queue |

### 7.5 M1c  canUseTool permission

| ID | Test | Failure it catches |
|---|---|---|
| pm-17 | input contains binary / non-UTF8 bytes: rendered as hex preview, not crashing | render crash |
| pm-18 | "Edit input" produces invalid JSON: submit blocked with inline error | bad payload to SDK |
| pm-19 | "Edit input" produces JSON with extra keys: SDK accepts (forward-compat); test pins behaviour | format breakage |
| pm-20 | "Approve all" while settings.json missing: file is created with the new rule | missing-file write fails |
| pm-21 | "Approve all" while settings.json `permissions` key absent: key inserted, other keys preserved | partial-key bug |
| pm-22 | concurrent "Approve all" for different tools (race): both rules end up in file (uses ajw-1) | lost rule |
| pm-23 | "Deny" while bridge stdin closed: UI shows error, conversation logs warning | silent deny loss |
| pm-24 | mode swap mid-await (default → bypassPermissions): outstanding modal closes auto-allow | stuck modal |
| pm-25 | mode swap mid-await (default → plan): modal switches to plan-mode mock-allow | wrong behaviour |
| pm-26 | screen reader: every action button has accessible label + role | a11y regression |
| pm-27 | very long tool input (10kB diff): scrolls within modal, doesn't push buttons off-screen | layout overflow |
| pm-28 | session-allow ref survives respawn (already in pm-14) AND survives mode-swap | rule dropped on swap |

### 7.6 M2  TODOs

| ID | Test | Failure it catches |
|---|---|---|
| t-12 | TodoWrite with 50 items: panel virtualizes after 20 visible | scroll jank |
| t-13 | TodoWrite with empty content for an item: that row shows "(empty)" placeholder, not blank | invisible row |
| t-14 | TodoWrite stream interleaved with assistant text: panel updates, prose unaffected | render race |
| t-15 | session reload: panel state (collapsed/expanded) reads from saved_workspace correctly | persisted state lost |
| t-16 | rapid-fire TodoWrite (10 events in 1s): debounced render; only last lands | render thrash |
| t-17 | TodoWrite item.status outside known enum: row renders with `?` glyph + warning logged | unknown-status crash |

### 7.7 M3  MCP

| ID | Test | Failure it catches |
|---|---|---|
| mcp-18 | `~/.claude.json` missing: add-server creates file with permissions 0600 | missing-file write fails |
| mcp-19 | `~/.claude.json` is invalid JSON: dialog refuses save with explicit "config corrupted" error | nuking user config |
| mcp-20 | server name with shell metachars (e.g. `; rm -rf /`): rejected by validation | injection via name |
| mcp-21 | command field empty when transport=stdio: validation blocks save | broken server entry |
| mcp-22 | url field empty when transport=sse|http: validation blocks save | broken server entry |
| mcp-23 | env values with unicode: round-trip preserved | mojibake |
| mcp-24 | restart MCP while spawn in flight: queues; final state = restarted | double-spawn race |
| mcp-25 | remove server while in-flight tool call to it: tool call gets clean error, doesn't hang | hung tool call |
| mcp-26 | mcp_servers field absent in init (older Claude): renders "(none)", no crash | unsupported version |
| mcp-27 | 50 MCP servers configured: section virtualizes, status dots render correctly | scroll jank |

### 7.8 M4  Memory

| ID | Test | Failure it catches |
|---|---|---|
| mem-10 | path traversal attempt (`../../../etc/passwd` in memory_paths): refused | escape-the-allowlist |
| mem-11 | symlinked memory file: refused (TOCTOU) | symlink swap exploit |
| mem-12 | file with non-UTF8 bytes: editor shows binary warning, refuses save until fixed | corrupting binary |
| mem-13 | save while file changed externally: conflict UI shows both versions, [reload] [overwrite] [merge] | silent loss |
| mem-14 | save with empty content: writes empty file, doesn't delete | unintended deletion |
| mem-15 | very large file (>500KB CLAUDE.md): editor warns, allows save | freeze on large file |
| mem-16 | offline / disk-full: save returns explicit error, dirty state preserved | silent save failure |

### 7.9 M5  Permissions

| ID | Test | Failure it catches |
|---|---|---|
| perm-12 | `permissions` key missing in settings.json: insert key, preserve everything else | wiping config |
| perm-13 | duplicate rule add: dedupe (no-op write) | bloated file |
| perm-14 | rule with regex special chars (e.g. `Bash(grep -E "*":*)`): stored verbatim, displayed escaped | render breakage |
| perm-15 | "Test pattern" with unparseable input: shows "no match" verdict, never throws | crash on bad input |
| perm-16 | settings file under git, user edits via TUI mid-Hermes-edit: mtime watcher fires, conflict UI | overwrite |
| perm-17 | rule for non-existent tool name (e.g. `FooBar(...)`): allowed (forward-compat) but UI hints "tool not found" | over-strict UI |
| perm-18 | bypassPermissions mode active: rules list shows "currently bypassed" banner | confusing state |

---

## 8. Visual design specs

> The aesthetic anchor is `docs/internal/v1-redesign-playbook.md` —
> "Editorial Engineering" (Bloomberg Terminal density × NYT Magazine
> typography × Mathematica notebook structure × Linear's craftsmanship).
> All new surfaces extend that.  Below: per-surface specs with
> measurements, glyphs, and motion rules.

### 8.0 Shared rules (apply to every new surface)

- **No card corners > 3px.**  Hairline rules (`1px solid var(--rule)`) substitute for card borders wherever possible.
- **No drop shadows.**  Depth comes from contrast and rule density, not blur.
- **No emoji in chrome.**  Use the verified glyph set (`◇ ▸ ⌕ ┃ ▾ ¹ ●`) from playbook §4.  New glyphs added in this plan: `◉` (filled-radio), `○` (empty-radio), `☐` (empty-checkbox), `☑` (filled-checkbox), `✓` (done), `✗` (deny).
- **Typography:** chrome → `Inter Tight` 9px UPPERCASE letter-spacing 0.08em, color `--ink-tertiary`.  Content → `JetBrains Mono` 11–13px.  Never mix Inter Tight inside the conversation column.
- **Workshop palette discipline:** `--brass` is reserved for ACTIVE / yours-here / waiting-for-you signals.  Status colors stay semantic: `--green` = connected/done, `--red` = failed/deny, `--yellow` = running/searching, `--violet` = file ops, `--accent` = web ops.
- **Motion:** respiration (existing) for in-flight states; heartbeat-cursor (existing) for streaming; new motion only via CSS keyframes.  No JS-driven animation libraries.
- **All inputs use Hermes' input style:** `background: var(--bg-paper)`, `border: 1px solid var(--rule)`, `padding: 4px 8px`, `font: 12px var(--font-mono)`.  Focus: `border-color: var(--brass)`.  Refused: rounded ≥3px, drop shadow, gradient.

### 8.1 M0  Right Context Panel — shell

```
┌────────────────────────────────────────┐
│ ▔▔▔▔▔ HERMES · CONTEXT ▔▔▔▔▔▔▔▔▔▔▔▔▔▔ │ ← Inter Tight 9px ↑↑ tracked, --ink-tertiary
├────────────────────────────────────────┤    1px hairline (var(--rule)), full width
│                                        │
│ ▾ MCP                          (3)     │ ← section header, Inter Tight 10px tracked
│   ● context7              connected    │    JetBrains Mono 11px
│   ● Sanity                connected    │    status dot 8px ø, --green
│   ✕ broken-server         failed       │    failed: ✗ glyph + --red
│   + Add MCP server                     │    + Add: --brass, JetBrains Mono 10px italic
│                                        │
├────────────────────────────────────────┤    section divider: 1px --rule-strong
│                                        │
│ ▾ MEMORY                       (2)     │
│   ◇ ~/.claude/CLAUDE.md   user · 3h ago│    ◇ glyph violet (file ops), path mono 10px
│   ◇ project/CLAUDE.md     project ·…   │    label "user|project" 9px tracked tertiary
│   + Add memory line                    │
│                                        │
├────────────────────────────────────────┤
│ ▾ PERMISSIONS                  (4 / 1) │    "(allow / deny)"
│   3 allow rules · 1 deny rule          │    summary line; click → expand
│   + Add rule                           │
│                                        │
├────────────────────────────────────────┤
│ ▾ PINNED FILES                 (0)     │
│   no pins                              │    empty-state: --ink-tertiary italic
│   + Pin file                           │
│                                        │
├────────────────────────────────────────┤
│ ▾ COST & TOKENS                        │
│   $0.42                                │    larger value, --brass mono 14px
│   12.3k in · 4.2k out                  │    detail line, --ink-tertiary 11px
│   ━━━━━━╴╴╴╴╴╴╴╴ 22% of $2.00 cap     │    optional progress bar
│                                        │
└────────────────────────────────────────┘
   ↑ left edge: 1px --rule, hover → 1px --brass, drag-resize cursor
```

- Width: default 280, range [200, 480].
- Background: `var(--bg-paper)`.  Conversation column to the left.
- Resize handle: invisible 4px-wide hit area on the left edge; the visual hairline stays 1px.
- Keyboard: section headers focusable; `←/→` collapse-all / expand-all.

### 8.2 M1a  AskUserQuestion — slide-up card

```
└──────── conversation ends here ─────────┘
┌──────────────────────────────────────────┐ ← respiration (1.5s) on the brass left bar
│ ┃ HERMES IS WAITING FOR YOU              │   left bar: 2px --brass, full card height
│ ┃                                        │   header: Inter Tight 9px ↑↑ tracked, --brass
│ ┃ Q1.  Which option?                     │   question: JetBrains Mono 13px italic
│ ┃                                        │
│ ┃ ◉ Approve and continue                 │   selected radio: 12px ◉, --brass
│ ┃   keeps the diff, runs the migration   │   description: 11px --ink-secondary
│ ┃                                        │
│ ┃ ○ Reject and rethink                   │   unselected radio: 12px ○, --ink-tertiary
│ ┃   I'll write a different approach      │
│ ┃                                        │
│ ┃ ○ Other  ┌────────────────────────────┐│   "Other" textarea on focus: --brass border
│ ┃          │ type a custom answer…      ││
│ ┃          └────────────────────────────┘│
│ ┃                                        │
│ ┃                  Esc cancel · ⏎ send → │   actions inline-link style, send: --brass
└──────────────────────────────────────────┘
   ↑ top: 1px --rule-strong; bottom: 1px --rule
```

- Composer below: dimmed (`opacity: 0.4`, `pointer-events: none`) while card visible.
- Multi-select: same layout, `☐` ↔ `☑` glyphs.

### 8.3 M1b  ExitPlanMode — plan card

```
━━━━━ PLAN SUBMITTED FOR APPROVAL ━━━━━━━━━━━━━━━━━━━━ ← title in the rule
                                                        Inter Tight 9px ↑↑ tracked
 Plan
  1. Update SessionContext to use the helper.            ← MarkdownBody (existing)
  2. Add a migration test.
  3. Run preflight.

 Files to be modified
  ◇ src/state/SessionContext.tsx                         ← ◇ glyph --tool-file (violet)
  ◇ src/utils/autoAttach.ts

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
                         ✗ reject (with feedback)  ·  ✓ approve →
                         ↑ --ink-secondary           ↑ --brass
```

### 8.4 M1c  canUseTool — permission card

Single-tool case (Bash):
```
▸ HERMES IS REQUESTING PERMISSION TO RUN A TOOL          ← Inter Tight 9px ↑↑ tracked, --brass
                                                            ▸ glyph --tool-exec (green)
  Tool        Bash                                        ← labels: 9px ↑↑ tracked --ink-tertiary
  Command     git status --short                             values: 12px JetBrains Mono --ink-primary
  Working dir /Users/.../proj-a                              tabular-aligned

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  approve once  ·  approve all (Bash)  ·  deny  ·  edit input
  ↑ all four are inline-link buttons; "approve all" → --brass on hover with tooltip
    "Adds  permissions.allow: ['Bash(git status:*)']  to ~/.claude/settings.json"
```

File-edit tool case (Write/Edit): adds a UnifiedDiff preview between the tool table and the action row.

### 8.5 M1d  Plan-mode banner

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PLAN MODE  ·  no edits will execute. claude will describe its plan and ask before continuing.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
       ↑ "PLAN MODE" --brass Inter Tight 10px ↑↑ tracked
                        ↑ rest --ink-secondary 11px JetBrains Mono italic
```

Sits directly above the composer.  Click → opens permission picker chip dropdown.

### 8.6 M2  TODO panel

```
┌─────────────────────────────────────────────────────┐ ← sticky bottom of conversation
│ TODOS · 2/5                              ▾          │   header: Inter Tight 9px ↑↑
│ ┃ ✓ Find the slowest test                           │   ✓ --green
│ ┃ ✓ Rewrite the test fixture                        │   ┃ left bar: 2px --rule-strong
│ ┃ ▸ Run preflight  ←                                 │   ▸ --brass + respiration; ← arrow active
│ ┃ ☐ Document the new helper                         │   ☐ --ink-tertiary
│ ┃ ☐ Open a PR                                       │
└─────────────────────────────────────────────────────┘
```

Collapsed:
```
┌─────────────────────────────────────────────────────┐
│ TODOS · 2/5  ·  running: Run preflight   ▸          │
└─────────────────────────────────────────────────────┘
```

### 8.7 M3  MCP add-server dialog

Centered modal, 480px wide.  Hairline border + frosted overlay (no blur — just a 60% opaque `--bg-0`).
```
━━━━━━━ ADD MCP SERVER ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  name        ┌──────────────────────────────────┐
              │ context7                         │       ← input style as §8.0
              └──────────────────────────────────┘

  transport   ◉ stdio   ○ sse   ○ http                  ← consistent radios with §8.2

  command     ┌──────────────────────────────────┐
              │ npx                              │
              └──────────────────────────────────┘

  args        ┌──────────────────────────────────┐
              │ -y, @upstash/context7-mcp        │       ← comma-separated; tokenized into chips on blur
              └──────────────────────────────────┘

  env         + add variable                            ← repeatable key/value rows

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
                     esc cancel · ⏎ save & spawn  →
                                  ↑ --brass
```

### 8.8 M4  Memory inline editor

Section row click toggles the editor open inline (no separate modal):
```
▾ MEMORY                                            (2)
  ◇ ~/.claude/CLAUDE.md                user · 3h ago    ← collapsed
  ▾ ◇ project/CLAUDE.md                project · just now
        ┌─────────────────────────────────────────┐
        │ # Project context                       │     ← textarea, JetBrains Mono 11px
        │                                         │       1px --rule, --bg-paper, no scroll
        │ ## Conventions                          │       chrome.  vertical resize only.
        │ - prefer rg over grep                   │
        │                                         │
        └─────────────────────────────────────────┘
        save · revert  ·  conflict: file changed externally · [reload] [overwrite]
        ↑ --brass     ↑ --ink-tertiary   ↑ shows only on conflict (mtime mismatch)
```

### 8.9 M5  Permissions editor

Tabular layout inside the Permissions section (or expanded modal for editing):
```
▾ PERMISSIONS                                       (4 / 1)   [+ rule]
  ALLOW                                          source
   Bash(git status:*)                            project
   Read(src/**)                                  user
   WebFetch(*.anthropic.com)                     user
                                                 [+]

  DENY                                           source
   Bash(rm -rf:*)                                user
                                                 [+]

  test pattern  ┌──────────────────┐  → allow (project)         ← live verdict
                │ Bash(git ...)     │     ↑ --green; deny → --red
                └──────────────────┘
```

### 8.10 Motion + a11y rules (per-surface)

| Surface | Motion | Focus order | Esc behavior |
|---|---|---|---|
| Sidebar | none on render; resize handle hover transitions 120ms | section headers → items → CTAs | none |
| AskUserQuestion | brass left bar respires (existing 1.5s `breathe` keyframe) | header → Q1 options → Other textarea → Esc → ⏎ | cancel + tool_result `{cancelled: true}` |
| ExitPlanMode | rule fade-in 200ms on mount | content → reject → approve | reject (auto-feedback "user dismissed") |
| canUseTool | rule fade-in 200ms; brass hover on action buttons | first action focused → tab through | deny |
| TODO panel | in_progress row brass stripe respires | non-interactive, decorative | none |
| MCP dialog | rule fade-in; modal overlay 80ms fade | name → transport → conditional fields → save | cancel |

---

## 8.11 M6 — Session metadata mutators (rename / color / description / group) for agent mode

### Root cause

Four IPCs in `src-tauri/src/pty/commands.rs` short-circuit with
`"Session {id} not found"` when called against an agent-mode session,
because they only look in `pty_manager.sessions` (which has no entry for
agent sessions — those have no PTY).  Affected commands:

- `update_session_label`
- `update_session_description`
- `update_session_color`
- `update_session_group`

The bug is identical in shape to the multi-folder attach bug we fixed
earlier: a single-source-of-truth assumption written before agent mode
existed.  `add_workspace_path` / `remove_workspace_path` already have
the right pattern (try PTY → fall back to DB).  We mirror that for the
four metadata mutators.

### Test plan

| ID | Test | Level |
|---|---|---|
| sm-1 | `update_session_label` for agent session writes to DB and emits `session-updated` | rust integration |
| sm-2 | `update_session_label` for terminal session preserves the existing PTY-first behaviour (regression guard) | rust integration |
| sm-3 | `update_session_description` agent path | rust integration |
| sm-4 | `update_session_color` agent path | rust integration |
| sm-5 | `update_session_group` agent path (incl. `null` clears group) | rust integration |
| sm-6 | reading a session row after the agent IPC sees the new value (round-trip) | rust integration |
| sm-7 | calling the IPC with a non-existent session id returns `"Session {id} not found"` (no DB row) | rust integration |
| sm-8 | rapid concurrent updates to the same agent session preserve the latest value (no race) | rust integration |
| sm-9 | terminal-mode behaviour unchanged: in-memory `Session` mutated AND DB row updated AND event emitted | rust integration |
| sm-10 | frontend `updateSessionLabel` IPC wrapper still passes correct args | vitest |

### Locked decisions

- **Terminal-mode behaviour cannot regress.**  PTY-first branch keeps
  bit-exact semantics: in-memory `Session` mutation, `session-updated`
  emit from in-memory state, DB write last.
- **Agent fallback emits `session-updated` from the freshly-written DB
  row.**  Same event shape; frontend reducer doesn't need to change.
- **No new event types.**  The `session-workspace-paths-updated` event
  is path-specific; metadata changes ride on `session-updated`.

### Implementation

Each of the four IPCs gets the same refactor: keep the PTY block as
the early return, add a "fallback to DB" block for agent sessions,
emit `session-updated` from the read-back row.

---

## 8.12 M7 — Agent prewarm: pre-populate UI from on-disk sources

### Root cause

In stream-json mode, the SDK only emits `init` after the first user
message lands.  `init` is the only source of: slash_commands list, MCP
server list, memory_paths, available tools.  So when the user opens a
fresh agent session, every UI element keyed on `init` is empty until
they type their first message AND Claude responds.

The user-visible failure: type `/`, see no dropdown.  Open the Context
Panel, see "no MCP servers".  Both are wrong — the data exists on
disk; we're just waiting for Claude to roundtrip it back to us.

### Fix

Pre-populate from on-disk sources so the UI is fully populated by the
time the user starts typing:

- **MCP servers** — read `~/.claude.json` `mcpServers` directly.  Show
  with `status: "unknown"` until the live `init.mcp_servers` arrives.
- **Slash commands** — list `*.md` files in `~/.claude/commands/` and
  `<cwd>/.claude/commands/`.  Each filename → `/<name>` slash command.
  Once `init.slash_commands` arrives, prefer that (it includes
  built-ins + plugin commands the static read can't see).
- **Memory paths** — list `~/.claude/CLAUDE.md`, `<cwd>/CLAUDE.md`,
  and any project-relative CLAUDE.md files.  Same prefer-init pattern.

### Test plan

| ID | Test | Level |
|---|---|---|
| pw-1 | `read_static_mcp_servers` returns parsed mcpServers from ~/.claude.json with status=unknown | rust |
| pw-2 | returns [] when file missing | rust |
| pw-3 | returns [] on corrupt JSON | rust |
| pw-4 | `read_static_slash_commands(cwd)` lists user + project `.claude/commands/*.md` files | rust |
| pw-5 | refuses paths outside the user/project commands dirs (security) | rust |
| pw-6 | `read_static_memory_paths(cwd)` lists user + project CLAUDE.md when they exist | rust |
| pw-7 | frontend hook prefers `init.slash_commands` over static when both available | vitest |
| pw-8 | frontend hook returns static while init still null | vitest |
| pw-9 | merge contract: live init.mcp_servers replaces static (live status > unknown) | vitest |

### Locked decisions

- **Static reads happen in parallel with bridge spawn**, both fired
  from `createSession`.  No additional IPC roundtrip on first message.
- **Init wins** when both static and live are available.  Static is
  scaffolding; the SDK's view is authoritative.
- **No synthetic warmup user message.**  Sending "ping" to Claude
  pollutes the session blob and costs tokens.  We accept the inherent
  first-API-call latency of the user's actual first message.

---

## 9. Pre-implementation gate

Before any milestone moves to in_progress:

1. The full §2 + §7 test list for that milestone must exist as failing tests.
2. The visual spec in §8 must be locked (no "designing as I implement").
3. `tsc --noEmit` on the test file (with stub imports) must pass.
4. CI for the test file (red on every test) must be green-on-skip — i.e., the harness wires it up.

This gate exists because the user explicitly required: *"we should catch them and fix and guarantee the whole working before any starting."*
