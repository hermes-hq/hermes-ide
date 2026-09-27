// ─── Platform Detection ─────────────────────────────────────────────
// Single source of truth for all OS-specific logic in the frontend.

export type Platform = "mac" | "win" | "linux";

/**
 * Test builds only (VITE_HERMES_E2E=1, stripped from normal builds): a
 * real-app scenario can run the frontend with another platform's keyboard
 * rules by setting localStorage "hermes-e2e-platform" and reloading.
 */
function e2ePlatformOverride(): Platform | null {
  if (import.meta.env.VITE_HERMES_E2E !== "1") return null;
  try {
    const value = localStorage.getItem("hermes-e2e-platform");
    return value === "mac" || value === "win" || value === "linux" ? value : null;
  } catch {
    return null;
  }
}

function detectPlatform(): Platform {
  const override = e2ePlatformOverride();
  if (override) return override;
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

/** Human-readable OS version extracted from the user agent string. */
export const OS_VERSION: string = (() => {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent ?? "" : "";
  // macOS: "Mac OS X 10_15_7" → "macOS 10.15.7"
  const macMatch = ua.match(/Mac OS X ([\d_]+)/);
  if (macMatch) return "macOS " + macMatch[1].replace(/_/g, ".");
  // Windows: "Windows NT 10.0" → "Windows 10.0"
  const winMatch = ua.match(/Windows NT ([\d.]+)/);
  if (winMatch) return "Windows NT " + winMatch[1];
  // Linux: "Linux x86_64" or just "Linux"
  const linuxMatch = ua.match(/Linux ([\w_]+)/);
  if (linuxMatch) return "Linux " + linuxMatch[1];
  return "";
})();

/**
 * Returns true when the platform's "action" modifier is held.
 * - macOS: metaKey (⌘)
 * - Windows/Linux: ctrlKey
 */
export function isActionMod(e: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return isMac ? e.metaKey : e.ctrlKey;
}

// ─── Shortcut Formatting ────────────────────────────────────────────

export const MAC_SYMBOLS: Record<string, string> = {
  "{mod}": "⌘",
  "{shift}": "⇧",
  "{alt}": "⌥",
  "{ctrl}": "⌃",
};

export const PC_SYMBOLS: Record<string, string> = {
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
  return formatChord(canonical, PLATFORM);
}

/** Like fmt(), for an explicit platform. */
export function formatChord(canonical: string, platform: Platform): string {
  const symbols = platform === "mac" ? MAC_SYMBOLS : PC_SYMBOLS;
  let result = canonical;
  for (const [token, replacement] of Object.entries(symbols)) {
    result = result.replaceAll(token, replacement);
  }
  return result;
}
