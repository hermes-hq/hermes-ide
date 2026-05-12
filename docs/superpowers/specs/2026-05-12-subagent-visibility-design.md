# Subagent Visibility — Design Spec

**Date:** 2026-05-12
**Status:** Approved (sections §1–§3) — ready for implementation planning
**Scope:** Agent-mode sessions only. Terminal mode is out of scope.

## Problem

When Claude spawns subagents via the `Task` tool — sometimes without the
operator explicitly asking, and sometimes recursively (a subagent that
itself dispatches more subagents) — the operator loses track of *what is
running, what stage each one is at, and what each one produced*.

The data is already in `AgentSessionState` (every message carries
`parentToolUseId`), but the UI does not surface it: subagent messages
render inline in the flat conversation stream without grouping or
state-rollups. There is no way to tell, at a glance, how many subagents
are in flight, whether a Task block fanned out to 1 or 5 children, or
whether the agent took initiative to spawn a deeper layer.

## Goals

- The operator can always tell **how many** subagents are running, both
  inline (under the parent Task) and globally (in the session masthead).
- The operator can tell **what** each running subagent is doing, with
  one click.
- Done subagents stop competing for attention but remain countable and
  drillable.
- Nested spawns (subagent → subagent) are visible without surprising
  the operator.
- Zero changes to the reducer; no new state surface in
  `AgentSessionState`.

## Non-goals

- Per-subagent stop / interrupt control. The existing global Stop
  covers it.
- Live token-by-token streaming preview in the row. The compact row
  shows state only; expand to see the subagent's reply.
- Aggregating subagents across multiple sessions. Workspace-level
  agent visibility is a separate effort.
- Editing or sending messages into a running subagent.

## Locked decisions

| Decision | Choice |
| --- | --- |
| Scope | Subagents inside one Agent-mode session |
| Where the rows live | Inline under the parent Task tool-use block |
| Row density | Compact — chev + state dot + name + elapsed (+ `(+N)` if nested) |
| Done behavior | Auto-collapse after **5 seconds**; remaining shows `N done` rollup |
| Expand contents | Final output / latest assistant text + `Show full transcript ↘` link |
| Per-subagent stop | Not in scope — global Stop is the only interrupt |
| Aggregate count surface | Inline rollup **and** `N subagents ▾` chip in session masthead |
| Implementation strategy | Derived selectors + `useMemo` (no new state) |

## §1 · Data model & selectors

No new state added to `AgentSessionState`. Two pure selectors over the
existing `messages` list, both colocated in
`src/agent/subagentSelectors.ts`:

### `selectSubagentsForTool(state, toolUseId): SubagentRow[]`

Returns the **direct** subagents spawned by a single Task `tool_use`.

Algorithm: walk `state.messages`, keep messages whose
`parentToolUseId === toolUseId`, group by the subagent's root message
id (the first message observed with that `parentToolUseId`).

Each row:

```ts
interface SubagentRow {
  id: string;                  // root message id of this subagent
  name: string;                // first-line title from Task input.description,
                               // else `subagent #N`
  state: "thinking" | "running" | "done";
  since: number;               // ms timestamp the first message landed
  doneAt: number | null;       // ms timestamp the row entered "done"
  nestedRunningCount: number;  // descendants still running, any depth
  lastReply: ContentBlock[] | null;  // most recent assistant text block,
                                     // null if the subagent never spoke
}
```

State derivation:

- `thinking` — has messages but no tool_use blocks have been issued
  *and* none of the subagent's own message ids appear in
  `state.runningToolUseIds`.
- `running` — at least one of the subagent's own `tool_use` ids
  appears in `state.runningToolUseIds`.
- `done` — either: a closing assistant event for the subagent's
  message id (`stop_reason !== null`), or the parent turn's `result`
  event has landed (existing B8 freeze in `messageStore` is extended
  to apply here).

### `selectSubagentCounts(state): SubagentCounts`

```ts
interface SubagentCounts {
  running: number;          // any state ≠ "done" anywhere in the tree
  done: number;             // any state === "done" anywhere in the tree
  totalEverSpawned: number; // monotonic per session
}
```

Walks `state.messages` once, counts every distinct subagent root id at
every depth.

### Memoization

Both selectors are pure. Call sites wrap them:

```ts
const rows = useMemo(
  () => selectSubagentsForTool(state, toolUseId),
  [state.messages, state.runningToolUseIds, toolUseId],
);
```

### Invariants

- **No stored state.** Survives bridge respawn / rewind correctly
  because `state.messages` is the source of truth.
- **Recursion terminates at data depth.** No artificial max-depth cap.
- **`done` is monotonic per row.** A row that has entered `done`
  cannot regress; the only way to "un-done" is a brand-new session.
- **`nestedRunningCount` reflects currently-visible running rows
  only.** Descendants that have already passed their auto-collapse
  are not counted.

## §2 · UI surfaces

Five new components. Existing files touched: two (one append, one
mount point). No reducer changes.

### `SubagentList` — inline under a Task tool-use

`src/agent/blocks/SubagentList.tsx`

Renders when the parent block is `tool_use` with `name === "Task"`.
Props: `{ toolUseId: string }`.

Reads rows via `selectSubagentsForTool`. `SubagentList` owns the
per-row 5 s auto-collapse timers (one `setTimeout` per row,
cleared on unmount or when the row is manually expanded). Surfaces:

- An ordered list of `SubagentRow` components for currently-visible
  rows, sorted by `since` ascending (oldest first — preserves
  spawn order).
- A rollup line `N done` at the **bottom** of the list once at least
  one row has auto-collapsed. Clicking the rollup expands a quiet
  list of the collapsed rows for that Task block, ordered by
  `doneAt`.

### `SubagentRow` — the compact row

Same file. Renders:

```
▸  ●  #1 audit-main  ·  4s         ·  (+2)
```

- `▸` chev rotates to `▾` when expanded.
- State dot color: slate `#7c8fa8` (thinking) / green `#6fb98e`
  (running, with `box-shadow` glow) / grey `#6a6353` (done).
