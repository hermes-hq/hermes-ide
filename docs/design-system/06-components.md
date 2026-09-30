# 06 · Components

## ThinkingBlock

**Posture:** A thinking trace is a footnote attached to a message, not a
free-standing container.

**Rules:**
1. Collapsed state renders only the **chip** — no full-width container.
2. The chip carries the elapsed counter and a disclosure caret.
3. Expanded state renders the body **inside** the chip's footprint (the
   chip flips into a card flush with the speaker rail).
4. The block lives within the assistant message's left rail — there is a
   visible parent–child relationship.

```tsx
<div className={`agent-thought ${open ? "is-open" : ""}`}>
  <button className="agent-thought-chip" onClick={...}>
    <span className="agent-thought-dot" aria-hidden="true" />
    {live ? "thinking" : "thought"}
    {elapsedLabel && <span className="agent-thought-elapsed"> · {elapsedLabel}</span>}
    <span className="agent-thought-caret" aria-hidden="true">{open ? "▾" : "›"}</span>
  </button>
  {open && <pre className="agent-thought-body">{block.thinking}</pre>}
</div>
```

**Anti-pattern:** Rendering the dashed container unconditionally so it
appears as an empty box when collapsed. (The pre-fix bug.)

## Status bar

**Structure:** Three zones with `--rule-zone` dividers.

```html
<footer class="status-bar">
  <!-- Zone 1 · Identity -->
  <span class="status-branch">main</span>
  <span class="status-version-chip" data-state="idle">v1.1.16</span>
  <div class="status-zone-rule" />

  <!-- Zone 2 · Session state -->
  <span class="status-capsule" data-state="busy">...</span>
  <div class="status-mode-segmented" role="radiogroup">...</div>
  <div class="status-zone-rule" />

  <!-- Zone 3 · Metrics -->
  <span class="status-tokens">14,238 tok</span>
  <span class="status-cost">$0.42</span>
  <span class="status-elapsed">4:12</span>
</footer>
```

### Status capsule (busy / needs-input)

A pill with a breathing dot + tracked uppercase label. Slow shimmer
sweeps across the pill while busy.

### Mode segmented control

Three flush pill-segments: `[Manual · Assisted · Auto]`. Active segment
filled with its mode color, inactive segments are ghost labels with no
fill. Replaces cycle-on-click — users always see all three options.

### Version chip (4 states)

One element, four states (`data-state`): `idle` / `checking` /
`available` / `downloading`. In `downloading`, the border is a
clockwise progress arc (conic gradient + radial mask).

### Color discipline

Static metadata uses `--text-2`. Color is reserved for change-of-state:
- `--success` on busy
- `--warning` on needs-input
- `--voice-user` flash on cost-just-changed (fades back to `--text-2` over 1.5s)
- `--danger` on error

## Activity bar

**Posture:** Cardinal landmark. Never bobs, never shifts, always
anchored.

**Rules:**
1. Icon geometry is frozen — hover only reveals a horizontal label
   pop-out beside the icon.
2. A single `--rail` element travels between active tabs (spring easing).
3. Badges are the control set's `Counter` (16px), floating top-right of
   the icon: neutral for a plain count (open sessions), brass
   (`tone="attention"`) only when the count needs you.
4. The pinned group and reorderable group are separated by an etched
   1px groove (not a flat separator).

**Anti-pattern:** Per-tab `::before` accent rectangles that flicker on
state change; hover-height changes that shift neighboring tabs.

## Session list

**Current row:** each row is a `ListRow`; the session in view is filled
with `--row-active-bg` and carries the 2px brass rail on its left. Row
metadata is drawn in inks held to 4.5:1 on that fill (the row lifts
`--text-3` to `--text-2`; status words use the `-ink` tokens). The row's
close button is the one `CloseButton`, shown on the current row, on hover
and with the keyboard.

**Row composition:** Two zones.
1. Identity — name + (optional, hidden by default) description
2. State — git row + monogram glyphs + phase tag (hidden when row inactive)

**Phase signal lives on the color band** (3px wide, full row height):
- `idle` — solid voice color
- `busy` — vertical shimmer
- `needs_input` — amber pulse
- `error` — solid danger

**Monograms** replace the previous agent and SSH tag chips: a single
14px brass-ringed glyph (`C` for Claude, `◍` for SSH, etc.) tucked next
to the name.

**Skeletons during boot:** ruled-paper stripes with brass-tinted
shimmer fill the row positions while data hydrates.

## Composer

**Send pill:** A 34px brass circular button anchored bottom-right of the
composer card with a paper-plane glyph. States:

- **disabled** — hollow ring, no fill
- **armed** — brass fill, raised shadow
- **submitting** — thin animated arc rotates around the rim
- **hover (armed)** — a small `⌘⏎` kbd hint appears beneath

**Measure cap:** content area is capped at `max-width: 76ch` and
centered within the pane. The wrapper background bleeds full-width.

**Focus state:** the card lifts via `--shadow-2` + `--focus-ring-shadow`,
border becomes `--focus-ring` color.

