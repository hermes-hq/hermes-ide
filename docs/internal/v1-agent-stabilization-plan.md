# v1.0.0 Agent Stabilization Plan

Status: **DRAFT — awaiting review.** No code is written against this until the user approves.

---

## 1. The point of this document

The recent iteration loop has been: ship a fix → user opens it → something else is broken. That's unacceptable, and the cause is that I've been treating each bug as isolated instead of mapping the whole agent surface, locking down its contract, and proving every state with tests.

This document does the inversion:

1. **Spec.** Every agent-mode feature, including edge cases and how it should behave under each.
2. **Architecture.** The data flow that supports each feature, with named seams.
3. **Test coverage.** For each spec line, the test (or tests) that proves the implementation behaves the way the spec says.
4. **Sequencing.** The order in which to ship the fixes, and which test gates each milestone.

When this is approved, I will execute against it — and `npm run preflight` will be the gate before any "ready to test" message.

---

## 2. The agent surface (what should work, exhaustively)

### 2.1 Session lifecycle

| # | Behavior | Acceptance criteria |
|---|---|---|
| L1 | New agent session opens | Subprocess A spawns. Init event arrives within 5 s. UI shows the masthead with model + cwd. |
| L2 | First user message | Echo appears immediately. Subprocess A processes, replies, exits cleanly. |
| L3 | Second user message after A exited | Auto-respawn (plain `--resume <canonical-uuid>`) succeeds. Conversation continues with prior context. |
| L4 | Multi-turn (≥6 turns) | Every auto-respawn succeeds. No `No conversation found`. No silent context loss. |
| L5 | Workspace restore | Reopening the app brings back the session. `--resume <canonical-uuid>` recovers Claude's persisted conversation if available. |
| L6 | Session close | Subprocess torn down cleanly. Session removed from state. No orphan refs. |
| L7 | Session-mode conversion | Terminal → agent (and vice versa) tears down the old subprocess and spawns the new mode. |

### 2.2 Flag changes (model / permission / effort)

| # | Behavior | Acceptance criteria |
|---|---|---|
| F1 | User clicks chip | Picker opens. Selecting a value queues it (no spawn yet). Chip shows pending dot. |
| F2 | Multiple chip clicks before submit | Latest values for each flag collapse into one queued bag. |
| F3 | First user submit after queueing | Fork-respawn fires WITH the queued flags AND the user envelope. Subprocess persists the new session id. |
| F4 | Subsequent auto-respawn | Plain `--resume`, but `--model`, `--permission-mode`, `--effort` are still passed (preserved across turns). |
| F5 | Init event after a fork | Reports the new model + permission. Chip + masthead update to match. |
| F6 | Switch flag back to default | `null` clears the override; spawn omits the flag. |
| F7 | Bypass-permission selection | Visually distinct (red) and accessible only via explicit confirmation. (Currently red in the picker; no confirm dialog yet — open question, see §6.) |

### 2.3 Attached projects (`--add-dir`)

| # | Behavior | Acceptance criteria |
|---|---|---|
| P1 | Attach project via Context Panel | Path appended to `session.workspace_paths`. **No immediate respawn.** Pending-attach state visible in UI. |
| P2 | Send next message | Respawn passes `--add-dir <each-attached-path>`. Claude has tool access to the new path on this turn. |
| P3 | Detach project | Path removed from `workspace_paths`. Next respawn omits it. Claude no longer accesses it. |
| P4 | Workspace restore with attached projects | Initial spawn includes all `workspace_paths`. |
| P5 | Working directory itself | Always passed via `current_dir`, never via `--add-dir` (avoid duplication). |

### 2.4 Composer (chatbox)