- Name truncated to fit; hover shows full Task description in a
  native `title` tooltip.
- Elapsed counter: live `Xs` while thinking/running, frozen as
  `done · Xs` once done.
- `(+N)` nested hint shown when `nestedRunningCount > 0`.

Click anywhere on the row toggles expanded. Pressing the auto-collapse
timer cancels if the row is currently expanded.

### `ExpandedSubagent` — short expand body

Same file. Shown below the row when `expanded === true`. Contents:

1. `lastReply` rendered via the existing `MarkdownBody` component.
   Falls back to `— no output —` if `lastReply` is `null`.
2. A `Show full transcript ↘` link. Click opens `ExpandedViewModal`
   (already present in the codebase) populated with the subagent's
   full nested transcript — every message whose ancestor chain leads
   back to this subagent's root.

### `SubagentMastheadChip` — session masthead

`src/agent/SubagentMastheadChip.tsx`

Small pill next to the model name in the `AgentHeader` row:

```
[ ⊙ 3 subagents  ▾ ]
```

- Hidden entirely when `selectSubagentCounts(state).running === 0`.
- Pulses softly while `running > 0`.
- Click toggles `SubagentMastheadPopover` (same file).

### `SubagentMastheadPopover`

Opens anchored to the chip. Lists every **currently running** subagent
flattened across the whole session, with a 2 px depth indent per
nesting level. Same row format as `SubagentRow`, read-only. Clicking
a row scrolls the conversation pane to that subagent's Task block
(using the existing `scrollToMessage` mechanism). Closes on Esc /
outside-click.

### Plug-in points

Two existing files modified:

- `src/agent/blocks/ExecToolBlock.tsx` (or wherever `tool_use` blocks
  render — verify in the implementation plan): when `block.name ===
  "Task"`, append `<SubagentList toolUseId={block.id} />` below the
  block's normal rendering.
- `src/agent/AgentSessionView.tsx` — inside `AgentHeader`, mount
  `<SubagentMastheadChip />` next to the model chip / before the
  Stop button.

Nothing else in `AgentSessionView` or the reducer changes.

## §3 · Lifecycle & edge cases

### Normal flow

1. Operator sends a prompt; Claude emits a `tool_use` with
   `name === "Task"`. `SubagentList` mounts under it.
2. Subagent's first `assistant` or `user` event lands with
   `parent_tool_use_id`. `SubagentRow` appears with state
   `thinking`.
3. Subagent's `tool_use` lands → state flips to `running`. Step
   text not shown in compact row (only the dot color changes).
4. Subagent's closing event or the parent `result` lands → state
   flips to `done`. 5 s auto-collapse timer starts. `since` is
   frozen; elapsed displays `done · Xs`.
5. 5 s later, the row is removed from the list and the `N done`
   rollup increments. If the operator manually expanded the row
   before the timer fired, the timer is cancelled and the row
   stays until they explicitly close it.

### Bridge respawn mid-subagent

