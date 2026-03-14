# Changelog

All notable user-facing changes to Hermes IDE are documented in this file.

For the format, see the [release template](.github/RELEASE_TEMPLATE.md).
Each release uses the categories: **New**, **Fixed**, **Improved**, **Removed**.

---

# 0.5.8 (2026-03-14)

## Fixed
- Terminal sessions now resize correctly when the window is resized on macOS
- Shell and child processes (e.g. Claude Code) properly pick up new terminal dimensions after resize

---

# 0.5.6 (2026-03-14)

## New
- Plugins can now open links in the default browser via `api.shell.openExternal()`

## Fixed
- Plugin error messages now display correctly instead of showing "Unknown error"

---

# 0.5.5 (2026-03-14)

## Fixed
- Plugin update button now works reliably — previously clicking "Update" could silently do nothing when the update checker state was out of sync

---

# 0.5.4 (2026-03-14)

## New
- Plugins can now fetch data from the internet, enabling new types of plugins like feed readers and API tools
- Plugin Manager now shows your app version and clearer messages when a plugin requires a newer version
- Plugin updates that require a newer app version are no longer offered, preventing incompatible installs

## Improved
- Incompatible plugins in the store now show a detailed warning explaining what version is needed and how to update

---

# 0.5.3 (2026-03-13)

## Improved
- Command suggestions can now be navigated with arrow keys, accepted with Enter, and clicked with the mouse
- Suggestion dropdown shows up to 15 results in a scrollable list, up from 6
- Suggestion dropdown flips above the cursor when typing near the bottom of the terminal
- Light themes now have better contrast for text, labels, and borders

## Fixed
- Command suggestions no longer appear inside interactive CLI tools like vim, htop, or Claude Code
- Suggestion overlay position is now correctly aligned with the cursor

---

# 0.4.6 (2026-03-12)

## New
- Browse, view, and edit files directly in the app — with syntax highlighting and full SSH remote support
- Shift+Enter now inserts a newline in CLI tools that support it, matching the behavior of other modern terminals
