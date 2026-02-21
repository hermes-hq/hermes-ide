// ─── Cost Types ──────────────────────────────────────────────────────

export interface CostDailyEntry {
  date: string;
  provider: string;
  model: string;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd: number;
  session_count: number;
}

export interface ProjectCostEntry {
  working_directory: string;
  provider: string;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd: number;
  session_count: number;
}
