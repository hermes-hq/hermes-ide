# v1 — Claude Agent, From Scratch

Status: **DRAFT.** No code is written against this until the user signs off.

This supersedes the stabilization plan for the agent UI. It treats agent mode (Claude only) as a clean-room product, not a patched-over terminal.

---

## 0. The bar

Better than Conductor. Better than Cursor's chat panel. Better than Claude.ai. Better than Continue. The kind of tool an engineer keeps open all day because every interaction is *gratifying*.

Three rules for every decision:

1. **No surprises, no lies.** The UI never claims something is true that isn't. If a model swap is in flight, we say so. If Claude is thinking, we show it. If we crashed, we say what happened.
2. **One row of trust.** Every persistent surface (masthead, composer, chips) is a single source of truth. Anything visible is correct *now*.
3. **Designed for the long session.** Not a single Q&A. A multi-hour build session — model swaps, project attaches, tool runs, diff reviews, all without losing context.

---

## 1. Competitive read (honest)

### Conductor
**Strong:** Fast onboarding, no token to paste; chip-driven session config; clean conversation thread; tool calls feel native.
**Weak:** Conversation is a single column, no rhythm between turns; tool blocks are visually undifferentiated; model swap shows as a chip but the actual mechanism is opaque ("scrapes interactive Claude TUI").
**What we steal:** chip-driven session config; "no token, just go" feel.
**What we beat:** structured tool blocks (we have file/exec/search/web with distinct visual languages already); explicit session id tracking; honest activity indicators.

### Cursor (chat panel)
**Strong:** In-editor context (the file you're editing is auto-attached); diff acceptance flow is excellent.
**Weak:** Chat panel is cramped, conversation history is hard to navigate, model picker is buried.
**What we steal:** auto-attach the editor's current file as context.
**What we beat:** full-window agent surface; structured per-turn context; better conversation navigation.

### Claude.ai (web)
**Strong:** Beautiful prose rendering; artifacts panel.
**Weak:** No tool runs; no file system access; not a development tool.
**What we steal:** prose rendering quality.
**What we beat:** native tool runs, file edits, project attachment.

### Continue.dev
**Strong:** Slash commands, custom commands, deep IDE integration.
**Weak:** Chat is plain; no structured tool view.
**What we steal:** slash commands as power-user shortcuts (we have them).
**What we beat:** a session is a session, not a series of chat completions.

### What none of them do well
- **A real activity dashboard.** They all show "thinking…" with no granularity. We can show: what tool is running, how long, what file it's touching, with clean cancel/interrupt.
- **Mid-conversation flag changes that actually work.** They either don't (Claude.ai) or fudge it (Conductor's TUI scrape).
- **Project workspaces with multiple paths.** All of them assume one root.
- **Honest persistence.** If the conversation is saved, when, where, recoverable how — explicit.

---

## 2. The user's day in this app (the loop we optimize for)

**Morning, opens app.** Workspace restores: 2-3 sessions, each with their last turn visible. Click the one you were working on, the masthead instantly reads `AGENT · sonnet · my-project · LAST TURN 14h AGO`. One click → continue.

**Pick up a turn.** Type into the composer. The composer's `❯` glyph and the brass cursor make it feel like an instrument, not a textarea. Submit. Conversation flows tight and dense — your prompt as italic margin-quote, Claude's reply as monospace prose, tool blocks for file edits and shell commands.

**Switch models mid-conversation.** Click the model chip → pick `opus`. Chip shows pending dot. Type your next message. Model swap *and* the message hit Claude in one fork. Init reports opus. Chip clears the dot. Conversation continues unbroken.

**Attach a second repo.** Right-click the project sidebar → "Attach existing project". Path appears in the masthead's `+1 path` indicator. Next message includes `--add-dir <path>`. Claude can read both.

**Long-running tool.** Claude runs a 90-second `Bash` build. The masthead ticker shows `RUNNING BASH · 47s` with the brass LED pulsing. The exec block in the conversation has a respiring left bar. You can keep typing your next prompt while it runs (queued).

**End of session.** Close the pane. Workspace auto-saves. Tomorrow, same state.

**Crash recovery.** App was killed mid-tool-run. On reopen, the session is restored, the last turn is shown with a clear "process exited with code 137" notice and a `Resume from here` button. Click → fresh subprocess with `--resume <canonical>`, same conversation.

---

## 3. The surfaces

### 3.1 Masthead (header)

```
┌───────────────────────────────────────────────────────────────────┐
│ ●  AGENT · claude-sonnet-4-6 · my-project · +2 paths     14:32 [≡]│
└───────────────────────────────────────────────────────────────────┘
```

- LED + state label (`READY` / `THINKING 12s` / `RUNNING Bash 47s` / `AWAITING CLAUDE`).
- Model alias (compact form — `sonnet`, `opus`, `haiku`).
- Project leaf name + extra-path counter (`+2 paths`) hovers to show full list.
- Right side: clock + overflow menu.
- States with motion: only `THINKING` and `RUNNING` pulse; otherwise still.

