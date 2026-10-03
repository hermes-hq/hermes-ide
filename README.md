# HERMES IDE

[![CI](https://github.com/hermes-hq/hermes-ide/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/hermes-hq/hermes-ide/actions/workflows/ci.yml) [![Release](https://github.com/hermes-hq/hermes-ide/actions/workflows/release.yml/badge.svg?event=push)](https://github.com/hermes-hq/hermes-ide/actions/workflows/release.yml) [![Latest Release](https://img.shields.io/github/v/release/hermes-hq/hermes-ide?label=latest)](https://github.com/hermes-hq/hermes-ide/releases/latest)

[![Tauri](https://img.shields.io/badge/Tauri-2.x-FFC131?logo=tauri&logoColor=white)](https://tauri.app)
[![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=white)](https://react.dev)
[![Rust](https://img.shields.io/badge/Rust-2021-DEA584?logo=rust&logoColor=white)](https://www.rust-lang.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![License](https://img.shields.io/badge/license-BSL%201.1-blue)](LICENSE)
[![Discord](https://img.shields.io/badge/Discord-Join_Server-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discord.gg/vMQXSTY6BM)
[![Sponsor](https://img.shields.io/badge/Sponsor-EA4AAA?style=flat-square&logo=github-sponsors&logoColor=white)](https://github.com/sponsors/hermes-hq)

> An AI-native terminal that understands your projects, predicts your commands, and executes autonomously.

Hermes IDE is a desktop terminal emulator that deeply integrates AI assistance into command-line workflows. It scans your projects to build context, suggests commands in real time, tracks errors and resolutions, and can execute tasks autonomously — all without leaving the terminal.

**Platforms:** macOS, Windows, Linux

Hermes IDE is not affiliated with Nous Research or its Hermes Agent.

---
![GIF](https://github.com/user-attachments/assets/dce248cc-d215-48c7-a1c1-33e539c2a20f)

## Features

### Terminal first, for every agent
- **Every agent in its own terminal** — Claude Code, Codex, Gemini, Aider, Copilot, Kiro and plain shells all open in a real terminal by default, running the agent's own interface exactly as it would anywhere else <!-- claim:every-agent-terminal -->
- **Bring your own auth** — agents use their own CLI sign-in (for Claude: Pro, Max, or API key); Hermes never asks for tokens <!-- claim:agent-own-auth -->
- **Multi-session management** — create, switch, and organize parallel sessions <!-- claim:multi-session -->
- **Split panes** — split right or down to run sessions side by side; close a pane and the others fill the space <!-- claim:split-panes -->
- **Fast terminal rendering** — GPU-accelerated (WebGL) where the system supports it, clickable web links, and auto-fit to the window <!-- claim:webgl-rendering -->
- **Remembers your choice per agent** — the New Session wizard preselects the last agent and how you ran it <!-- claim:remember-agent-choice -->

### Agent view for Claude (optional)
- **Opt in per session** — tick "Agent view for Claude" in the New Session wizard to have Hermes render the conversation instead of Claude's terminal interface <!-- claim:agent-view-opt-in -->
- **Structured conversation** — thinking blocks, tool-call cards, and diff previews <!-- claim:agent-chat -->
- **Real images** — paste images straight into the composer; Claude sees the actual pixels <!-- claim:agent-images -->
- **Persistent conversations** — Agent-view sessions come back after an app restart and Claude continues the same conversation <!-- claim:agent-persistent-conversations -->

### Git Integration
- **Built-in git view** — the Review Desk lists staged, unstaged, and untracked files per project <!-- claim:git-panel -->
- **Stage / unstage / commit / discard / push / pull** — all from the Review Desk <!-- claim:git-actions -->
- **Inline diff viewer** — click any changed file to see its diff, with removed and added lines marked <!-- claim:git-diff -->
- **Push with your own credentials** — pushes sign in with your git credential helper (such as Git Credential Manager) or a `GITHUB_TOKEN`, and say how to sign in when nothing works <!-- claim:git-auth -->

### AI Intelligence
- **Ghost-text suggestions** — completions from your command history as you type; → accepts them (in shells without suggestions of their own) <!-- claim:ghost-text -->
- **Prompt Composer** — build a structured prompt from a template, a task and a scope, and send it to the session <!-- claim:prompt-composer -->
- **Stuck detection** — when an Agent-view session ignores Stop, Hermes tells you it isn't responding and offers Force stop, keeping the conversation <!-- claim:stuck-detection -->

### Project Awareness
- **Automatic scanning** — detects each project's languages, frameworks, architecture, and conventions <!-- claim:project-scanning -->
- **Context injection** — your agent is pointed at a context file with what the scan found, kept within a token budget you can set per project <!-- claim:context-injection -->
- **Multi-project support** — attach several projects to one session; their context reaches the agent together <!-- claim:multi-project -->

### Productivity
- **Command Palette** — type to find and run any action <!-- claim:command-palette -->
- **Spend per session** — the cost an agent reports, or an estimate from its transcript clearly marked as estimated, with token totals <!-- claim:session-spend -->
- **Memory & context pins** — facts and pinned files saved for a project reach every later session's agent, also after a restart <!-- claim:memory-pins -->
- **System notifications** — get notified about long-running command completions <!-- claim:notifications -->

---

## Download & Installation

Download the latest version for your platform from the official website:

**[https://www.hermes-ide.com/download](https://www.hermes-ide.com/download)**

Pre-built installers are available for macOS (Apple Silicon & Intel), Windows, and Linux (.deb, .AppImage, .rpm).

---

## Getting Started

### Prerequisites (for building from source)

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
│   (PTY, SQLite, Project Scanner)  │
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
│   │   ├── project/            # Project scanning & context assembly
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

## 💛 Sponsors

Hermes IDE is built and maintained by a small team. If you find it useful, please consider sponsoring to help keep the project alive and accelerate development.

[![Sponsor Hermes IDE](https://img.shields.io/badge/Sponsor-Hermes_IDE-EA4AAA?style=for-the-badge&logo=github-sponsors&logoColor=white)](https://github.com/sponsors/hermes-hq)
[![GitHub Sponsors](https://img.shields.io/github/sponsors/hermes-hq?style=flat-square&logo=github-sponsors&label=Sponsors&color=EA4AAA)](https://github.com/sponsors/hermes-hq)

| Tier | Monthly | Perks |
|------|---------|-------|
| ☕ Supporter | $5 | Sponsor badge |
| 🚀 Backer | $20 | Badge + release notes mention |
| 💎 Contributor | $50 | Badge + README credit + early access |
| 🤝 Partner | $100 | Logo in README + priority bug reports |
| 🏢 Company | $500 | Logo on website + direct support channel |

**[→ View all sponsorship tiers and become a sponsor](https://github.com/sponsors/hermes-hq)**

See [SPONSORS.md](./SPONSORS.md) for the full list of sponsors and details.

---

<p align="center">
  <a href="https://hermes-ide.com">Website</a> &middot;
  <a href="https://github.com/hermes-hq/hermes-ide/discussions">Discussions</a> &middot;
      <a href="https://discord.gg/vMQXSTY6BM">Discord</a>a> &middot;
  <a href="https://hermes-ide.com/changelog">Changelog</a>
</p>
