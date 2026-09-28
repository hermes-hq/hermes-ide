/** C0 contracts: the feature.md front matter reader. */
import { describe, it, expect } from "vitest";
import { FEATURE_GATES, FEATURE_PHASES, FEATURE_TRACKS, isFeatureSlug, parseFeatureFrontMatter } from "../agent/contract/featureFrontMatter";

const FULL = `---
slug: search-index
track: Full
phase: plan          # where we are
gate: waiting
done_when:
  - npm test
  - "npm run lint"
---
# Search index

Build the index.
`;

describe("parseFeatureFrontMatter", () => {
  it("reads slug, track, phase, gate and done_when, and returns the body", () => {
    expect(parseFeatureFrontMatter(FULL)).toEqual({
      ok: true,
      meta: { slug: "search-index", track: "Full", phase: "plan", gate: "waiting", doneWhen: ["npm test", "npm run lint"], ignored: [] },
      body: "# Search index\n\nBuild the index.\n",
    });
  });

  it("defaults phase to questions and gate to none; done_when may be inline", () => {
    expect(parseFeatureFrontMatter("---\nslug: a\ntrack: Quick\ndone_when: [npm test, 'x y']\n---\n")).toEqual({
      ok: true,
      meta: { slug: "a", track: "Quick", phase: "questions", gate: "none", doneWhen: ["npm test", "x y"], ignored: [] },
      body: "",
    });
    expect(FEATURE_TRACKS).toEqual(["Quick", "Light", "Full"]);
    expect(FEATURE_PHASES).toEqual(["questions", "research", "design", "structure", "plan", "implement", "done"]);
    expect(FEATURE_GATES).toEqual(["none", "waiting", "approved"]);
  });

  it("keeps unknown keys so an older Hermes still reads a newer file", () => {
    const r = parseFeatureFrontMatter("---\nslug: a\ntrack: Light\nowner: someone\n---\nbody");
    expect(r).toMatchObject({ ok: true, meta: { ignored: ["owner"] }, body: "body" });
  });

  it("validates the slug as a branch component", () => {
    expect(isFeatureSlug("search-index")).toBe(true);
    expect(isFeatureSlug("Search Index")).toBe(false);
    expect(isFeatureSlug("-x")).toBe(false);
  });

  it.each<[string, string, number]>([
    ["# no front matter\n", "feature.md must start with ---", 1],
    ["---\nslug: a\ntrack: Full\n", "front matter never closes (missing ---)", 3],
    ["---\ntrack: Full\n---\n", "slug is required", 1],
    ["---\nslug: a\n---\n", "track is required (Quick, Light or Full)", 1],
    ["---\nslug: Bad Slug\ntrack: Full\n---\n", "slug must be lowercase letters, digits and dashes", 2],
    ["---\nslug: a\ntrack: Huge\n---\n", "track must be one of Quick, Light, Full", 3],
    ["---\nslug: a\ntrack: Full\nphase: later\n---\n", "phase must be one of questions, research, design, structure, plan, implement, done", 4],
    ["---\nslug: a\ntrack: Full\ngate: yes\n---\n", "gate must be one of none, waiting, approved", 4],
    ["---\nslug: a\ntrack: Full\ndone_when: npm test\n---\n", "done_when must be a list", 4],
    ["---\nslug: a\ntrack: Full\n  - stray\n---\n", "list item outside a list", 4],
    ["---\nslug: a\n\nthis is not a field\ntrack: Full\n---\n", "expected key: value", 4],
    ["---\nslug: a\nslug: b\ntrack: Full\n---\n", "slug given twice", 3],
    ["---\nslug: a\ntrack: Full\ndone_when: [a, b\n---\n", "unterminated list", 4],
    ["---\nslug: [a]\ntrack: Full\n---\n", "slug must be lowercase letters, digits and dashes", 2],
  ])("refuses %j naming the line", (text, error, line) => {
    expect(parseFeatureFrontMatter(text)).toEqual({ ok: false, error, line });
  });
});
