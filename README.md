# HERMES-IDEA

[![Tauri](https://img.shields.io/badge/Tauri-2.x-FFC131?logo=tauri&logoColor=white)](https://tauri.app)
[![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=white)](https://react.dev)
[![Rust](https://img.shields.io/badge/Rust-2021-DEA584?logo=rust&logoColor=white)](https://www.rust-lang.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![macOS](https://img.shields.io/badge/macOS-13%2B-000000?logo=apple&logoColor=white)](https://www.apple.com/macos)
[![License](https://img.shields.io/badge/license-Private-red)](#)

> An AI-native terminal for macOS that understands your projects, predicts your commands, and executes autonomously.

HERMES-IDEA is a desktop terminal emulator that deeply integrates AI assistance into command-line workflows. It scans your projects to build context ("Realms"), suggests commands in real time, tracks errors and resolutions, and can execute tasks autonomously — all without leaving the terminal.

---

## Table of Contents

- [Features](#features)
- [Architecture](#architecture)
- [Prerequisites](#prerequisites)
- [Setup](#setup)
- [Usage](#usage)
- [Keyboard Shortcuts](#keyboard-shortcuts)
- [Configuration](#configuration)
- [Project Structure](#project-structure)
- [Contributing](#contributing)

---

## Features

### Terminal
- **Multi-session management** — create, switch, and organize parallel terminal sessions
- **Split panes** — horizontal and vertical splits with drag-and-drop reordering
- **WebGL-accelerated rendering** — powered by xterm.js with web links and auto-fit
- **Execution timeline** — visual history of every command with exit codes and durations

### AI Intelligence
- **Ghost-text suggestions** — real-time command completions from history and context
- **Prompt Composer** — write natural-language instructions for autonomous task execution
- **Error pattern matching** — learns error fingerprints and auto-applies known resolutions
- **Stuck detection** — monitors for hanging processes and offers interrupts

### Project Awareness (Realms)
- **Automatic scanning** — detects languages, frameworks, architecture, and conventions
- **Context injection** — attaches project knowledge to AI agents via a token budget
- **Multi-realm support** — attach multiple project contexts to a single session

### Productivity
- **Command Palette** — fuzzy search for any action
- **Cost Dashboard** — track token usage and estimated costs per model and session
- **Memory & context pins** — persist important facts, files, and patterns across sessions
- **System notifications** — get notified about long-running command completions

---

## Architecture

HERMES-IDEA is a [Tauri 2](https://tauri.app) application with a clear frontend/backend split:

```
┌──────────────────────────────────┐
│         React Frontend           │
│  (TypeScript, xterm.js, Vite)    │
├──────────────────────────────────┤
│         Tauri IPC Bridge         │
├──────────────────────────────────┤
│          Rust Backend            │
│  (PTY, SQLite, Realm Scanner)    │
└──────────────────────────────────┘
```

| Layer | Responsibility |
|-------|---------------|
| **Frontend** (`src/`) | UI components, terminal rendering, state management, suggestion engine |
| **IPC** | Tauri commands bridge React and Rust via typed async invocations |
| **Backend** (`src-tauri/`) | PTY session lifecycle, SQLite persistence, project scanning, context assembly |

---

## Prerequisites

Before you begin, make sure you have the following installed:

| Tool | Version | Purpose |
|------|---------|---------|
| [Node.js](https://nodejs.org) | 18+ | Frontend build tooling |
| [Rust](https://rustup.rs) | 1.70+ | Backend compilation |
| [Tauri CLI prerequisites](https://v2.tauri.app/start/prerequisites/) | — | System dependencies for Tauri |

> **Note:** HERMES-IDEA targets **macOS 13 (Ventura)** or later.

Verify your setup:

```bash
node --version    # v18.x or higher
rustc --version   # 1.70.x or higher
cargo --version
```

---

## Setup

### 1. Clone the repository

```bash
git clone https://github.com/your-username/hermes-idea.git
cd hermes-idea
```

### 2. Install frontend dependencies

```bash
npm install
```

### 3. Run in development mode

```bash
npm run tauri dev
```

This starts both the Vite dev server (hot-reloading the React frontend) and compiles/launches the Tauri Rust backend. The app window will open automatically.

### 4. Build for production

```bash
npm run tauri build
```

The compiled `.app` bundle will be output to `src-tauri/target/release/bundle/`.

---

## Usage

### Creating a session

When you first launch HERMES-IDEA, you'll see an empty state with recent sessions (if any). Press **Cmd+T** to create a new terminal session, or use the session creator to pick a shell and attach a Realm.

### Working with Realms

Realms represent scanned project directories. To set up a Realm:

1. Press **Cmd+R** to open the Realm Picker
2. Select a directory — HERMES-IDEA scans it to detect languages, frameworks, and conventions
3. The Realm context is now available to AI features in that session

### AI Suggestions

As you type in the terminal, ghost-text suggestions appear based on your command history and project context. Press **Tab** to accept a suggestion.

### Prompt Composer

Press **Cmd+J** to open the Prompt Composer. Write a natural-language instruction (e.g., "run the tests and fix any failures"), and the AI agent will execute it autonomously.

### Context Panel

Press **Cmd+E** to toggle the Context Panel. Here you can:
- View injected context from attached Realms
- Pin important files or error patterns
- Copy assembled context to clipboard

### Split Panes

| Action | Shortcut |
|--------|----------|
| Split horizontally | **Cmd+D** |
| Split vertically | **Cmd+Shift+D** |
| Navigate between panes | **Cmd+Alt+Arrow** |

### Execution Timeline

Press **Cmd+L** to view the execution timeline — a chronological log of all commands, their exit codes, durations, and output.

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+T` | New session |
| `Cmd+W` | Close session |
| `Cmd+D` | Split pane horizontally |
| `Cmd+Shift+D` | Split pane vertically |
| `Cmd+K` | Command Palette |
| `Cmd+E` | Toggle Context Panel |
| `Cmd+J` | Prompt Composer |
| `Cmd+R` | Realm Picker |
| `Cmd+L` | Execution Timeline |
| `Cmd+$` | Cost Dashboard |
| `Cmd+Shift+F` | Toggle Flow Mode |
| `Cmd+,` | Settings |
| `Cmd+Alt+Arrow` | Navigate panes |
| `F1` | Interrupt stuck command |
| `F3` | Auto-execute suggestion |

---

## Configuration

### Settings

Open Settings with **Cmd+,** to configure:

| Setting | Description | Options |
|---------|-------------|---------|
| **Execution Mode** | How commands are run | `manual`, `assisted`, `autonomous` |
| **AI Provider** | Which AI backend to use | Auto-detected from agent config |
| **Auto-Cancel Delay** | Seconds before auto-confirming autonomous actions | Numeric (seconds) |
| **Shell** | Default shell | Auto-detected (`zsh`, `bash`, `fish`) |

### Execution Modes

| Mode | Behavior |
|------|----------|
| **Manual** | You type and run every command yourself |
| **Assisted** | AI suggests commands; you confirm before execution |
| **Autonomous** | AI executes tasks independently with a configurable confirmation delay |

### Data Storage

HERMES-IDEA stores session data, memories, error patterns, and cost history in a local **SQLite** database managed by the Rust backend. Data is stored in the Tauri application data directory:

```
~/Library/Application Support/com.hermes-idea.terminal/
```

---

## Project Structure

```
hermes-idea/
├── src/                        # React/TypeScript frontend
│   ├── api/                    # Tauri IPC command wrappers
│   ├── components/             # UI components (29+)
│   ├── hooks/                  # Custom React hooks
│   ├── lib/                    # Shared utilities
│   ├── state/                  # State management (Context + useReducer)
│   ├── styles/                 # Per-component CSS modules
│   ├── terminal/               # Terminal pool & intelligence engine
│   │   └── intelligence/       # Suggestion engine, context analyzer, history
│   ├── types/                  # TypeScript interfaces
│   ├── utils/                  # Helper functions
│   └── App.tsx                 # Root component
├── src-tauri/                  # Rust backend
│   ├── src/
│   │   ├── pty/                # PTY session management
│   │   ├── db/                 # SQLite persistence layer
│   │   ├── realm/              # Project scanning & context assembly
│   │   └── workspace/          # Workspace detection
│   ├── Cargo.toml              # Rust dependencies
│   └── tauri.conf.json         # Tauri app configuration
├── public/                     # Static assets
├── index.html                  # HTML entry point
├── package.json                # npm dependencies & scripts
├── vite.config.ts              # Vite build config
└── tsconfig.json               # TypeScript config
```

---

## Contributing

### Getting started

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Make your changes
4. Run the dev server to test: `npm run tauri dev`
5. Commit your changes with a clear message
6. Push to your fork and open a Pull Request

### Development workflow

```bash
# Start development (frontend + backend hot-reload)
npm run tauri dev

# Build frontend only
npm run build

# Run frontend tests
npx vitest

# Check Rust compilation
cd src-tauri && cargo check

# Run Rust tests
cd src-tauri && cargo test
```

### Code style

- **TypeScript**: Strict mode enabled. Follow existing patterns in `src/`.
- **Rust**: Standard `cargo fmt` and `cargo clippy` conventions.
- **CSS**: Per-component CSS files in `src/styles/`. No CSS-in-JS.
- **Components**: Functional React components with hooks. State lives in `SessionContext`.

### Guidelines

- Keep PRs focused on a single change
- Add tests for new functionality when applicable
- Follow the existing naming conventions (e.g., Realms, Cartography, Attunement)
- Test on macOS 13+ before submitting

---

<p align="center">
  Built with <a href="https://tauri.app">Tauri</a> + <a href="https://react.dev">React</a> + <a href="https://www.rust-lang.org">Rust</a>
</p>
