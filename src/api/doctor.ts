import { invoke } from "@tauri-apps/api/core";
import { isFeatureFlagEnabled } from "../featureFlags";

/** One catalog agent as the agent doctor sees it (src-tauri/src/agent_doctor.rs). */
export interface DoctorRow {
  id: string;
  name: string;
  installed: boolean;
  version: string | null;
  min_version: string | null;
  /** False when below min_version; null when either version is unknown. */
  version_ok: boolean | null;
  signed_in: "yes" | "no" | "unknown";
  signals: "exact" | "signal" | "none";
  resume: boolean;
  retired: boolean;
  retired_note: string | null;
  beta: boolean;
  /** Installed but it cannot start: the first line it printed (its sign-in is then "unknown"). */
  broken?: string | null;
}

/** Ask every catalog agent CLI this build shows for its version and sign-in state. */
export function runAgentDoctor(): Promise<DoctorRow[]> {
  return invoke<DoctorRow[]>("agent_doctor", { includeBeta: isFeatureFlagEnabled("agentCatalog") });
}
