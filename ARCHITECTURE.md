# Hermes IDE — Architecture Guide

This document describes the internal architecture of Hermes IDE for contributors who want to understand the codebase before diving into code. It covers the frontend and backend structure, data flow, and key design decisions.

## Overview

Hermes IDE is a desktop application built on [Tauri 2](https://tauri.app). The frontend is a React + TypeScript single-page application rendered in a platform-native webview. The backend is a Rust process that manages PTY sessions, an embedded SQLite database, git operations, and project scanning.

```
┌──────────────────────────────────────────────────────┐
│                  React Frontend                       │
│          (TypeScript, Vite, xterm.js)                 │
│                                                       │
│  ┌────────┐  ┌───────────┐  ┌──────────────────────┐ │
│  │  State  │  │ Components│  │  Terminal Pool       │ │
│  │ Context │  │  (50+)    │  │  (xterm + WebGL)     │ │
│  └────┬───┘  └─────┬─────┘  └──────────┬───────────┘ │
│       │            │                    │              │
│  ┌────┴────────────┴────────────────────┴───────────┐ │
│  │            API Layer (src/api/)                   │ │
│  │        Typed wrappers around invoke()             │ │
│  └──────────────────────┬───────────────────────────┘ │
├─────────────────────────┼────────────────────────────-┤
│              Tauri IPC Bridge                         │
│     (async commands, events, type-safe payloads)      │
├─────────────────────────┼────────────────────────────-┤
│                  Rust Backend                         │
│                                                       │
│  ┌──────────┐  ┌──────┐  ┌───────┐  ┌─────────────┐ │
│  │   PTY    │  │  DB  │  │  Git  │  │  Project    │ │
│  │ Manager  │  │SQLite│  │(git2) │  │  (Scanner)  │ │
│  └──────────┘  └──────┘  └───────┘  └─────────────┘ │
└──────────────────────────────────────────────────────┘
```

Communication between frontend and backend uses Tauri's IPC mechanism: the frontend calls `invoke("command_name", { args })` which maps to a Rust function annotated with `#[tauri::command]`. The backend can also push events to the frontend via `app.emit("event-name", payload)`, which the frontend listens to with `listen("event-name", callback)`.

---

## Glossary

These are domain-specific terms used throughout the codebase:

| Term | Definition |
|------|-----------|
| **Project** | A registered project directory. Projects are scanned to discover structure, languages, and frameworks. They provide context to AI agents working in terminal sessions. Internally stored in the `realms` table. |
| **Cartography** | The process of scanning a project directory to discover its structure. There are three scan depths: **surface** (marker files, < 2s), **deep** (config files + architecture detection, < 30s), and **full** (import analysis + entry points, minutes). See `src-tauri/src/project/cartography.rs`. |
| **Attunement** | The process of assembling project context from one or more projects into a token-budgeted Markdown document that gets written to disk and injected into AI agent sessions. See `src-tauri/src/project/attunement.rs`. |
| **Session** | A terminal session backed by a PTY (pseudo-terminal) process. Each session has a unique ID, a color, a working directory, and lifecycle state. Sessions can have AI agents (Claude Code, Aider, Codex, Gemini) running inside them. |
| **SessionPhase** | The lifecycle state of a session. The state machine is: `Creating` -> `Initializing` -> `ShellReady` -> `LaunchingAgent` -> `Idle` / `Busy` / `NeedsInput` -> `Closing` -> `Destroyed`. Defined in `src-tauri/src/pty/mod.rs`. |
| **Ghost Text** | Inline command suggestions rendered as semi-transparent overlaid text in the terminal. When the user presses Tab, the ghost text is accepted and written to the PTY. Managed by the `TerminalPool`. |
| **Execution Node** | A tracked command execution stored in the database. Records the command input, output summary, exit code, working directory, and duration. Displayed in the Execution Timeline. |
| **Provider Adapter** | A strategy pattern implementation in the backend for detecting and parsing output from different AI CLI tools (Claude Code, Aider, Gemini CLI, Codex). Each adapter knows how to detect agent startup, parse token usage, identify tool calls, and recognize prompts. See the `ProviderAdapter` trait in `src-tauri/src/pty/mod.rs`. |
| **Output Analyzer** | A per-session component that processes raw PTY output through the Provider Adapter registry. It strips ANSI sequences, detects the active AI provider, tracks token usage, and determines phase transitions. See `OutputAnalyzer` in `src-tauri/src/pty/mod.rs`. |
| **Context Pin** | A file, directory, or text snippet pinned to a session or project. Pinned files have their content included in the assembled context document. Stored in the `context_pins` table. |
| **Intent Command** | A colon-prefixed shortcut (e.g., `:test`, `:diff`) that the frontend resolves to an actual shell command before sending it to the PTY. See `src/terminal/intentCommands.ts`. |
| **Injection Lock** | A per-session mutex in the frontend state that prevents concurrent context injections into the same terminal. Ensures that context nudges don't race with user input. |
| **Nudge** | A lightweight write to the PTY that tells the AI agent to re-read its context file. Sent when project context changes (e.g., a project is re-scanned or a pin is added). |
| **Flow Mode** | A minimal UI mode that hides the sidebar and activity bars, leaving only the terminal and a floating toast. Toggled via the Command Palette. |

---

## Frontend Architecture

**Stack:** React 18, TypeScript 5.6, Vite, xterm.js (with WebGL addon)

### Entry Point

The app boots from `src/main.tsx` -> `src/App.tsx`. `App` wraps everything in an `ErrorBoundary` and a `SessionProvider` (the central state manager). `AppContent` renders the full UI: top bar, activity bars, sidebar, main terminal area, context panel, and all modal dialogs.

### State Management

All application state flows through a single React Context + `useReducer` pattern in `src/state/SessionContext.tsx`.

**Key types:**
- `SessionState` — the full state tree: sessions map, active session, layout, UI toggles
- `SessionAction` — a discriminated union of ~35 action types (defined in `src/types/session.ts`)
- `sessionReducer` — a pure function that handles all state transitions

**The SessionProvider** (`src/state/SessionContext.tsx`) does more than just hold state. On mount, it:
1. Initializes notifications and analytics
2. Loads settings and applies the theme
3. Restores sessions from the previous workspace (if configured)
4. Sets up Tauri event listeners for `session-updated`, `session-removed`, and `session-projects-changed`
5. Starts a periodic auto-save (every 10 seconds)

**Derived hooks** provide memoized slices of state:
- `useActiveSession()` — the currently focused session
- `useSessionList()` — all sessions as an array
- `useTotalCost()` / `useTotalTokens()` — aggregated metrics

### Layout System

The pane layout uses a binary tree data structure defined in `src/state/layoutTypes.ts`:

- `PaneLeaf` — a terminal pane displaying one session
- `SplitNode` — a horizontal or vertical split with two children and a ratio (0.0-1.0)
- `LayoutNode` — a union of `PaneLeaf | SplitNode`

Tree operations (`replaceNode`, `removePane`, `collectPanes`, `setPaneSession`, `removePanesBySession`) are all pure functions that return new trees. The reducer manages layout through actions like `SPLIT_PANE`, `CLOSE_PANE`, `FOCUS_PANE`, and `RESIZE_SPLIT`.

### Component Organization

All components live in `src/components/` as flat files (no nesting). Each component has a corresponding CSS file in `src/styles/components/`. There are 50+ components covering:

- **Terminal:** `TerminalPane.tsx`, `SplitLayout.tsx`, `SplitPane.tsx`, `SplitDivider.tsx`
- **Session management:** `SessionList.tsx`, `SessionCreator.tsx`, `SessionPaneTabs.tsx`
- **Git:** `GitPanel.tsx`, `SessionGitPanel.tsx`, `GitDiffView.tsx`, `GitLogView.tsx`, `GitBranchSelector.tsx`, `GitConflictViewer.tsx`, `GitMergeBanner.tsx`, `GitStashSection.tsx`
- **AI / Context:** `ContextPanel.tsx`, `ContextPreview.tsx`, `PromptComposer.tsx`, `ProviderActionsBar.tsx`, `RoleSelector.tsx`, `StyleSelector.tsx`
- **Navigation:** `CommandPalette.tsx`, `ActivityBar.tsx`, `StatusBar.tsx`
- **Settings & Info:** `Settings.tsx`, `CostDashboard.tsx`, `ShortcutsPanel.tsx`, `OnboardingWizard.tsx`, `WhatsNewDialog.tsx`, `UpdateDialog.tsx`
- **Workspace:** `WorkspacePanel.tsx`, `ProjectPicker.tsx`, `FileExplorerPanel.tsx`, `SearchPanel.tsx`, `ProcessPanel.tsx`

### Terminal Rendering

Terminal rendering is managed by a **module-level pool** in `src/terminal/TerminalPool.ts`, not by React components. This is a deliberate design choice (see [Key Design Decisions](#key-design-decisions)).

The pool maintains a `Map<string, PoolEntry>` where each entry contains:
- An xterm.js `Terminal` instance with `FitAddon`, `WebLinksAddon`, and `WebglAddon`
- Tauri event listeners for PTY output (`session-output-{id}`) and process exit
- Ghost text state and overlay DOM elements
- Intelligence state: input buffer, suggestion timer, history provider, shell environment info

Key pool functions:
- `createTerminal(sessionId, color)` — creates a terminal instance, sets up key handlers and event listeners
- `attach(sessionId, container)` / `detach(sessionId)` — mounts/unmounts a terminal to/from a DOM element
- `destroy(sessionId)` — tears down listeners and removes the entry from the pool
- `focusTerminal(sessionId)` — gives keyboard focus to a terminal
- `writeScrollback(sessionId, content)` — restores saved terminal content on session restore

### Intelligence Engine

The `src/terminal/intelligence/` directory contains the client-side suggestion system:

- **`shellEnvironment.ts`** — detects the user's shell type and plugins (zsh, bash, fish), determines whether to show ghost text or overlay suggestions (e.g., fish has native autosuggestions)
- **`contextAnalyzer.ts`** — detects project context (package manager, languages, frameworks) for the current working directory, used to boost relevance of suggestions
- **`historyProvider.ts`** — provides command history matching (both shell history and per-session history)
- **`suggestionEngine.ts`** — the core scoring algorithm. Combines history matches, static command index matches, and context relevance into a ranked list of suggestions. Target: < 5ms per invocation.
- **`commandIndex.ts`** — a static index of common commands with metadata (description, category, arguments)
- **`SuggestionOverlay.tsx`** — a React component that renders the dropdown suggestion panel below the cursor

### CSS Architecture

Styles are organized as:
- `src/styles/tokens.css` — design tokens (colors, spacing, fonts, border-radius) used as CSS custom properties
- `src/styles/themes.css` — theme definitions that override tokens (e.g., `tron`, `dimmed`, `hacker`)
- `src/styles/base.css` — global resets and base styles
- `src/styles/layout.css` — the main app layout (grid, flexbox structure)
- `src/styles/topbar.css` — top bar styles (window drag region, traffic light spacer)
- `src/styles/components/*.css` — one CSS file per component, co-located by name

There is no CSS-in-JS. Theming works by swapping CSS custom property values via the `themeManager.ts` utility.

### API Layer

`src/api/` contains typed TypeScript wrappers around Tauri's `invoke()` function. Each file maps to a backend module:

| File | Backend Module | Purpose |
|------|---------------|---------|
| `sessions.ts` | `pty` | Create, close, resize, write to sessions |
| `projects.ts` | `project` | CRUD for projects, attach/detach to sessions, trigger scans |
| `context.ts` | `project::attunement` | Context pins, context assembly, config loading |
| `git.ts` | `git` | Status, stage, commit, push, pull, branches, stash, merge, worktrees, search |
| `intelligence.ts` | `pty` | Shell environment detection, command history |
| `processes.ts` | `process` | System process listing and management |
| `settings.ts` | `db` | Key-value settings persistence |
| `costs.ts` | `db` | Token usage and cost history |
| `memory.ts` | `db` | Persistent memory (session, project, global scopes) |
| `execution.ts` | `db` | Execution node queries |
| `menu.ts` | `menu` | Native context menu and menu state sync |
| `clipboard.ts` | `clipboard` | Image clipboard operations |

### Custom Hooks

`src/hooks/` contains reusable hooks:

| Hook | Purpose |
|------|---------|
| `useGitStatus` | Polls `git_status` IPC command at a configurable interval. Returns status, error, and a manual refresh function. |
| `useProcesses` | Polls the system process list for the Process Panel. |
| `useFileTree` | Manages file tree state for the File Explorer. |
| `useContextState` | Manages context panel state (pins, memory, Project info). |
| `useSessionProjects` | Listens for `session-projects-updated-{id}` events and provides the session's attached projects. |
| `useSessionGitSummary` | Lightweight git summary (branch name, change count) for the top bar. |
| `useAutoUpdater` | Manages the Tauri auto-update lifecycle (check, download, install). |
| `useContextMenu` | Provides right-click context menu via native Tauri menus. |
| `useTextContextMenu` | Standard cut/copy/paste context menu for text inputs. |
| `useNativeMenuEvents` | Bridges native menu bar events to React dispatch actions. |
| `useMenuStateSync` | Syncs React UI state (sidebar open, panels open) to native menu checkmarks. |
| `useWorktreeEvents` | Listens for git worktree change events. |

---

## Backend Architecture

**Stack:** Rust (2021 edition), Tauri 2, SQLite (via rusqlite), libgit2 (via git2 crate), portable-pty, sysinfo, walkdir

### Module Structure

```
src-tauri/src/
├── lib.rs          # App setup, plugin registration, IPC handler registration, AppState
├── main.rs         # Entry point (calls lib::run)
├── pty/
│   └── mod.rs      # PTY session lifecycle, output analysis, provider adapters
├── db/
│   └── mod.rs      # SQLite database, migrations, all persistence queries
├── project/
│   ├── mod.rs      # Project CRUD, IPC commands
│   ├── cartography.rs  # Project scanning (surface, deep, full)
│   └── attunement.rs   # Context assembly, Markdown formatting, context file I/O
├── git/
│   ├── mod.rs      # Git operations (status, stage, commit, push, pull, branches, merge, search)
│   └── worktree.rs # Git worktree management (create, remove, prune)
├── process/
│   └── mod.rs      # System process listing, kill, protected process detection
├── workspace/
│   └── mod.rs      # Directory scanning and project auto-detection
├── menu/           # Native menu bar construction and event handling
├── clipboard.rs    # Image clipboard support
└── platform.rs     # Platform-specific helpers (macOS, Windows, Linux)
```

### AppState

The shared application state is a struct with three mutex-protected fields:

```rust
pub struct AppState {
    pub db: Mutex<Database>,
    pub pty_manager: Mutex<PtyManager>,
    pub sys: Mutex<sysinfo::System>,
}
```

All IPC commands receive `State<'_, AppState>` and lock the specific mutex they need.

### PTY Management

The PTY module (`src-tauri/src/pty/mod.rs`) is the largest file in the backend (~2700 lines). It handles:

**Session lifecycle:**
1. `create_session` creates a new PTY using `portable-pty`, spawns the user's default shell, and starts a reader thread
2. The reader thread reads raw output, strips ANSI for analysis, and emits `session-output-{id}` events to the frontend
3. The `OutputAnalyzer` processes each chunk through the `ProviderAdapter` registry to detect AI agents, track token usage, and determine phase transitions
4. Phase changes are emitted as `session-updated` events
5. `close_session` sends SIGHUP to the PTY process, waits briefly, then emits `session-removed`

**The Phase State Machine:**
```
Creating ──> Initializing ──> ShellReady ──> LaunchingAgent
                                                   │
                                                   ▼
                                    ┌──── Idle ◄──── Busy
                                    │       ▲          │
                                    │       └──────────┘
                                    │              │
                                    │       NeedsInput
                                    │
                                    ▼
                                 Closing ──> Destroyed
```

**Provider Adapters:**

The `ProviderAdapter` trait defines how to parse output from each supported AI CLI tool:

```rust
trait ProviderAdapter: Send + Sync {
    fn detect_agent(&self, line: &str) -> Option<AgentInfo>;
    fn analyze_line(&self, line: &str) -> LineAnalysis;
    fn is_prompt(&self, line: &str) -> bool;
    fn known_actions(&self) -> Vec<ActionTemplate>;
}
```

Current adapters: `ClaudeCodeAdapter`, `AiderAdapter`, `GeminiCliAdapter`, `CodexAdapter`. Each adapter uses compiled `Regex` patterns (via `lazy_static!`) to parse token counts, tool calls, cost information, and slash commands from terminal output.

The `ProviderRegistry` iterates through adapters on each output line. Once an agent is detected, that adapter becomes the "active" one and gets priority for subsequent line analysis.

### Database

`src-tauri/src/db/mod.rs` manages an embedded SQLite database with WAL mode enabled for concurrent reads.

**Key tables:**
| Table | Purpose |
|-------|---------|
| `sessions` | Session metadata (label, color, phase, working directory, scrollback snapshot) |
| `realms` | Registered projects (path, name, languages, frameworks, architecture, scan status) |
| `session_realms` | Many-to-many relationship between sessions and projects |
| `realm_conventions` | Detected coding conventions per project |
| `token_usage` | Token usage records per session/provider |
| `cost_daily` | Aggregated daily cost data |
| `memory` | Persistent memory with scopes (session, project, global) |
| `execution_log` | Command execution history |
| `settings` | Key-value application settings |
| `context_pins` | Pinned files/text per session or project |
| `context_snapshots` | Versioned snapshots of assembled context |
| `session_worktrees` | Git worktree-to-session mappings |
| `error_patterns` | Detected error fingerprints and their resolutions |
| `command_patterns` | Command sequences learned by releases up to 1.4 (no longer read or written) |

Migrations run on startup via `run_migrations()`, using idempotent `CREATE TABLE IF NOT EXISTS` statements and `ALTER TABLE` additions wrapped in try-catch blocks.

### Git Integration

`src-tauri/src/git/mod.rs` uses the `git2` crate (Rust bindings for libgit2) for all git operations. Features include:

- **Status:** Scans all attached projects for a session, returns per-project file status with staging area info
- **Operations:** Stage, unstage, commit, push, pull with full credential support
- **Branches:** List, create, checkout, delete branches
- **Stash:** List, save, apply, pop, drop, clear
- **Log:** Commit history with pagination
- **Diff:** Per-file diffs with addition/deletion counts
- **Merge/Conflicts:** Merge status detection, conflict content retrieval, resolution strategies (ours, theirs, manual)
- **Search:** Regex and literal search across project files
- **Worktrees:** Create and manage git worktrees per session (allows each session to work on a different branch)

**Credential cascade:** The git module tries multiple authentication methods in order: SSH agent, SSH key files (`~/.ssh/id_ed25519`, `id_rsa`, etc.), Git Credential Manager, and the system credential store.

**Worktree paths:** All git operations resolve the correct working path via `resolve_worktree_path()`, which checks for a session-specific worktree before falling back to the project's root path.

### Project Scanning (Cartography)

The scanning system has three tiers in `src-tauri/src/project/cartography.rs`:

1. **Surface scan** (< 2 seconds) — checks for marker files at the project root (`package.json`, `Cargo.toml`, `go.mod`, etc.) and counts file extensions at depth 2. Detects languages and frameworks.

2. **Deep scan** (< 30 seconds) — extends surface scan with config file analysis (`.prettierrc`, `tsconfig.json`, `.editorconfig`, `Cargo.toml` settings), architecture pattern detection (monorepo, MVC, Next.js, Tauri, etc.), and convention extraction.

3. **Full scan** (minutes) — extends deep scan by sampling up to 200 source files at depth 5, analyzing import patterns, and detecting entry points.

When a project is created, a surface scan runs synchronously and a deep scan is spawned on a background thread. After the deep scan completes, context files are regenerated for all sessions attached to that project.

### Context Assembly (Attunement)

`src-tauri/src/project/attunement.rs` assembles the final context document:

1. Collects all projects attached to the session
2. Loads `.hermes/context.json` project configs (if present) for custom pins, memory, conventions, and token budget overrides
3. Gathers context pins (session-scoped and project-scoped) with file content
4. Merges memory entries across scopes (project takes precedence over global)
5. Estimates token usage per section (~4 chars = 1 token)
6. Trims to the token budget by removing conventions from lower-priority projects
7. Formats everything as Markdown and writes it atomically to disk (tmp + rename)
8. Saves a versioned snapshot to the database

The output is a Markdown file at `{app_data_dir}/context/{session_id}.md` that AI agents can read.

### Process Management

`src-tauri/src/process/mod.rs` uses the `sysinfo` crate to list system processes. It enriches each process with:
- CPU and memory usage
- Whether it belongs to a Hermes terminal session (`is_hermes_session`)
- Whether it is a protected system process (`is_protected`) — platform-specific lists prevent users from accidentally killing critical system processes
- Zombie detection

---

## Data Flow

### How a Terminal Session is Created

```
User clicks "New Session"
        │
        ▼
Frontend: SessionCreator dispatches createSession(opts)
        │
        ▼
Frontend: SessionContext.createSession() calls apiCreateSession()
        │
        ▼
IPC: invoke("create_session", { ... })
        │
        ▼
Backend: pty::create_session()
  1. Assigns a UUID (or uses pre-generated ID for worktree sessions)
  2. Selects the user's default shell
  3. Spawns a PTY via portable-pty
  4. Launches a reader thread that:
     a. Reads raw output in a loop
     b. Emits session-output-{id} events to the frontend
     c. Feeds output through OutputAnalyzer for phase detection
  5. Transitions phase: Creating -> Initializing
  6. Optionally launches an AI provider command
  7. Emits session-updated event
  8. Returns SessionData to frontend
        │
        ▼
Frontend: createTerminal(sessionId, color)
  1. Creates an xterm.js Terminal with theme and font settings
  2. Attaches WebGL, FitAddon, WebLinksAddon
  3. Sets up key handlers (Tab for ghost text, etc.)
  4. Listens for session-output-{id} events and writes data to terminal
  5. Detects shell environment for intelligence config
        │
        ▼
Frontend: dispatch(SESSION_UPDATED) + dispatch(SET_ACTIVE)
  - Updates state, focuses pane, renders terminal
```

### How AI Context is Assembled and Delivered

```
Project is created or re-scanned
        │
        ▼
Backend: cartography::deep_scan() runs on background thread
  - Detects languages, frameworks, architecture, conventions
        │
        ▼
Backend: attunement::write_session_context_file()
  - Assembles context for each session attached to the project
  - Writes {session_id}.md to disk
        │
        ▼
Backend: Emits session-projects-changed event
        │
        ▼
Frontend: SessionContext listens, debounces (1.5s), calls nudgeProjectContext()
        │
        ▼
IPC: invoke("nudge_project_context", { sessionId })
        │
        ▼
Backend: PtyManager.nudge_context()
  - If an AI agent is detected in the session:
    Writes a nudge command to the PTY (e.g., "/read context.md")
  - If no agent detected: no-op (context file is still available on disk)
```

### How Git Status is Polled and Displayed

```
useGitStatus hook starts with enabled=true
        │
        ▼
Frontend: Calls gitStatus(sessionId) via IPC
        │
        ▼
Backend: git::git_status()
  1. Fetches all projects attached to the session
  2. For each project, resolves the worktree path
  3. Opens the git repository via git2::Repository
  4. Reads branch, remote tracking, ahead/behind counts
  5. Iterates file statuses (staged, unstaged, untracked, conflicted)
  6. Counts stashes
  7. Returns GitSessionStatus with per-project breakdowns
        │
        ▼
Frontend: useGitStatus sets status state
  - SessionGitPanel / GitPanel renders file lists, branch info, diff viewer
  - useSessionGitSummary extracts branch name and change count for top bar
        │
        ▼
Frontend: setInterval polls every 3 seconds (configurable)
```

---

## Key Design Decisions

### Why Tauri 2

Tauri provides a native webview (WKWebView on macOS, WebView2 on Windows, WebKitGTK on Linux) with a Rust backend. Compared to Electron:
- **Smaller binary size** — no bundled Chromium
- **Lower memory usage** — shared system webview
- **Security model** — explicit IPC commands with fine-grained permissions; the frontend cannot access the filesystem or spawn processes directly
- **Rust backend** — memory safety, excellent concurrency primitives, access to system APIs through crates like `portable-pty`, `git2`, and `sysinfo`

### Why a Single Reducer for Session State

All session-related state (sessions, layout, UI toggles, injection locks) lives in one `useReducer` in `SessionContext`. This was chosen over multiple contexts or a state management library because:

- **Predictability** — every state transition is a pure function in `sessionReducer`, making it easy to trace and test
- **Atomicity** — actions like `SESSION_REMOVED` need to update sessions, layout, active session, injection locks, and UI state in a single render. A single reducer handles this atomically.
- **Testability** — the reducer is exported and unit-tested independently of React

### Why a Module-Level Terminal Pool

xterm.js `Terminal` instances are expensive to create and have complex lifecycle requirements (open, attach to DOM, fit, focus, destroy). Managing them inside React components causes problems:
- React re-renders would recreate terminals, losing scrollback and state
- StrictMode double-mounts would create duplicate PTY listeners
- Component unmounting during pane rearrangement would destroy terminals unnecessarily

The pool (`src/terminal/TerminalPool.ts`) solves this by managing terminals outside React's lifecycle. Components call `attach(sessionId, container)` to mount a pre-created terminal into a DOM element, and `detach(sessionId)` to unmount it without destroying state. The terminal survives pane splits, tab switches, and sidebar toggles.

### Why Provider Adapters

Hermes IDE supports multiple AI CLI tools (Claude Code, Aider, Gemini CLI, Codex) running inside terminals. Each tool has different output formats for token usage, tool calls, cost information, and prompts. The adapter pattern allows:

- **Independent parsing logic** — each adapter encapsulates its own regex patterns and parsing rules
- **Auto-detection** — the `ProviderRegistry` iterates adapters to detect which agent is running, then gives that adapter priority
- **Extensibility** — adding support for a new AI CLI tool means implementing the `ProviderAdapter` trait without modifying existing adapters
- **Composability** — common patterns (like `is_input_needed_line()` for Y/n prompts) are shared across adapters

### Why SQLite with WAL Mode

SQLite was chosen over a remote database or file-based storage because:
- **Zero configuration** — the database file lives in the app data directory
- **ACID guarantees** — no data corruption on crashes
- **WAL mode** — allows concurrent reads while writing, important since the reader thread and IPC commands access the database simultaneously
- **Single file** — easy to back up, migrate, or reset

### Why Workspace Restore Uses Frontend State

The workspace restore system saves and restores the layout tree, focused pane, active session, and session metadata. This data lives in the frontend's `SessionState`, not in the backend. The backend saves scrollback snapshots and session metadata, but the layout structure is saved as a JSON blob in the `settings` table by the frontend's periodic auto-save. This separation exists because:
- The layout tree is a frontend-only concept (pane IDs, split ratios)
- The backend doesn't know about UI state
- Restoring layout requires remapping old session IDs to newly created ones, which the frontend handles during workspace restore
