import { updateSettings } from "../terminal/TerminalPool";

/**
 * Theme catalog (1.1.15).
 *
 * Hermes shipped 30 themes through 1.1.14.  v1.1.15 consolidates that
 * to **eight** — four dark, four light — with one shared identity:
 * triple-font system (Inter Tight UI · JetBrains Mono code · Newsreader
 * serif), brass-rail accent placement, editorial layout grammar.
 * Mood varies; vocabulary doesn't.  See
 * `docs/mockups/themes-and-ui-improvements.html` for the spec.
 *
 * The 22 dropped themes are migrated, not erased — see
 * `LEGACY_THEME_MIGRATIONS` below.  Existing users keep their nearest
 * cousin and never see a broken stylesheet.
 */

export const DARK_THEMES = [
  { id: "frosted-dark", label: "Frosted Dark" },
  { id: "atelier", label: "Atelier" },
  { id: "observatory", label: "Observatory" },
  { id: "phosphor", label: "Phosphor" },
] as const;

export const LIGHT_THEMES = [
  { id: "frosted-light", label: "Frosted Light" },
  { id: "linen", label: "Linen" },
  { id: "newsprint", label: "Newsprint" },
  { id: "atrium", label: "Atrium" },
] as const;

export const THEME_OPTIONS = [...DARK_THEMES, ...LIGHT_THEMES] as const;

/** Default theme for fresh installs and unrecognised stored values. */
export const DEFAULT_THEME_ID = "frosted-dark";

/** Set of valid theme ids in the v1.1.15 catalog. */
const VALID_THEME_IDS: ReadonlySet<string> = new Set(
  THEME_OPTIONS.map((t) => t.id),
);

/**
 * Migration table: every theme id that shipped in 1.0–1.1.14 maps to
 * its nearest cousin in the new eight.  The mapping is opinionated —
 * we group by mood and chroma, not by name (e.g. "tron" → "phosphor"
 * because it was neon-on-black; "midnight" → "observatory" because it
 * was navy + brass; "amber" → "atelier" because it was warm cocoa).
 *
 * This table is *additive*: the renamed-in-place case ("designer" →
 * "atelier") lives here too, alongside true drops.  `normalizeThemeId`
 * applies it once on read; `applyTheme` then writes the new id back to
 * settings so the next boot is clean (see `applyTheme` below).
 *
 * If you remove a theme in the future, add it here.  Never delete an
 * entry — old entries are how stale settings.json files keep working.
 */
export const LEGACY_THEME_MIGRATIONS: Record<string, string> = {
  // ─── Pre-v1.1.15 darks ─────────────────────────────────────
  "dark":            "frosted-dark",   // generic dark → modern neutral
  "hacker":          "phosphor",       // green-on-black CRT
  "nightowl":        "frosted-dark",   // modern dark
  "tron":            "phosphor",       // neon-on-black → CRT
  "duel":            "frosted-dark",   // split-color → neutral
  "80s":             "phosphor",       // retro neon → CRT
  "midnight":        "observatory",    // navy → vintage instrument
  "neon-sunset":     "atelier",        // warm dark
  "polar":           "frosted-dark",   // cold neutral
  "reactor":         "phosphor",       // green terminal → CRT
  "amber":           "atelier",        // warm
  "macchiato":       "atelier",        // warm cocoa
  "shibuya":         "frosted-dark",   // urban modern
  "solarized-dark":  "atelier",        // warm earthy
  "evergreen":       "observatory",    // forest green + brass-y → vintage
  "cobalt":          "frosted-dark",   // blue accent
  "minimal-dark":    "frosted-dark",   // clean
  "transilvania":    "atelier",        // dark warm
  "rainbow":         "frosted-dark",   // multi-color → neutral fallback
  "data":            "frosted-dark",   // techy
  "corporate":       "frosted-dark",   // enterprise → clean
  "designer":        "atelier",        // direct rename — was already "Atelier"

  // ─── Pre-v1.1.15 lights ────────────────────────────────────
  "light":           "frosted-light",  // generic light → modern neutral
  "solarized":       "linen",          // warm cream
  "rose":            "linen",          // warm pastel
  "lavender":        "atrium",         // cool soft
  "mint":            "atrium",         // cool soft
  "sand":            "linen",          // warm sand
};

