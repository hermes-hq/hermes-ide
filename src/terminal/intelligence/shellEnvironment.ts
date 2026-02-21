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

// ─── Shell Environment Detection ─────────────────────────────────────

export async function detectShellEnvironment(sessionId: string): Promise<ShellEnvironment> {
  try {
    const env = await apiDetectShellEnvironment(sessionId);
    sessionShellEnv.set(sessionId, env);

    // Auto-adjust defaults for fish
    if (env.shellType === "fish" && globalConfig.mode === "augment") {
      // Fish has strong built-in autosuggestions — disable ghost text by default
      // but keep overlay available
    }

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

// ─── Conflict Detection ──────────────────────────────────────────────

/** Determine if ghost text should be shown for this session */
export function shouldShowGhostText(sessionId: string): boolean {
  if (!globalConfig.enabled || !globalConfig.ghostTextEnabled) return false;
  if (globalConfig.mode === "off") return false;

  const env = sessionShellEnv.get(sessionId);
  if (!env) return globalConfig.ghostTextEnabled;

  // In augment mode, don't show ghost text if shell has native autosuggestions
  if (globalConfig.mode === "augment") {
    if (env.hasNativeAutosuggest) return false;
    if (env.shellType === "fish") return false;
  }

  return true;
}

/** Determine if the overlay panel should be shown */
export function shouldShowOverlay(_sessionId: string): boolean {
  if (!globalConfig.enabled || !globalConfig.overlayEnabled) return false;
  if (globalConfig.mode === "off") return false;
  return true;
}

/** Determine if Tab should be consumed by our overlay or passed to shell */
export function shouldConsumeTab(sessionId: string, overlayVisible: boolean): boolean {
  if (!globalConfig.enabled || globalConfig.mode === "off") return false;
  if (!overlayVisible) return false;

  const env = sessionShellEnv.get(sessionId);
  if (!env) return overlayVisible;

  // In augment mode, prefer shell Tab completion over ours
  // We only consume Tab in augment mode if we're confident shell isn't completing
  if (globalConfig.mode === "augment") {
    // Let shell handle Tab if it has native autosuggestions
    // User can use Ctrl-Space or arrow-select + Enter instead
    if (env.hasNativeAutosuggest || env.shellType === "fish") {
      return false;
    }
  }

  // In replace mode, always consume Tab when overlay is visible
  return true;
}

/** Check if intelligence is fully disabled (zero overhead mode) */
export function isIntelligenceDisabled(): boolean {
  return !globalConfig.enabled || globalConfig.mode === "off";
}
