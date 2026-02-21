import { invoke } from "@tauri-apps/api/core";
import type { CostDailyEntry, ProjectCostEntry } from "../types";

export function getCostHistory(days: number): Promise<CostDailyEntry[]> {
  return invoke<CostDailyEntry[]>("get_cost_history", { days });
}

export function getCostByProject(days: number): Promise<ProjectCostEntry[]> {
  return invoke<ProjectCostEntry[]>("get_cost_by_project", { days });
}
