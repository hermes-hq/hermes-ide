import { detectShellEnvironment as apiDetectShellEnvironment } from "../../api/intelligence";

// ─── Types ───────────────────────────────────────────────────────────

export type SuggestionMode = "augment" | "replace" | "off";

export interface ShellEnvironment {
  shellType: "zsh" | "bash" | "fish" | "unknown";
  pluginsDetected: string[];
  hasNativeAutosuggest: boolean;
  hasOhMyZsh: boolean;
  hasSyntaxHighlighting: boolean;
  hasStarship: boolean;
  hasPowerlevel10k: boolean;
  shellIntegrationActive: boolean;
  /** Whether Hermes inline suggestions were on when this session was spawned.
   *  Fixed per session; absent until the backend has reported it. */
  hermesSuggestions?: boolean;
}

export interface IntelligenceConfig {
  enabled: boolean;
  mode: SuggestionMode;
  ghostTextEnabled: boolean;
  overlayEnabled: boolean;
  projectAware: boolean;
  historyWeighting: boolean;
}

// ─── Defaults ────────────────────────────────────────────────────────

const DEFAULT_CONFIG: IntelligenceConfig = {
  enabled: true,
  mode: "augment",
  ghostTextEnabled: true,
  overlayEnabled: true,
  projectAware: true,
  historyWeighting: true,
};

// ─── Per-session state ───────────────────────────────────────────────

const sessionShellEnv = new Map<string, ShellEnvironment>();
let globalConfig: IntelligenceConfig = { ...DEFAULT_CONFIG };
/** Current "Hermes inline suggestions" setting (#117). Only used for sessions
 *  whose spawn-time value isn't known yet — each session keeps its own mode. */
let hermesSuggestionsSetting = true;

// ─── Shell Environment Detection ─────────────────────────────────────

export async function detectShellEnvironment(sessionId: string): Promise<ShellEnvironment> {
  try {
    const env = await apiDetectShellEnvironment(sessionId);
    sessionShellEnv.set(sessionId, env);
    return env;
  } catch {
    const fallback: ShellEnvironment = {
      shellType: "unknown",
      pluginsDetected: [],
      hasNativeAutosuggest: false,
      hasOhMyZsh: false,
      hasSyntaxHighlighting: false,
      hasStarship: false,
      hasPowerlevel10k: false,
      shellIntegrationActive: false,
    };
    sessionShellEnv.set(sessionId, fallback);
    return fallback;
  }
}

export function getShellEnvironment(sessionId: string): ShellEnvironment | null {
  return sessionShellEnv.get(sessionId) ?? null;
}

export function clearShellEnvironment(sessionId: string): void {
  sessionShellEnv.delete(sessionId);
}

// ─── Configuration ───────────────────────────────────────────────────

export function getIntelligenceConfig(): IntelligenceConfig {
  return globalConfig;
}

export function updateIntelligenceConfig(partial: Partial<IntelligenceConfig>): void {
  globalConfig = { ...globalConfig, ...partial };
}

/** Load config from settings DB */
export function loadConfigFromSettings(settings: Record<string, string>): void {
  const mode = settings.intelligence_mode as SuggestionMode | undefined;
  globalConfig = {
    enabled: settings.intelligence_enabled !== "false",
    mode: mode === "replace" || mode === "off" ? mode : "augment",
    ghostTextEnabled: settings.intelligence_ghost_text !== "false",
    overlayEnabled: settings.intelligence_overlay !== "false",
    projectAware: settings.intelligence_project_aware !== "false",
    historyWeighting: settings.intelligence_history_weighting !== "false",
  };
}

/** Track the "Hermes inline suggestions" setting ("native" = off). Affects
 *  only inline suggestions, ghost text and Tab — not intent commands. */
export function applyShellSuggestionsSetting(settings: Record<string, string>): void {
  hermesSuggestionsSetting = settings.shell_suggestions !== "native";
}

/** Whether this session shows Hermes inline suggestions — the value recorded
 *  when its shell was spawned, so it matches whether the shell's own
 *  autosuggestion plugins were disabled. */
function hermesSuggestionsFor(sessionId: string): boolean {
  const spawned = sessionShellEnv.get(sessionId)?.hermesSuggestions;
  return typeof spawned === "boolean" ? spawned : hermesSuggestionsSetting;
}

// ─── Conflict Detection ──────────────────────────────────────────────

/** Determine if ghost text should be shown for this session */
export function shouldShowGhostText(sessionId: string): boolean {
  if (!globalConfig.enabled || !globalConfig.ghostTextEnabled) return false;
  if (!hermesSuggestionsFor(sessionId)) return false;
  if (globalConfig.mode === "off") return false;

  const env = sessionShellEnv.get(sessionId);
  if (!env) return globalConfig.ghostTextEnabled;

  // If shell integration is active, conflicting plugins have been disabled
  // at the shell level — always show Hermes ghost text.
  if (env.shellIntegrationActive) return true;

  // Without integration, don't show ghost text if shell has native autosuggestions
  // (they would overlap with ours)
  if (globalConfig.mode === "augment") {
    if (env.hasNativeAutosuggest) return false;
    if (env.shellType === "fish") return false;
  }

  return true;
}

/** Determine if the overlay panel should be shown */
export function shouldShowOverlay(sessionId: string): boolean {
  if (!globalConfig.enabled || !globalConfig.overlayEnabled) return false;
  if (!hermesSuggestionsFor(sessionId)) return false;
  if (globalConfig.mode === "off") return false;
  return true;
}

/** Determine if Tab should be consumed by our overlay or passed to shell */
export function shouldConsumeTab(sessionId: string, overlayVisible: boolean): boolean {
  if (!globalConfig.enabled || globalConfig.mode === "off") return false;
  if (!hermesSuggestionsFor(sessionId)) return false;
  if (!overlayVisible) return false;

  const env = sessionShellEnv.get(sessionId);
  if (!env) return overlayVisible;

  // If shell integration is active, conflicting plugins have been disabled —
  // safe to consume Tab for Hermes suggestions.
  if (env.shellIntegrationActive) return true;

  // Without integration, prefer shell Tab completion in augment mode
  if (globalConfig.mode === "augment") {
    if (env.hasNativeAutosuggest || env.shellType === "fish") {
      return false;
    }
  }

  return true;
}

/** Check if intelligence is fully disabled (zero overhead mode) */
export function isIntelligenceDisabled(): boolean {
  return !globalConfig.enabled || globalConfig.mode === "off";
}
