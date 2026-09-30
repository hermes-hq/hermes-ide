# 07 · Accessibility

## Contrast contract

Every text token declares a minimum WCAG contrast ratio against
`--bg-1`. Themes that fail are bugs.

| Token       | Minimum ratio                       |
| ----------- | ----------------------------------- |
| `--text-0`  | ≥ 12:1                              |
| `--text-1`  | ≥ 7:1                               |
| `--text-2`  | ≥ 4.5:1                             |
| `--text-3`  | ≥ 4.5:1 (or 3:1 for ≥18px / bold ≥14px) |

### Light themes — fixed values

Three light themes previously failed AA for `--text-3`. The new values:

| Theme         | `--text-3` was | now      | ratio on `--bg-1` |
| ------------- | -------------- | -------- | ----------------- |
| Frosted Light | `#9c9ca0`      | `#7a7a7e`| 4.6 : 1           |
| Atrium        | `#a8b0bc`      | `#6a7280`| 4.7 : 1           |
| Linen         | `#a89a82`      | `#8a7a5a`| 4.6 : 1           |

The change is visually subtle (only the L value shifts ~10 points; the
hue stays the same) but restores a population segment that was locked
out.

### Verification

`scripts/contrast-audit.mjs` resolves every theme's tokens from
`tokens.css` and `themes.css` and checks the pairs the controls rely on:
the four text tokens on every surface (`--bg-0`, `--bg-1`, `--bg-2`,
`--bg-elevated`, `--popover-bg`), labels on every button fill including
hover and pressed, placeholders, links, badge inks on their tints, and the
non-text pairs (field edges, focus ring, brass marks, toggle track and
knob). Text must reach 4.5:1 and non-text 3:1 in all eight themes; the unit
tests run it, and CI prints any failing pair by name:

```bash
node scripts/contrast-audit.mjs          # failures only
node scripts/contrast-audit.mjs --all    # every pair with its ratio
```

## Focus ring

Every focusable element MUST display a visible focus ring on every
theme: one solid ring, 2 px wide and 2 px away from the control, in the
theme's `--focus-ring` (brass — the operator's hand; ≥ 3:1 on every
surface).

```css
:root {
  --focus-ring-width: 2px;
  --focus-ring-offset: 2px;
  --focus-ring-shadow: 0 0 0 var(--focus-ring-width) var(--focus-ring);
}
```

Global rule in `base.css`:

```css
:focus-visible {
  outline: var(--focus-ring-width) solid var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
}
```

The rule leaves `box-shadow` alone, so a focused card or popover keeps
its elevation. It has the lowest specificity, so any `outline: none` in a
more specific rule (`.item:focus-visible`, `.field input`), or in a
lazily loaded stylesheet that lands after `base.css`, hides it.

Inside a container that would clip it (a segmented well, a tab bar, a
scrolling list, a borderless sheet that fills its panel, a 28 px chrome
line that holds 28 px buttons: the pane header, the scope bar, the status
strip and the status bar at the window's edge) the ring is drawn inset (`outline-offset: calc(-1 * var(--focus-ring-width))`).
The UI-chrome scenario checks that each chrome ring fits inside the window
and every clipping ancestor.
`--focus-ring-shadow` draws the same ring for the few components that
still show focus with a box-shadow.

**Rule:** No component may declare `outline: none` without drawing the
same ring another way; `scripts/lint-css.mjs` rejects a new
`outline: none`.

## Motion sensitivity

The global default in `base.css` honors `prefers-reduced-motion`:

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

Critical motion utilities (`.hermes-progress`, `.hermes-skel`,
`.agent-cursor`, `.status-capsule-pulse`) provide an explicit
reduced-motion fallback that retains a useful static state — they
should not vanish entirely.

## Keyboard affordance

- Every interactive control is reachable via Tab.
- Tab order follows visual order (no `tabindex` greater than 0).
- Composite controls (mode segmented, tab strips) implement standard
  ARIA patterns:
  - Mode segmented: `role="radiogroup"`, each segment `role="radio"`
    with `aria-checked`.
  - Tabs: `role="tablist"` / `role="tab"` with `aria-selected`.
- `kbd` elements render in `var(--font-code)` with `--tracking-normal`
  — they communicate exact key names, so the mono affordance matters.

## Screen reader announcements

State changes that matter to a non-sighted user are announced via
`aria-live`:

```html
<span class="status-capsule" role="status" aria-live="polite">
  <span class="status-capsule-pulse" aria-hidden="true" />
  <span class="status-capsule-label">WORKING</span>
</span>
```

- `aria-live="polite"` for transient status (busy, idle, cost updates)
- `aria-live="assertive"` for blocking states (permission needed, error)

## Color is never the only signal

If a state is signaled by color (red error, amber waiting, green
success), it MUST also carry one of:

- An icon glyph
- A text label
- A shape change (pulse vs solid)

Color-only signaling fails for users with color blindness and is a
documentation gap for any state.
