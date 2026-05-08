# h-ide v1.0.0 Redesign Playbook (AI executor reference)

> This file is read by every subsequent agent implementing the v1.0.0 redesign.
> If a spec changes, update here first; downstream agents trust this.
>
> Source plan (human-facing rationale): `~/.claude/plans/wondrous-wishing-quilt.md`.
> This playbook is the *executor's reference card* — organized for fast lookup
> while implementing, not narrative reading.

---

## 1. Aesthetic Commitment

**"Editorial Engineering"** — Bloomberg Terminal density × NYT Magazine typography
× Mathematica notebook structure × Linear's craftsmanship.

The chat surface is a *primary document of work*, not a chat thread. Treat the
conversation as an engineering notebook the user could print and hand a
colleague. Information density is high; typographic precision is the redeeming
quality. Nothing in the chrome competes with the content.

### Refused

- Round message bubbles, avatars, ChatGPT/Slack/Discord aesthetic
- Material Design rounded corners (>3px) and drop shadows
- Purple-gradient AI vibes ("AI sparkles", animated rainbows)
- Spinning circles, ellipsis loaders, emoji in chrome (no `📄` `🔍` `✨`)
- "ASSISTANT" / "USER" caps headers above each message
- Generic body fonts (Inter the default sans, Roboto, Arial, system-ui)

### Committed

- Hairline rules (1px `--rule`) instead of card borders where possible
- Marginalia (left-margin 2px bar) for user-message indicators — no caps headers
- Tool *families* with distinct visual languages (file / exec / search / web / generic)
- Right-aligned colophon (3 numbers, whisper-quiet) at end of each turn
- Unified diff (red/green left bars, line-number gutter) — not a split before/after
- Three precious streaming patterns: heartbeat cursor, tool respiration, thinking elapsed

---

## 2. Tokens

All tokens live in `src/styles/tokens.css`. The agent-mode redesign tokens are a
**separate set** from the legacy terminal-mode tokens. Agent-UI components
reference *only* agent-mode tokens; terminal-UI components reference *only*
legacy tokens. **Never mix the two within a single component file.**

### Agent-mode tokens (use these in all new agent UI work)

| Token | Hex / value | Semantic intent |
|---|---|---|
| `--bg-paper` | `#0d1218` | Page surface where the conversation lives |
| `--rule` | `#1a2230` | Hairline rules — block separators, colophon underline |
| `--rule-strong` | `#243040` | Hairline rules at higher contrast — section dividers |
| `--ink-primary` | `#e2e8f0` | Body prose, code, primary message text |
| `--ink-secondary` | `#a0aab8` | Tool output, secondary metadata, search snippets |
| `--ink-tertiary` | `#5d6878` | Whispers — line numbers, timestamps, colophon, citations |
| `--accent-paper` | `#6b88d0` | Reading-optimized accent — desaturated `--accent` for in-copy emphasis (margin bar, links) |
| `--tool-file` | `var(--violet)` `#a78bfa` | File operations (Read, Write, Edit, NotebookEdit) |
| `--tool-exec` | `var(--green)` `#34d399` | Executions (Bash, Run) — also "success" |
| `--tool-search` | `var(--yellow)` `#ffb000` | Searches (Grep, Glob) — also "running" |
| `--tool-web` | `var(--accent)` `#7b93db` | Web tools (WebFetch, WebSearch) |
| `--tool-error` | `var(--red)` `#ff4444` | Tool errors |
| `--font-mono` | `"JetBrains Mono", …` | Body, code, tool blocks (everything by default) |
| `--font-display` | `"Inter Tight", …` | Chrome (top bar, status bar, modal headers) |
| `--font-serif` | `"Newsreader", …` | **WebFetch / WebSearch excerpts only** — protected |
| `--font-mono-features` | `"calt", "liga", "ss01", "tnum"` | Apply via `font-feature-settings` for ligatures + tabular numerics |

### Backwards-compat: which legacy tokens stay