/**
 * Resolve a stored theme id (which may be a legacy / typo / unknown
 * value) to a valid id from the current catalog.
 *
 * - Known valid id          → returned unchanged
 * - Known legacy id         → mapped via LEGACY_THEME_MIGRATIONS
 * - Anything else (typo, "", null-y, future id we don't know) →
 *   `DEFAULT_THEME_ID` so the app never paints with a missing
 *   stylesheet.
 *
 * Pure function — no DOM access, safe to call from tests.
 */
export function normalizeThemeId(stored: unknown): string {
  if (typeof stored !== "string" || stored.length === 0) return DEFAULT_THEME_ID;
  if (VALID_THEME_IDS.has(stored)) return stored;
  const migrated = LEGACY_THEME_MIGRATIONS[stored];
  if (migrated && VALID_THEME_IDS.has(migrated)) return migrated;
  return DEFAULT_THEME_ID;
}

/**
 * True iff `id` was migrated by `normalizeThemeId` (i.e. the stored
 * value is *not* a current valid id).  Used by `applyTheme` to decide
 * whether to write the new id back to settings.
 */
export function wasThemeMigrated(stored: unknown): boolean {
  if (typeof stored !== "string" || stored.length === 0) return true;
  return !VALID_THEME_IDS.has(stored);
}

export const UI_SCALE_OPTIONS = [
  { id: "compact", label: "Compact (90%)" },
  { id: "default", label: "Default (100%)" },
  { id: "comfortable", label: "Comfortable (115%)" },
  { id: "large", label: "Large (130%)" },
  { id: "x-large", label: "Extra Large (150%)" },
] as const;

// Base token values (must match tokens.css :root defaults).
// Updated for design-system v2 (modular 1.125 scale rooted at 13px).
// See docs/design-system/01-typography.md and 08-tokens-reference.md.
const BASE_TOKENS = {
  // Type scale — 1.125 modular ladder
  "--text-2xs": 10,
  "--text-xs": 11,
  "--text-sm": 12,
  "--text-base": 13,
  "--text-md": 14,
  "--text-lg": 16,
  "--text-xl": 18,
  "--text-2xl": 22,
  "--text-3xl": 28,
  "--text-display": 36,
  // Spacing
  "--space-1": 4,
  "--space-2": 8,
  "--space-3": 12,
  "--space-4": 16,
  "--space-5": 24,
  "--space-6": 32,
  "--space-7": 48,
  "--space-8": 72,
  // Layout heights / widths
  "--topbar-h": 40,
  "--statusbar-h": 28,
  "--sidebar-w": 240,
  "--context-w": 288,           // on 24px snap grid (12 × 24)
  "--activity-bar-w": 36,
  // Radius
  "--radius": 3,
  "--radius-sm": 3,
  "--radius-lg": 6,
  // --radius-pill is not here: it is an alias of --radius-full (999px, or
  // 1px in the sharp themes) and must stay a pill at every scale.
  // Icons + buttons — slightly bigger than the previous 18px for comfort
  "--icon-size": 18,            // tab icons (kept at 18 since SVGs render at viewBox 0 0 18 18)
  "--icon-size-sm": 14,
  "--icon-size-lg": 22,
  "--btn-size": 28,
};

const SCALE_FACTORS: Record<string, number> = {
  compact: 0.9,
  default: 1.0,
  comfortable: 1.15,
  large: 1.3,
  "x-large": 1.5,
};

