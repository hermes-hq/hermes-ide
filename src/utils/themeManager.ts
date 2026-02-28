import { updateSettings } from "../terminal/TerminalPool";

export const THEME_OPTIONS = [
  { id: "dark", label: "Dark" },
  { id: "hacker", label: "Hacker" },
  { id: "designer", label: "Atelier" },
  { id: "data", label: "Deep Lab" },
  { id: "corporate", label: "Enterprise" },
  { id: "nightowl", label: "Night Owl" },
  { id: "tron", label: "Tron" },
  { id: "duel", label: "Duel" },
  { id: "rainbow", label: "Rainbow" },
  { id: "80s", label: "80s" },
  { id: "solarized", label: "Solarized Light" },
] as const;

export const UI_SCALE_OPTIONS = [
  { id: "compact", label: "Compact (90%)" },
  { id: "default", label: "Default (100%)" },
  { id: "comfortable", label: "Comfortable (115%)" },
  { id: "large", label: "Large (130%)" },
  { id: "x-large", label: "Extra Large (150%)" },
] as const;

// Base token values (must match tokens.css :root defaults)
const BASE_TOKENS = {
  "--text-xs": 9,
  "--text-sm": 10,
  "--text-base": 11,
  "--text-md": 12,
  "--text-lg": 13,
  "--text-xl": 15,
  "--space-1": 4,
  "--space-2": 8,
  "--space-3": 12,
  "--space-4": 16,
  "--space-5": 24,
  "--space-6": 32,
  "--topbar-h": 40,
  "--statusbar-h": 28,
  "--sidebar-w": 240,
  "--context-w": 300,
  "--activity-bar-w": 36,
  "--radius": 3,
  "--radius-sm": 3,
  "--radius-lg": 6,
  "--radius-pill": 10,
  "--icon-size": 18,
  "--btn-size": 28,
};

const SCALE_FACTORS: Record<string, number> = {
  compact: 0.9,
  default: 1.0,
  comfortable: 1.15,
  large: 1.3,
  "x-large": 1.5,
};

export function applyUiScale(scaleId: string): void {
  const factor = SCALE_FACTORS[scaleId] ?? 1.0;
  const root = document.documentElement;
  for (const [prop, base] of Object.entries(BASE_TOKENS)) {
    root.style.setProperty(prop, `${Math.round(base * factor)}px`);
  }
}

export function applyTheme(themeId: string, allSettings: Record<string, string>): void {
  // Set data-theme on <html> — CSS does the rest
  if (themeId === "dark") {
    delete document.documentElement.dataset.theme;
  } else {
    document.documentElement.dataset.theme = themeId;
  }
  // Apply UI scale
  applyUiScale(allSettings.ui_scale || "default");
  // Sync terminal colors
  updateSettings({ ...allSettings, theme: themeId });
}