The following legacy terminal-mode tokens **stay** (do not modify, do not remove):
`--bg-0/1/2/3/-hover/-active`, `--text-0/1/2/3`, `--accent`, `--accent-dim`,
`--green`, `--green-dim`, `--red`, `--red-dim`, `--yellow`, `--yellow-dim`,
`--violet`, `--violet-dim`, `--error`, `--border`, `--border-light`,
`--scanline-opacity`, `--accent-glow`, all `--radius*`, all `--space-*`, all
`--text-{xs,sm,base,md,lg,xl,2xl}`, layout vars (`--topbar-h`, etc.),
`--icon-size`, `--btn-size`, all `--badge-*`.

### Sanctioned font swap

`--font-mono` previously pointed at IBM Plex Mono and is now repointed to
JetBrains Mono. `--font-ui` previously pointed at IBM Plex Mono and is now
repointed to Inter Tight (chrome only). Existing terminal-mode UI continues to
use these tokens unchanged and gets the new font *for free*. This is sanctioned
visual change, not a regression.

---

## 3. Typography

**Two-font system + one rare serif.** Self-hosted as woff2 in `public/fonts/`.

### Body / mono / code → JetBrains Mono

- Token: `--font-mono`
- Used in: every agent-UI block by default (text, thinking, tool, diff, colophon)
- Weights shipped: Regular (400), Bold (700), Italic (400 italic)
- Apply `font-feature-settings: var(--font-mono-features)` on the agent root for
  ligatures (`calt`, `liga`), stylistic-set 01 (`ss01`), and tabular numerics (`tnum`)

### Chrome / display → Inter Tight (variable)

- Token: `--font-display`
- Used in: top bar titles, status bar, session-list labels, modal headers,
  buttons. Anywhere the terminal-mode UI used `--font-ui`
- Variable axis: weight 100–900
- Apply `letter-spacing: -0.01em` for the "Tight" character — Inter Tight is
  Inter with negative tracking; we ship Inter Variable and apply the tracking
  in CSS

### Serif accent → Newsreader (variable)

- Token: `--font-serif`
- **Used in exactly ONE place: WebFetch / WebSearch excerpts.** Nowhere else.
- The serif's preciousness comes from its scarcity — protect it
- Variable axes: opsz 6–72, weight 200–800
- Optical-size axis: set `font-optical-sizing: auto` for body-size excerpts

### Never mix rules

- Never use Inter Tight inside the conversation column. The conversation is mono.
- Never use Newsreader outside a WebToolBlock excerpt. Not for headings, not for
  user messages, not anywhere else.
- Never use JetBrains Mono in the chrome top bar / status bar.
- Never fall back to system-ui in agent-mode UI; the fallback chains below
  preserve typographic feel even if a font fails to load.

### Fallback chains (defined in tokens.css)

```
--font-mono:    "JetBrains Mono", "SF Mono", "Fira Code", Menlo, monospace;
--font-display: "Inter Tight", "Inter", system-ui, sans-serif;
--font-serif:   "Newsreader", "Lyon Text", "Charter", Georgia, serif;
```

### Font deviation note

Newsreader is shipped as woff2 self-hosted (`Newsreader-Variable.woff2`). If a
future build pipeline or browser refuses the woff2-variations format, fall back
to Google Fonts CDN via `@import` in `tokens.css`:

```css
@import url("https://fonts.googleapis.com/css2?family=Newsreader:opsz,wght@6..72,400;6..72,600&display=swap");
```

This was not needed for the initial Phase 0 — all three fonts are self-hosted.

---

## 4. Glyphs (Unicode, JetBrains Mono compatible)

All glyphs render as text in JetBrains Mono. Verified-rendering set; if any
glyph fails on a target platform, swap **only that one** for an inline SVG.
Glyphs live in `src/agent/blocks/glyphs.ts` (Phase 3 creates this file).