// Theme-specific token overrides — values that differ from BASE_TOKENS.
// Inline styles beat CSS selectors, so we MUST honour theme-specific
// values here even when the user has the default UI scale.  Keep this
// in sync with the [data-theme=…] blocks in themes.css.
const THEME_TOKEN_OVERRIDES: Record<string, Partial<Record<string, number>>> = {
  // Frosted Dark / Frosted Light — soft Apple-style rounding (matches
  // the macOS HUD vocabulary the theme borrows from).
  "frosted-dark": {
    "--radius": 6,
    "--radius-sm": 4,
    "--radius-lg": 10,
  },
  "frosted-light": {
    "--radius": 6,
    "--radius-sm": 4,
    "--radius-lg": 10,
  },
  // Phosphor — sharp corners (a CRT terminal doesn't round).
  "phosphor": {
    "--radius": 0,
    "--radius-sm": 0,
    "--radius-lg": 1,
  },
  // Newsprint — also sharp; broadside grid wants right angles.
  "newsprint": {
    "--radius": 0,
    "--radius-sm": 0,
    "--radius-lg": 0,
  },
};

export function applyUiScale(scaleId: string, themeId?: string): void {
  const factor = SCALE_FACTORS[scaleId] ?? 1.0;
  const overrides = themeId ? THEME_TOKEN_OVERRIDES[themeId] : undefined;
  const root = document.documentElement;
  for (const [prop, base] of Object.entries(BASE_TOKENS)) {
    const value = overrides?.[prop] ?? base;
    root.style.setProperty(prop, `${Math.round(value * factor)}px`);
  }
}

/**
 * Apply a theme to <html>.
 *
 * Migration policy: any stored theme id that isn't in the current
 * catalog is mapped to its nearest cousin via `normalizeThemeId`,
 * applied immediately, AND written back to settings so the next boot
 * is clean.  This is the *only* path that mutates the stored theme
 * for a migration; every other code path treats the stored value as
 * authoritative.
 */
export function applyTheme(
  themeId: string,
  allSettings: Record<string, string>,
): void {
  const normalized = normalizeThemeId(themeId);
  // Set data-theme on <html>.  Every theme — including the default —
  // gets an explicit attribute so theme-conditional CSS selectors fire
  // uniformly.  (Pre-1.1.15 the "dark" theme deleted the attribute and
  // relied on :root tokens; that's gone — :root now mirrors
  // frosted-dark, so an unset state is identical to the default.)
  document.documentElement.dataset.theme = normalized;

  // Apply UI scale (pass themeId so theme-specific token overrides are honoured)
  applyUiScale(allSettings.ui_scale || "default", normalized);

  // If the stored id was migrated, write the canonical id back to
  // settings so subsequent boots don't keep re-running the migration.
  // This is fire-and-forget — failure to persist is benign because
  // normalizeThemeId is idempotent on the next boot.
  if (wasThemeMigrated(themeId)) {
    void persistMigratedThemeId(normalized);
  }

  // Sync terminal colors
  updateSettings({ ...allSettings, theme: normalized });
  // Notify editor to refresh syntax highlight colours
  window.dispatchEvent(new CustomEvent("hermes:theme-changed"));
}

/** Persist the migrated id back to the settings table.  Imported
 *  lazily so this module stays usable in test environments without a
 *  running Tauri runtime. */
async function persistMigratedThemeId(themeId: string): Promise<void> {
  try {
    const { setSetting } = await import("../api/settings");
    await setSetting("theme", themeId);
  } catch {
    // Best-effort persist — don't surface migration write failures.
  }
}

/** Apply the agent-timeline style preference to <html>.  CSS under
 *  `html[data-agent-timeline-style="classic"]` restores the denser
 *  pre-1.1 logbook look (mono body, brass left-bar on user messages,
 *  hairline rules between turns) on top of whichever theme is active.
 *  `modern` (default) is the speaker-chip / sans-serif layout. */
export function applyAgentTimelineStyle(style: string | undefined): void {
  const value = style === "classic" ? "classic" : "modern";
  if (value === "modern") {
    delete document.documentElement.dataset.agentTimelineStyle;
  } else {
    document.documentElement.dataset.agentTimelineStyle = value;
  }
}
