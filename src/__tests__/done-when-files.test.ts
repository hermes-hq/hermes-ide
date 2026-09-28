/**
 * F27 Done-When: the frontend's contract readers and the `hi` helper's
 * readers (src-tauri/hi/src/done_when.rs) must say the same thing about the
 * same file. Both run over src/doneWhen/fixtures/done-when-files.json; this
 * is the frontend half.
 */
import { describe, it, expect } from "vitest";
import fixture from "../doneWhen/fixtures/done-when-files.json";
import { parseWorktreeToml } from "../agent/contract/worktreeToml";
import { parseFeatureFrontMatter } from "../agent/contract/featureFrontMatter";

interface Case {
  name: string;
  text: string;
  slug?: string;
  doneWhen?: string[];
  error?: { message: string; line: number };
}

const worktree = fixture.worktree as Case[];
const feature = fixture.feature as Case[];

describe("done_when readers agree with the hi helper", () => {
  it.each(worktree.map((c) => [c.name, c] as const))("worktree.toml: %s", (_name, c) => {
    const r = parseWorktreeToml(c.text);
    if (c.doneWhen) {
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.config.doneWhen).toEqual(c.doneWhen);
    } else {
      expect(r).toEqual({ ok: false, error: c.error?.message, line: c.error?.line });
    }
  });

  it.each(feature.map((c) => [c.name, c] as const))("feature.md: %s", (_name, c) => {
    const r = parseFeatureFrontMatter(c.text);
    if (c.doneWhen) {
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.meta.doneWhen).toEqual(c.doneWhen);
        expect(r.meta.slug).toBe(c.slug);
      }
    } else {
      expect(r).toEqual({ ok: false, error: c.error?.message, line: c.error?.line });
    }
  });
});