| Use | Glyph | Codepoint | Fallback if missing |
|---|---|---|---|
| File operation | `◇` | U+25C7 (WHITE DIAMOND) | inline SVG diamond |
| Execution prompt | `▸` | U+25B8 (BLACK RIGHT-POINTING SMALL TRIANGLE) | inline SVG triangle |
| Search query | `⌕` | U+2315 (TELEPHONE RECORDER) — visually a magnifier | inline SVG magnifier |
| Margin / diff bar | `┃` | U+2503 (BOX DRAWINGS HEAVY VERTICAL) | inline SVG 2px rect |
| Disclosure | `▾` | U+25BE (BLACK DOWN-POINTING SMALL TRIANGLE) | inline SVG triangle |
| Citation | `¹` | U+00B9 (SUPERSCRIPT ONE) — also `²` U+00B2, `³` U+00B3 | superscript Latin digit |

**Rule:** never use emoji glyphs in chrome (`📄` `🔍` `✨` `⚡`). The redesign is
typographic. If a concept needs a glyph, use the table above.

---

## 5. Visual Grammar — per content block

Each block has a single source of visual truth here. If a block is missing from
this section, fall back to GenericToolBlock treatment.

### TextBlock (assistant prose, user messages)

Layout: full-width inside the conversation column. Padding: `0`. Background:
none. Border: none. Font: `13px/1.5 var(--font-mono)`, color `--ink-primary`,
`font-feature-settings: var(--font-mono-features)`. Paragraphs separated by a
blank line in source render to a single `<p>` with `margin: 0 0 12px 0`. Inline
code: `var(--ink-secondary)` on `var(--bg-paper)` shifted slightly darker
(`#0a0e14`), `padding: 0 4px`, `border-radius: 2px`. Streaming state: while the
text block is the latest streaming block of an assistant message, append the
heartbeat cursor (§6) inline at the end of the last visible character. No
"typing…" text, no "..." indicator.

### ThinkingBlock (extended reasoning)

Layout: full-width. Left border: `2px solid var(--ink-tertiary)` flush with
text. Padding: `0 0 0 12px`. Background: none. Font: `12px/1.5 var(--font-mono)`,
color `--ink-tertiary`, `font-style: italic`. Above the content: a single line
`thought · 4.2s` (or `thinking · 0.8s` while streaming). The elapsed counter is
in `--ink-tertiary` `10px var(--font-mono)` `font-variant-numeric: tabular-nums`,
frozen on completion (§6). Default-collapsed if longer than 3 lines, with a
`▾ thought · 4.2s` disclosure that expands inline. No card. No background.

### FileToolBlock (Read, Write, Edit, NotebookEdit)

Layout: full-width. Top border: `3px solid var(--tool-file)` (a stripe, not a
left bar). Padding: `8px 0 0 0`. Background: none. Header (single line, 11px
mono): `◇ src/agent/types.ts` followed by `+3, −0` summary in `--ink-tertiary`,
right-aligned. Path uses `letter-spacing: 0.05em` and no uppercase
transformation (the path itself stays lowercase / case-preserving). Body: line
number gutter (28px, mono 11px, `--ink-tertiary`, tabular-nums) + content. For
Edit-type calls, the body is `<UnifiedDiff>` (§5 UnifiedDiffBlock and Phase 4).
For Read, the body is the file content with the gutter only. Default-collapsed
if content > 8 lines: shows the header only with a `▾` disclosure. Streaming /
running: top stripe respires (§6). Errored: top stripe replaces with
`--tool-error`.

### ExecToolBlock (Bash, Run)