## Empty state · Logbook

**Row composition:** Two lines per entry.
1. Top line — № number, color dot, title, project, time-ago
2. Bottom line — last-prompt snippet + meta chips (model, message count,
   cost)

On hover, a 1px brass page-edge appears on the left and the arrow slides
4px right with a brass tint. Maintains the editorial / workshop tone.

## Agent surface

**Voice rails:** Every message has a left rail in its voice color:
- User messages — `--voice-user` (warm)
- Assistant messages — `--voice-agent` (cool)

**Heading scale:** See [01-typography.md](./01-typography.md). h1 24px /
h2 20px / h3 16px / h4 14px tracked uppercase.

**Blockquotes:** Always Newsreader, italic, opsz 14, with a 2px left
rule in `--rule-strong`.

**Message entry:** 220ms opacity + translateY(6px) on first mount only.

## Tool blocks

**Header:** title + status indicator + **elapsed counter** + **probabilistic arc**

The elapsed counter mirrors the ThinkingBlock format (tenths under 10s,
integer seconds above). The arc fills clockwise to the rolling p50
duration of past invocations for that tool family. Unknown tools get a
pulse-then-decay rhythm that visibly slows over time.

## Modals, popovers, command palette

Use `--bg-elevated` + `--shadow-3` (popover) or `--shadow-4` (dialog)
+ `--radius-lg`. No hand-rolled shadows.

Enter animation: `var(--dur-slow) var(--ease-out-expo)` opacity + scale.

## Bad patterns to avoid

```tsx
/* ✗ Container that's empty when collapsed */
<div className="thinking-block-container">  {/* dashed border, padding */}
  <Toggle />
  {open && <Body />}
</div>

/* ✓ Chip collapses to its content */
<div className={`thought ${open ? "is-open" : ""}`}>
  <button className="thought-chip">...</button>      {/* the visible element when collapsed */}
  {open && <pre className="thought-body">...</pre>}
</div>
```

## Controls

Every button, field, list, toggle and badge comes from one set of React
components in `src/components/ui/` (styles in `src/styles/ui/`). A screen
never styles its own button or select; it picks a component and a variant.
Open **Settings → Flags → Controls preview** (click the Settings title seven
times to show Flags) to see every control in every state, in any theme.

**Signature: brass is the operator's hand.** Anything that commits your
intent is brass (`--primary-bg`): the primary button, a checked box, a
toggle that is on, the rail under the selected tab or beside the current
row, and the focus ring. Blue stays with the agent and with links.

### Rules

1. **One primary per surface.** A dialog, sheet or panel has at most one
   `primary` button, right-most in its footer. Everything else is
   `secondary` or `quiet`. The step's own "Next"/"Finish" is the primary,
   not a helper action beside it.
2. **Three heights.** `md` (32 px, `--control-h-md`) everywhere by default;
   `sm` (28 px) only in dense chrome (toolbars, list rows) with ≥ 4 px
   between targets; `lg` (36 px) only on the welcome and empty states.
   Heights go through `--density-y`.
3. **One focus ring.** A solid 2 px `--focus-ring` outline, 2 px away from
   the control (`base.css`). Fields do not change their border on focus.
   Never `outline: none` without drawing the same ring another way.
4. **Selection is never colour alone:** a raised keycap, a rail, a check, a
   dot or the knob's position always goes with it.
5. **Disabled** is `opacity: .45`, no hover, `cursor: not-allowed`.
6. **No hardcoded text.** Every label and accessible name comes from
   `t("…")`; icon-only controls must be given a `label` (the types require
   it).
7. **Contrast.** Text ≥ 4.5:1 on every fill it is drawn on (hover and
   selected included); field edges, the focus ring and brass marks ≥ 3:1.
   `scripts/contrast-audit.mjs` checks every pair in all eight themes and
   runs in the unit tests.

### Components

