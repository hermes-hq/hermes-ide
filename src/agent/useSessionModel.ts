import type { SessionData } from "../types/session";
import { useAgentInit } from "./useAgentInit";
import { compactModelName } from "./modelOptions";

/** The session's active model as a short name ("opus", "sonnet", …), or
 *  null when unknown.  Agent mode reads the latest `system/init` model
 *  (updated on every respawn after a ModelPicker switch); terminal mode
 *  reads the model the PTY analyzer detected. */
export function useSessionModel(
  session: Pick<SessionData, "id" | "mode" | "detected_agent"> | undefined,
): string | null {
  const isAgent = session?.mode === "agent";
  const init = useAgentInit(isAgent ? session.id : null);
  return compactModelName(isAgent ? init?.model : session?.detected_agent?.model);
}