### 3.2 Conversation (the work)

- Centered column, max-width tuned for prose readability.
- Each turn:
  - Time gutter on the left (HH:MM:SS, only on the first message of a turn).
  - User prompt: italic mono, brass left-rule.
  - Assistant body: regular mono, full GFM markdown.
  - Tool blocks with family-distinct visual treatments.
  - Colophon (right-aligned, dim): `2.4s · 312 out · $0.07`.
- Inter-turn rhythm: 1px hairline + tighter intra-turn gap.
- Empty state: the brass LED + `[ AWAITING FIRST SIGNAL ]` (already shipped, keep).

### 3.3 Composer (the chatbox)

A single row, never wraps:

```
[ ❯  Message…                                                              ]
[                                                                          ]
[ ✨ Builder | Claude · sonnet ▾ | Default ▾ | medium ▾    ⌘↵ SEND      ]
```

Rules:
- Model chip shows the **alias** (`sonnet`), full id only in tooltip.
- Permission and effort chips are short labels.
- Send button is the only colored button. Brass.
- The composer never overflows even on a 600px window — chips collapse into a `⋯` menu past a width threshold.
- Pending state on chips = brass `•` glyph next to the value, cleared on the next init.

### 3.4 Tool blocks (already done, keep)

File / Exec / Search / Web / Generic — each has a distinct visual language. Don't change.

### 3.5 Session sidebar

- One row per session, with model + last-turn timestamp.
- Drag to reorder. Right-click for: Rename, Convert to terminal, Close.
- "+ New session" at the bottom — opens the streamlined creator (see 3.6).

### 3.6 Session creator (the entry funnel)

Currently this is two panes. New version:

```
┌─────────────────────────────────────┐
│  NEW SESSION                        │
│                                     │
│  Project        [ ▾ select ]        │
│  Model          ( opus / sonnet ▾ ) │
│  Permission     ( default ▾ )       │
│  Effort         ( medium ▾ )        │
│                                     │
│            [   Create   ]           │
└─────────────────────────────────────┘
```

One screen. Keyboard navigation. No SSH wizardry until v1.1 (Claude only).

### 3.7 Project sidebar

- List of projects with attach/detach actions.
- Multi-select to attach to current session.
- Drag a folder onto the app to add it as a project.

### 3.8 Failure surfaces

| Failure | UI |
|---|---|
| `No conversation found` (stale uuid) | Inline notice with `Start fresh from here` button |
| `Session id already in use` | Auto-recover with new uuid; log warning, no user-facing notice |
| Subprocess crashed (non-0) | Clear notice + `Resume from here` button |
| Rate limit | Top banner; submits queue; countdown to reset |
| Claude not on PATH | Splash screen with install instructions |

### 3.9 Activity surfaces

The masthead ticker + the heartbeat cursor are the only "alive" cues during streaming. Both already exist.

---

## 4. The differentiators (the moat)

These are the things only we have. Each is a real product feature, not a slogan:

1. **Editorial Engineering aesthetic.** Vintage-instrument palette (navy paper, brass), monospace typography, gridded composition. Distinct from every competitor's chat-bubble style.
2. **Numbered turn rhythm.** Each turn is visually a unit; the conversation is a logbook. (The literal `№` numbering was rejected — replaced with a time gutter, but the rhythm stays.)
3. **Honest activity indicator.** Tool name + elapsed time + LED that actually means something.
4. **Mid-conversation flag changes that work.** Deferred fork — change model, then submit, fork applies on the message. No hand-waving.
5. **Real project workspaces.** Attach multiple paths. `--add-dir` for each. Detach without losing conversation.
6. **Crash-resilient sessions.** Subprocess persistence is verified by e2e harness; resume actually works after kill.
7. **`Raw` view on every assistant message.** Click `RAW` → see literal markdown source. Copy it. Source is always available.
8. **A preflight harness that tests against the real `claude` binary.** No "I think it works." Every fix has a test.

---

## 5. What we keep from the current code

The recent stabilization work that's solid:

- `build_spawn_args` (Rust) with all four spawn shapes (initial, plain-resume, fork, fork-no-prior).
- `spawn_agent_session` IPC + the per-session refs (`claudeUuids`, `claudeModels`, `claudePermissionModes`, `claudeEfforts`).
- The deferred-fork queue (`pendingFlags`).
- The submit pipeline (`submitAgentMessage` with retry-on-not-found).
- `--add-dir` plumbing.
- The 13 e2e tests against the real `claude` binary.
- `npm run preflight` as the canonical gate.
- All the Tool family components (FileToolBlock, ExecToolBlock, SearchToolBlock, WebToolBlock, GenericToolBlock).
- MarkdownBody, CodeFence, SmartOutput.
- ResultFooter colophon.

---

## 6. What we redesign clean-room

These get a fresh design pass — built right, not patched:

- **Composer.** Single row, never wraps. Compact model alias. Brass focus ring + send. Slash command dropdown. Model/permission/effort chips with the deferred-fork queue.
- **Masthead.** Plain-text labels, masthead-as-nameplate, ticker for activity. Clock on the right.
- **Conversation column.** Tight intra-turn rhythm, hairline inter-turn rule, time gutter, italic user / regular assistant.
- **Session sidebar.** Single-row sessions, hover affordances, drag-reorder.
- **Session creator.** One-screen, keyboard-friendly.
- **Project sidebar.** List + drag-to-attach.

---

## 7. Sequencing (milestones with hard gates)

Each milestone has:
- **Tests** that must pass.
- **Manual smoke checklist** items.
- **No advancement** to the next milestone until both are clean.

### M1 — Foundation lockdown (1 day)

Verified baseline. No new features.

- All current preflight green.
- Remove anything obviously broken from the current UI without adding new behavior.
- Document the per-session ref invariants in code comments.

**Gate:** preflight green. Manual smoke: open session, send message, get reply, model swap, send next message.

### M2 — Composer never wraps (½ day)

- Test C1: render composer with all chips at multiple widths; assert no overflow.
- Test C2: model alias displayed correctly.
- Implement: compact model chip (`compactModel`), `nowrap` row, max-width per chip, overflow `⋯` menu past threshold.

**Gate:** the new tests + preflight.

### M3 — Masthead truthfulness (½ day)

- LED state matches `deriveActivity` output exactly.
- Ticker text reflects real subprocess state.
- Add `+N paths` indicator.
- Test: deriveActivity edge cases (already covered) + a snapshot of the new masthead at each state.

**Gate:** new tests + preflight.

### M4 — Project attach round-trip (1 day)

- Frontend integration test: attach → submit → IPC carries `addDirs` correctly.
- Detach test: detach → submit → `addDirs` excludes path.
- Workspace-restore test: persisted `workspace_paths` reach Claude.
- Manual smoke: attach a project, ask Claude to read a file in it, verify it can.

**Gate:** new tests + preflight + manual smoke confirmed.

### M5 — Failure surfaces (1 day)

- "Start fresh from here" recovery on `No conversation found`.
- Rate-limit banner with countdown.
- Subprocess crash notice with retry.
- Tests for each failure mode.

**Gate:** new tests + preflight + manual repro of each failure path.

### M6 — Session sidebar redesign (1 day)

- New layout (one row per session, drag-reorder).
- Right-click menu with Convert / Close / Rename.
- Tests for state transitions.

**Gate:** new tests + preflight.

### M7 — Session creator (1 day)

- One-screen layout with all four selects.
- Keyboard navigation tests.
- E2E: create session via creator, verify session opens with chosen model + perm + effort + project.

**Gate:** new tests + preflight + e2e.

### M8 — Aesthetic / final polish (1 day)

- Color, motion, typography pass over the whole agent surface.
- Visual regression baseline (Playwright if it'll fly; otherwise structured screenshot diffs).

**Gate:** preflight + visual baseline locked.

### M9 — Closing the loop (½ day)

- Update README with v1 agent description.
- Update CLAUDE.md if needed.
- Commit, no push until you say.

---

## 8. The discipline going forward

After this plan is approved:

- **Every milestone starts with a TEST.** Write it. Make it fail. Then implement until it passes.
- **`npm run preflight` is the only "ready to test" signal.** If it isn't green, the milestone isn't done.
- **No "I think it works."** Every claim is backed by a test name and a passing run.
- **No silent regressions.** If a milestone breaks an earlier test, that's a stop.
- **The user's reproductions are gold.** Every new bug they catch becomes a test before the fix.

---

## 9. Open questions for the user

Pick one of (a) / (b) for each before I execute.

1. **Bypass-permissions confirm dialog?** (a) Yes, require an extra confirm click; (b) No, the red picker entry is enough.
2. **Default model behavior?** (a) Pass nothing, let Claude pick the account default each spawn; (b) Track the initial model from init and re-pass it on every spawn.
3. **Idle timeout?** (a) Subprocess waits forever for first input; (b) Time out after N minutes idle and tear down (saves resources).
4. **Mid-conversation system prompt?** (a) Don't inject anything; (b) Prepend a `[system: you are running model X with permission mode Y]` on every fork so Claude self-describes accurately.
5. **`Raw` view by default?** (a) Hidden, hover to reveal (current); (b) Persistent low-opacity badge on every assistant message.
6. **Project-attach apply-now?** (a) Lazy (next message respawns with `--add-dir`); (b) Add an "apply now" affordance (does an empty fork — accept the persistence risk and surface a toast).
7. **Effort across models?** (a) Pass through, don't surface differences; (b) Show a per-model badge when effort behavior differs.
8. **Are we building anything in v1 beyond Claude?** From your message: Claude only for now. Confirming.

---

## 10. What I will not do until this is approved

- No implementation.
- No further code changes.
- No "small fix" temptations.

When you sign off — or revise — I'll execute M1 first and only message you when its preflight is green.