Layout: full-width. **No card. No border.** This block lives flush with the
prose. Command line: `▸ ls -la src/` — the `▸` glyph in `--tool-exec`,
non-breaking space, then the command in mono `--ink-primary`. Output is
indented to align with the command's first text character. Output font: `12px
var(--font-mono)`, color `--ink-secondary`. Output gets a 2px left bar in the
margin: `var(--tool-search)` (yellow) while running, `var(--tool-exec)` (green)
on success, `var(--tool-error)` (red) on error. The bar respires while running
(§6). Long output (>12 lines): collapse to last 4 lines + a disclosure
`▾ N hidden lines`. Click expands inline. Exit code displayed only if non-zero,
as `· exit 1` in `--tool-error` after the command.

### SearchToolBlock (Grep, Glob)

Layout: full-width. Query line: `⌕ "useState" — src/components/`. The `⌕` is
`--tool-search` (yellow). The query string is in `font-style: italic` mono with
`font-feature-settings: var(--font-mono-features), 'ss01'`. Path scope after
the em-dash is `--ink-tertiary`. Results: each match a single line in the form
`src/foo.tsx:42 · "const [x, setX] = useState(0)"`. Path:line in
`--ink-secondary`, tabular-nums on the line number, snippet in `--ink-primary`.
Matches separated by `1px solid var(--rule)` (a hairline, not gaps). Up to 5
matches visible by default; more via a disclosure `▾ N more matches`. Highlight
the matched substring inside snippets via `<mark>` with `background:
var(--yellow-dim); color: var(--yellow); padding: 0 2px; border-radius: 1px`.

### WebToolBlock (WebFetch, WebSearch) — *only place serif appears*

Layout: full-width. Citation header (12px mono): `¹ docs.anthropic.com/.../stream-json`
— the superscript number in `--accent-paper`, the URL/path in
`--ink-secondary`. Excerpt body: **`var(--font-serif)` (Newsreader)**, `13px /
1.6 line-height`, `--ink-secondary`, `font-optical-sizing: auto`. This is the
**only place serif appears in the entire agent UI** — protect it. Truncated to
~200 characters at a sentence boundary, with `… Read full` disclosure that
expands inline (showing the full excerpt also in serif). Multiple citations
listed as `¹ … ² … ³ …` with hairline rules between them.

### GenericToolBlock (fallback for unknown tools)

Layout: full-width. **Bare-bones treatment** — explicitly minimal. Tool name in
`font-style: italic` mono, color `--ink-tertiary`, prefixed with no glyph (the
glyph table above doesn't grant a glyph to unknowns). Input: collapsed `▾ input`
disclosure, JSON-pretty-printed when expanded with 2-space indent, font
`11px/1.5 var(--font-mono)`, color `--ink-secondary`. Result: rendered as text
(or JSON if structured). No card border, no background, no embellishment. This
block stays ugly on purpose — to motivate adding a proper family-specific
treatment when a new tool becomes important.

### ToolResultBlock (inline + standalone variants)

The `ToolResultBlock` is the *output* of a tool call. In most cases it's
absorbed into the parent tool block (FileToolBlock shows the diff inline,
ExecToolBlock shows stdout inline, SearchToolBlock shows results inline,
WebToolBlock shows the excerpt inline). Standalone variant only renders when a
ToolResult event arrives without a matching ToolUse block visible (rare, e.g.,
mid-stream reconnect). Standalone treatment: hairline-bordered panel, `12px
var(--font-mono)` `--ink-secondary`, max-height `200px` with scroll. The
parent-tool component owns the per-family hint styling (e.g., file family
result gets a subtle violet left margin); standalone is family-neutral.

### UnifiedDiffBlock (Phase 4 produces this)

Embedded inside FileToolBlock for Edit-type tools. Single-column unified diff
(not split before/after). Layout per row: `[28px gutter line-number][12px
+/−/blank column][1fr code]`. Removed lines: `background: var(--red-dim);
color: var(--red);`. Added lines: `background: var(--green-dim); color:
var(--green);`. Modified lines also display the `┃` glyph in the +/− column.
Context: no background, color `--ink-secondary`. Line numbers: mono 11px,
`--ink-tertiary`, tabular-nums. 3 lines of context above/below each hunk. Skip
massive unchanged sections with a `…` separator row. Default-collapsed showing
only the file header + `+N, −M` summary; click the FileToolBlock header to
expand the diff body.

### ColophonFooter (end of each turn — Phase 2 produces this)

Right-aligned. Three numbers in this order: `duration · output_tokens · cost`.
Example: `8.5s · 303 out · $0.13`. Font: `11px var(--font-mono)`, color
`--ink-tertiary`, `font-variant-numeric: tabular-nums`. Below the colophon: a
1px hairline rule (`--rule`) full-width across the conversation column. Click
the colophon → expands an inline detail panel with: `model`, `stop reason`,
`cache: read X · written Y`, `tokens: A in · B out`, `duration: X.Xs (api
Y.Ys)`. Each detail row: `11px var(--font-mono)`, `--ink-tertiary`,
tabular-nums, two-column key-value layout. No animation chrome — `display:
none` ↔ `display: block`, no slide. Cost is rounded to 2 decimals (`$0.13`,
not `$0.1266`). If output_tokens is missing, omit that segment (`8.5s ·
$0.13`). Duration formatting: `< 10s` shows one decimal (`0.4s`, `8.5s`); `≥
10s` shows integer seconds (`24s`).

---

## 6. Streaming Patterns

Three precious "alive" cues. **No spinners. No ellipsis. No skeletons.**

### Heartbeat cursor (latest streaming text block)

`1.06s` period (≈57 BPM, resting heart rhythm). `step-end` timing — instant on,
instant off. 1px wide, 1.1em tall, color `var(--accent)` (full-strength accent,
not `--accent-paper`). Appended inline at end of the latest streaming text
block.

```css
.agent-cursor {
  display: inline-block;
  width: 1px;
  height: 1.1em;
  background: var(--accent);
  margin-left: 1px;
  vertical-align: text-bottom;
  animation: heartbeat 1.06s step-end infinite;
}
@keyframes heartbeat {
  0%, 60%   { opacity: 1; }
  61%, 100% { opacity: 0; }
}
```

When streaming completes (`stop_reason !== null` or `result` event arrives),
the cursor is removed in the next render — no fade-out.

### Tool respiration (running tool block bar)

`2.5s` period. `ease-in-out alternate` timing. Animates the `background-color`
of the tool-block left bar (or top stripe for FileToolBlock) between
`--yellow-dim` and `--yellow`.

```css
.tool-block[data-status="running"] .exec-margin {
  animation: respiration 2.5s ease-in-out infinite;
}
@keyframes respiration {
  0%, 100% { background: var(--yellow-dim); }
  50%      { background: var(--yellow); }
}
.tool-block[data-status="success"] .exec-margin { background: var(--tool-exec); }
.tool-block[data-status="error"]   .exec-margin { background: var(--tool-error); }
```

On completion the animation stops; the bar solidifies to green (success) or red
(error). For FileToolBlock the same pattern applies to its top stripe instead
of a left bar.

### Thinking elapsed counter (frozen on completion)

While a thinking block is mid-stream, increment the elapsed counter via a
single `requestAnimationFrame` loop in `AgentSessionView` that walks
`state.thinkingStartedAt` and updates a ref-based DOM text node directly. **Do
not** re-render the message list every frame.

When the thinking block completes (next non-thinking block in the same
message, or end of message), capture `elapsed = Date.now() - startedAt` into
`state.thinkingElapsed[blockKey]` and use that frozen value for all subsequent
renders.

```css
.thinking-elapsed {
  font: 10px/1 var(--font-mono);
  color: var(--ink-tertiary);
  font-variant-numeric: tabular-nums;
}
```

Format: `0.8s` (one decimal under 10s), `24s` (integer ≥ 10s).

---

## 7. Spacing System

| Property | Value | Used for |
|---|---|---|
| body line-height | `1.5` | prose, code |
| within-turn gap | `12px` | between content blocks of a single message |
| between-turn gap | `24px` | between message rows (user → assistant → user…) |
| outer padding | `32px` sides | conversation column at default width |
| narrow-pane padding | `16px` sides | when conversation pane width `< 700px` |
| body font-size | `13px` (`--text-lg`) | text |
| tool block font-size | `12px` (`--text-md`) | code, output |
| metadata font-size | `11px` (`--text-base`) | colophon, line numbers, citations |
| smallest metadata | `10px` (`--text-sm`) | timestamps on hover, thinking-elapsed counter |
| tabular-nums | always on | numbers in colophon, line numbers, costs, elapsed |

**Outer padding rule:** the conversation column maintains 32px left/right
padding. Content can extend to the full column width; only the chrome (top bar,
sidebar) gates the outer container. Below 700px, drop to 16px.

**Within-turn vs between-turn:** 12px between a user message's text block and
its next content block (rare); 24px between two consecutive message rows. Tool
blocks within a single assistant message use 12px.

---

## 8. Wording Guidelines (mode-conditional)

Two parallel vocabularies. **Never mix vocab within a mode.**

### Agent-mode vocabulary

- conversation (not "session")
- turn (not "exchange", "interaction")
- ended (not "terminated", "killed")
- Claude (the model — name it)
- project context (not "working directory")
- message (not "command", "input")
- send (not "run", "execute")

### Terminal-mode vocabulary

- session (not "conversation")
- terminate (not "end", "close")
- command (not "message")
- working directory (not "project context")
- run / execute (not "send")
- shell, prefix, flag (terminal-specific terms allowed)

### Per-surface exact strings

#### `SessionCreator` (Phase 6 implements this)

- Step 1 heading: `"How do you want to work?"`
- Mode card titles: `"Chat with Claude"` / `"Terminal"` / `"SSH"`
- Mode card descriptions:
  - Chat: `"Real conversation with Claude on your code. Diffs, tool runs, files."`
  - Terminal: `"A shell or CLI tool of your choice. Claude Code, Aider, Codex, Gemini, Copilot, or just a plain shell."`
  - SSH: `"Connect to a remote machine."`
- Agent-mode label for folder: `"Project context"` (not "Working directory")
- Terminal-mode label for folder: `"Working directory"`
- Approval pills heading (terminal-mode only): `"Approval Flow"` (not "Permission Mode")

#### `StatusBar` (Phase 7 gates conditional render)

- CWD tooltip in agent mode: `"Project context: {fullPath}"`
- CWD tooltip in terminal mode: `"Working directory: {fullPath}"`
- The `Manual / Assisted / Auto` cycle button: **render only in terminal mode.**
  Do not render in agent mode.

#### `CloseSessionDialog` (Phase 8)

- Agent mode title: `"End conversation?"`
- Agent mode body: `"This will end the conversation with Claude."`
- Terminal mode title: `"Close session?"`
- Terminal mode body: `"This will terminate the running terminal session."`

#### `EmptyState` (Phase 8)

- Subtitle: `"AI-native development environment"` (not "AI-native terminal & IDE")

#### `SessionList` close-button title attr (Phase 8)

- Agent mode: `"End conversation"`
- Terminal mode: `"Close session"`

---

## 9. Anti-patterns

Explicit list of things never to do. Each has a one-line "instead" alternative.

- **Don't** add card borders around every block. *Instead:* use hairline rules
  between blocks; reserve borders for blocks that need a stripe (file family).
- **Don't** use border-radius > 3px. *Instead:* sharp corners are typographic;
  the existing `--radius` (3px) is the maximum for any surface.
- **Don't** use drop shadows on conversation blocks. *Instead:* hairline rules
  and color contrast carry hierarchy.
- **Don't** render `"ASSISTANT"` / `"USER"` caps headers. *Instead:* marginalia
  (2px left bar in `--accent-paper` for user, none for assistant).
- **Don't** render an avatar circle for either role. *Instead:* the marginalia
  is the role indicator.
- **Don't** use spinning loaders or `…` typing indicators. *Instead:* heartbeat
  cursor (text), respiration (tool), elapsed counter (thinking).
- **Don't** use emoji in chrome (`📄` `🔍` `✨` `⚡` `🤖`). *Instead:* the §4
  glyph table.
- **Don't** put serif anywhere except WebToolBlock excerpts. *Instead:* mono
  for body, sans (Inter Tight) for chrome.
- **Don't** use 4 decimals on costs (`$0.1266`). *Instead:* `$0.13` (2 decimals).
- **Don't** mix agent-mode tokens (`--ink-*`, `--rule`) with legacy tokens
  (`--text-*`, `--bg-*`) in a single component file. *Instead:* keep them
  segregated by file.
- **Don't** repeat tokens as hex codes in component CSS. *Instead:* always
  reference the token name so a redefinition propagates (`color: var(--tool-file)`,
  not `color: #a78bfa`).
