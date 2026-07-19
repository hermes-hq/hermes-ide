# Changelog

All notable user-facing changes to Hermes IDE are documented in this file.

For the format, see the [release template](.github/RELEASE_TEMPLATE.md).
Each release uses the categories: **New**, **Fixed**, **Improved**, **Removed**.

---

# 1.4.0 (2026-07-19)

## New
- Interface translations built in — switch Hermes to Russian, Spanish, French, German, Portuguese (Brazil), Simplified Chinese, Japanese, or Hindi from Plugins → Hermes Language Pack; the switch is instant, needs no restart, and is remembered across launches
- Language Pack ships as a built-in plugin, visible and manageable in the installed plugins list
- Localized the start screen, command palette, settings, session creation flow (including the SSH and tmux steps), usage and plan limits, shortcuts, plugin manager, and the prompt composer with roles, styles, and templates

## Fixed
- Usage panel now counts input tokens from the whole session, including turns from before the panel was opened

## Improved
- Context Panel action on the start screen works before a session is opened

# 1.2.0 (2026-05-11)

## New
- Voice-color system across every theme — your turns wear a warm tone, the agent's turns wear a cool tone, so a long conversation reads at a glance
- Attach button in the composer for adding images by clicking (paste and drag-and-drop continue to work)
- Three-segment execution mode control in the status bar — Manual, Assisted, and Auto are all visible at once instead of cycling on click
- Pulsing status capsules for "working" and "needs input" replace the bare-text labels
- Version chip in the status bar that shows idle, checking, update-available, and downloading-with-progress in a single element
- Comprehensive design-system documentation describing every visual token and component pattern

## Fixed
- Collapsed "thought" footnotes in agent conversations no longer render as an empty dashed box with their content escaping below; the collapsed state is now an inline brass chip, expanded thoughts pull their body inside the same footprint
- Text contrast on Frosted Light, Atrium, and Linen now meets WCAG AA — previously failed for secondary metadata
- Activity bar icons no longer bob vertically when you hover them
- The minimized composer is a discoverable "Compose" brass pill with the keyboard shortcut visible, instead of a small dark circle hugging the corner

## Improved
- Agent conversation headings have a proper editorial hierarchy (24 / 20 / 16 / 14) — markdown structure in long replies is finally scannable
- Editorial themes (Atelier, Linen, Observatory, Newsprint) use the Newsreader serif typeface for headings
- Newsprint is now a true duotone — brass is the live accent for links and selection, true ink stays as the body color
- Atrium gains a richer slate-teal accent; the previous muted slate didn't pop on the daylight surface
- Frosted Dark and Frosted Light carry subtle cool chroma so the frosted overlays have something to refract
- Composer settings (Model · Permission · Effort) are now compact dot-chips with categorical colored dots
- The Permission chip turns red and pulses when set to Bypass — the danger state announces itself instead of looking like every other pill
- The Send button is now a brass pill that reads `Send →` with the arrow sliding right on hover; the keyboard shortcut moved to the tooltip
- Session row left band carries the live phase — vertical shimmer when busy, amber pulse when needs-input, solid red on error
- Session list description and project chips hide until the row is active or hovered, so the sidebar reads as a glanceable index
- Single-letter monogram glyphs replace the agent-name and SSH chips on session rows
- Logbook entries on the empty state show a preview snippet and shell name for each recent session
- Sliding underline between Terminal and Git tabs instead of a snap
- Focus ring is themed per theme — soft halo on glass themes, sharp double-rule on Newsprint, accent glow on Phosphor, brass on editorial themes
- Activity bar icons are larger and the active-tab indicator anchors flush to the bar edge
- Token count, cost, and elapsed time in the status bar settle to calm grey by default and flash brass briefly when they change
- All animations respect prefers-reduced-motion

## Removed
- The legacy theme rule that quietly collapsed every multi-tone theme's "your" voice into its accent color — themes now declare both voices explicitly

---

# 1.0.0 (2026-04-27)

## New
- Agent mode for Claude — Claude sessions now open in a real chat interface by default, with rich tool calls, thinking blocks, diff cards, and image input
- File edits made by Claude render as syntax-highlighted diff cards instead of plain text
- Tool calls (Bash, Read, Write, Edit, web search, and more) render as collapsible cards with arguments and results visible at a glance
- Each turn ends with a summary showing token usage and timing
- Paste or drop images directly into the Claude composer and Claude sees the actual pixels
- Per-session mode picker in the new-session modal — choose Agent mode (chat experience) or Terminal mode (classic TUI)
- Right-click any session and choose Convert to switch between Agent and Terminal mode
- Conversations with Claude in Agent mode persist across app restarts — reopen the session and continue where you left off

## Improved
- Slash command suggestions for Claude are now sourced from Claude itself, so new commands appear automatically as Claude updates
- The model picker reflects Claude's actual current model and effort options instead of a hardcoded list
- Composer mentions and image attachments are now first-class in the chat input, with previews before you send

## Removed
- The bracketed-paste workaround used to fake a chat experience inside the Claude TUI is gone — Agent mode replaces it with a real chat surface
- The bundled fallback list of slash commands has been removed; commands now come live from Claude

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
