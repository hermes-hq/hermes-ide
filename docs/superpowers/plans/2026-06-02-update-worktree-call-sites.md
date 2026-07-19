# Implementation Report: Configurable Git Worktree Base Paths

**Status:** Completed
**Date:** 2026-06-02

## Goal
Enable users to configure the base directory where Hermes creates Git worktrees. This supports scenarios where users want worktrees on a specific fast disk, outside of the default app data directory, or organized per-project.

## Architecture & Implementation

### 1. Multi-Level Configuration Hierarchy
Hermes now resolves the worktree base path using a prioritized hierarchy:
1.  **Session Level**: Optional override provided during session creation in the `SessionCreator`.
2.  **Project Level**: Default base path set for a specific project in the `ProjectPicker`.
3.  **Global Level**: Application-wide setting `worktree_base_path` in the database.
4.  **System Default**: Fallback to the standard app data directory.

### 2. Backend Changes (Rust/Tauri)
- **Database Schema**: Added `worktree_base_path` column to `projects`, `realms`, and `sessions` tables via idempotent migrations in `src-tauri/src/db/mod.rs`.
- **Core Logic**: Updated `src-tauri/src/git/worktree.rs` and `src-tauri/src/git/journal.rs` to accept an optional `custom_base` path.
- **IPC Commands**: Modified `git_create_worktree` and related commands in `src-tauri/src/git/mod.rs` to fetch and resolve the base path according to the hierarchy.
- **Startup Cleanup**: Updated `src-tauri/src/lib.rs` to ensure stale worktrees are cleaned up from both default and custom locations.

### 3. Frontend Changes (TypeScript/React)
- **Settings UI**: Added a "Worktree Base Path" setting in the Git tab of `Settings.tsx` with a directory picker.
- **Project Picker**: Added a settings icon to project items in `ProjectPicker.tsx` that reveals an inline editor for the per-project worktree path.
- **Session Creator**: Added an "Advanced" optional field in the confirmation step of `SessionCreator.tsx` for session-specific overrides.
- **API Layers**: Updated `src/api/git.ts`, `src/api/projects.ts`, and `src/api/sessions.ts` to support passing the new path parameter.

## Verification Results
- **Type Safety**: `npx tsc --noEmit` passes with no errors.
- **Unit Tests**: Updated mocks in `src/__tests__` to account for the new `worktreeBasePath` parameter. All 3542 tests pass.
- **Migrations**: Database migrations verified to be idempotent and safe for existing data.
