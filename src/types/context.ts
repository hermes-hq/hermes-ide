// ─── Context Types ───────────────────────────────────────────────────

export interface ContextPin {
  id: number;
  session_id: string | null;
  project_id: string | null;
  kind: string;
  target: string;
  label: string | null;
  priority: number;
  created_at: number;
}

export interface ProjectContextInfo {
  realm_id: string;
  realm_name: string;
  path: string;
  languages: string[];
  frameworks: string[];
  architecture_pattern: string | null;
  architecture_layers: string[];
  conventions: string[];
  scan_status: string;
}

export interface ErrorResolution {
  fingerprint: string;
  resolution: string;
  occurrence_count: number;
}

export interface PersistedMemory {
  id: number;
  scope: string;
  scope_id: string;
  category: string;
  key: string;
  value: string;
  source: string;
  confidence: number;
  access_count: number;
  created_at: string;
  updated_at: string;
}

export interface ContextState {
  pinnedItems: ContextPin[];
  memoryFacts: Pick<PersistedMemory, 'key' | 'value' | 'source' | 'confidence'>[];
  persistedMemory: Pick<PersistedMemory, 'key' | 'value' | 'source'>[];
  realms: ProjectContextInfo[];
  workspacePaths: string[];
  workingDirectory: string;
  agent: string | null;
  model: string | null;
}

export type ContextLifecycleState = 'clean' | 'dirty' | 'applying' | 'apply_failed';

export interface ContextManager {
  context: ContextState;
  currentVersion: number;
  injectedVersion: number;
  lastInjectedAt: number | null;
  lifecycle: ContextLifecycleState;
  lastError: string | null;
  injectedContent: string | null;
  tokenBudget: number;
  estimatedTokens: number;
  applyContext: () => Promise<void>;
  acknowledgeInjection: () => void;
  formatContext: () => string;
  copyToClipboard: () => Promise<void>;
}

export interface ApplyContextResult {
  version: number;
  content: string;
  file_path: string;
  nudge_sent: boolean;
  nudge_error: string | null;
  estimated_tokens: number;
  token_budget: number;
}

/** .hermes/context.json schema as returned from the backend */
export interface HermesProjectConfig {
  pins: { kind: string; target: string; label?: string }[];
  memory: { key: string; value: string }[];
  conventions: string[];
  token_budget?: number;
}