`messageStore` already resets `streamingMessageId` and
`runningToolUseIds` on respawn. The derived selector follows
naturally: any still-running subagent flips to `done` (no future
events for it will land). Auto-collapse fires the normal 5 s after.

### Global Stop

The existing reducer branch handles the `result` event with an
interrupt subtype: `runningToolUseIds: new Set()`,
`streamingMessageId: null`. Every running subagent flips to `done`
simultaneously. Auto-collapse follows.

### Nested spawn

A subagent's transcript may itself contain a `Task` tool_use block
that spawns further subagents. Because `SubagentList` recurses
through `ExecToolBlock` (or wherever `Task` blocks render), the
nesting renders to arbitrary depth without special-case code. The
parent row's `nestedRunningCount` reflects the count of
direct-and-deeper descendants that are still running.

### Subagent that dies silent

If a subagent finishes without producing an assistant text block,
`lastReply` is `null`. `ExpandedSubagent` shows `— no output —`
and the `Show full transcript ↘` link still works (the transcript
may include thinking and tool calls even if no text was emitted).

### Race: `done` before `lastReply`

The selector reads `lastReply` from the most recent assistant text
block at the moment of read. If the closing event arrives before
any text block exists (rare, but possible on an immediately-failing
subagent), `lastReply` is `null` and the placeholder behavior kicks
in.

### Operator scrolled past the Task block

The masthead chip remains visible. Clicking it opens the popover;
clicking a row in the popover scrolls back to that subagent's Task
block.

### Auto-collapsed row re-opened from history

The `N done` rollup, when expanded, shows the collapsed rows
inline (still grey, still `done · Xs`). Each is expandable for its
transcript. There is no "un-done" — once done, always done.

## §4 · Testing strategy

### Unit tests — selectors

`src/__tests__/subagent-selectors.test.ts`

- `selectSubagentsForTool` returns empty when no messages have the
  given `parentToolUseId`.
- Returns one row per distinct subagent root id, ordered by `since`.
- `state` derives correctly across thinking / running / done.
- Closing assistant event (`stop_reason !== null`) flips state to
  `done` and freezes `since`.
- Parent `result` event flips every running subagent under the tree
  to `done`.
- `nestedRunningCount` counts descendants at any depth.
- `lastReply` returns the most recent assistant text block; `null`
  when there is none.

`selectSubagentCounts`

- `running`, `done`, `totalEverSpawned` correct on a synthetic
  multi-level session.
- `running` decrements as subagents finish; `done` only
  increments.

### Component tests

`src/__tests__/subagent-list.test.tsx`

- A `Task` tool_use with no subagents yet renders an empty
  `SubagentList`.
- Adding a subagent message (via the reducer) makes the row appear.
- Hovering shows the full Task description tooltip.
- Clicking the row toggles `ExpandedSubagent`.
- A `done` row auto-collapses 5 s after entering done; expanded
  rows do not auto-collapse; cancelling the timer works.
- `N done` rollup line appears once at least one row has auto-
  collapsed; clicking it expands the collapsed rows.

`src/__tests__/subagent-masthead-chip.test.tsx`

- Chip is hidden when `running === 0`.
- Chip shows the correct count.
- Click opens popover; Esc / outside-click closes it.
- Clicking a row in the popover calls the existing
  `scrollToMessage` helper with the correct id.

### Regression tests

`src/__tests__/subagent-regressions.test.tsx`

- After a bridge respawn, all previously-running subagents flip to
  `done` and eventually auto-collapse.
- After a global Stop (`result` with interrupt subtype), every
  running subagent flips to `done`.
- A subagent that finishes with no `lastReply` renders the
  `— no output —` placeholder in `ExpandedSubagent`.

### Manual / e2e

A short Playwright smoke test that dispatches a parallel Task call,
waits for ≥2 subagents to appear in the list, asserts the masthead
chip count matches, and verifies the auto-collapse behavior after
done.

## §5 · Out of scope (re-iterated)

- Per-subagent interrupt button
- Live streaming preview in the compact row
- Workspace-level / cross-session aggregation
- Sending side-messages to a running subagent
- Persisting collapsed/expanded preference across reloads
- Notifications / sound on subagent completion

## §6 · Open questions

None blocking. Two implementation-time clarifications to confirm in
the writing-plans pass:

1. Exact file where `Task` tool_use blocks render today
   (`ExecToolBlock.tsx`, or another block component). Verify before
   adding the plug-in point.
2. Whether `ExpandedViewModal` accepts arbitrary content props as
   it stands, or needs a small contract change to host a
   transcript-shaped payload.