- **Don't** add new npm dependencies for the redesign. *Instead:* hand-roll
  small utilities (LCS for diff, glyph map, etc.).
- **Don't** modify legacy `--text-*` / `--bg-*` tokens. *Instead:* add new
  agent-mode tokens; legacy stays for terminal-mode UI.
- **Don't** name files with "v2" or "redesign" suffixes. *Instead:* replace in
  place (e.g., `BashBlock.tsx` → `ExecToolBlock.tsx` is a deletion + creation).

---

## 10. Manual smoke checklist (run after each phase)

Each phase executor walks the relevant subset of these scenarios. Phase 10
walks all of them.

13. Open a Claude agent session. Confirm: no `ASSISTANT`/`USER` caps headers
    anywhere. User messages have a 2px `--accent-paper` bar in the left margin.
    Assistant messages have no margin bar.
14. Hover a message row. Timestamp appears in the right gutter, `10px mono
    --ink-tertiary`. No timestamp visible by default. Move cursor away —
    timestamp fades out.
15. Send `"list files in src"`. Confirm: tool block has no card border, command
    shown with `▸` glyph in `--tool-exec`, output below in `--ink-secondary`.
    While running, left margin bar respires yellow (2.5s breathing). On
    completion, solidifies to green (`--tool-exec`).
