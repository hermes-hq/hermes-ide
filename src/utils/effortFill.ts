/**
 * Map the current effort level to a discrete "fill" bucket (0..3) for the
 * three-bar chip in the composer.
 *
 * - Empty `allLevels` or unknown `currentLevel` → 0.
 * - Single-element list → always 3 (max), since there is no scale to spread.
 * - Otherwise the level's index is linearly mapped onto 0..3 by
 *   `round(index * 3 / (allLevels.length - 1))`.
 *
 * Tested in `src/__tests__/use-claude-capabilities.test.ts`. The composer
 * (or its hook) should use this exact function so the chip glyph stays in
 * sync with the test contract.
 */
export function effortFillForLevel(currentLevel: string, allLevels: string[]): number {
  if (allLevels.length === 0) return 0;
  const idx = allLevels.indexOf(currentLevel);
  if (idx < 0) return 0;
  if (allLevels.length === 1) return 3;
  return Math.round((idx * 3) / (allLevels.length - 1));
}
