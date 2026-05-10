# Performance Audit & Optimization — Design

**Date:** 2026-05-10
**Status:** Approved (user: end-to-end execution)
**Scope:** SQLite queries (`src-tauri/src/db/mod.rs`) + Agent-mode hot path (stream reducer + message-list rendering)

## Goal

Make Hermes IDE faster on two surfaces without introducing regressions. Every fix must be gated behind a test that captures the observable behavior so we can prove the optimization is safe.

## Non-Goals

- Optimizing PTY/Terminal mode throughput (separate round)
- Optimizing startup / bundle size (separate round)
- Refactoring unrelated code

## Architecture

Two phases.

### Phase 1 — Parallel specialist audits (read-only)

| Agent | Scope | Deliverable |
|---|---|---|
| **DB specialist** | `src-tauri/src/db/mod.rs` (3,501 LOC, ~138 SQL stmts), schema, callers | Findings report |
| **Agent-mode specialist** | `src-tauri/src/agent/`, `src/agent/`, `SessionComposer.tsx`, message-list components, stream reducer | Findings report |

No code changes during this phase.

### Phase 2 — TDD implementation (this session, parallel where safe)

For each approved finding, an implementation agent:

1. Writes a regression test capturing observable behavior
2. Adds a micro-benchmark or query EXPLAIN before
3. Implements the fix
4. Verifies benchmark improves AND every test still passes
5. Commits (one fix = one logical commit, but the user does the actual `git commit`)

## Finding schema (every finding follows this)

```
ID: <surface>-<num>     (e.g., DB-01, AGENT-03)
File: <path:line-range>
Title: <short>
Issue: <what is slow / wasteful / wrong, with measurement or argument>
Big-O before: <O(n) etc.>
Big-O after: <O(n) etc.>
Risk: low | medium | high
Fix: <code excerpt>
Test: <how we prove no regression>
Benchmark: <how we prove the win>
```

## Safety bar (aggressive: fix everything found, gated behind tests)

| Gate | Command |
|---|---|
| Type check | `npx tsc --noEmit` |
| Unit + integration | `npm run test` |
| Rust lints | `cargo clippy --all-targets -- -D warnings` |
| Final smoke | `npm run tauri dev` (background, user drives UI) |

Manual test plan provided to user before launch.

## Risk Mitigations

- **Schema changes** (indexes, etc.) tested with both directions: cold open of an existing DB (migration path) and fresh install.
- **Rendering changes** validated with the existing Agent-mode regression suite (24 bug fixes already covered) and a new test per fix.
- **Reducer changes** validated by reducer unit tests with synthetic event streams.
- **No semantic changes** — every fix preserves observable behavior.

## Components Produced

- This design doc (`docs/superpowers/specs/2026-05-10-perf-audit-design.md`)
- Audit reports (in chat, summarized in plan)
- Implementation plan (`docs/superpowers/plans/2026-05-10-perf-audit-plan.md`)
- Code changes (one logical chunk per fix)
- Manual test checklist (in chat)

## Out of Scope for Regressions

We accept the following as not regressions:
- Tiny render-time microsecond differences that don't affect FPS
- Changes in internal data-structure identity (as long as observable output equals)
- Changes in SQL plan as long as result rows + ordering match
