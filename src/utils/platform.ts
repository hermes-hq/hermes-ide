// ─── Platform Detection ─────────────────────────────────────────────
// Single source of truth for all OS-specific logic in the frontend.

type Platform = "mac" | "win" | "linux";

function detectPlatform(): Platform {
  const ua = (typeof navigator !== "undefined" ? navigator.userAgent ?? "" : "").toLowerCase();
  if (ua.includes("macintosh") || ua.includes("mac os")) return "mac";
  if (ua.includes("windows")) return "win";
  if (ua.includes("linux")) return "linux";
  return "mac";
}

/** Current platform, detected once at module load. */
export const PLATFORM: Platform = detectPlatform();

export const isMac = PLATFORM === "mac";
export const isWin = PLATFORM === "win";
export const isLinux = PLATFORM === "linux";

/**
 * Returns true when the platform's "action" modifier is held.
 * - macOS: metaKey (⌘)
 * - Windows/Linux: ctrlKey
 */
export function isActionMod(e: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return isMac ? e.metaKey : e.ctrlKey;
}

// ─── Shortcut Formatting ────────────────────────────────────────────

const MAC_SYMBOLS: Record<string, string> = {
  "{mod}": "⌘",
  "{shift}": "⇧",
  "{alt}": "⌥",
  "{ctrl}": "⌃",
};

const PC_SYMBOLS: Record<string, string> = {
  "{mod}": "Ctrl+",
  "{shift}": "Shift+",
  "{alt}": "Alt+",
  "{ctrl}": "Ctrl+",
};

/**
 * Format a canonical shortcut string for the current platform.
 *
 * Canonical tokens: `{mod}`, `{shift}`, `{alt}`, `{ctrl}`
 *
 * Examples:
 *   fmt("{mod}N")       → "⌘N" (mac) / "Ctrl+N" (win/linux)
 *   fmt("{mod}{shift}C") → "⌘⇧C" (mac) / "Ctrl+Shift+C" (win/linux)
 */
export function fmt(canonical: string): string {
  const symbols = isMac ? MAC_SYMBOLS : PC_SYMBOLS;
  let result = canonical;
  for (const [token, replacement] of Object.entries(symbols)) {
    result = result.replaceAll(token, replacement);
  }
  return result;
}
