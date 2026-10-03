/**
 * Rendering an entry with its arguments goes through @hermes-hq/hodios-core
 * (one render path for every agent): filled arguments, defaults, optional
 * sections dropped, required ones reported, personas as roles, styles at a
 * level, workflows with their steps.
 */
import { describe, expect, it } from "vitest";
import { argsOf, defaultValues, missingRequired, render } from "../library/render";
import type { EntryBody } from "../library/types";

const prompt: EntryBody = {
  schema: 1,
  fm: {
    id: "review-pull-request",
    kind: "prompt",
    title: "Review a pull request",
    version: "1.2.0",
    args: [
      { name: "diff", description: "Diff, PR URL or branch", type: "text", required: true },
      { name: "focus", description: "Area", type: "enum", enum: ["correctness", "security"], default: "correctness" },
      { name: "notes", description: "Extra notes", type: "text" },
    ],
  },
  body: "Review {{diff}}.\nWeight: {{focus}}.\n{{#notes}}\nNotes: {{notes}}\n{{/notes}}\nDone.",
  steps: [],
};

describe("library render", () => {
  it("reads arguments, defaults and what is still required", () => {
    expect(argsOf(prompt).map((a) => a.name)).toEqual(["diff", "focus", "notes"]);
    expect(defaultValues(prompt)).toEqual({ focus: "correctness" });
    expect(missingRequired(prompt, {})).toEqual(["diff"]);
    expect(missingRequired(prompt, { diff: "  " })).toEqual(["diff"]);
    expect(missingRequired(prompt, { diff: "feat/x" })).toEqual([]);
    expect(argsOf(null)).toEqual([]);
  });

  it("fills arguments and drops an optional section left empty", async () => {
    const text = await render(prompt, { diff: "feat/checkout", focus: "security", notes: "" });
    expect(text).toContain("Review feat/checkout.");
    expect(text).toContain("Weight: security.");
    expect(text).not.toContain("Notes:");
    const withNotes = await render(prompt, { diff: "x", notes: "be brief" });
    expect(withNotes).toContain("Notes: be brief");
    expect(withNotes).toContain("Weight: correctness.");
  });

  it("keeps a missing value visible as a placeholder", async () => {
    expect(await render(prompt, {})).toContain("[DIFF]");
  });

  it("renders a persona as a role and a style at its level", async () => {
    const persona: EntryBody = { schema: 1, fm: { id: "auditor", kind: "persona", title: "Security auditor", version: "1.0.0" }, body: "Report exploitable issues only.", steps: [] };
    const p = await render(persona, {});
    expect(p).toContain("Security auditor");
    expect(p).toContain("Report exploitable issues only.");
    const style: EntryBody = {
      schema: 1,
      fm: {
        id: "concise",
        kind: "style",
        title: "Concise",
        version: "1.0.0",
        levels: [1, 2, 3, 4, 5].map((n) => ({ label: `L${n}`, instruction: `Instruction ${n}.` })),
      },
      body: "Be brief.",
      steps: [],
    };
    expect(await render(style, {}, 5)).toContain("Instruction 5.");
    expect(await render(style, {}, 2)).toContain("Instruction 2.");
  });

  it("inlines a workflow's steps", async () => {
    const wf: EntryBody = {
      schema: 1,
      fm: { id: "bugfix-track", kind: "workflow", title: "Bugfix track", version: "1.0.0" },
      body: "Fix the bug in gated steps.",
      steps: [
        { id: "reproduce", stage: "verify", gate: "approve", text: "Reproduce it." },
        { id: "fix", stage: "build", text: "Fix it." },
      ],
    };
    const text = await render(wf, {});
    expect(text).toContain("Reproduce it.");
    expect(text).toContain("Fix it.");
  });
});