| # | Behavior | Acceptance criteria |
|---|---|---|
| C1 | Resting state | Single row: builder · model chip · permission chip · effort chip · send. Never wraps to a second row at any plausible window width. |
| C2 | Long model id (`claude-haiku-4-5-20251001`) | Displayed as the family alias (`haiku`) — full id only in tooltip. |
| C3 | Pending state on chips | Visible `•` dot, non-jarring, cleared once init reports the new value. |
| C4 | Send button | Active when there's text or attachments. Tactile press. Accessible name. |
| C5 | Esc key (empty draft) | Collapses composer (existing behavior). Esc with text just blurs. |
| C6 | Cmd/Ctrl+Enter | Submits regardless of focus on chip dropdowns (existing). |

### 2.5 Conversation surface

| # | Behavior | Acceptance criteria |
|---|---|---|
| S1 | Empty state | Brass LED + `[ AWAITING FIRST SIGNAL ]` + hint. No "stuck" feeling. |
| S2 | Streaming | Heartbeat brass cursor at end of streaming text. Disappears the instant the result event arrives. |
| S3 | Tool family blocks | File / exec / search / web / generic each render with their own visual language. |
| S4 | Markdown / code / mermaid / tables | Render correctly. Raw toggle on each assistant message + each fence. |
| S5 | Activity indicator | Header dot pulses + ticker text shows `THINKING` / `RUNNING <tool>` / elapsed counter. |
| S6 | Inter-turn rhythm | Hairline rule + tighter intra-turn spacing; turns visually pair. |
| S7 | Exit notice | Hidden on clean code-0 exit during a conversation. Visible only on real errors (non-zero, signal, exit-before-init). |

### 2.6 Failure modes that must be handled gracefully

| # | Scenario | Acceptance criteria |
|---|---|---|
| E1 | Claude returns `No conversation found` | Surface the actual stderr; offer "fresh session" recovery; never just blank the UI. |
| E2 | Claude rejects an argv combination | Same: stderr surfaced; offending flags identified. |
| E3 | Subprocess crashes mid-stream | Exit notice shown; user can retry submitting. |
| E4 | Network / rate-limit | `RATE LIMIT` notice in masthead; user submits stay queued or fail loudly. |
| E5 | Claude binary not on PATH | Friendly error at session creation; instructions to install. |

---

## 3. Architecture (named seams + data flow)

### 3.1 The four spawn shapes

Every spawn goes through `build_spawn_args` (Rust) and falls into ONE of four shapes:

| Shape | Trigger | Args |
|---|---|---|
| **A. Initial** | First spawn for a new session | `--session-id <new>` |
| **B. Auto-resume** | Between-turn continuation, no flag change | `--resume <canonical>` (no `--session-id`) |
| **C. Fork** | User-driven flag change (model, perm, effort), with prior session | `--session-id <new> --resume <prior> --fork-session` + new flag(s) |
| **D. Restore** | App restart / workspace restore | `--session-id <new>` (with `--add-dir` if `workspace_paths`); attempts plain init |

Common to all: `--print --output-format stream-json --input-format stream-json --include-partial-messages --verbose`. Plus `--add-dir <path>` per attached project, plus current `--model` / `--permission-mode` / `--effort` from the per-session refs.

### 3.2 Per-session refs (single source of truth on the frontend)

```
sessionId → claudeUuids       : Claude's canonical session uuid (from init)
sessionId → claudeModels      : Currently-active model (or undefined for default)
sessionId → claudePermissionModes : Currently-active permission mode
sessionId → claudeEfforts     : Currently-active effort
sessionId → pendingFlags      : Queued chip changes, drained on next submit
sessionId → initListeners     : Tauri unlisten fn for init capture
```

### 3.3 Submit pipeline

```
SessionComposer.handleSubmit(draft, attachments)
  → SessionContext.submitAgentMessage(sid, draft, attachments)
      1. buildUserEnvelope(draft, attachments)  // returns null if empty
      2. echoUserEnvelope(sid, env)             // user message renders immediately
      3. if pendingFlags[sid] non-empty:
            respawnAgent(sid, pendingFlags[sid])  // fork shape if priorUuid exists
            pendingFlags.delete(sid)
      4. sendUserEnvelope(sid, env)
      5. on 'not found' error:
            respawnAgent(sid, {})                 // auto-resume shape
            sendUserEnvelope(sid, env)            // retry
      6. on any other error: throw
```

