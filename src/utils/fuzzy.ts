/**
 * Lightweight fuzzy ranker used by the composer's `@mention` suggestions.
 *
 * Zero dependencies. Designed for short lists (a few hundred items at most)
 * where readability beats absolute throughput.
 */

export interface FuzzyMatch<T> {
  item: T;
  score: number;
  /** Indices in the searchable string that matched the query (for highlighting). */
  matches: number[];
}

/**
 * Lightweight fuzzy ranker. No dependencies.
 *
 * Algorithm:
 * - Empty query → return all items in original order with score 0 and matches [].
 * - For each item, get the searchable string via `getKey(item)`.
 * - Lowercase both query and key for matching, but record indices in the original key.
 * - Walk the query characters left-to-right, finding each in the key in order
 *   (skipping non-matching chars). If any query char isn't found, the item is excluded.
 * - Score: higher = better.
 *   - Start at 0.
 *   - +10 for each consecutive-match streak (bonus for tight matches).
 *   - +5 if the first match is at the start of the key, or after a path separator (`/`, `\`).
 *   - -1 per gap character between matches.
 * - Sort by score descending, ties broken by shorter key (prefer concise matches).
 * - Cap output to `limit` items (default 10).
 */
export function fuzzyRank<T>(
  items: readonly T[],
  query: string,
  getKey: (item: T) => string,
  limit: number = 10,
): FuzzyMatch<T>[] {
  if (query.length === 0) {
    return items.slice(0, limit).map((item) => ({ item, score: 0, matches: [] }));
  }

  const lowerQuery = query.toLowerCase();
  const ranked: { match: FuzzyMatch<T>; key: string; order: number }[] = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const key = getKey(item);
    const matches = findMatches(key, lowerQuery);
    if (!matches) continue;
    ranked.push({
      match: { item, score: scoreMatches(key, matches), matches },
      key,
      order: i,
    });
  }

  ranked.sort((a, b) => {
    if (b.match.score !== a.match.score) return b.match.score - a.match.score;
    if (a.key.length !== b.key.length) return a.key.length - b.key.length;
    return a.order - b.order;
  });

  return ranked.slice(0, limit).map((r) => r.match);
}

function findMatches(key: string, lowerQuery: string): number[] | null {
  const lowerKey = key.toLowerCase();
  const matches: number[] = [];
  let qi = 0;
  for (let i = 0; i < lowerKey.length && qi < lowerQuery.length; i++) {
    if (lowerKey[i] === lowerQuery[qi]) {
      matches.push(i);
      qi++;
    }
  }
  return qi === lowerQuery.length ? matches : null;
}

function scoreMatches(key: string, matches: number[]): number {
  let score = 0;
  for (let i = 1; i < matches.length; i++) {
    const gap = matches[i] - matches[i - 1] - 1;
    if (gap === 0) score += 10;
    else score -= gap;
  }
  const first = matches[0];
  if (first === 0) {
    score += 5;
  } else {
    const prev = key[first - 1];
    if (prev === "/" || prev === "\\") score += 5;
  }
  return score;
}
