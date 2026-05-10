# Performance Audit & Optimization — Implementation Plan

**Date:** 2026-05-10
**Spec:** `docs/superpowers/specs/2026-05-10-perf-audit-design.md`
**Baseline:** 171 test files, 3235 tests passing in 8.52s; `tsc --noEmit` clean.

## Triage of audit findings

54 findings total (27 DB + 27 Agent). Landing all in one session is unsafe — too many semantic changes interact. We split into tiers.

**Tier 1 (this session, parallel TDD):** isolated, low-risk, high-impact, well-covered by existing tests. 13 logical changes.

**Tier 2 (deferred):** medium risk, semantic changes, schema migrations, cross-cutting refactors. Documented for a follow-up round.

---

## Tier 1 — DB (work scope: `src-tauri/src/db/mod.rs` + `src-tauri/src/workspace/mod.rs`)

| # | ID | Title | Why safe | Test strategy |
|---|----|-------|----------|---------------|
| D1 | **DB-01** | Add PRAGMAs (synchronous=NORMAL, temp_store, mmap_size, cache_size, busy_timeout) | Single-line in `Database::new`; no API change | Existing 3235 tests must still pass; add unit test asserting PRAGMA values via `pragma_query` |
| D2 | **DB-08+09+10+11** | Add 4 missing indexes (`sessions`, `token_usage`, `session_realms`, `command_patterns`) | `CREATE INDEX IF NOT EXISTS` is idempotent and never observable | Existing tests pass; add `EXPLAIN QUERY PLAN` assertion test for one query that should now use the new index |
| D3 | **DB-02** | Convert `conn.prepare(...)` → `conn.prepare_cached(...)` across `db/mod.rs` (mechanical sweep) | Same `Statement` API surface; the cache is interior-mutable | All existing tests cover correctness; add micro-benchmark unit test that calls `get_setting` 1000× and asserts wall-time improvement |
| D4 | **DB-13** | Wrap workspace bulk upsert (`scan_directory` → `upsert_project`) in a transaction via new `upsert_projects_bulk` helper | Adds a new method, doesn't change existing | Existing scan tests; add unit test for the new bulk fn |

**Files touched:** `src-tauri/src/db/mod.rs`, `src-tauri/src/workspace/mod.rs`.

---

## Tier 1 — Agent (work scope: `src/agent/`, `src/state/SessionContext.tsx` (only callbacks), `src/agent/blocks/`, `src/styles/`, `src-tauri/src/agent/mod.rs` (AGENT-23 only))

| # | ID | Title | Why safe | Test strategy |
|---|----|-------|----------|---------------|
| A1 | **AGENT-09** | Replace `assignTurnNumbers` O(N²) `out.some(...)` with O(N) `Set` | Pure algorithm rewrite, identical output | Snapshot-equal test: replay a fixture, assert output array deep-equals current |
| A2 | **AGENT-12** | Memoize `computeDiff` + wrap `FileToolBlock` body in `useMemo` | Cache; same output | Existing diff snapshot tests; add render-counter test asserting `computeDiff` runs once per (before,after) |
| A3 | **AGENT-19** | `memo()` `AgentHeader` (shallow equal) | Pure render optimization | Render-counter test on AgentHeader during a stream |
| A4 | **AGENT-20** | `ThinkingBlock`: 100ms tick while elapsed<10s, then 1Hz | Formatter only shows integer seconds after 10s, so output identical | Snapshot test against fixed clock |
| A5 | **AGENT-21** | Pass `resultForBlock` (single tool result) into `BlockRenderer` instead of whole `toolResults` Map | Same data, narrower prop | Existing fixture tests; add render-counter test asserting only one ToolUseBlock re-renders on a tool_result event |
| A6 | **AGENT-25** | Add `content-visibility: auto; contain: layout style; contain-intrinsic-size: 200px 800px;` to `.agent-message` | CSS-only, native browser feature | Existing visual snapshots; add e2e check |
| A7 | **AGENT-23** | Replace `from_utf8_lossy(...).into_owned()` with `String::from_utf8(mem::take(buf))` + lossy fallback | Same final string for valid UTF-8 (vast majority); identical for invalid via fallback | Existing `read_bounded_line` tests + add a multi-byte UTF-8 line test |
| A8 | **AGENT-13** | `SmartOutput`: only attempt JSON parse when result is final (`isFinal` prop, parent passes `result !== undefined`) | Reduces work mid-stream; final render is identical | Existing parse tests + assert no parse during streaming via spy |
| A9 | **AGENT-15** | `_capStderr` ring-buffer of chunks; concat at read time | Same final string returned to consumers | Existing cap test; add a test pumping many chunks asserting final length and content unchanged |
| A10 | **AGENT-05** | rAF-coalesce auto-scroll in `AgentSessionView` | Final scrollTop equals scrollHeight under sticky-bottom; 1 layout per frame instead of per event | Behavioral test — assert eventually `scrollTop === scrollHeight` after a burst |
| A11 | **AGENT-18** | IME composition handling on composer textarea | While composing, skip dispatch+overlay; flush on `compositionend` | Test simulates compositionstart→input→compositionend; assert exactly one dispatch |

**Files touched:**
- `src/agent/AgentSessionView.tsx`
- `src/agent/blocks/FileToolBlock.tsx`
- `src/agent/blocks/ThinkingBlock.tsx`
- `src/agent/blocks/SmartOutput.tsx`
- `src/agent/agentSessionStore.ts` (AGENT-15 only)
- `src/agent/messageStore.ts` (read for AGENT-09 if helper lives here)
- `src/components/SessionComposer.tsx` (AGENT-18 only)
- `src/styles/components/AgentMessage.css` (or equivalent — A6)
- `src-tauri/src/agent/mod.rs` (AGENT-23 only — line 584-611 area)

---

## Deferred to Tier 2 (documented, not landing this session)

- **DB:** DB-03 (multi-update in `update_project_scan`), DB-04..07 (N+1 fixes — adds new bulk helpers, several callsites), DB-14/15/16 (transaction wrapping shutdown paths — depends on DB-16 ON CONFLICT semantic switch), DB-17 (`scrollback_preview` schema migration), DB-18, DB-19, DB-20, DB-21, DB-22, DB-23, DB-26 (versioned migrations).
- **Agent:** AGENT-01..04 (reducer rewrite — high blast radius), AGENT-06 (MessageRow memo + per-row prop bundle — touches 4 components), AGENT-07/08 (move derived state into reducer — needs careful audit), AGENT-10/11 (`useDeferredValue` for streaming markdown/highlight), AGENT-14 (store slice-aware subscriptions — touches store contract), AGENT-16/17 (SessionContext split + composer local state — cross-cutting), AGENT-22 (Rust IPC RawValue — needs a Tauri serialization audit), AGENT-24 (per-session stdin lock), AGENT-26/27.

---

## Execution order

1. Two parallel implementation agents (DB + Agent), each TDD.
2. Each agent reports completion with: files changed, tests added, all-tests-pass evidence.
3. Main session runs the unified verification suite:
   - `npx tsc --noEmit` — must equal baseline (clean)
   - `npm run test` — must equal baseline (3235 passing)
   - `cd src-tauri && cargo test --lib` — must pass
   - `cd src-tauri && cargo clippy --all-targets -- -D warnings` — must pass
4. Launch `npm run tauri dev` in background.
5. Provide manual test checklist to user.

## Rollback plan

Every change is in the working tree (uncommitted). If verification fails, `git diff` shows exactly what changed; user can `git restore` per-file or per-hunk.
