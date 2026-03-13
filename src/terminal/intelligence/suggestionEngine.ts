import { lookupCommands, lookupByPrefix, type CommandEntry } from "./commandIndex";
import { type ProjectContext, isContextRelevant } from "./contextAnalyzer";
import { type HistoryProvider } from "./historyProvider";

export interface Suggestion {
  text: string;
  description?: string;
  source: "history" | "index" | "context";
  score: number;
  badge?: string;
}

const MAX_RESULTS = 15;
const LENGTH_PENALTY_THRESHOLD = 60;

/**
 * Compute suggestions synchronously. Target: <5ms.
 *
 * Scoring:
 * | Factor                                      | Points           |
 * |---------------------------------------------|------------------|
 * | Session/shell history match                  | +300 / +200      |
 * | Static index match                           | +100             |
 * | Frequency boost                              | +min(freq*10,200)|
 * | Recency boost (history)                      | +100 decaying    |
 * | Context relevance (e.g. cargo in Rust proj)  | +150             |
 * | Exact prefix bonus                           | +100             |
 * | Length penalty (>60 chars)                    | -(len-60)*2      |
 *
 * Dedup: same command from multiple sources → keep highest + 50 per extra source.
 */
export function suggest(
  input: string,
  context: ProjectContext | null,
  history: HistoryProvider,
): Suggestion[] {
  const trimmed = input.trim();
  if (!trimmed) return [];

  const candidates = new Map<string, Suggestion>();

  // 1. History matches
  const historyMatches = history.match(trimmed);
  for (const hm of historyMatches) {
    const recencyBoost = Math.max(0, 100 - hm.recencyIndex * 2);
    const freqBoost = Math.min(hm.frequency * 10, 200);
    const score = 200 + freqBoost + recencyBoost;

    addCandidate(candidates, {
      text: hm.command,
      source: "history",
      score,
    });
  }

  // 2. Static index matches
  const tokens = trimmed.split(/\s+/);
  let indexMatches: CommandEntry[];

  if (tokens.length >= 1 && trimmed.includes(" ")) {
    // Multi-token: exact prefix lookup
    indexMatches = lookupCommands(trimmed);
  } else {
    // Single token or partial: prefix match on first token
    indexMatches = lookupByPrefix(tokens[0]);
  }

  for (const entry of indexMatches) {
    let score = 100;

    // Context relevance boost
    if (context && isContextRelevant(entry.category, context)) {
      score += 150;
    }

    // Exact prefix bonus
    if (entry.command.startsWith(trimmed)) {
      score += 100;
    }

    addCandidate(candidates, {
      text: entry.command,
      description: entry.description,
      source: "index",
      score,
      badge: entry.category,
    });
  }

  // 3. Apply length penalty and finalize
  const results: Suggestion[] = [];
  for (const s of candidates.values()) {
    if (s.text.length > LENGTH_PENALTY_THRESHOLD) {
      s.score -= (s.text.length - LENGTH_PENALTY_THRESHOLD) * 2;
    }
    results.push(s);
  }

  // Sort descending by score
  results.sort((a, b) => b.score - a.score);

  return results.slice(0, MAX_RESULTS);
}

/** Add or merge candidate into the map (dedup with +50 bonus per extra source) */
function addCandidate(map: Map<string, Suggestion>, candidate: Suggestion): void {
  const existing = map.get(candidate.text);
  if (existing) {
    // Dedup: keep the higher-scoring entry + 50 multi-source bonus
    const kept = candidate.score > existing.score ? candidate : existing;
    const other = candidate.score > existing.score ? existing : candidate;
    kept.score += 50;
    // Preserve description/badge from the richer source
    if (!kept.description && other.description) {
      kept.description = other.description;
    }
    if (!kept.badge && other.badge) {
      kept.badge = other.badge;
    }
    map.set(candidate.text, kept);
  } else {
    map.set(candidate.text, candidate);
  }
}