16. Send `"edit src/foo.ts to ..."`. Confirm: file tool block with `--tool-file`
    (violet) top stripe, `◇` glyph in path, `+N, −M` summary in `--ink-tertiary`.
    Click header to expand. Unified diff with line numbers in 28px gutter,
    `--red-dim` / `--green-dim` backgrounds for removed/added lines, context in
    `--ink-secondary`.
17. Send `"search for useState in src"`. Confirm: search tool block with `⌕`
    query line, query in italic mono, results as a list of `path:line ·
    "snippet"` rows separated by 1px hairlines (`--rule`).
18. Send `"fetch https://anthropic.com"`. Confirm: web tool block with
    `¹ url` citation header, excerpt body in **serif** (Newsreader, 13px /
    1.6). Confirm this is the **only** serif text in the UI by inspecting the
    rest of the conversation.
19. Hover the colophon at the end of a turn. Click. Confirm: detail panel
    expands inline (no slide) with `model`, `stop reason`, `cache`, `tokens`,
    full duration. Click again to collapse.
20. While Claude is mid-stream, confirm: typing cursor (1px vertical bar)
    blinks at heartbeat rhythm (1.06s) at the end of the streaming text block.
    Cursor disappears the instant streaming completes — no fade.
21. Click `New Session`. Step 1 is `"How do you want to work?"` with three
    radio cards (`Chat with Claude` / `Terminal` / `SSH`). Default selection:
    `Chat with Claude`. Pick it; confirm Step 2 is just a folder picker, no
    permission pills, no shell prefix, no initial dimensions.
