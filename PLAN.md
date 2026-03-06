# Multi-Session Git Architecture Plan

## Problem Statement

Currently, Hermes IDE's git integration is **global** -- the Git panel sits at the same level as the session list, and all sessions pointing to the same repo share one working tree, one index, one branch. This means:

- Two sessions on the same repo **cannot work on different branches simultaneously**
- Staging/unstaging in one session **silently affects** the other
- There's no visual clarity about which session "owns" which git state
- The Git panel doesn't know which session it belongs to

## Solution: Git Worktrees as Session Isolation

Each session gets its own **git worktree** -- an independent checkout of the same repo with its own branch, index, and working directory. The shared `.git` object store means no duplication of history. The worktree mechanism is **invisible to the user** -- they think in terms of sessions and branches, never worktrees.

---

## Architecture Overview

```
                          +--------------------------+
                          |   REPO: my-project       |
                          |   .git/ (shared store)   |
                          +------+-------+-----------+
                                 |       |
                  +--------------+       +--------------+
                  |                                      |
     +------------v-----------+          +---------------v----------+
     | Session 1              |          | Session 2                |
     | Branch: main           |          | Branch: feature/auth     |
     | Path: /my-project      |          | Path: .hermes/worktrees/ |
     | (main worktree)        |          |   a1b2c3d4_feature-auth  |
     |                        |          |                          |
     | [Terminal] [Git] [Files]|         | [Terminal] [Git] [Files] |
     +------------------------+          +--------------------------+

     Each session pane has its own tab bar.
     Git tab is scoped to the session's branch/worktree.
     Sidebar Git tab becomes the Repo Overview (bird's eye view).
```

### Key Design Principles

- **"A session IS a branch"** -- branch is as prominent as session name
- **Zero worktree jargon** in user-facing UI (no "worktree", "linked", "main worktree")
- The git worktree mechanism is **invisible** to the user
- Branch conflicts show **which session** is using a branch, not just "in use"

---

## Completed Work

### Phase 1: Data Model  [DONE]

- `session_worktrees` table created in SQLite with session/realm/branch tracking
- `worktree_id` foreign key added to `session_realms`
- Rust types `SessionWorktree` and `WorktreeInfo` defined
- DB migration and backfill logic for existing sessions

### Phase 2: Backend Worktree Manager  [DONE]

- New module `src-tauri/src/git/worktree.rs` implemented
- Core functions: `create_session_worktree`, `remove_session_worktree`, `list_repo_worktrees`, `is_branch_available`, `switch_worktree_branch`
- Worktree path convention: `.hermes/worktrees/{session_id_first_8}_{branch}/`
- Auto-adds `.hermes/worktrees/` to `.gitignore` on first creation
- Session lifecycle integration (create, destroy, reopen)

### Phase 3: Refactored Git Operations  [DONE]

- All git IPC commands refactored from `project_path` to `session_id + realm_id`
- Backend resolves the correct worktree path internally
- Branch checkout validation prevents two sessions from sharing a branch
- Stash scoping via `[hermes:{session_id_short}]` message prefix
- Git status computed per-session using each session's worktree path

### Phase 8: New IPC Commands  [DONE]

- `git_create_worktree(session_id, realm_id, branch_name?, create_branch?)`
- `git_remove_worktree(session_id, realm_id)`
- `git_list_worktrees(realm_id)`
- `git_check_branch_available(realm_id, branch_name)`
- `git_session_worktree_info(session_id, realm_id)`
- All registered in `src-tauri/src/lib.rs`

### Phase 9: Event System  [DONE]

- New events: `worktree-created-{realm_id}`, `worktree-removed-{realm_id}`, `branch-locked-{realm_id}`, `branch-unlocked-{realm_id}`
- Modified events: `session-updated` now includes worktree_path and branch_name
- Per-session git status change notifications: `git-status-changed-{session_id}`

### Frontend API & Types  [DONE]

- `src/api/git.ts` updated -- all calls pass session context instead of project path
- `src/types/git.ts` -- new worktree-related types
- `src/types/session.ts` -- session type includes worktree info

---

## Tier 1: Session-Aware Git UI  [IN PROGRESS]

Contextual git information surfaces in the existing UI without rearranging panels.

### Task 1: useSessionGitSummary Hook + SessionList Branch Display

Create a `useSessionGitSummary(sessionId)` hook that returns `{ branch, changeCount, ahead, behind }` by listening to the per-session git status events. Each session item in the SessionList gains a third line:

```
+--------------------------------------+
| (color dot) My Session          x    |
|   my-project                         |
|   (branch icon) main  3 changes     |  <-- NEW third line
+--------------------------------------+
```

### Task 2: Git Panel Session Identity Header

The Git panel header shows whose state is being displayed:

```
+----------------------------------------------+
| (session color dot) My Session  |  main      |
+----------------------------------------------+
|  Staged (2)                                   |
|  ...                                          |
```

This eliminates ambiguity when the user switches between sessions.

### Task 3: Jargon Cleanup Across Components

Audit all user-facing strings and remove worktree terminology:

| Before | After |
|---|---|
| "main worktree" | (no label, or "primary") |
| "linked worktree" | (no label) |
| "worktree" anywhere in UI | "branch" or "session" |
| "Branch X is checked out in another worktree" | "Branch X is in use by Session Y" |

