// ─── Realm Types ─────────────────────────────────────────────────────

export interface Realm {
  id: string;
  path: string;
  name: string;
  languages: string[];
  frameworks: string[];
  architecture: {
    pattern: string;
    layers: string[];
    entry_points: string[];
  } | null;
  conventions: { rule: string; source: string; confidence: number }[];
  scan_status: string;
  last_scanned_at: string | null;
  created_at: string;
  updated_at: string;
}