22. Pick `Terminal` instead. Confirm Step 2 is provider picker (Claude Code /
    Aider / Codex / Gemini / Copilot / Kiro / Plain shell). Step 3 has the
    existing terminal-only fields (permission pills, prefix, dimensions).
23. In Agent mode StatusBar, confirm: no `Manual / Assisted / Auto` cycle
    button. In Terminal mode, confirm: it is present.
24. Try to close an agent session. Dialog title says `"End conversation?"`,
    body says `"This will end the conversation with Claude."` Try to close a
    terminal session — title says `"Close session?"`, body says `"This will
    terminate the running terminal session."`
25. EmptyState (no sessions): subtitle reads `"AI-native development
    environment"`. No "terminal" word in the marquee.

### Foundation smoke (Phase 0 — runs before any subsequent phase)

A. Open the running app in a Claude agent session. DevTools → Network →
   filter by `font`. Confirm three woff2 200 responses:
   `JetBrainsMono-Regular.woff2`, `InterTight-Variable.woff2`,
   `Newsreader-Variable.woff2`.
B. DevTools → Elements → inspect a tool block. Computed `font-family` includes
   `JetBrains Mono`. Inspect a status bar label. Computed `font-family`
   includes `Inter Tight`.
C. Render a placeholder WebToolBlock (or wait until Phase 3). Computed
   `font-family` includes `Newsreader`.
D. `npm run test` is green. The `playbook-exists` test passes.
E. `npx tsc --noEmit` is clean.