### Task 4: Repo Overview as Sidebar Git Tab

The sidebar Git tab transforms into a Repo Overview -- a bird's eye view across all sessions:

```
+-- Repo Overview: my-project ----------------+
|                                              |
|  (dot) Session 1  ---  main       2 changes |
|  (dot) Session 2  ---  feature/auth  clean  |
|  (dot) Session 3  ---  fix/bug-123   1 chg  |
|                                              |
|  Available branches:                         |
|  develop, release/v2, hotfix/login           |
|                                              |
|  [+ New Session on Branch...]                |
+----------------------------------------------+
```

---

## Tier 2: Per-Session Tab System  [IN PROGRESS]

Git moves physically into each session pane, so switching sessions naturally switches git context.

### Task 5: SessionPaneTabs Component

New component that renders a tab bar inside each session's pane area:

```
[Terminal]  [Git]  [Files]
```

- Tabs are lightweight toggles (no routing, just conditional rendering)
- Terminal tab stays mounted when switching to Git/Files (preserves PTY state)
- Active tab indicated by accent color matching the session color

### Task 6: SplitPane Integration

Modify `SplitPane` to include the `SessionPaneTabs` bar above or below the terminal:

```
+-- Session Pane (SplitPane) -----------------+
| [Terminal]  [Git]  [Files]                   |  <-- tab bar
+----------------------------------------------+
|                                              |
|  (active tab content here)                   |
|                                              |
+----------------------------------------------+
```

### Task 7: Move Git/Files Into Session Tabs

- The Git tab renders the existing `GitPanel` but scoped to the session's worktree
- The Files tab renders a file explorer rooted at the session's worktree path
- The sidebar Git tab becomes exclusively the Repo Overview (from Task 4)
- Remove the global git panel toggle from `SessionContext`

### Task 8: Top Bar Branch Context

The application top bar shows the active session's identity:

```
+-- Top Bar -----------------------------------+
| (color dot) My Session  |  (branch) main     |
+----------------------------------------------+
```

This persists even when the user is in the Terminal tab, providing constant branch awareness.

---

## Tier 3: Cross-Session Operations  [PLANNED]

Future capabilities that leverage the multi-worktree architecture.

- **Compare branches between sessions** -- side-by-side diff of files across two session branches
- **Cherry-pick between sessions** -- pick commits from one session's branch into another
- **Cross-session notifications** -- "Session 2 pushed to feature/auth" appears in Session 1
- **Drag-and-drop commits** -- drag a commit from one session's history into another to cherry-pick
- **Session creation from branch** -- right-click a branch anywhere to "Open in New Session"
- **Shared worktree mode** -- escape hatch allowing two sessions on the same branch with explicit warning

---

## Key Constraints & Decisions

| Constraint | Decision |
|---|---|
| Two worktrees can't share a branch | Enforce at UI + backend; show which session owns the branch |
| Stashes are global in git | Tag with session prefix `[hermes:{id}]` to scope per session |
| Main worktree can't be removed | Track ownership; reassign when session closes |
| Disk space for worktrees | Lazy creation; show usage in settings; auto-cleanup on close |
| git2-rs worktree API | Use `Repository::worktree_add()`, `find_worktree()`, `is_worktree()` |
| Worktree path convention | `.hermes/worktrees/{session_short_id}_{branch}/` |
| User-facing terminology | Never expose "worktree" -- use "branch" and "session" exclusively |
| Terminal working directory | Linked worktree sessions start in the worktree path, not repo root |
| Session close with dirty state | Prompt: stash and close / keep worktree / discard and remove |
| Stale worktree cleanup | On app startup, prune orphaned worktrees not in `session_worktrees` table |

---

## Files Created/Modified

### Backend (Rust) -- DONE

| File | Status | Description |
|---|---|---|
| `src-tauri/src/git/worktree.rs` | Created | Worktree manager (create, remove, list, branch validation) |
| `src-tauri/src/git/mod.rs` | Modified | All git IPC commands refactored to session_id + realm_id |
| `src-tauri/src/db/mod.rs` | Modified | `session_worktrees` table, queries, migration |
| `src-tauri/src/lib.rs` | Modified | New IPC command registrations |

### Frontend (TypeScript) -- API layer DONE, UI in progress

| File | Status | Description |
|---|---|---|
| `src/api/git.ts` | Modified | All API calls pass session context |
| `src/types/git.ts` | Modified | Worktree-related types added |
| `src/types/session.ts` | Modified | Session type includes worktree info |
| `src/hooks/useSessionGitSummary.ts` | Planned | Per-session branch/change summary hook |
| `src/components/SessionPaneTabs.tsx` | Planned | Tab bar component for session panes |
| `src/components/RepoOverview.tsx` | Planned | Bird's eye cross-session repo view |
| `src/components/SessionList.tsx` | To modify | Add branch + change count third line |
| `src/components/GitPanel.tsx` | To modify | Add session identity header |
| `src/components/SplitPane.tsx` | To modify | Integrate session tab bar |
| `src/state/SessionContext.tsx` | To modify | Remove global git panel toggle |