| Component | Use it for | Notes |
|---|---|---|
| `Button` | An action. `primary` (brass, one per surface), `secondary` (default), `quiet` (toolbar and tertiary actions), `danger` (a destructive action among others), `danger-solid` (only as the primary of a confirm dialog), `link` (inline "Sign in", "Check again") | `size` sm/md/lg. `loading` keeps the label, shows a brass sweep, sets `aria-busy` and ignores presses. Presses move the button down half a pixel; nothing scales. |
| `IconButton` | An action shown as an icon only | `label` is required: it is the accessible name and the tooltip. `pressed` for icon toggles. md 32 or sm 28. |
| `CloseButton` | Closing any dialog, sheet or panel | Always a small icon button with one drawn ×. Replaces every "x", ×, ✕ and `.close-btn`. |
| `Input`, `Textarea` | Free text | `code` for paths, branches and commands (code font, 12 px). `error` shows the message under the field and links it with `aria-describedby`; `invalid` alone marks the field. |
| `Select` | Choosing a value whose options carry a status or version ("2.1.284", "not installed"), or anything longer than a handful of plain words | Combobox with `aria-activedescendant`; focus stays on the trigger. Enter, Space, ↑, ↓ or Alt+↓ open; ↑ ↓ Home End PgUp PgDn move without wrapping; type-ahead (500 ms, repeat a letter to cycle); Enter/Space or Tab commit; Esc reverts. Typing while closed changes the value, like a native select. Options have a check slot, a label and a right-hand detail; disabled options are skipped. The trigger and each option carry `data-value`, the way automation reads a native select. |
| `NativeSelect` | Short lists of plain text in Settings (shell, scrollback, font size, channel) | A real `<select>` with the trigger's look; the OS draws the list, like the right-click menus. |
| `Menu` | A list of actions (not values) behind a button | `role=menu`, same keys as Select, focus returns to the trigger. Shortcut hints on the right, separators, destructive items in the danger ink (a highlighted destructive item turns its row red). |
| `Chip` | A compact value: a model, a filter, a scope | Neutral by default; `selected` + `onToggle` makes it a toggle button (`aria-pressed`, brass tint); `onRemove` + `removeLabel` adds a trailing ×; `expands` makes it open a panel of choices for its value (`aria-expanded`, a chevron, brass while open); `onClick` makes an action chip, one button (a pane-header chip that opens its detail: `expanded`, `haspopup`); `tone="danger"` marks a risky value; `buttonAttrs` puts a hook class, tooltip and `data-*` on a toggle chip's button, other attributes go on the chip's outer element. sm 24 / md 28, fully round. |
| `Segmented` | Picking one of two to five views of the same content ("By file / By turn") | `radiogroup` with one tab stop; arrows move and select, Home/End jump. The selected segment is a raised keycap in a recessed well. An option’s `attrs` puts a hook class, tooltip and `data-*` on its segment. |
| `Tabs` | Switching between separate views of one surface | `tablist` with automatic activation (arrows select). Horizontal: brass rail under the selected tab. `orientation="vertical"` for a navigation column (Settings): 32 px rows, current row filled with `--row-active-bg` plus a left rail. Pair panels with `TabPanel`. |
| `Checkbox` | Picking items, and consent | 16 px box, brass when checked, `indeterminate` shows a bar (`aria-checked="mixed"`). The label makes the row ≥ 32 px tall. |
| `Toggle` | An on/off setting that applies at once — every Settings boolean | `role=switch`, 32 × 18 track. |
| `RadioGroup` / `Radio` | One of a few choices that need a description each | One tab stop; arrows move and select in every engine. An option’s `attrs` goes on its radio; `Checkbox` and `Radio` take `inputClassName` for a hook on the box itself. |
| `Badge` | A short status word ("EXACT", "RETIRED") | 18 px, 10 px caps. Tones: neutral, success, warning, danger, info (the `-dim` fill with the tone's ink). |
| `ListRow` | A row of a list, listbox or the sidebar | `size` sm (32 px, one line: command palette) or lg (44 px, two lines: inbox); left out, it sizes to its content (a sidebar session). `highlighted`: the hover fill (keyboard or pointer), metadata inks lift to `--text-1`. `current`: the thing in view, `--row-active-bg` plus the 2 px brass rail; current and highlighted adds a hairline. |
| `Counter` | A count on a tab, button or icon | 16 px, tabular digits, `max` shows "99+". Neutral by default; `attention` (brass) only when the count needs you. `label` gives screen readers the meaning. Nothing is smaller than 10 px. |

### Tokens

Heights, paddings and fonts: `--control-h-{sm,md,lg}`, `--control-px-*`,
`--control-font-*`, `--control-weight`. Radii: `--radius-xs` 3,
`--radius-sm` 4, `--radius-md` (= `--radius`), `--radius-lg` 10,
`--radius-full` (`--radius-pill` is its deprecated alias). Focus:
`--focus-ring`, `--focus-ring-width`, `--focus-ring-offset`. Colour roles,
set per theme in `themes.css` ("Controls"): `--primary-bg`/`-hover`/
`-active`/`--primary-fg`, `--control-bg`/`-hover`/`-active`/`--control-border`/
`--control-fg`, `--field-bg`/`--field-border`/`-hover`, `--quiet-hover-bg`,
`--quiet-active-bg`, `--selected-bg`, `--row-active-bg`, `--popover-bg`,
`--danger-fg`, `--danger-solid-bg`, `--success-ink`, `--warning-ink`,
`--info-ink`, `--link-fg`, `--chip-selected-*`, `--toggle-*`.

### Lint

`node scripts/lint-css.mjs` (CI: Frontend job) applies `.stylelintrc.json`
to every line of `src/styles/ui/` and of new stylesheets, and to the added
lines of older ones: no raw px, raw colours, hand-rolled shadows or easing,
raw font weights or `outline: none`. The older lines are the baseline and
migrate with their screens. A screen that has moved to the control set
lists its stylesheet in `STRICT_FILES` (scripts/lint-css.mjs), which holds
every line of it to the rules from then on: so far the task launcher, the
three-step welcome with its agent doctor, and the New Session creator with
its branch step.
