# v0.6.9

## Fixes

- **sudo and password prompts now work in terminals** — Commands like `sudo`, `ssh` (password auth), and `gpg` that need to read passwords securely were failing silently. They now prompt for input as expected.

- **Sidebar panels no longer flicker when toggling** — Clicking a panel button (like Context) would close and immediately reopen it. Panels now toggle reliably with a single click.
