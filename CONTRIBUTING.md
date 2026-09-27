# Contributing to Hermes IDE

Thank you for considering contributing to Hermes IDE! This guide will help you get started.

## Before You Start

**Read the [Design Principles](DESIGN_PRINCIPLES.md).** Hermes IDE is intentionally minimal. We say "no" to most feature requests. Understanding these principles will save you time.

**Read the [Architecture Guide](ARCHITECTURE.md)** to understand the codebase structure before diving into code. It covers the frontend/backend split, state management, terminal rendering, and all the domain-specific concepts you will encounter.

## The #1 Rule

**Open an issue or discussion before writing code for any new feature.** We will tell you upfront if it fits the project's scope. Unsolicited feature PRs that weren't discussed first will be closed.

Bug fixes and documentation improvements do **not** require prior discussion.

## CLA Requirement

All contributors must sign the [Contributor License Agreement](CLA.md) before their first PR is merged. This is automated — the CLA Assistant bot will guide you through it on your first pull request.

## What We Accept

- Bug fixes (always welcome)
- Performance improvements
- Documentation improvements
- Accessibility improvements
- Features that are on the roadmap or approved in a discussion

## What We Do Not Accept

- Features that expand scope beyond the [Design Principles](DESIGN_PRINCIPLES.md)
- Large refactors without prior discussion
- Changes that add significant new dependencies
- Anything that can be an extension instead of core

## Development Setup

### Prerequisites

| Tool | Version |
|------|---------|
| [Node.js](https://nodejs.org) | 18+ |
| [Rust](https://rustup.rs) | 1.70+ |
| [Tauri CLI prerequisites](https://v2.tauri.app/start/prerequisites/) | — |

### Getting Running

```bash
git clone https://github.com/hermes-hq/hermes-ide.git
cd hermes-ide
npm install
npm run tauri dev
```

### Troubleshooting

Common build issues by platform:

- **Linux:** Tauri requires system dependencies that are not installed by default. Install them with:
  ```bash
  sudo apt install libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf
  ```
- **macOS:** You need Xcode Command Line Tools. Install with:
  ```bash
  xcode-select --install
  ```
- **Windows:** You need [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) (with the "Desktop development with C++" workload) and the [WebView2 Runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) (pre-installed on Windows 11, may need manual install on Windows 10).

If the Rust build fails with missing system libraries, see the [Tauri prerequisites guide](https://v2.tauri.app/start/prerequisites/) for your platform.

### Useful Commands

```bash
npm run tauri dev        # Full app with hot-reload
npm run dev              # Frontend only (Vite dev server)
npm run build            # Build frontend
npm run test             # Run frontend tests
npx tsc --noEmit         # Type check
cd src-tauri && cargo check  # Check Rust compilation
cd src-tauri && cargo test   # Run Rust tests
```

### Dev builds and your installed Hermes

`npm run tauri dev` runs as its own app (`com.hermes-ide.terminal.dev`) with its own data folder, so it never touches the database, worktrees or terminals of a Hermes you have installed. Set `HERMES_DATA_DIR=/absolute/path` to use a throwaway data folder instead. Dev and test builds refuse to start if they would use the installed app's data folder, and CI fails if a dev or test config uses the production identifier.

Running the Tauri CLI or Cargo directly (`npx tauri dev`, `cargo run`) builds with the production identifier, so that debug build stops with exit code 78 and says why. Use `npm run tauri dev`, or set one of:

- `HERMES_DATA_DIR=/absolute/path` — use that folder for all app data. Honoured by dev, test and beta builds; the released app ignores it.
- `HERMES_ALLOW_PRODUCTION_DATA=1` — let a debug build with the production identifier use the installed app's data folder. Only do this if you mean to work on your real sessions; it has no effect on test builds.

## Finding Good First Issues

If you are new to the project, look for issues labeled [`good-first-issue`](https://github.com/hermes-hq/hermes-ide/labels/good-first-issue). These are intentionally scoped to be approachable for newcomers and usually include enough context to get started without deep codebase knowledge.

## Commit Message Convention

We use [Conventional Commits](https://www.conventionalcommits.org/) for commit messages. This makes the git history easier to read and enables automated tooling.

Format: `type: short description`

| Prefix | When to use |
|--------|-------------|
| `feat:` | A new feature or user-visible enhancement |
| `fix:` | A bug fix |
| `docs:` | Documentation-only changes |
| `refactor:` | Code changes that neither fix a bug nor add a feature |
| `test:` | Adding or updating tests |
| `chore:` | Build scripts, CI config, dependency bumps, tooling |

Examples:
- `feat: add stash support to git panel`
- `fix: prevent ghost text from appearing during agent busy phase`
- `docs: update architecture guide with context assembly flow`
- `refactor: extract provider detection into shared utility`

Keep the description concise (under 72 characters). Use the commit body for additional detail if needed.

## Code Style

- **TypeScript**: Strict mode enabled. Follow existing patterns in `src/`.
- **Rust**: Standard `cargo fmt` and `cargo clippy` conventions.
- **CSS**: Per-component CSS files in `src/styles/`. No CSS-in-JS.
- **Components**: Functional React components with hooks. State lives in `SessionContext`.

## Pull Request Process

1. Fork the repo and create a feature branch from `main`.
2. Make your changes. Keep PRs focused on a single change.
3. Ensure `npx tsc --noEmit` and `npm run test` pass.
4. Open a PR with a clear description of what and why.
5. Link to the issue or discussion that approved the change (for features).

### Checks

The one required check is `gate`. It passes only when every check that had to run succeeded; a failed, cancelled or wrongly skipped check fails it.

On pull requests, checks run only for what the PR touches:

- Frontend (type check, lint, unit tests): `src/`, `package*.json`, lint and build config.
- Rust (format, clippy, tests on Linux, macOS and Windows): `src-tauri/`, `package*.json`, `rust-toolchain.toml`.
- Real-app scenarios on all three OSes: frontend or Rust changes.
- Workflow lint: `.github/workflows/`.
- Privacy: every PR.

Changing `.github/workflows/ci.yml`, `scripts/ci-gate.mjs` or `e2e/` runs the frontend, Rust and real-app checks.

So a frontend-only PR runs no Rust tests, and the `gate` log shows those jobs as `ok ... skipped`. That means "not needed", not "passed". Every push to `main` and every merge-queue run executes all checks. The Rust security audit runs on `main` only and is not part of the gate.

### Review Timeline

- Initial feedback within 7 days.
- Bug fix PRs can be merged by any maintainer.
- Feature PRs require BDFL final approval.
- Stale PRs (no response for 14 days) will be closed.

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](https://github.com/hermes-hq/.github/blob/main/CODE_OF_CONDUCT.md). Please be respectful.

## Questions?

Open a thread in [GitHub Discussions](https://github.com/hermes-hq/hermes-ide/discussions).
