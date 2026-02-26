/**
 * Deep structural equality comparison.
 *
 * Unlike JSON.stringify, this is:
 * - Key-order insensitive for objects (sorted comparison)
 * - Reference-aware (short-circuits on same reference)
 * - Type-strict (no coercion)
 *
 * Arrays are order-sensitive (elements compared positionally).
 */
export function structuralEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;

  // Handle NaN: NaN !== NaN in JS, but they are structurally equal
  if (typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b)) {
    return true;
  }

  if (a == null || b == null) return a === b;
  if (typeof a !== typeof b) return false;

  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!structuralEqual(a[i], b[i])) return false;
    }
    return true;
  }

  if (typeof a === 'object') {
    // Handle Date comparison by time value
    if (a instanceof Date && b instanceof Date) {
      return a.getTime() === b.getTime();
    }
    // Handle RegExp comparison by source and flags
    if (a instanceof RegExp && b instanceof RegExp) {
      return a.source === b.source && a.flags === b.flags;
    }
    // Reject cross-type comparisons (e.g., Date vs plain object)
    if ((a instanceof Date) !== (b instanceof Date)) return false;
    if ((a instanceof RegExp) !== (b instanceof RegExp)) return false;

    const objA = a as Record<string, unknown>;
    const objB = b as Record<string, unknown>;
    const keysA = Object.keys(objA).sort();
    const keysB = Object.keys(objB).sort();
    if (keysA.length !== keysB.length) return false;
    for (let i = 0; i < keysA.length; i++) {
      if (keysA[i] !== keysB[i]) return false;
      if (!structuralEqual(objA[keysA[i]], objB[keysB[i]])) return false;
    }
    return true;
  }

  return a === b;
}

/** Deep clone via structured clone (or JSON fallback). */
export function structuralClone<T>(value: T): T {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}
