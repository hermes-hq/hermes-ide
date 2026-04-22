# v0.6.16

## New

- **Customize the launch command for each AI agent** — Add a prefix like `caffeinate -i` (macOS), `wsl` (Windows), or `nice -n 10` (Linux) before the agent binary to keep your machine awake during long tasks, run inside WSL, lower scheduling priority, or anything else you'd type at the shell. Set defaults per agent in Settings → AI Agent, or override per session in the new-session modal. Platform-aware example chips and a live preview help you see exactly what will run.

## Fixed

- **Claude and other AI CLIs now detect correctly when installed via nvm, volta, pnpm, or npm-global** — Previously, a valid Claude Code install would show "Not detected" in the provider picker even though sessions launched fine. Detection now picks up any AI CLI that runs from your terminal.

- **Window title now reads "HERMES-IDE" on Linux and Windows** — Previously the title bar displayed "Tauri App" on those platforms. macOS was already correct.