### 3.4 Init capture loop

A per-session listener subscribes to `agent-event-{sessionId}` and:
- Stores `event.session_id` in `claudeUuids[sid]` (canonical id for resume)
- Logs `[init]` for diagnostics
- Does NOT mutate React state directly — the AgentSessionView and useAgentInit have their own subscriptions for that

---

## 4. Test plan (every spec line maps to a test)

### 4.1 Rust unit tests (`agent::tests`, `npm run preflight` covers)

- `build_spawn_args_*` — flag ordering and presence pinned for shapes A/B/C/D.
- Whitelisted permission modes accepted; unknown rejected.
- Whitelisted effort levels accepted; unknown rejected.
- `--add-dir` emitted once per non-empty path; empty list omits flag entirely.
- No `--session-id` when resuming without fork.
- No `--fork-session` when no prior uuid given.

### 4.2 Rust e2e tests (real `claude` binary, gated `#[ignore]`, `--test-threads 1`)

| Test | Spec line covered |
|---|---|
| `e2e_single_turn_smoke` | L1, L2 |
| `e2e_resume_continues_conversation` | L3 |
| `e2e_resume_in_project_directory` | L3 in real cwd |
| `e2e_six_turn_resume_chain` | L4 |
| `e2e_full_production_lifecycle` | L1+L2+L3+F3+F5 chain |
| `e2e_fork_with_model_swap_takes_effect` | F3, F5 |
| `e2e_fork_with_permission_mode_swap_takes_effect` | F3, F5 |
| `e2e_effort_flag_accepted` (5 levels) | F3 |
| `e2e_fork_then_resume_the_fork` | F3, L3 |
| `e2e_fork_with_user_message_persists_for_later_resume` | F3 (the deferred-fork fix) |
| `e2e_fork_without_user_message_breaks_subsequent_resume` | bug reproducer for the empty-fork pattern |
| `e2e_plain_resume_after_fork_reports_correct_model_in_init` | F5 |
| `e2e_add_dir_grants_extra_project_access` | P2 |

**Missing tests we still need to write:**
- E1: Claude rejects an argv combo → stderr surfaced verbatim. (Manual repro from the user-side; needs a "spawn that we know fails" assertion.)
- E2: simulate `Session ID … is already in use` rejection (already noticed, no test).
- E3: subprocess crashes mid-stream (force kill -9). Verify the exit notice shows.
- E4: rate-limit event handling (no current test fixture).
- L5: workspace restore with persisted Claude session. (Requires a fixture file with stale uuids.)
- L6: clean teardown with no orphan refs (assert all four refs empty after `SESSION_REMOVED`).
- L7: agent ↔ terminal mode conversion path.
- F2: chip click + chip click + submit collapses to one fork (covered by `deferred-fork.test.ts` already, partial).
- F4: auto-respawn preserves model/perm/effort across plain resumes.
- F6: switching back to "default" clears the override (no test).
- P1, P3, P4, P5: project-attach state mutations (no end-to-end test through the UI; only the binary `--add-dir` test exists).

### 4.3 Frontend tests (vitest)

| File | Spec line covered |
|---|---|
| `deferred-fork.test.ts` | F1, F2, F3 (queue → submit pipeline) |
| `agent-respawn-flags.test.ts` | F3, F4 IPC contract |
| `submit-to-agent.test.ts` | submit envelope shape + retry + echo |
| `derive-activity.test.ts` | S5 |
| `exit-notice-policy.test.ts` | S7 |
| `agent-marginalia.test.tsx` + `agent-stream-integration.test.tsx` | S2-S7 |
| `markdown-body.test.tsx`, `smart-output.test.tsx` | S4 |

**Missing:**
- C1 (composer never wraps) — no current test pinning the chip width / no-wrap behavior.
- C2 (compact model alias) — no test that asserts `claude-haiku-4-5-20251001` renders as `haiku`.
- C3, C4, C5, C6 — composer interaction tests are sparse.
- P1 attach UI flow: project attach → `workspace_paths` mutated → next spawn includes path. No frontend integration test for this (only the binary-level `--add-dir` test).

