# HERMES IDE

[![Tauri](https://img.shields.io/badge/Tauri-2.x-FFC131?logo=tauri&logoColor=white)](https://tauri.app)
[![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=white)](https://react.dev)
[![Rust](https://img.shields.io/badge/Rust-2021-DEA584?logo=rust&logoColor=white)](https://www.rust-lang.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![License](https://img.shields.io/badge/license-BSL%201.1-blue)](LICENSE)

> An AI-native terminal that understands your projects, predicts your commands, and executes autonomously.

Hermes IDE is a desktop terminal emulator that deeply integrates AI assistance into command-line workflows. It scans your projects to build context ("Realms"), suggests commands in real time, tracks errors and resolutions, and can execute tasks autonomously — all without leaving the terminal.

**Platforms:** macOS, Windows, Linux

---

## Features

### Terminal
- **Multi-session management** — create, switch, and organize parallel terminal sessions
- **Split panes** — horizontal and vertical splits with drag-and-drop reordering
- **WebGL-accelerated rendering** — fast terminal with web links and auto-fit
- **Execution timeline** — visual history of every command with exit codes and durations

### Git Integration
- **Built-in git panel** — view staged, unstaged, and untracked files per project
- **Stage / unstage / commit / push / pull** — all from the sidebar
- **Inline diff viewer** — click any changed file to see a syntax-highlighted diff
- **Robust authentication** — SSH agent, SSH key files, Git Credential Manager, and token-based auth

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

## Getting Started

### Prerequisites

| Tool | Version | Purpose |
|------|---------|---------|
| [Node.js](https://nodejs.org) | 18+ | Frontend build tooling |
| [Rust](https://rustup.rs) | 1.70+ | Backend compilation |
| [Tauri CLI prerequisites](https://v2.tauri.app/start/prerequisites/) | — | System dependencies for Tauri |

#### Platform-Specific Dependencies

- **Linux:**
  ```bash
  sudo apt install libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf
  ```
- **macOS:** Xcode Command Line Tools (`xcode-select --install`)
- **Windows:** [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) (with "Desktop development with C++" workload) + [WebView2 Runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/)

### Setup

```bash
git clone https://github.com/hermes-hq/hermes-ide.git
cd hermes-ide
npm install
npm run tauri dev
```

### Build for Production

```bash
npm run tauri build
```

---

## Architecture

Hermes IDE is a [Tauri 2](https://tauri.app) application:

```
┌──────────────────────────────────┐
│         React Frontend           │
│     (TypeScript, Vite)           │
├──────────────────────────────────┤
│         Tauri IPC Bridge         │
├──────────────────────────────────┤
│          Rust Backend            │
│   (PTY, SQLite, Realm Scanner)   │
└──────────────────────────────────┘
```

| Layer | Responsibility |
|-------|---------------|
| **Frontend** (`src/`) | UI components, terminal rendering, state management, suggestion engine |
| **IPC** | Tauri commands bridge React and Rust via typed async invocations |
| **Backend** (`src-tauri/`) | PTY session lifecycle, SQLite persistence, project scanning, context assembly |

---

## Project Structure

```
hermes-ide/
├── src/                        # React/TypeScript frontend
│   ├── api/                    # Tauri IPC command wrappers
│   ├── components/             # UI components
│   ├── hooks/                  # Custom React hooks
│   ├── state/                  # State management (Context + useReducer)
│   ├── styles/                 # Per-component CSS
│   ├── terminal/               # Terminal pool & intelligence engine
│   ├── types/                  # TypeScript interfaces
│   └── utils/                  # Helper functions
├── src-tauri/                  # Rust backend
│   ├── src/
│   │   ├── pty/                # PTY session management
│   │   ├── db/                 # SQLite persistence layer
│   │   ├── realm/              # Project scanning & context assembly
│   │   └── workspace/          # Workspace detection
│   ├── Cargo.toml              # Rust dependencies
│   └── tauri.conf.json         # Tauri app configuration
├── public/                     # Static assets
├── package.json                # npm dependencies & scripts
├── vite.config.ts              # Vite build config
└── tsconfig.json               # TypeScript config
```

---

## Documentation

- **[Architecture Guide](ARCHITECTURE.md)** — How the codebase is structured, data flow, and key design decisions
- **[Design Principles](DESIGN_PRINCIPLES.md)** — What Hermes IDE is and isn't
- **[Governance](GOVERNANCE.md)** — How decisions are made

---

## Contributing

We welcome contributions! Before you start, please read:

- **[CONTRIBUTING.md](CONTRIBUTING.md)** — How to contribute, what we accept, PR process
- **[DESIGN_PRINCIPLES.md](DESIGN_PRINCIPLES.md)** — Our anti-bloat philosophy (please read this)
- **[CLA.md](CLA.md)** — Contributor License Agreement (required for all contributions)
- **[Code of Conduct](https://github.com/hermes-hq/.github/blob/main/CODE_OF_CONDUCT.md)** — Be kind

**The #1 rule:** Open an issue or discussion before writing code for any new feature. Bug fixes and docs don't require prior discussion.

### Quick Start for Contributors

```bash
git clone https://github.com/hermes-hq/hermes-ide.git
cd hermes-ide
npm install
npm run tauri dev        # Full app with hot-reload
npx tsc --noEmit         # Type check
npm run test             # Run tests
cd src-tauri && cargo test  # Rust tests
```

---

## License

Hermes IDE is source-available under the **[Business Source License 1.1](LICENSE)** (BSL 1.1).

- **You can:** copy, modify, create derivative works, redistribute, and make non-production use freely. Production use is allowed as long as it does not compete with Hermes IDE.
- **You cannot:** use it to build a competing code editor, terminal emulator, or IDE offered to third parties.
- **After 3 years** from each release, the code converts to **Apache License 2.0** — fully open source.

All contributions require signing the [Contributor License Agreement](CLA.md).

See [ARCHITECTURE.md](ARCHITECTURE.md) for a detailed technical overview.

---

## Security

Found a vulnerability? Please report it responsibly via [ga.contact.me@gmail.com](mailto:ga.contact.me@gmail.com). See our [Security Policy](https://github.com/hermes-hq/.github/blob/main/SECURITY.md) for details.

---

<p align="center">
  <a href="https://hermes-ide.com">Website</a> &middot;
  <a href="https://github.com/hermes-hq/hermes-ide/discussions">Discussions</a> &middot;
  <a href="https://hermes-ide.com/changelog">Changelog</a>
</p>
