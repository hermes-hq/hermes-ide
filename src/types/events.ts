// ─── Event Types ─────────────────────────────────────────────────────

export interface ErrorMatchEvent {
  fingerprint: string;
  occurrence_count: number;
  resolution: string | null;
  raw_sample: string | null;
}

export interface CommandPredictionEvent {
  predictions: { next_command: string; frequency: number }[];
}

export interface ErrorCorrelation {
  session_id: string;
  session_label: string;
  last_seen: number;
  occurrence_count: number;
}