### 4.4 Visual regression (deferred)

Playwright is in `package.json` but not currently exercising the agent UI. Out of scope until the functional gates above are green.

---

## 5. Sequencing (what to fix, in what order, with test gates)

Each step is gated by **all preflight tests + the new tests for that step** passing. No "I think it works" without the proof in the suite.

### Milestone 1 — Reliability gates already in place
Everything currently green in `npm run preflight`. Don't regress.

### Milestone 2 — Composer doesn't wrap (the immediate visible issue)
- Test C1: render `<SessionComposer>` with all 4 chips active in a 720 px wide container; assert no element is outside the row's bounding box.
- Test C2: assert `compactModel("claude-haiku-4-5-20251001")` returns `"haiku"`; assert chip displays it.
- Implement: model display = compact alias; CSS `white-space: nowrap` on chips; `overflow: hidden` on the row; max-width per chip.

### Milestone 3 — Auto-respawn preserves all flags (F4) verified end-to-end
- Test F4: e2e — set model+perm+effort, run 5 plain-resume turns, assert init reports same flags every turn.
- Currently looks correct in the user's logs but isn't pinned by a test.

### Milestone 4 — Project attach/detach round-trip
- Test P1: frontend-integration — call `attachSessionProject(sid, projId)` mock, then `submitAgentMessage`, assert `spawnAgentSession` IPC payload includes the path in `addDirs`.
- Test P3: same flow with detach; assert path absent from next `addDirs`.
- Test P4: workspace-restore path includes `addDirs`.
- Implement nothing new — the wiring exists; verify via tests.

### Milestone 5 — Failure-mode UX (E1, E2, E3, E4, E5)
- Test each error condition; assert the user gets a *useful* message (not just "0 out · $0.00").
- Add a "Fresh session" affordance for E1 (Claude lost the session uuid).
- Inline rate-limit countdown for E4.

### Milestone 6 — Clean teardown (L6) and mode conversion (L7)
- Assert all per-session refs empty after `SESSION_REMOVED`.
- Round-trip terminal ↔ agent.

### Milestone 7 — Polish & visual
- Composer aesthetics that don't regress.
- Empty state, masthead, tool blocks consistency check.

---

## 6. Open questions for the user

1. **Bypass confirmation.** Today the picker shows `Bypass` in red but doesn't require an extra confirm click. Should it require a confirmation dialog when going from non-bypass → bypass? (Risk: user picks it accidentally.)
2. **Default model ambiguity.** When the user picks "Default" in the model picker, do we:
   - (a) Pass no `--model` and let Claude pick the account default, or
   - (b) Track the initial model from init and re-pass it?
   We do (a) today. Either is defensible; let's confirm.
3. **Empty conversation persistence.** If the user opens a session and never types, the subprocess waits forever. Is that fine, or should we time-out and tear down after N minutes idle?
4. **Project-attach UX latency.** Today the `--add-dir` reaches Claude only on the *next* user message. Is "lazy apply" acceptable, or do you want an "apply now" affordance that does an empty-input fork (and we accept the persistence risk)?
5. **Effort across models.** Claude's `--effort` is accepted by all models we tested, but the actual thinking budget per level may differ. Do we surface that to the user (e.g., a per-model badge), or just pass through?
6. **Mid-conversation memory.** When Claude self-reports the wrong model ("I'm Opus" while we're running Haiku), do we want to prepend a `[system: you are running model X]` message on every fork to keep its self-description accurate?

---

## 7. What I will NOT do until this plan is approved

- No more chip / composer / aesthetic changes.
- No new e2e tests beyond what's listed in §4.
- No untested fixes shipped for any of the six "open questions" above.

When you've reviewed this and either approved or marked it up, I'll execute Milestone 2 first (the visible chip overflow), with the test gate, and then move to Milestone 3 only when M2 is green in preflight.
