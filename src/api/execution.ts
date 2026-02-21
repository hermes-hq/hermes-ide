import { invoke } from "@tauri-apps/api/core";
import type { ExecutionNode } from "../types/session";

export function getExecutionNodes(sessionId: string, limit: number, offset: number): Promise<ExecutionNode[]> {
  return invoke<ExecutionNode[]>("get_execution_nodes", { sessionId, limit, offset });
}
