# 09 · Migration & deprecation

## What changed in this release

The redesign added new tokens but **kept all legacy tokens as aliases**.
Existing code that references `--brass`, `--accent`, `--green`, etc.
continues to work unchanged.

## Legacy aliases

```css
/* color */
--accent       → --voice-agent       (in multi-tone themes)
--brass        → --voice-user        (in multi-tone themes)
--green        → --success
--red          → --danger
--yellow       → --warning
--error        → --danger
--border       → --rule-card
--border-light → --rule-zone

/* font */
--font-mono    → --font-code
--font-sans    → --font-ui
```

In mono-tone themes (Atelier, Linen, Phosphor) the voice tokens are
deliberately aliased to the same accent — `--voice-user` and
`--voice-agent` both equal `--accent`. That's intentional, not a
migration gap.

## What you should do in new code

Use the new tokens whenever you write or modify CSS. Migrate the legacy
tokens opportunistically when you touch a file for another reason. There
is no big-bang rewrite required.

| Old                            | New                               |
| ------------------------------ | --------------------------------- |
| `color: var(--brass)`          | `color: var(--voice-user)`        |
| `color: var(--accent)`         | `color: var(--voice-agent)`       |
| `color: var(--green)`          | `color: var(--success)`           |
| `border: 1px solid var(--border)` | `border: 1px solid var(--rule-card)` |
| `font-weight: 600`             | `font-weight: var(--weight-semibold)` |
| `line-height: 1.6`             | `line-height: var(--leading-relaxed)` |
| `font-family: var(--font-mono)` | `font-family: var(--font-code)`  |
| `letter-spacing: 0.05em`       | `letter-spacing: var(--tracking-wider)` |

## Hardcoded values that need migration

The lint rules in this folder reject these patterns. If a stylelint run
fails on a file you didn't touch, fix the file you touched first; we'll
sweep the rest in dedicated migration PRs.

### Magic numbers

```css
/* ✗ */ padding: 5px; gap: 7px; margin: 13px;
/* ✓ */ padding: var(--space-1); gap: var(--space-2); margin: var(--space-3);
```

### Hand-rolled shadows

```css
/* ✗ */ box-shadow: 0 4px 12px rgba(0,0,0,.4);
/* ✓ */ box-shadow: var(--shadow-2);
```

### Hand-rolled cubic-bezier

```css
/* ✗ */ transition: opacity 200ms cubic-bezier(0.16, 1, 0.3, 1);
/* ✓ */ transition: opacity var(--dur-base) var(--ease-out-expo);
```

### Raw weight numbers

```css
/* ✗ */ font-weight: 600;
/* ✓ */ font-weight: var(--weight-semibold);
```

### Mixed-unit tracking

```css
/* ✗ */ letter-spacing: 0.5px;     /* doesn't scale with font-size */
/* ✓ */ letter-spacing: var(--tracking-widest);
```

## Stylelint rules

```jsonc
// .stylelintrc.json
{
  "rules": {
    "declaration-property-value-disallowed-list": {
      "/^padding|^margin|^gap|^row-gap|^column-gap/": ["/\\d+px/"],
      "/^font-weight/": ["100", "200", "300", "400", "500", "600", "700", "800", "900"],
      "/^line-height/": ["/^[0-9.]+$/"],
      "/^transition|^animation/": ["/cubic-bezier/"]
    },
    "declaration-property-value-allowed-list": {
      "/^box-shadow/": ["var(--shadow-1)", "var(--shadow-2)", "var(--shadow-3)", "var(--shadow-4)", "none", "inset", "/var\\(--focus-ring/"]
    }
  }
}
```

The live config is `.stylelintrc.json` (the rules above, plus no raw
colours, no raw px and no `outline: none`). `node scripts/lint-css.mjs`
enforces it on every line of `src/styles/ui/` and of new stylesheets, and on
the added lines of older ones, so existing lines are a baseline that
migrates with its screen (see 06-components.md · Controls).

## ThinkingBlock-specific migration

The pre-fix `ThinkingBlock.tsx` rendered a `.agent-thinking-block` div
that always carried the dashed border. The new component uses
`.agent-thought` and `.agent-thought-chip`. **Both classes are styled
in `AgentSessionView.css`**; the old class is preserved as a deprecation
alias that maps to the new look-and-feel during the transition.

If you import `ThinkingBlock`, no change is needed — the component
shape is the same. If you wrote custom CSS targeting
`.agent-thinking-block`, switch to `.agent-thought`.
